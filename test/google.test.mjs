import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { Google, SCOPES } from '../src/google.mjs';

test('OAuth: PKCE, stan, weryfikacja nonce i tożsamości', async () => {
  const store = new Store(':memory:', randomBytes(32));
  try {
    const session = store.createSession();
    const google = new Google({ clientId: 'client', baseUrl: 'https://example.org' }, store);
    let options;
    let tokenOptions;
    let nonce;
    google.client = () => ({
      generateCodeVerifierAsync: async () => ({ codeVerifier: 'private-verifier', codeChallenge: 'challenge' }),
      generateAuthUrl: args => { options = args; nonce = args.nonce; return 'https://accounts.google.com/'; },
      getToken: async args => { tokenOptions = args; return { tokens: { id_token: 'id', access_token: 'access' } }; },
      verifyIdToken: async () => ({ getPayload: () => ({ nonce, sub: 'subject', email: 'one@example.org', email_verified: true }) }),
      getTokenInfo: async () => ({ scopes: SCOPES.calendar })
    });
    await google.authorize(store, session, 'calendar');
    assert.equal(options.code_challenge_method, 'S256');
    assert.equal(options.access_type, 'offline');
    assert.ok(options.scope.includes(SCOPES.calendar[0]));
    const state = store.consumeState(options.state, session);
    const result = await google.exchange('code', state);
    assert.equal(tokenOptions.codeVerifier, 'private-verifier');
    assert.equal(result.identity.sub, 'subject');
    nonce = 'nieprawidłowe';
    await assert.rejects(google.exchange('code', state), /Nieprawidłowa tożsamość/);
  } finally { store.close(); }
});

test('odświeżanie tokenu zachowuje refresh token i nie przywraca odłączonego konta', async () => {
  const store = new Store(':memory:', randomBytes(32));
  try {
    const user = store.login('sub', 'a@example.org');
    store.saveCredentials(user.id, { refresh_token: 'long', expiry_date: 0 }, SCOPES.calendar);
    const google = new Google({}, store);
    let refreshes = 0;
    google.client = () => ({ setCredentials() {}, getTokenInfo: async () => ({ scopes: SCOPES.calendar }), refreshAccessToken: async () => { refreshes++; return { credentials: { access_token: 'new', expiry_date: Date.now() + 3600000 } }; } });
    const results = await Promise.all([google.access(store.user(user.id)), google.access(store.user(user.id))]);
    assert.deepEqual(results, ['new', 'new']);
    assert.equal(refreshes, 1);
    assert.equal(store.decrypt(store.user(user.id).credentials).refresh_token, 'long');
    store.saveCredentials(user.id, { refresh_token: 'long', expiry_date: 0 }, SCOPES.calendar);
    google.client = () => ({ setCredentials() {}, getTokenInfo: async () => ({ scopes: SCOPES.calendar }), refreshAccessToken: async () => { store.disconnect(user.id); return { credentials: { access_token: 'new', expiry_date: Date.now()+3600000 } }; } });
    await assert.rejects(google.access(store.user(user.id)), /reauthorization_required/);
    assert.equal(store.user(user.id).credentials, null);
  } finally { store.close(); }
});

test('invalid_grant oznacza tylko właściwe połączenie jako wymagające ponownej zgody', async () => {
  const store = new Store(':memory:', randomBytes(32));
  try {
    const a = store.login('a', 'a@example.org');
    const b = store.login('b', 'b@example.org');
    for (const user of [a, b]) store.saveCredentials(user.id, { refresh_token: 'long', expiry_date: 0 }, SCOPES.tasks);
    const google = new Google({}, store);
    google.client = () => ({ setCredentials() {}, refreshAccessToken: async () => { const error = Error(); error.response = { data: { error: 'invalid_grant' } }; throw error; } });
    await assert.rejects(google.access(store.user(a.id)), /reauthorization_required/);
    assert.equal(store.user(a.id).status, 'reauthorization_required');
    assert.equal(store.user(b.id).status, 'connected');
  } finally { store.close(); }
});
