import fs from 'node:fs';
import path from 'node:path';

// Only callers' fixed, explicitly selected fields are logged; never pass request data or errors.
export function createLogger(file, maxBytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
  return {
    write(event, details = {}) {
      const line = JSON.stringify({ time: new Date().toISOString(), event, ...details }) + '\n';
      try {
        const fd = fs.openSync(file, 'a', 0o600);
        let size;
        try { size = fs.fstatSync(fd).size; } finally { fs.closeSync(fd); }
        if (size && size + Buffer.byteLength(line) > maxBytes) {
          fs.renameSync(file, `${file}.1`);
        }
        fs.appendFileSync(file, line, { mode: 0o600 });
      } catch {
        // Do not include filesystem errors: their messages may disclose paths or other data.
        console.error('Nie można zapisać logu aplikacji.');
      }
    }
  };
}
