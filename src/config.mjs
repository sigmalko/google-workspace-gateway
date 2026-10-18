import fs from 'node:fs';
import { isIP } from 'node:net';

function secret(env, name) {
  if (!env[`${name}_FILE`]) throw Error(`Ustaw ${name}_FILE.`);
  return fs.readFileSync(env[`${name}_FILE`], 'utf8').trim();
}
export function readConfig(env = process.env) {
  let redirect;
  try { redirect = new URL(env.OAUTH_REDIRECT_URL || ''); } catch { throw Error('Ustaw OAUTH_REDIRECT_URL.'); }
  const callbackPath = '/oauth/google/callback';
  if (redirect.username || redirect.password || redirect.search || redirect.hash || !redirect.pathname.endsWith(callbackPath) ||
      (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(redirect.hostname)))) {
    throw Error('OAUTH_REDIRECT_URL musi być HTTPS i kończyć się /oauth/google/callback (HTTP tylko lokalnie).');
  }
  if (isIP(redirect.hostname) && redirect.hostname !== '127.0.0.1') throw Error('Publiczny OAUTH_REDIRECT_URL wymaga domeny.');
  const mountPath = redirect.pathname.slice(0, -callbackPath.length).replace(/\/$/, '');
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
  const logMaxBytes = Number(env.LOG_MAX_BYTES || 10485760);
  if (!Number.isSafeInteger(logMaxBytes) || logMaxBytes < 1024 || logMaxBytes > 1073741824) throw Error('LOG_MAX_BYTES musi wynosić od 1024 do 1073741824.');
  return { redirectUrl: redirect.toString(), secureCookies: redirect.protocol === 'https:', mountPath, clientId, clientSecret, encryptionKey: key, agentToken: apiToken, allowed, port, dbPath: env.DB_PATH || './data/gateway.sqlite', logFile: env.LOG_FILE || './data/gateway.log', logMaxBytes };
}
