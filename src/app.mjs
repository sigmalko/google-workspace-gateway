import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { hash } from './store.mjs';
import { SCOPES } from './google.mjs';

const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eq = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); };
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
const fields = ['subscriptionId', 'sourceEventId', 'category', 'title', 'start', 'end', 'timeZone', 'venue', 'sourceUrl', 'verifiedAt'];
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function validTimestamp(value) {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validate(input, kind) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) return false;
  for (const k of ['subscriptionId', 'sourceEventId', 'title', 'start', 'timeZone']) if (!text(input[k], k === 'title' ? 256 : 2048)) return false;
  for (const k of ['category', 'venue', 'sourceUrl', 'verifiedAt']) if (input[k] !== undefined && !text(input[k], 2048)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }); } catch { return false; }
  if (!validTimestamp(input.start)) return false;
  if (input.verifiedAt !== undefined && !validTimestamp(input.verifiedAt)) return false;
  if (kind === 'calendar' && (!text(input.end, 64) || !validTimestamp(input.end) || !(Date.parse(input.end) > Date.parse(input.start)))) return false;
  if (input.end !== undefined && (!text(input.end, 64) || !validTimestamp(input.end) || !(Date.parse(input.end) > Date.parse(input.start)))) return false;
  if (input.sourceUrl !== undefined) { try { const url = new URL(input.sourceUrl); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; } }
  return true;
}
function page(title, body) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>body{font:16px system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;line-height:1.55;color:#172033}h1{font-size:1.8rem}section{border:1px solid #d8dfe8;border-radius:10px;padding:1rem;margin:1rem 0}button,select{font:inherit;padding:.55rem;margin:.25rem}button{cursor:pointer}small{color:#4b5563}form{margin:.5rem 0}.error{color:#9d2020}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}
function form(action, csrf, content) { return `<form method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrf)}">${content}</form>`; }
function path(config, value) { return `${config.mountPath || ''}${value === '/' ? '/' : value}`; }
function setCookie(res, config, value) {
  res.setHeader('Set-Cookie', `gateway_session=${value}; Path=${config.mountPath ? `${config.mountPath}/` : '/'}; HttpOnly; SameSite=Lax; Max-Age=86400${config.secureCookies ? '; Secure' : ''}`);
}
function csrf(req, res, next) {
  if (!req.session || !eq(req.body?.csrf, req.session.csrf)) return res.status(403).send(page('Błąd', '<p>Nieprawidłowa sesja formularza.</p>'));
  next();
}
function isLogged(config) { return (req, res, next) => { if (!req.session?.user_id) return res.redirect(path(config, '/')); next(); }; }
function serviceAuth(config) {
  return (req, res, next) => {
    const auth = req.get('authorization') || '';
    if (!auth.startsWith('Bearer ') || !eq(auth.slice(7), config.agentToken)) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
}
export function createApp({ config, store, google, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (config.mountPath && (req.path === config.mountPath || req.path.startsWith(`${config.mountPath}/`))) {
      req.url = req.url.slice(config.mountPath.length) || '/';
    }
    next();
  });
  app.use((req, res, next) => {
    const fixed = new Set(['/', '/healthz', '/login', '/oauth/google/callback', '/disconnect', '/logout', '/internal/v1/subscriptions', '/internal/v1/publications']);
    const match = /^\/(connect|targets|disable)\/(calendar|tasks)$/.exec(req.path);
    const route = fixed.has(req.path) ? req.path : match ? `/${match[1]}/:kind` : 'unknown';
    const method = ['GET', 'POST'].includes(req.method) ? req.method : 'OTHER';
    const started = Date.now();
    res.on('finish', () => logger?.write('http_request', { method, route, ...(match ? { kind: match[2] } : {}), ...(res.locals.logKind ? { kind: res.locals.logKind } : {}), status: res.statusCode, durationMs: Date.now() - started, ...(res.locals.logOutcome ? { outcome: res.locals.logOutcome } : {}) }));
    next();
  });
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'" });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 10 }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/internal/') || req.path === '/healthz') return next();
    store.cleanup();
    const raw = cookie(req, 'gateway_session');
    req.session = raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? store.session(raw) : null;
    if (!req.session) { req.session = store.createSession(); setCookie(res, config, req.session.raw); }
    if (req.session.user_id) {
      const user = store.user(req.session.user_id);
      if (!user || !config.allowed.includes(user.email.toLowerCase())) {
        store.db.prepare('DELETE FROM sessions WHERE id=?').run(req.session.id);
        req.session = store.createSession();
        setCookie(res, config, req.session.raw);
      }
    }
    next();
  });
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/', async (req, res) => {
    const user = req.session.user_id && store.user(req.session.user_id);
    if (!user) return res.send(page('Google Workspace Gateway', `<p>Połącz kalendarz lub listę zadań z monitorem wydarzeń.</p><p><a href="${path(config, '/login')}">Zaloguj się przez Google</a></p>`));
    const active = store.subscriptions(user.id);
    const scopes = JSON.parse(user.scopes);
    const last = store.db.prepare("SELECT MAX(p.completed_at) AS time FROM publications p JOIN subscriptions s ON s.id=p.subscription_id WHERE s.user_id=? AND p.status='created'").get(user.id).time;
    let content = `<p>Konto: ${esc(user.email)}. Stan połączenia: <strong>${esc(user.status)}</strong>.</p>`;
    if (last) content += `<p>Ostatni zapis: ${esc(new Date(last).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' }))} (Europe/Warsaw).</p>`;
    if (scopes.length) content += `<details><summary>Przyznane zakresy Google</summary><ul>${scopes.map(scope => `<li>${esc(scope)}</li>`).join('')}</ul></details>`;
    for (const kind of ['calendar', 'tasks']) {
      const label = kind === 'calendar' ? 'Google Calendar' : 'Google Tasks';
      const subscription = active.find(s => s.kind === kind);
      content += `<section><h2>${label}</h2><p>${subscription ? `Cel: ${esc(subscription.target_name)}. Publikacja włączona.` : 'Cel nie jest wybrany.'}</p>`;
      content += form(path(config, `/connect/${kind}`), req.session.csrf, `<button>Połącz lub przyznaj uprawnienia</button>`);
      if (user.status === 'connected' && SCOPES[kind].every(s => scopes.includes(s))) content += `<p><a href="${path(config, `/targets/${kind}`)}">Wybierz cel</a></p>`;
      if (subscription) content += form(path(config, `/disable/${kind}`), req.session.csrf, '<button>Wyłącz publikację</button>');
      content += '</section>';
    }
    content += `<p><small>Dostęp OAuth może obejmować więcej kalendarzy i zadań niż wybrany cel. Przed przyznaniem zgody zapoznaj się z zakresem uprawnień w Google.</small></p>`;
    content += form(path(config, '/disconnect'), req.session.csrf, '<button>Odłącz Google lokalnie</button>') + '<p><small>Aby cofnąć zgodę w Google, użyj <a href="https://myaccount.google.com/permissions">ustawień konta Google</a>. Lokalne odłączenie nie usuwa zdarzeń ani nie cofa zgody w Google.</small></p>';
    content += form(path(config, '/logout'), req.session.csrf, '<button>Wyloguj</button>');
    return res.send(page('Ustawienia połączenia', content));
  });
  app.get('/login', async (req, res) => res.redirect(await google.authorize(store, req.session, 'login')));
  app.post('/connect/:kind', isLogged(config), csrf, async (req, res) => {
    if (!['calendar', 'tasks'].includes(req.params.kind)) return res.sendStatus(404);
    res.redirect(await google.authorize(store, req.session, req.params.kind));
  });
  app.get('/oauth/google/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' && store.consumeState(req.query.state, req.session);
    if (!state || typeof req.query.code !== 'string' || req.query.error) return res.status(400).send(page('Nie udało się połączyć', `<p>Sesja wygasła, zgoda została odrzucona lub odpowiedź jest nieprawidłowa.</p><a href="${path(config, '/')}">Wróć</a>`));
    try {
      const result = await google.exchange(req.query.code, state);
      const email = result.identity.email.toLowerCase();
      if (!config.allowed.includes(email)) return res.status(403).send(page('Brak dostępu', '<p>Konto nie znajduje się na liście dozwolonych użytkowników.</p>'));
      if (state.purpose === 'login') {
        const user = store.login(result.identity.sub, email);
        const session = store.rotateSession(req.session, user.id);
        setCookie(res, config, session.raw);
        res.locals.logOutcome = 'login_completed';
        return res.redirect(path(config, '/'));
      }
      const user = store.user(req.session.user_id);
      if (!user || user.sub !== result.identity.sub || !SCOPES[state.purpose]?.every(s => result.scopes.includes(s))) return res.status(403).send(page('Brak dostępu', `<p>Wybrano inne konto lub nie przyznano wszystkich wymaganych uprawnień.</p><a href="${path(config, '/')}">Wróć</a>`));
      const previous = user.credentials && store.decrypt(user.credentials);
      const refresh = result.tokens.refresh_token || previous?.refresh_token;
      if (!refresh) return res.status(400).send(page('Brak dostępu offline', `<p>Nie otrzymano refresh tokenu. Spróbuj ponownie udzielić zgody.</p><a href="${path(config, '/')}">Wróć</a>`));
      store.saveCredentials(user.id, { refresh_token: refresh, access_token: result.tokens.access_token, expiry_date: result.tokens.expiry_date }, result.scopes);
      res.locals.logOutcome = `connected_${state.purpose}`;
      res.redirect(path(config, `/targets/${state.purpose}`));
    } catch { res.status(400).send(page('Nie udało się połączyć', `<p>Nie można zweryfikować odpowiedzi Google. Rozpocznij ponownie.</p><a href="${path(config, '/')}">Wróć</a>`)); }
  });
  app.get('/targets/:kind', isLogged(config), async (req, res) => {
    const kind = req.params.kind;
    if (!['calendar', 'tasks'].includes(kind)) return res.sendStatus(404);
    const user = store.user(req.session.user_id);
    if (user.status !== 'connected' || !SCOPES[kind].every(s => JSON.parse(user.scopes).includes(s))) return res.status(403).send(page('Brak uprawnień', `<a href="${path(config, '/')}">Wróć</a>`));
    try {
      const targets = await google.targets(user, kind);
      if (!targets.length) return res.send(page('Wybór celu', `<p>Nie znaleziono dostępnych celów.</p><a href="${path(config, '/')}">Wróć</a>`));
      const options = targets.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
      res.send(page('Wybór celu', form(path(config, `/targets/${kind}`), req.session.csrf, `<label>Cel <select name="target">${options}</select></label><button>Zapisz i włącz</button>`) + `<a href="${path(config, '/')}">Wróć</a>`));
    } catch { res.status(503).send(page('Błąd Google', `<p>Nie można pobrać listy. Sprawdź połączenie lub połącz konto ponownie.</p><a href="${path(config, '/')}">Wróć</a>`)); }
  });
  app.post('/targets/:kind', isLogged(config), csrf, async (req, res) => {
    const kind = req.params.kind;
    if (!['calendar', 'tasks'].includes(kind) || !text(req.body.target, 2048)) return res.sendStatus(400);
    const user = store.user(req.session.user_id);
    if (user.status !== 'connected' || !SCOPES[kind].every(s => JSON.parse(user.scopes).includes(s))) return res.sendStatus(403);
    try {
      const target = (await google.targets(user, kind)).find(t => t.id === req.body.target);
      if (!target) return res.sendStatus(403);
      store.setTarget(user.id, kind, target.id, target.name);
      res.redirect(path(config, '/'));
    } catch { res.status(503).send(page('Błąd Google', `<a href="${path(config, '/')}">Wróć</a>`)); }
  });
  app.post('/disable/:kind', isLogged(config), csrf, (req, res) => { if (!['calendar', 'tasks'].includes(req.params.kind)) return res.sendStatus(404); store.disableTarget(req.session.user_id, req.params.kind); res.redirect(path(config, '/')); });
  app.post('/disconnect', isLogged(config), csrf, (req, res) => { store.disconnect(req.session.user_id); res.redirect(path(config, '/')); });
  app.post('/logout', csrf, (req, res) => { store.db.prepare('DELETE FROM sessions WHERE id=?').run(req.session.id); setCookie(res, config, ''); res.redirect(path(config, '/')); });
  app.use('/internal/v1', serviceAuth(config));
  app.get('/internal/v1/subscriptions', (req, res) => res.json({ subscriptions: store.activeSubscriptions(config.allowed) }));
  app.post('/internal/v1/publications', async (req, res) => {
    const reply = (status, result) => { res.locals.logOutcome = result.status || result.error; return res.status(status).json(result); };
    const key = req.get('idempotency-key');
    const event = req.body;
    if (!text(key, 200) || !event || typeof event.subscriptionId !== 'string') return reply(400, { error: 'invalid_request' });
    const subscription = store.subscription(event.subscriptionId);
    if (!subscription || !subscription.enabled) return reply(404, { error: 'subscription_not_found' });
    if (['calendar', 'tasks'].includes(subscription.kind)) res.locals.logKind = subscription.kind;
    if (!validate(event, subscription.kind)) return reply(400, { error: 'invalid_event' });
    const user = store.user(subscription.user_id);
    if (!user || !config.allowed.includes(user.email.toLowerCase())) return reply(404, { error: 'subscription_not_found' });
    if (user.status !== 'connected' || !SCOPES[subscription.kind].every(s => JSON.parse(user.scopes).includes(s))) return reply(409, { error: 'reauthorization_required' });
    try { await google.access(user); } catch (error) {
      if (error.message === 'reauthorization_required') return reply(409, { error: 'reauthorization_required' });
      return reply(503, { error: 'google_unavailable' });
    }
    const current = store.subscription(subscription.id);
    const currentUser = store.user(subscription.user_id);
    if (!current || !current.enabled || currentUser?.status !== 'connected') return reply(409, { error: 'subscription_unavailable' });
    if (!SCOPES[subscription.kind].every(s => JSON.parse(currentUser.scopes).includes(s))) return reply(409, { error: 'reauthorization_required' });
    const payloadHash = hash(JSON.stringify(fields.map(f => event[f] ?? null)));
    const existing = store.publication(subscription.id, key);
    if (existing) {
      if (existing.payload_hash !== payloadHash) return reply(409, { error: 'idempotency_conflict' });
      if (existing.status === 'created') return reply(200, { status: 'already_exists', id: existing.google_id });
      return reply(409, { status: 'uncertain', message: 'Sprawdź wpis w Google przed kolejną próbą.' });
    }
    if (store.publicationSource(subscription.id, event.sourceEventId)) return reply(409, { error: 'source_already_recorded' });
    store.reserve(subscription.id, key, event.sourceEventId, payloadHash);
    const id = createHash('sha256').update(`${subscription.id}\0${event.sourceEventId}`).digest('hex');
    try {
      const result = await google.publish(user, subscription, event, id);
      if (!result.id) throw Error('missing_id');
      store.complete(subscription.id, key, result.id);
      reply(201, { status: 'created', id: result.id });
    } catch {
      store.uncertain(subscription.id, key);
      reply(409, { status: 'uncertain', message: 'Sprawdź wpis w Google przed kolejną próbą.' });
    }
  });
  app.use((err, req, res, next) => { if (res.headersSent) return next(err); res.status(err.status === 413 ? 413 : 500).json({ error: 'request_failed' }); });
  return app;
}
