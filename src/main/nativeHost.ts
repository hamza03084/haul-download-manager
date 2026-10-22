// Native messaging host for the browser extension. The browser starts the host program with a
// "chrome-extension://…" argument and talks to it over stdin/stdout (a 4-byte little-endian length
// followed by JSON, both ways). Electron cannot be that program on Windows: its main process writes
// a newline to stdout at startup, which breaks the framing. So the host is a small PowerShell script
// (started through a .cmd file, as browsers allow) that Haul writes next to its data. It reads one
// request, hands it to Haul as a `haul://add` link (the running Haul receives it through the
// single-instance lock; otherwise Haul starts with it) and replies. No Electron imports: the files
// and the registration are tested under plain Node, and so is the script itself.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The host's name (the extension's `sendNativeMessage` target). */
export const NATIVE_HOST_NAME = 'io.github.hauldm.app';
/** ID of the browser extension (fixed by the `key` in its manifest), the only origin allowed to talk to the host. */
export const EXTENSION_ID = 'efjlehoamakeikoojdajegfkplohgjca';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
const MAX_MESSAGE = 1024 * 1024;

/** Registry keys (under HKCU) that each Chromium-based browser reads native messaging hosts from. */
export const NATIVE_HOST_REGISTRY_KEYS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
];

export function encodeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Reads one framed message from a stream (what the browser does with the host's reply). */
export function readMessage(input: NodeJS.ReadableStream, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let have = 0;
    let need: number | null = null;
    const timer = setTimeout(() => fail(new Error('No message within the time limit.')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', fail);
    };
    const fail = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      have += chunk.length;
      if (need === null && have >= 4) {
        need = Buffer.concat(chunks).readUInt32LE(0);
        if (need > MAX_MESSAGE) return fail(new Error('Message is too large.'));
      }
      if (need !== null && have >= 4 + need) {
        cleanup();
        const all = Buffer.concat(chunks);
        try {
          resolve(JSON.parse(all.subarray(4, 4 + need).toString('utf8')));
        } catch {
          reject(new Error('Message is not valid JSON.'));
        }
      }
    };
    const onEnd = () => fail(new Error('The connection closed before a message arrived.'));
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', fail);
  });
}

// ------------------------------------------------------------------ the host program

export interface HostCommand {
  /** The program that is Haul: the packaged exe, or electron.exe when running from source. */
  exe: string;
  /** Leading arguments (the app folder when running from source). */
  args?: string[];
  /** Environment for the Haul that the host starts (tests: an isolated profile). */
  env?: Record<string, string>;
  /** Haul's version, reported to the extension's "ping". */
  version: string;
}

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: 'stdio';
  allowed_origins: string[];
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The script that is the host. `$args[0]` is the extension origin the browser passes. It reads one
 * message, checks it strictly (only http(s) links, short strings, known fields), starts Haul with the
 * equivalent `haul://add` link and answers. Everything the message contains ends up only in that link.
 */
