import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tls from 'node:tls';
import type { ActionResult, AddDownloadRequest, DownloadView, ToolInstallStatus } from '../shared/types';
import { DownloadManager, type Logger } from './engine/manager';
import { openStore, type SqliteStore } from './engine/store';
import { ToolInstaller } from './engine/tools';
import { PROTOCOL_SCHEME, ValidationError, extractProtocolUrls, redactText, redactUrl, validateDownloadUrl } from './engine/urls';
import { createFileLogger } from './logger';
import { markFromInternet } from './zone';

const PROTOCOL = PROTOCOL_SCHEME;

// Optional override, used by automated tests and for running from a USB stick.
// Everything else lives in the per-user %APPDATA%\Haul Download Manager folder.
if (process.env.HAUL_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.HAUL_USER_DATA_DIR));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}

let mainWindow: BrowserWindow | null = null;
let manager: DownloadManager | null = null;
const pendingAddUrls: string[] = [];
let rendererReady = false;
let log: Logger = { info() {}, warn() {}, error() {} };

async function bootstrap(): Promise<void> {
  registerProtocolClient();
  app.on('second-instance', (_e, argv) => {
    for (const url of extractProtocolUrls(argv)) deliverAddRequest(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  for (const url of extractProtocolUrls(process.argv)) pendingAddUrls.push(url);

  await app.whenReady();
  Menu.setApplicationMenu(null);

  const userData = app.getPath('userData');
  log = createFileLogger(path.join(userData, 'logs'));
  log.info(`starting ${app.getName()} ${app.getVersion()} (electron ${process.versions.electron})`);
  useWindowsCertificates();

  let store: SqliteStore;
  let quarantined: string | null = null;
  try {
    ({ store, quarantined } = openStore(path.join(userData, 'data', 'haul.db')));
  } catch (e) {
    log.error(`database open failed: ${(e as Error).message}`);
    dialog.showErrorBox(
      'Haul Download Manager',
      `Could not open the download database in:\n${path.join(userData, 'data')}\n\n${(e as Error).message}\n\n` +
        'Another program may be using it. Restart Windows and try again. The app will now exit.',
    );
    app.exit(1);
    return;
  }
  if (quarantined) log.warn(`database was damaged; moved to ${path.basename(quarantined)} and started a new one`);

  const defaultDir = process.env.HAUL_DOWNLOAD_DIR ? path.resolve(process.env.HAUL_DOWNLOAD_DIR) : app.getPath('downloads');
  // yt-dlp, FFmpeg and Deno are downloaded into the user's own profile: no administrator rights, and
  // the portable build keeps them too. Tests turn this off so they never download them.
  const installer =
    process.env.HAUL_NO_TOOL_DOWNLOADS === '1' ? null : new ToolInstaller({ dir: path.join(userData, 'tools'), userAgent: userAgent(), log });
  manager = new DownloadManager({
    store,
    logger: log,
    defaultSettings: { downloadDirectory: defaultDir, maxConcurrent: 3, resumeOnStartup: true, ytDlpPath: '', autoMediaTools: true },
    onFileFinalized: (file, rec) => markFromInternet(file, rec.url, log),
    userAgent: userAgent(),
    mediaCommand: testMediaCommand(),
    toolInstaller: installer,
  });
  manager.init();
  wireIpc(manager);
  installer?.on('status', (s: ToolInstallStatus) => mainWindow?.webContents.send('media:toolsProgress', s));

  let lastTaskbarUpdate = 0;
  manager.on('changed', (v: DownloadView) => {
    mainWindow?.webContents.send('downloads:changed', v);
    const now = Date.now();
    if (now - lastTaskbarUpdate > 500 || v.state !== 'downloading') {
      lastTaskbarUpdate = now;
      updateTaskbarProgress();
    }
  });
  manager.on('removed', (id: string) => mainWindow?.webContents.send('downloads:removed', id));

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !manager) return;
    e.preventDefault();
    quitting = true;
    manager
      .shutdown()
      .catch((err) => log.error(`shutdown error: ${err}`))
      .finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());

  createWindow();
  // Get the YouTube tools in the background once the window is up, so the first YouTube link is quick.
  // Checking again every few hours keeps yt-dlp current when Haul stays open for days (the installer
  // itself looks for a newer release at most once a day).
  setTimeout(() => void manager?.prepareMediaTools(), 3_000).unref();
  setInterval(() => void manager?.prepareMediaTools(), 4 * 60 * 60 * 1000).unref();
  if (quarantined) {
    const notice = {
      type: 'warning' as const,
      title: 'Haul Download Manager',
      message: 'Your download history could not be read and has been reset.',
      detail:
        'The history file was damaged (for example by a power cut or disk error). Your downloaded files are not affected. ' +
        `The damaged file was kept as:\n${quarantined}`,
    };
    mainWindow?.once('ready-to-show', () => void (mainWindow ? dialog.showMessageBox(mainWindow, notice) : dialog.showMessageBox(notice)));
  }
}

/**
 * Trusts the Windows certificate store in addition to Node's bundled root certificates, as browsers
 * on Windows do. Without it, every HTTPS download fails on PCs whose antivirus or company network
 * inspects HTTPS traffic with its own root certificate.
 */
function useWindowsCertificates(): void {
  const t = tls as typeof tls & {
    getCACertificates?: (type: 'default' | 'system') => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
  };
  if (!t.getCACertificates || !t.setDefaultCACertificates) return;
  try {
    const certs = [...new Set([...t.getCACertificates('default'), ...t.getCACertificates('system')])];
    t.setDefaultCACertificates(certs);
    log.info(`HTTPS trusts ${certs.length} root certificates (bundled and Windows store)`);
  } catch (e) {
    log.warn(`could not load Windows root certificates: ${(e as Error).message}`);
  }
}

/** Automated tests only: HAUL_YTDLP_COMMAND='["node.exe","fake-yt-dlp.js"]' replaces yt-dlp. */
function testMediaCommand(): string[] | null {
  const raw = process.env.HAUL_YTDLP_COMMAND;
  if (!raw) return null;
  try {
    const cmd = JSON.parse(raw);
    return Array.isArray(cmd) && cmd.length > 0 && cmd.every((c) => typeof c === 'string') ? cmd : null;
  } catch {
    return null;
  }
}

/** Identifies the app to servers. A homepage in package.json is included as contact information. */
function userAgent(): string {
  let homepage = '';
  try {
    homepage = String(JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).homepage ?? '');
  } catch {
    /* optional */
  }
  return `HaulDownloadManager/${app.getVersion()} (Windows${/^https:\/\/\S+$/.test(homepage) ? `; +${homepage}` : ''})`;
}

