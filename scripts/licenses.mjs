// Writes THIRD_PARTY_LICENSES.txt with the license text of every third-party package that is
// shipped inside the built app. Development-only tools (TypeScript, Vite, electron-builder,
// Playwright) are not distributed and are therefore not listed.
// Chromium/Electron component licenses are shipped by Electron itself as LICENSES.chromium.html.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = [
  'electron',
  'react',
  'react-dom',
  'scheduler',
  '@fontsource-variable/bricolage-grotesque',
  '@fontsource-variable/instrument-sans',
  '@fontsource-variable/jetbrains-mono',
];

let out = `Third-party software included in Haul Download Manager
=======================================================

Haul Download Manager itself is licensed under the MIT License (see LICENSE).
It bundles the following third-party components. Licenses of the Chromium and
Node.js components inside the Electron runtime are in LICENSES.chromium.html
next to the installed executable.
`;
for (const name of SHIPPED) {
  const dir = path.join(root, 'node_modules', name);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  if (!licFile) throw new Error(`No license file found for ${name}`);
  const text = readFileSync(path.join(dir, licFile), 'utf8').trim();
  const homepage = pkg.homepage ?? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? '';
  out += `\n\n------------------------------------------------------------------------\n${pkg.name} ${pkg.version}  (${pkg.license})\n${homepage}\n------------------------------------------------------------------------\n\n${text}\n`;
}
writeFileSync(path.join(root, 'THIRD_PARTY_LICENSES.txt'), out.replace(/\r\n/g, '\n'));
console.log(`THIRD_PARTY_LICENSES.txt written (${SHIPPED.length} packages)`);
