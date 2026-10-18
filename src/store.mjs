import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

export const hash = (s) => createHash('sha256').update(s).digest('hex');
export const random = () => randomBytes(32).toString('base64url');

export class Store {
  constructor(file, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('Klucz szyfrowania musi mieć 32 bajty.');
    this.key = key;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, email TEXT NOT NULL, credentials TEXT, scopes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'disconnected');
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, purpose TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, target_id TEXT NOT NULL, target_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, UNIQUE(user_id,kind,target_id));
      CREATE TABLE IF NOT EXISTS publications (subscription_id TEXT NOT NULL REFERENCES subscriptions(id), idempotency_key TEXT NOT NULL, source_id TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, google_id TEXT, completed_at INTEGER, PRIMARY KEY(subscription_id,idempotency_key), UNIQUE(subscription_id,source_id));`);
  }
  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
  }
  decrypt(value) {
    const parts = value.split('.').map(s => Buffer.from(s, 'base64url'));
    if (parts.length !== 3) throw Error('Niepoprawny format danych.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, parts[0]);
    decipher.setAuthTag(parts[1]);
    return JSON.parse(Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8'));
  }
  session(raw) {
    const row = raw && this.db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(raw), Date.now());
    return row || null;
  }
  createSession() {
    const raw = random();
    const csrf = random();
    this.db.prepare('INSERT INTO sessions VALUES(?,?,NULL,?)').run(hash(raw), csrf, Date.now() + 86400000);
    return { raw, csrf, id: hash(raw), user_id: null };
  }
  rotateSession(session, userId) {
    const fresh = this.createSession();
    this.db.prepare('UPDATE sessions SET user_id=? WHERE id=?').run(userId, fresh.id);
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
    return { ...fresh, user_id: userId };
  }
  cleanup() {
    this.db.prepare('DELETE FROM oauth_states WHERE expires < ?').run(Date.now());
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }
  oauthState(session, purpose, verifier, nonce) {
    const state = random();
    this.db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?,?,?)').run(hash(state), session.id, purpose, this.encrypt(verifier), nonce, Date.now() + 600000);
    return state;
  }
  consumeState(state, session) {
    const id = hash(state);
    const row = this.db.prepare('DELETE FROM oauth_states WHERE state=? AND session_id=? RETURNING *').get(id, session.id);
    if (!row || row.session_id !== session.id || row.expires < Date.now()) return null;
    return { ...row, verifier: this.decrypt(row.verifier) };
  }
  user(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  login(sub, email) {
    this.db.prepare('INSERT INTO users(id,sub,email) VALUES(?,?,?) ON CONFLICT(sub) DO UPDATE SET email=excluded.email').run(randomUUID(), sub, email);
    return this.db.prepare('SELECT * FROM users WHERE sub=?').get(sub);
  }
  saveCredentials(id, credentials, scopes) {
    this.db.prepare('UPDATE users SET credentials=?, scopes=?, status=? WHERE id=?').run(this.encrypt(credentials), JSON.stringify(scopes), 'connected', id);
  }
  disconnect(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE users SET credentials=NULL, scopes='[]', status='disconnected' WHERE id=?").run(id);
      this.db.prepare('UPDATE subscriptions SET enabled=0 WHERE user_id=?').run(id);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  setTarget(userId, kind, targetId, name) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE subscriptions SET enabled=0 WHERE user_id=? AND kind=?').run(userId, kind);
      this.db.prepare(`INSERT INTO subscriptions(id,user_id,kind,target_id,target_name,enabled) VALUES(?,?,?,?,?,1)
        ON CONFLICT(user_id,kind,target_id) DO UPDATE SET target_name=excluded.target_name,enabled=1`).run(randomUUID(), userId, kind, targetId, name);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  disableTarget(userId, kind) { this.db.prepare('UPDATE subscriptions SET enabled=0 WHERE user_id=? AND kind=?').run(userId, kind); }
  subscriptions(userId) { return this.db.prepare('SELECT * FROM subscriptions WHERE user_id=? AND enabled=1 ORDER BY kind').all(userId); }
  activeSubscriptions(allowed) { return this.db.prepare("SELECT s.id,s.kind,u.email FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.enabled=1 AND u.status='connected' ORDER BY s.id").all().filter(s => allowed.includes(s.email.toLowerCase())).map(({ id, kind }) => ({ id, kind })); }
  subscription(id) { return this.db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id); }
  publication(subscription, key) { return this.db.prepare('SELECT * FROM publications WHERE subscription_id=? AND idempotency_key=?').get(subscription, key); }
  publicationSource(subscription, source) { return this.db.prepare('SELECT * FROM publications WHERE subscription_id=? AND source_id=?').get(subscription, source); }
  reserve(subscription, key, source, payloadHash) {
    this.db.prepare("INSERT INTO publications(subscription_id,idempotency_key,source_id,payload_hash,status) VALUES(?,?,?,?,'pending')").run(subscription, key, source, payloadHash);
  }
  complete(subscription, key, googleId) { this.db.prepare("UPDATE publications SET status='created',google_id=?,completed_at=? WHERE subscription_id=? AND idempotency_key=?").run(googleId, Date.now(), subscription, key); }
  uncertain(subscription, key) { this.db.prepare("UPDATE publications SET status='uncertain' WHERE subscription_id=? AND idempotency_key=? AND status='pending'").run(subscription, key); }
  close() { this.db.close(); }
}
