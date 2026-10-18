import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Google } from './google.mjs';
import { createApp } from './app.mjs';

process.umask(0o077);
const config = readConfig();
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
const store = new Store(config.dbPath, config.encryptionKey);
try { fs.chmodSync(config.dbPath, 0o600); } catch { throw Error('Nie można zabezpieczyć pliku bazy.'); }
const google = new Google(config, store);
createApp({ config, store, google }).listen(config.port, '0.0.0.0', () => console.log(`Gateway działa na porcie ${config.port}.`));
