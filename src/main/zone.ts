import * as fsp from 'node:fs/promises';
import type { Logger } from './engine/manager';
import { redactUrl } from './engine/urls';

/**
 * Adds the Windows "Mark of the Web" (Zone.Identifier alternate data stream) to a downloaded file,
 * as browsers do, so SmartScreen and Office Protected View treat it as coming from the internet.
 * Best effort: silently skipped on non-NTFS volumes (FAT32/exFAT) and other platforms.
 */
export async function markFromInternet(file: string, sourceUrl: string, log: Logger): Promise<void> {
  if (process.platform !== 'win32') return;
  const content = `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${redactUrl(sourceUrl).replace(/\?.*$/, '')}\r\n`;
  try {
    await fsp.writeFile(`${file}:Zone.Identifier`, content);
  } catch (e) {
    log.info(`could not write Zone.Identifier (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}
