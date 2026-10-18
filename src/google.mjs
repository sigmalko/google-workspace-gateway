import { OAuth2Client } from 'google-auth-library';

export const SCOPES = {
  calendar: ['https://www.googleapis.com/auth/calendar.events.owned', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
  tasks: ['https://www.googleapis.com/auth/tasks']
};
export class Google {
  constructor(config, store) { this.config = config; this.store = store; this.refreshing = new Map(); }
  client() { return new OAuth2Client(this.config.clientId, this.config.clientSecret, this.config.redirectUrl); }
  async authorize(store, session, purpose) {
    const client = this.client();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const nonce = crypto.randomUUID();
    const state = store.oauthState(session, purpose, codeVerifier, nonce);
    const scope = purpose === 'login' ? ['openid', 'email'] : ['openid', 'email', ...SCOPES[purpose]];
    return client.generateAuthUrl({ scope, state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256', access_type: purpose === 'login' ? 'online' : 'offline', include_granted_scopes: purpose !== 'login', ...(purpose === 'login' ? { prompt: 'select_account' } : { prompt: 'consent' }) });
  }
  async exchange(code, state) {
    const client = this.client();
    const { tokens } = await client.getToken({ code, codeVerifier: state.verifier });
    if (!tokens.id_token || !tokens.access_token) throw Error('Brak tokenu tożsamości lub dostępu.');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.clientId });
    const identity = ticket.getPayload();
    if (!identity || identity.nonce !== state.nonce || !identity.sub || !identity.email || !identity.email_verified) throw Error('Nieprawidłowa tożsamość.');
    const info = await client.getTokenInfo(tokens.access_token);
    return { identity, tokens, scopes: info.scopes };
  }
  async access(user) {
    if (!user || user.status !== 'connected' || !user.credentials) throw new Error('reauthorization_required');
    if (this.refreshing.has(user.id)) return this.refreshing.get(user.id);
    const promise = this.refresh(user);
    this.refreshing.set(user.id, promise);
    try { return await promise; } finally { this.refreshing.delete(user.id); }
  }
  async refresh(user) {
    const current = this.store.user(user.id);
    if (!current || current.status !== 'connected' || !current.credentials) throw new Error('reauthorization_required');
    const credentials = this.store.decrypt(current.credentials);
    if (credentials.access_token && credentials.expiry_date > Date.now() + 300000) return credentials.access_token;
    const client = this.client();
    client.setCredentials({ refresh_token: credentials.refresh_token });
    try {
      const result = await client.refreshAccessToken();
      const next = { ...credentials, ...result.credentials, refresh_token: result.credentials.refresh_token || credentials.refresh_token };
      if (!next.access_token) throw new Error('google_unavailable');
      const scopeInfo = await client.getTokenInfo(next.access_token);
      const update = this.store.db.prepare("UPDATE users SET credentials=?, scopes=? WHERE id=? AND credentials=? AND status='connected'").run(this.store.encrypt(next), JSON.stringify(scopeInfo.scopes), user.id, current.credentials);
      if (update.changes !== 1) throw new Error('reauthorization_required');
      return next.access_token;
    } catch (error) {
      if (error.response?.data?.error === 'invalid_grant') {
        this.store.db.prepare("UPDATE users SET status='reauthorization_required' WHERE id=? AND credentials=? AND status='connected'").run(user.id, current.credentials);
        throw new Error('reauthorization_required');
      }
      if (error.message === 'reauthorization_required') throw error;
      throw new Error('google_unavailable');
    }
  }
  async request(user, url, options = {}) {
    const token = await this.access(user);
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (!response.ok) {
      const error = new Error('google_api_error');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  async targets(user, kind) {
    const all = [];
    let pageToken;
    let pages = 0;
    do {
      if (++pages > 100) throw Error('Zbyt wiele stron.');
      const base = kind === 'calendar' ? 'https://www.googleapis.com/calendar/v3/users/me/calendarList' : 'https://tasks.googleapis.com/tasks/v1/users/@me/lists';
      const url = new URL(base);
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const result = await this.request(user, url);
      for (const item of result.items || []) {
        if (kind === 'calendar' && item.accessRole !== 'owner') continue;
        all.push({ id: item.id, name: kind === 'calendar' ? item.summary : item.title });
      }
      pageToken = result.nextPageToken;
      if (all.length > 10000) throw Error('Za dużo celów.');
    } while (pageToken);
    return all;
  }
  async publish(user, subscription, event, id) {
    const details = [['Źródło', event.sourceUrl], ['Sprawdzono', event.verifiedAt], ['Kategoria', event.category]].filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n');
    if (subscription.kind === 'calendar') {
      const body = { id, extendedProperties: { private: { gatewaySourceHash: id } }, summary: event.title, location: event.venue, description: details, start: { dateTime: event.start, timeZone: event.timeZone }, end: { dateTime: event.end, timeZone: event.timeZone } };
      return this.request(user, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(subscription.target_id)}/events`, { method: 'POST', body: JSON.stringify(body) });
    }
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: event.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(event.start));
    const part = key => parts.find(p => p.type === key).value;
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    const body = { title: event.title, due: `${date}T00:00:00.000Z`, notes: [`Godzina: ${event.start} (${event.timeZone})`, event.venue && `Miejsce: ${event.venue}`, details, `Identyfikator: ${id}`].filter(Boolean).join('\n') };
    return this.request(user, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(subscription.target_id)}/tasks`, { method: 'POST', body: JSON.stringify(body) });
  }
}
