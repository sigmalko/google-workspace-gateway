import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Google } from './google.mjs';
import { createApp } from './app.mjs';
import { createLogger } from './log.mjs';

process.umask(0o077);
const config = readConfig();
const logger = createLogger(config.logFile, config.logMaxBytes);
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
const store = new Store(config.dbPath, config.encryptionKey);
try { fs.chmodSync(config.dbPath, 0o600); } catch { throw Error('Nie można zabezpieczyć pliku bazy.'); }
const google = new Google(config, store, logger);
const server = createApp({ config, store, google, logger }).listen(config.port, '0.0.0.0', () => {
  logger.write('server_started', { port: config.port });
  console.log(`Gateway działa na porcie ${config.port}.`);
});
server.on('error', () => { logger.write('server_error'); console.error('Błąd serwera HTTP.'); process.exitCode = 1; });
