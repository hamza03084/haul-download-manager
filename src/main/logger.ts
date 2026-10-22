import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './engine/manager';
import { redactText } from './engine/urls';

const MAX_LOG_BYTES = 1024 * 1024;

/** Small rotating file logger. All messages pass through URL redaction before being written. */
export function createFileLogger(dir: string): Logger {
  const file = path.join(dir, 'haul.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, path.join(dir, 'haul.old.log'));
    }
  } catch {
    /* logging is best-effort */
  }
  const write = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} ${level} ${redactText(msg)}\n`;
    fs.appendFile(file, line, () => {});
  };
  return {
    info: (m) => write('INFO ', m),
    warn: (m) => write('WARN ', m),
    error: (m) => write('ERROR', m),
  };
}
