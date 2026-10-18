import fs from 'node:fs';
import { isIP } from 'node:net';

function secret(env, name) {
  if (!env[`${name}_FILE`]) throw Error(`Ustaw ${name}_FILE.`);
  return fs.readFileSync(env[`${name}_FILE`], 'utf8').trim();
}
export function readConfig(env = process.env) {
  const base = new URL(env.BASE_URL || '');
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))) {
    throw Error('BASE_URL musi być adresem HTTPS domeny bez ścieżki (HTTP tylko lokalnie).');
  }
  if (isIP(base.hostname) && base.hostname !== '127.0.0.1') throw Error('Publiczny BASE_URL wymaga domeny.');
  const allowed = (env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || allowed.some(s => !/^[^\s@]+@[^\s@]+$/.test(s))) throw Error('Ustaw ALLOWED_EMAILS.');
  const key = Buffer.from(secret(env, 'ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw Error('ENCRYPTION_KEY_FILE musi zawierać 32 bajty w base64.');
  const apiToken = secret(env, 'AGENT_TOKEN');
  if (apiToken.length < 32) throw Error('Token agenta musi mieć co najmniej 32 znaki.');
  const clientSecret = secret(env, 'GOOGLE_CLIENT_SECRET');
  if (!clientSecret) throw Error('Sekret klienta Google jest pusty.');
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) throw Error('Ustaw GOOGLE_CLIENT_ID.');
  const port = Number(env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Niepoprawny PORT.');
  return { baseUrl: base.origin, clientId, clientSecret, encryptionKey: key, agentToken: apiToken, allowed, port, dbPath: env.DB_PATH || './data/gateway.sqlite' };
}
