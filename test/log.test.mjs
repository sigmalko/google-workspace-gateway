import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/log.mjs';

test('log zapisuje JSONL i rotuje plik po osiągnięciu limitu', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-log-'));
  try {
    const file = path.join(dir, 'logs', 'gateway.log');
    const logger = createLogger(file, 120);
    logger.write('first');
    logger.write('second');
    logger.write('third');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(`${file}.1`));
    const current = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const previous = fs.readFileSync(`${file}.1`, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual([...previous, ...current].map(record => record.event), ['first', 'second', 'third']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