function createWindow(): void {
  const iconPath = path.join(__dirname, '..', '..', '..', 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    title: 'Haul Download Manager',
    backgroundColor: '#0f1419',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('did-finish-load', () => {
    rendererReady = true;
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Windows is shutting down, restarting or signing out. 'before-quit' is not emitted in this case and
  // the process may be terminated at any moment, so flush partial files synchronously first.
  mainWindow.on('session-end', () => {
    log.info('Windows is ending the session; saving download progress');
    manager?.checkpointNow();
    app.quit();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });
  void mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
}

function updateTaskbarProgress(): void {
  if (!mainWindow || !manager) return;
  const active = manager.activeViews();
  if (active.length === 0) {
    mainWindow.setProgressBar(-1);
    return;
  }
  const known = active.filter((d) => d.totalBytes);
  if (known.length === 0) {
    mainWindow.setProgressBar(2, { mode: 'indeterminate' });
    return;
  }
  const total = known.reduce((s, d) => s + (d.totalBytes ?? 0), 0);
  const done = known.reduce((s, d) => s + d.downloadedBytes, 0);
  mainWindow.setProgressBar(total > 0 ? Math.min(1, done / total) : 0);
}

// ---------------------------------------------------------------------- IPC

function wireIpc(m: DownloadManager): void {
  const handle = <T>(channel: string, fn: (...args: unknown[]) => T | Promise<T>) => {
    ipcMain.handle(channel, async (_e: IpcMainInvokeEvent, ...args: unknown[]): Promise<ActionResult<T>> => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        const msg = err instanceof ValidationError ? err.message : `Something went wrong: ${(err as Error).message}`;
        if (!(err instanceof ValidationError)) log.error(`${channel}: ${redactText(String((err as Error).stack ?? err))}`);
        return { ok: false, error: msg };
      }
    });
  };

  ipcMain.handle('downloads:list', () => m.list());
  handle('downloads:add', (req) => m.add(parseAddRequest(req)));
  handle('downloads:pause', (id) => m.pause(parseId(id)));
  handle('downloads:resume', (id) => m.resume(parseId(id)));
  handle('downloads:retry', (id) => m.retry(parseId(id)));
  handle('downloads:cancel', (id) => m.cancel(parseId(id)));
  handle('downloads:remove', (id, deleteFile) => m.remove(parseId(id), deleteFile === true));
  handle('downloads:pauseAll', () => m.pauseAll());
  handle('downloads:resumeAll', () => m.resumeAll());
  handle('downloads:clearFinished', () => m.clearFinished());
  handle('downloads:openFile', async (id) => {
    // Paths are always resolved here from the ID; the renderer never supplies a path.
    const file = m.completedFilePath(parseId(id));
    if (!file) throw new ValidationError('The download has not finished yet.');
    if (!fs.existsSync(file)) throw new ValidationError('The file was moved or deleted.');
    const err = await shell.openPath(file);
    if (err) throw new ValidationError(`Windows could not open the file: ${err}`);
  });
  handle('downloads:showInFolder', async (id) => {
    const loc = m.locate(parseId(id));
    if (!loc) throw new ValidationError('That download no longer exists.');
    if (loc.file) {
      shell.showItemInFolder(loc.file);
      return;
    }
    if (!fs.existsSync(loc.directory)) throw new ValidationError('The download folder no longer exists.');
    const err = await shell.openPath(loc.directory);
    if (err) throw new ValidationError(err);
  });
  ipcMain.handle('settings:get', () => m.getSettings());
  handle('settings:save', (s) => m.updateSettings(s));

  // Video pages: one quality lookup at a time; a new one (or closing the picker) cancels the previous.
  let probe: AbortController | null = null;
  handle('media:probe', async (url) => {
    probe?.abort();
    const mine = new AbortController();
    probe = mine;
    try {
      return await m.probeMedia(url, mine.signal);
    } catch (e) {
      if (mine.signal.aborted) throw new ValidationError('Cancelled.');
      throw e;
    } finally {
      if (probe === mine) probe = null;
    }
  });
  ipcMain.handle('media:cancelProbe', () => {
    probe?.abort();
    probe = null;
  });
  ipcMain.handle('media:tools', () => m.mediaToolsStatus());
  handle('media:updateTools', () => m.updateMediaTools());
  ipcMain.handle('dialog:chooseExecutable', async (_e, initial: unknown) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose yt-dlp.exe',
      properties: ['openFile'],
      filters: [{ name: 'Programs', extensions: ['exe'] }],
      defaultPath: typeof initial === 'string' && path.isAbsolute(initial) ? initial : undefined,
    };
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  ipcMain.handle('dialog:chooseDirectory', async (_e, initial: unknown) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose download folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: typeof initial === 'string' && path.isAbsolute(initial) ? initial : undefined,
    };
    const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  ipcMain.handle('clipboard:readUrl', async () => {
    const text = String(await clipboard.readText()).trim();
    try {
      return text && !/\s/.test(text) ? validateDownloadUrl(text).href : null;
    } catch {
      return null;
    }
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:takePendingAddRequests', () => {
    rendererReady = true;
    return pendingAddUrls.splice(0);
  });
}

function parseId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) throw new ValidationError('Invalid download ID.');
  return id;
}

