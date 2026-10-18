import test from 'node:test';
import assert from 'node:assert/strict';
import { Google } from '../src/google.mjs';

test('mapowanie Calendar i daty Tasks uwzględnia strefę czasową', async () => {
  const google = new Google({}, {});
  const requests = [];
  google.request = async (user, url, opts) => { requests.push({ url, body: JSON.parse(opts.body) }); return { id: 'x' }; };
  const event = { title: 'Wydarzenie', start: '2027-03-28T23:30:00Z', end: '2027-03-29T01:00:00Z', timeZone: 'Europe/Warsaw', venue: 'Kraków', sourceUrl: 'https://example.org', verifiedAt: '2027-01-10T12:00:00Z' };
  await google.publish({}, { kind: 'tasks', target_id: 'list' }, event, 'marker');
  assert.equal(requests[0].body.due, '2027-03-29T00:00:00.000Z');
  assert.ok(requests[0].body.notes.includes('Identyfikator: marker'));
  await google.publish({}, { kind: 'calendar', target_id: 'calendar' }, event, 'abc123');
  assert.equal(requests[1].body.extendedProperties.private.gatewaySourceHash, 'abc123');
  assert.equal(requests[1].body.start.timeZone, 'Europe/Warsaw');
});
