import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { MAX_CONCURRENT_LIMIT, type DownloadView, type MediaToolsStatus, type Settings, type ToolInstallStatus } from '../../shared/types';
import { formatBytes } from '../../shared/format';
import { api } from '../api';
import { IconClose, IconFolder } from './Icons';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

function Overlay({ children, onClose, kind }: { children: ReactNode; onClose: () => void; kind: 'sheet' | 'modal' }) {
  useEscape(onClose);
  return (
    <div className={`overlay overlay-${kind}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {children}
    </div>
  );
}

export function SettingsPanel({ initial, onClose, onSaved }: { initial: Settings; onClose: () => void; onSaved: (s: Settings) => void }) {
  const [dir, setDir] = useState(initial.downloadDirectory);
  const [max, setMax] = useState(initial.maxConcurrent);
  const [resume, setResume] = useState(initial.resumeOnStartup);
  const [ytDlpPath, setYtDlpPath] = useState(initial.ytDlpPath);
  const [autoTools, setAutoTools] = useState(initial.autoMediaTools);
  const [tools, setTools] = useState<MediaToolsStatus | null>(null);
  const [install, setInstall] = useState<ToolInstallStatus | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    void api.getVersion().then(setVersion);
  }, []);
  const checkTools = useCallback(() => {
    setTools(null);
    void api.getMediaTools().then((t) => {
      setTools(t);
      setInstall(t.install);
    });
  }, []);
  useEffect(checkTools, [checkTools]);
  // Live progress while Haul downloads the tools; the list is checked again once it finishes.
  useEffect(
    () =>
      api.onMediaToolsProgress((s) => {
        setInstall((prev) => {
          if (prev?.state === 'installing' && s.state !== 'installing') checkTools();
          return s;
        });
      }),
    [checkTools],
  );
  const getToolsNow = async () => {
    setToolsError(null);
    setInstall({ state: 'installing', tool: null, received: 0, total: null, error: null });
    const res = await api.updateMediaTools();
    if (!res.ok) setToolsError(res.error);
    checkTools();
  };
  const installing = install?.state === 'installing';

  const save = async () => {
    setSaving(true);
    const res = await api.saveSettings({
      downloadDirectory: dir,
      maxConcurrent: max,
      resumeOnStartup: resume,
      ytDlpPath: ytDlpPath.trim(),
      autoMediaTools: autoTools,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved(res.value);
    onClose();
  };

  return (
    <Overlay onClose={onClose} kind="sheet">
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="sheet-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            <IconClose />
          </button>
        </header>
        <div className="sheet-body">
          <section className="setting">
            <h3>Default download folder</h3>
            <p>New downloads are saved here unless you pick another folder when adding them.</p>
            <div className="field-inline">
              <input ref={first} value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} aria-label="Default download folder" />
              <button
                className="btn btn-ghost"
                onClick={async () => {
                  const d = await api.chooseDirectory(dir);
                  if (d) setDir(d);
                }}
              >
                <IconFolder width={16} height={16} /> Browse…
              </button>
            </div>
          </section>
          <section className="setting">
            <h3>Simultaneous downloads</h3>
            <p>Additional downloads wait in the queue until a slot frees up.</p>
            <div className="stepper" role="group" aria-label="Simultaneous downloads">
              <button className="btn btn-ghost" onClick={() => setMax((m) => Math.max(1, m - 1))} aria-label="Fewer" disabled={max <= 1}>
                −
              </button>
              <output className="mono stepper-value" aria-live="polite">
                {max}
              </output>
              <button className="btn btn-ghost" onClick={() => setMax((m) => Math.min(MAX_CONCURRENT_LIMIT, m + 1))} aria-label="More" disabled={max >= MAX_CONCURRENT_LIMIT}>
                +
              </button>
              <input
                type="range"
                min={1}
                max={MAX_CONCURRENT_LIMIT}
                value={max}
                onChange={(e) => setMax(Number(e.target.value))}
                aria-label="Simultaneous downloads slider"
              />
            </div>
          </section>
          <section className="setting">
            <label className="check big">
              <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
              <span>
                <b>Continue unfinished downloads when Haul starts</b>
                <small>Turn off to keep them paused until you resume them.</small>
              </span>
            </label>
          </section>
          <section className="setting">
            <h3>YouTube downloads</h3>
            <p>
              Uses the free tools yt-dlp, FFmpeg and Deno (a 150 MB download, 300 MB on disk). Haul can download them from their
              official GitHub pages, check them against their published checksums and keep yt-dlp up to date. Only save videos you
              have the right to keep.
            </p>
            <label className="check">
              <input type="checkbox" checked={autoTools} onChange={(e) => setAutoTools(e.target.checked)} />
              <span>Get these tools automatically and keep them up to date</span>
            </label>
            {installing ? (
              <p className="mono tools-progress" role="status">
                Downloading {install.tool ?? 'the tools'}…
                {install.received > 0 && ` ${formatBytes(install.received)}${install.total ? ` of ${formatBytes(install.total)}` : ''}`}
              </p>
            ) : !tools ? (
              <p className="mono">Checking…</p>
            ) : (
              <div className="tools-status mono" aria-label="Tools found">
                <ToolLine name="yt-dlp" path={tools.ytDlp} extra={tools.ytDlpVersion} />
                <ToolLine name="FFmpeg" path={tools.ffmpeg} />
                <ToolLine name={/node(\.exe)?$/i.test(tools.jsRuntime ?? '') ? 'Node.js' : 'Deno'} path={tools.jsRuntime} optional />
                {tools.problem && <p className="form-error">{tools.problem}</p>}
              </div>
            )}
            {toolsError && !installing && <p className="form-error">{toolsError}</p>}
            <div className="field-inline">
              <input
                value={ytDlpPath}
                onChange={(e) => setYtDlpPath(e.target.value)}
                placeholder="Find yt-dlp.exe automatically"
                spellCheck={false}
                aria-label="Location of yt-dlp.exe"
              />
              <button
                className="btn btn-ghost"
                onClick={async () => {
                  const f = await api.chooseExecutable(ytDlpPath || undefined);
                  if (f) setYtDlpPath(f);
                }}
              >
                <IconFolder width={16} height={16} /> Browse…
              </button>
            </div>
            <div className="tools-actions">
              {initial.autoMediaTools && (
                <button className="btn btn-ghost sm" onClick={getToolsNow} disabled={installing}>
                  {tools?.managed ? 'Update now' : 'Get the tools now'}
                </button>
              )}
              <button className="btn btn-ghost sm" onClick={checkTools} disabled={installing}>
                Check again
              </button>
            </div>
          </section>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer className="sheet-foot">
          <span className="version mono">{version && `Haul ${version}`}</span>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </footer>
      </aside>
    </Overlay>
  );
}

function ToolLine({ name, path, extra, optional }: { name: string; path: string | null; extra?: string | null; optional?: boolean }) {
  return (
    <div>
      <span className={path ? 'ok' : optional ? 'optional' : 'missing'}>{path ? '✓' : optional ? '!' : '✗'} {name}</span>
      <span title={path ?? undefined}>{path ? `${extra ? `${extra} · ` : ''}${path}` : optional ? 'not found (some YouTube formats may be missing)' : 'not found'}</span>
    </div>
  );
}

export function RemoveDialog({ d, onClose, onConfirm }: { d: DownloadView; onClose: () => void; onConfirm: (deleteFile: boolean) => void }) {
  const [deleteFile, setDeleteFile] = useState(false);
  const active = d.state === 'downloading' || d.state === 'queued' || d.state === 'paused';
  const canDeleteFile = d.state === 'completed' && d.fileExists;
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <Overlay onClose={onClose} kind="modal">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="rm-title" aria-describedby="rm-desc">
        <h2 id="rm-title">Remove “{d.fileName}”?</h2>
        <p id="rm-desc">
          {active
            ? 'The download will stop and its partial data will be deleted.'
            : canDeleteFile
              ? 'It will be removed from your history. The file stays on disk unless you choose otherwise.'
              : 'It will be removed from your history.'}
        </p>
        {canDeleteFile && (
          <label className="check">
            <input type="checkbox" checked={deleteFile} onChange={(e) => setDeleteFile(e.target.checked)} />
            <span>Also delete the file from disk</span>
          </label>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Keep
          </button>
          <button ref={confirmRef} className="btn btn-danger" onClick={() => onConfirm(deleteFile)}>
            {deleteFile ? 'Remove and delete file' : 'Remove'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