function parseAddRequest(input: unknown): AddDownloadRequest {
  if (!input || typeof input !== 'object') throw new ValidationError('Invalid request.');
  const r = input as Record<string, unknown>;
  const optionalString = (v: unknown, name: string, max: number) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > max) throw new ValidationError(`Invalid ${name}.`);
    return v;
  };
  return {
    url: typeof r.url === 'string' ? r.url : '',
    directory: optionalString(r.directory, 'folder', 1024),
    fileName: optionalString(r.fileName, 'file name', 255),
    startPaused: r.startPaused === true,
    // Checked field by field by the engine (validateMediaRequest).
    media: r.media && typeof r.media === 'object' ? (r.media as AddDownloadRequest['media']) : undefined,
  };
}

// ------------------------------------------------------- browser integration

function registerProtocolClient(): void {
  if (process.env.HAUL_DISABLE_PROTOCOL === '1') return;
  try {
    if (process.defaultApp) {
      // Development: `electron .` – register electron.exe with the app path as argument.
      if (process.argv.length >= 2) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      // The portable build runs from a temporary folder; register the portable .exe itself.
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      app.setAsDefaultProtocolClient(PROTOCOL, exe);
    }
  } catch {
    /* not fatal: browser integration is optional */
  }
}

function deliverAddRequest(url: string): void {
  if (mainWindow && rendererReady) mainWindow.webContents.send('app:addRequest', url);
  else pendingAddUrls.push(url);
  log.info(`add request from browser: ${redactUrl(url)}`);
}
