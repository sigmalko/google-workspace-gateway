import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/app.mjs';
import { SCOPES } from '../src/google.mjs';

function setup() {
  const store = new Store(':memory:', randomBytes(32));
  const config = { baseUrl: 'http://127.0.0.1:8765', agentToken: 'a'.repeat(40), allowed: ['a@example.com', 'b@example.com'] };
  let calls = 0;
  let failing = false;
  const google = {
    access: async user => { if (user.status !== 'connected') throw Error('reauthorization_required'); return 'secret'; },
    publish: async () => { calls++; if (failing) throw Error('timeout'); return { id: 'google-event-id' }; },
    targets: async () => [{ id: 'target-1', name: '<Calendar>' }],
    authorize: async () => 'https://accounts.google.com/',
    exchange: async () => ({ identity: { sub: 'a', email: 'a@example.com', email_verified: true }, tokens: { access_token: 'access', refresh_token: 'refresh', expiry_date: Date.now()+3600000 }, scopes: SCOPES.calendar })
  };
  const app = createApp({ config, store, google });
  const server = app.listen(0);
  const user = store.login('a', 'a@example.com');
  store.saveCredentials(user.id, { refresh_token: 'SECRET_REFRESH' }, [...SCOPES.calendar, ...SCOPES.tasks]);
  store.setTarget(user.id, 'calendar', 'target-1', '<Calendar>');
  store.setTarget(user.id, 'tasks', 'target-2', 'Tasks');
  const session = store.createSession();
  store.db.prepare('UPDATE sessions SET user_id=? WHERE id=?').run(user.id, session.id);
  const subscriptions = store.subscriptions(user.id);
  const url = () => `http://127.0.0.1:${server.address().port}`;
  const stop = () => { server.close(); store.close(); };
  return { store, config, user, session, subscriptions, url, stop, get calls() { return calls; }, fail() { failing = true; } };
}
function sample(id) { return { subscriptionId: id, sourceEventId: 'source:123', category: 'stand-up', title: 'Występ', start: '2027-03-12T19:00:00+01:00', end: '2027-03-12T20:30:00+01:00', timeZone: 'Europe/Warsaw', venue: 'Kraków', sourceUrl: 'https://example.org/event', verifiedAt: '2027-01-10T12:00:00Z' }; }
async function post(t, event, key = 'key-1', auth = 'a'.repeat(40)) {
  return fetch(`${t.url()}/internal/v1/publications`, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Idempotency-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
}

test('tokeny szyfrowane i brak dostępu bez tokenu usługi', async () => {
  const t = setup();
  try {
    assert.ok(!t.store.user(t.user.id).credentials.includes('SECRET_REFRESH'));
    assert.equal(t.store.decrypt(t.store.user(t.user.id).credentials).refresh_token, 'SECRET_REFRESH');
    const response = await fetch(`${t.url()}/internal/v1/subscriptions`);
    assert.equal(response.status, 401);
    const response2 = await fetch(`${t.url()}/internal/v1/subscriptions`, { headers: { Authorization: `Bearer ${t.config.agentToken}` } });
    const body = await response2.json();
    assert.equal(body.subscriptions.length, 2);
    assert.ok(!JSON.stringify(body).includes('example.com'));
  } finally { t.stop(); }
});

test('publikacja idempotentna, walidacja i konflikt', async () => {
  const t = setup();
  try {
    const s = t.subscriptions.find(x => x.kind === 'calendar');
    const event = sample(s.id);
    assert.equal((await post(t, event, 'x', 'bad')).status, 401);
    assert.equal((await post(t, { ...event, sourceUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await post(t, { ...event, end: undefined })).status, 400);
    assert.equal((await post(t, { ...event, start: '2027-02-30T19:00:00+01:00' })).status, 400);
    assert.equal((await post(t, event)).status, 201);
    assert.equal((await (await post(t, event)).json()).status, 'already_exists');
    assert.equal(t.calls, 1);
    assert.equal((await post(t, { ...event, title: 'Inny' })).status, 409);
    assert.equal((await post(t, event, 'different-key')).status, 409);
  } finally { t.stop(); }
});

test('niepewna odpowiedź nie powoduje ponownego zapisu', async () => {
  const t = setup();
  try {
    t.fail();
    const event = sample(t.subscriptions.find(x => x.kind === 'tasks').id);
    assert.equal((await (await post(t, event)).json()).status, 'uncertain');
    assert.equal((await (await post(t, event)).json()).status, 'uncertain');
    assert.equal(t.calls, 1);
  } finally { t.stop(); }
});

test('wyłączenie celu i izolacja osób; zmiana celu zachowuje historię', async () => {
  const t = setup();
  try {
    const first = t.subscriptions.find(x => x.kind === 'calendar');
    const b = t.store.login('b', 'b@example.com');
    t.store.saveCredentials(b.id, { refresh_token: 'other' }, SCOPES.calendar);
    t.store.setTarget(b.id, 'calendar', 'other', 'Inny');
    assert.equal((await post(t, sample(first.id))).status, 201);
    t.store.setTarget(t.user.id, 'calendar', 'new', 'Nowy');
    assert.equal((await post(t, sample(first.id))).status, 404);
    const current = t.store.subscriptions(t.user.id).find(x => x.kind === 'calendar');
    assert.notEqual(current.id, first.id);
    assert.equal((await post(t, sample(current.id))).status, 201);
    t.store.setTarget(t.user.id, 'calendar', 'target-1', '<Calendar>');
    assert.equal((await (await post(t, sample(first.id))).json()).status, 'already_exists');
    t.store.disconnect(t.user.id);
    assert.equal(t.store.activeSubscriptions(t.config.allowed).length, 1);
    assert.equal(t.store.user(t.user.id).credentials, null);
  } finally { t.stop(); }
});

test('sesja chroni ustawienia przed CSRF i kod stanu jest jednorazowy', async () => {
  const t = setup();
  try {
    const state = t.store.oauthState(t.session, 'calendar', 'verifier', 'nonce');
    assert.equal(t.store.consumeState(state, t.session).verifier, 'verifier');
    assert.equal(t.store.consumeState(state, t.session), null);
    const headers = { cookie: `gateway_session=${t.session.raw}`, 'Content-Type': 'application/x-www-form-urlencoded' };
    const bad = await fetch(`${t.url()}/disconnect`, { method: 'POST', headers, body: 'csrf=invalid', redirect: 'manual' });
    assert.equal(bad.status, 403);
    assert.equal(t.store.user(t.user.id).status, 'connected');
    const good = await fetch(`${t.url()}/disconnect`, { method: 'POST', headers, body: `csrf=${t.session.csrf}`, redirect: 'manual' });
    assert.equal(good.status, 302);
    assert.equal(t.store.user(t.user.id).status, 'disconnected');
  } finally { t.stop(); }
});

test('callback sprawdza state, sesję i konto Google przed zapisem', async () => {
  const t = setup();
  try {
    const sessionB = t.store.createSession();
    const b = t.store.login('b', 'b@example.com');
    t.store.db.prepare('UPDATE sessions SET user_id=? WHERE id=?').run(b.id, sessionB.id);
    const state = t.store.oauthState(sessionB, 'calendar', 'verifier', 'nonce');
    const headers = { cookie: `gateway_session=${sessionB.raw}` };
    const badState = await fetch(`${t.url()}/oauth/google/callback?code=code&state=bad`, { headers, redirect: 'manual' });
    assert.equal(badState.status, 400);
    const badUser = await fetch(`${t.url()}/oauth/google/callback?code=code&state=${state}`, { headers, redirect: 'manual' });
    assert.equal(badUser.status, 403);
    assert.equal(t.store.user(b.id).credentials, null);
    const repeat = await fetch(`${t.url()}/oauth/google/callback?code=code&state=${state}`, { headers, redirect: 'manual' });
    assert.equal(repeat.status, 400);
  } finally { t.stop(); }
});

test('usunięcie adresu z listy odbiera dostęp do subskrypcji', async () => {
  const t = setup();
  try {
    t.config.allowed = ['b@example.com'];
    const response = await fetch(`${t.url()}/internal/v1/subscriptions`, { headers: { Authorization: `Bearer ${t.config.agentToken}` } });
    assert.deepEqual((await response.json()).subscriptions, []);
    assert.equal((await post(t, sample(t.subscriptions[0].id))).status, 404);
  } finally { t.stop(); }
});
