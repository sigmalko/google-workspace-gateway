import { createHash } from 'node:crypto';
import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { Google } from './google.mjs';

const [subscriptionId, key, action, id, ...extra] = process.argv.slice(2);
if (!subscriptionId || !key || extra.length || !['--inspect', '--created', '--retry'].includes(action) || (action === '--created' && !id) || (action !== '--created' && id)) {
  console.error('Użycie: node src/resolve.mjs SUBSCRIPTION_ID IDEMPOTENCY_KEY --inspect | --created GOOGLE_ID | --retry');
  process.exit(2);
}
const config = readConfig();
const store = new Store(config.dbPath, config.encryptionKey);
try {
  const existing = store.publication(subscriptionId, key);
  if (!existing || !['pending', 'uncertain'].includes(existing.status)) throw Error('Brak niepewnej operacji.');
  if (action === '--created') {
    store.complete(subscriptionId, key, id);
    console.log('Zapisano istniejący rekord.');
  } else if (action === '--retry') {
    store.db.prepare("DELETE FROM publications WHERE subscription_id=? AND idempotency_key=? AND status IN ('pending','uncertain')").run(subscriptionId, key);
    console.log('Operację można ponowić.');
  } else {
    const subscription = store.subscription(subscriptionId);
    const user = store.user(subscription.user_id);
    const google = new Google(config, store);
    const marker = createHash('sha256').update(`${subscriptionId}\0${existing.source_id}`).digest('hex');
    const ids = [];
    if (subscription.kind === 'calendar') {
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(subscription.target_id)}/events/${marker}`;
      try {
        const event = await google.request(user, url);
        if (event.status !== 'cancelled' && event.extendedProperties?.private?.gatewaySourceHash === marker) ids.push(event.id);
      } catch (error) { if (error.status !== 404 && error.status !== 410) throw error; }
    } else {
      let next;
      let pages = 0;
      do {
        if (++pages > 1000) throw Error('Zbyt wiele stron wyników.');
        const url = new URL(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(subscription.target_id)}/tasks`);
        url.searchParams.set('showHidden', 'true');
        url.searchParams.set('showCompleted', 'true');
        url.searchParams.set('maxResults', '100');
        if (next) url.searchParams.set('pageToken', next);
        const page = await google.request(user, url);
        for (const item of page.items || []) if (!item.deleted && item.notes?.split('\n').includes(`Identyfikator: ${marker}`)) ids.push(item.id);
        next = page.nextPageToken;
      } while (next);
    }
    console.log(JSON.stringify({ candidates: ids, note: 'Brak wyniku nie dowodzi, że zapis się nie powiódł. Sprawdź Google przed zmianą stanu.' }));
  }
} finally { store.close(); }