function hostScript(c: HostCommand): string {
  const envLines = Object.entries(c.env ?? {}).map(([k, v]) => `$env:${k} = ${psQuote(v)}`);
  const leading = (c.args ?? []).map(psQuote).join(', ');
  return `# Haul Download Manager: native messaging host for the browser extension (written by Haul; do not edit).
$ErrorActionPreference = 'Stop'
$HaulExe = ${psQuote(c.exe)}
$Leading = @(${leading})
$Version = ${psQuote(c.version)}
$AllowedOrigin = ${psQuote(EXTENSION_ORIGIN)}
${envLines.join('\n')}
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
function Read-Exact([int]$n) {
  $buf = New-Object byte[] $n
  $off = 0
  while ($off -lt $n) {
    $r = $stdin.Read($buf, $off, $n - $off)
    if ($r -le 0) { throw 'The browser closed the connection before sending a message.' }
    $off += $r
  }
  return ,$buf
}
function Send-Reply($obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
  $stdout.Write([BitConverter]::GetBytes([uint32]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
try {
  # (PowerShell variable names are case-insensitive: keep these two names distinct.)
  $callerOrigin = if ($args.Count -gt 0) { [string]$args[0] } else { '' }
  if ($callerOrigin -ne $AllowedOrigin -and $callerOrigin -ne $AllowedOrigin.TrimEnd('/')) { throw 'This browser extension is not allowed to use Haul.' }
  $len = [BitConverter]::ToUInt32((Read-Exact 4), 0)
  if ($len -gt 1048576) { throw 'Message from the browser is too large.' }
  $msg = [Text.Encoding]::UTF8.GetString((Read-Exact $len)) | ConvertFrom-Json
  if ($msg.type -eq 'ping') { Send-Reply @{ ok = $true; version = $Version }; exit 0 }
  if ($msg.type -ne 'add') { throw 'Unknown request from the browser extension.' }
  $url = [string]$msg.url
  if ($url -notmatch '^https?://[^/\\s]' -or $url.Length -gt 8192) { throw 'Only http and https links can be downloaded.' }
  $link = 'haul://add?url=' + [Uri]::EscapeDataString($url)
  $name = ([string]$msg.fileName).Trim()
  if ($name) { $link += '&name=' + [Uri]::EscapeDataString($name.Substring(0, [Math]::Min(255, $name.Length))) }
  $ref = [string]$msg.referrer
  if ($ref -match '^https?://[^/\\s]' -and $ref.Length -le 2048) { $link += '&referrer=' + [Uri]::EscapeDataString($ref) }
  if ($msg.auto -eq $true) { $link += '&auto=1' }
  # Is Haul running? (Running from source, Haul is electron.exe with the app folder on its command line.)
  $exeName = [IO.Path]::GetFileName($HaulExe)
  $procs = @(Get-CimInstance Win32_Process -Filter ("Name = '" + ($exeName -replace "'", "''") + "'") -ErrorAction SilentlyContinue)
  $running = @($procs | Where-Object { $_.ExecutablePath -eq $HaulExe -and ($Leading.Count -eq 0 -or $_.CommandLine -like ('*' + $Leading[0] + '*')) }).Count -gt 0
  # A running Haul receives the link through its single-instance lock and this new process exits;
  # otherwise this process becomes Haul. Either way the browser's pipes are not passed on.
  $argList = @($Leading + $link) | ForEach-Object { '"' + ($_ -replace '"', '\\"') + '"' }
  Start-Process -FilePath $HaulExe -ArgumentList $argList | Out-Null
  Send-Reply @{ ok = $true; delivered = $(if ($running) { 'running' } else { 'started' }); version = $Version }
} catch {
  Send-Reply @{ ok = $false; error = [string]$_.Exception.Message }
  exit 1
}
`;
}

/**
 * Writes the host (a .cmd that runs the PowerShell script) and the manifest browsers read. Returns
 * the manifest's path (what the registry points at) and the host's path.
 */
export function writeHostManifest(dir: string, command: HostCommand): { manifest: string; path: string; script: string } {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${NATIVE_HOST_NAME}.ps1`);
  fs.writeFileSync(script, hostScript(command).replace(/\n/g, '\r\n'), 'utf8');
  const hostPath = path.join(dir, `${NATIVE_HOST_NAME}.cmd`);
  // -ExecutionPolicy Bypass applies to this invocation only; the origin argument is passed through (%*).
  fs.writeFileSync(
    hostPath,
    `@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -NoLogo -ExecutionPolicy Bypass -File "${script}" %*\r\n`,
  );
  const manifest: HostManifest = {
    name: NATIVE_HOST_NAME,
    description: 'Haul Download Manager: receives downloads from the browser extension.',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [EXTENSION_ORIGIN],
  };
  const file = path.join(dir, `${NATIVE_HOST_NAME}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return { manifest: file, path: hostPath, script };
}

// ------------------------------------------------------------------ registration

/** Points every supported browser's registry key at the manifest (per user, no administrator rights). */
export async function registerHostInRegistry(manifestFile: string, keys = NATIVE_HOST_REGISTRY_KEYS): Promise<string[]> {
  const problems: string[] = [];
  for (const key of keys) {
    try {
      await reg(['add', `${key}\\${NATIVE_HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestFile, '/f']);
    } catch (e) {
      problems.push(`${key}: ${(e as Error).message}`);
    }
  }
  return problems;
}

export async function unregisterHostFromRegistry(keys = NATIVE_HOST_REGISTRY_KEYS): Promise<void> {
  for (const key of keys) await reg(['delete', `${key}\\${NATIVE_HOST_NAME}`, '/f']).catch(() => {});
}

/** What a browser would find for the host under `key`, or null. */
export async function readHostRegistration(key: string): Promise<string | null> {
  try {
    const out = await reg(['query', `${key}\\${NATIVE_HOST_NAME}`, '/ve']);
    const m = /REG_SZ\s+(.+)$/m.exec(out);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function reg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
    execFile(exe, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || '').trim() || err.message));
      else resolve(stdout);
    });
  });
}
