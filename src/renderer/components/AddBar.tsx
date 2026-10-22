import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { mediaSiteOfUrl, type Settings } from '../../shared/types';
import { api } from '../api';
import { IconArrowDown, IconChevron, IconClipboard, IconClose, IconFolder } from './Icons';
import { MediaPicker } from './MediaPicker';

export interface AddBarHandle {
  focus(): void;
  prefill(url: string, fromBrowser?: boolean): void;
  /** Opens the quality picker for a page that is not on the list of known video sites. */
  pickVideo(url: string): void;
}

interface Props {
  settings: Settings | null;
  knownUrls: Set<string>;
  /** Links of downloads that are queued, downloading or paused. */
  unfinishedUrls: Set<string>;
  notify: (msg: string, kind?: 'info' | 'error') => void;
  onOpenSettings: () => void;
}

const URL_RE = /^https?:\/\/\S+$/i;

/** Same form the main process stores (`new URL().href`), so duplicates are recognised. */
function normalize(u: string): string {
  try {
    return new URL(u.trim()).href;
  } catch {
    return u.trim();
  }
}

export const AddBar = forwardRef<AddBarHandle, Props>(function AddBar({ settings, knownUrls, unfinishedUrls, notify, onOpenSettings }, ref) {
  const [url, setUrl] = useState('');
  const [batch, setBatch] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState('');
  const [fileName, setFileName] = useState('');
  const [startPaused, setStartPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromBrowser, setFromBrowser] = useState(false);
  const [clipSuggestion, setClipSuggestion] = useState<string | null>(null);
  /** A duplicate link the user was warned about; adding it again confirms a second copy. */
  const [confirmedDuplicate, setConfirmedDuplicate] = useState<string | null>(null);
  /** Video page whose quality picker is open. */
  const [picking, setPicking] = useState<string | null>(null);
  const offered = useRef(new Set<string>());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (settings && !directory) setDirectory(settings.downloadDirectory);
  }, [settings, directory]);

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    prefill: (u, browser = false) => {
      setBatch(null);
      setUrl(u);
      setError(null);
      setOpen(true);
      setFromBrowser(browser);
      input.current?.focus();
    },
    pickVideo: (u) => {
      setBatch(null);
      setError(null);
      setPicking(normalize(u));
    },
  }));

  // Offer a link found on the clipboard when the window gains focus (never added automatically).
  // The clipboard is read only on mount and on focus: frequent reads can block other apps' copy/paste.
  const knownUrlsRef = useRef(knownUrls);
  knownUrlsRef.current = knownUrls;
  useEffect(() => {
    const check = async () => {
      const u = await api.readClipboardUrl().catch(() => null);
      if (u && !offered.current.has(u) && !knownUrlsRef.current.has(u)) setClipSuggestion(u);
    };
    void check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);

  const reset = () => {
    setUrl('');
    setBatch(null);
    setFileName('');
    setError(null);
    setFromBrowser(false);
    setStartPaused(false);
    setOpen(false);
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    const links = text.split(/\s+/).filter((t) => URL_RE.test(t));
    if (links.length > 1) {
      e.preventDefault();
      setBatch([...new Set(links)]);
      setUrl('');
      setError(null);
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    let urls = batch ?? [url.trim()];
    if (!urls[0]) {
      setError('Paste or type a link first.');
      return;
    }
    if (!batch && unfinishedUrls.has(normalize(urls[0])) && confirmedDuplicate !== normalize(urls[0])) {
      setConfirmedDuplicate(normalize(urls[0]));
      setError('This link is already in your list and has not finished yet. Press Haul it again if you want a second copy.');
      return;
    }
    if (!batch && mediaSiteOfUrl(urls[0])) {
      // Video pages need a quality choice: the picker asks yt-dlp what is available.
      setConfirmedDuplicate(null);
      setError(null);
      setPicking(normalize(urls[0]));
      return;
    }
    if (batch) {
      const pages = urls.filter((u) => mediaSiteOfUrl(u));
      if (pages.length) notify(`Skipped ${pages.length} video page link(s): add them one at a time to choose a quality.`);
      const fresh = urls.filter((u) => !unfinishedUrls.has(normalize(u)) && !mediaSiteOfUrl(u));
      if (fresh.length < urls.length - pages.length) notify(`Skipped ${urls.length - pages.length - fresh.length} link(s) that are already in your list.`);
      if (fresh.length === 0) {
        reset();
        return;
      }
      urls = fresh;
    }
    setConfirmedDuplicate(null);
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const u of urls) {
      const res = await api.addDownload({
        url: u,
        directory: directory.trim() || undefined,
        fileName: !batch && fileName.trim() ? fileName.trim() : undefined,
        startPaused,
      });
      if (!res.ok) failures.push(batch ? `${u}: ${res.error}` : res.error);
      else offered.current.add(u);
    }
    setBusy(false);
    if (failures.length) {
      setError(failures.join('\n'));
      if (batch && failures.length < urls.length) notify(`Added ${urls.length - failures.length} of ${urls.length} links.`);
      return;
    }
    if (batch) notify(`Added ${urls.length} download${urls.length === 1 ? '' : 's'}.`);
    reset();
  };

  const browse = async () => {
    const dir = await api.chooseDirectory(directory || settings?.downloadDirectory);
    if (dir) setDirectory(dir);
  };

  const useSuggestion = () => {
    if (!clipSuggestion) return;
    offered.current.add(clipSuggestion);
    setUrl(clipSuggestion);
    setBatch(null);
    setClipSuggestion(null);
    input.current?.focus();
  };

  return (
    <>
    <form className={`addbar ${open ? 'is-open' : ''}`} onSubmit={submit} aria-label="Add a download">
      {fromBrowser && (
        <div className="addbar-banner" role="status">
          Link sent from your browser. Review it, then press <b>Haul it</b>.
        </div>
      )}
      <div className="addbar-row">
        <div className="addbar-field">
          <IconArrowDown className="addbar-glyph" />
          {batch ? (
            <div className="batch-chip">
              <b>{batch.length} links</b> ready to add
              <button type="button" className="chip-x" onClick={() => setBatch(null)} aria-label="Clear links">
                <IconClose width={14} height={14} />
              </button>
            </div>
          ) : (
            <input
              ref={input}
              className="addbar-input"
              type="text"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              placeholder="Paste a link to haul it…  (Ctrl+L)"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              onPaste={onPaste}
              onKeyDown={(e) => e.key === 'Escape' && reset()}
              aria-label="Download link"
              aria-invalid={!!error}
            />
          )}
          <button
            type="button"
            className={`addbar-toggle ${open ? 'rot' : ''}`}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title="Destination and options"
          >
            <IconChevron />
          </button>
        </div>
        <button className="btn btn-accent addbar-go" type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Haul it'}
        </button>
      </div>

      {clipSuggestion && !url && !batch && (
        <div className="clip-suggest">
          <button type="button" className="clip-use" onClick={useSuggestion}>
            <IconClipboard width={15} height={15} /> Use link from clipboard: <span className="mono">{shorten(clipSuggestion)}</span>
          </button>
          <button
            type="button"
            className="chip-x"
            aria-label="Dismiss clipboard suggestion"
            onClick={() => {
              offered.current.add(clipSuggestion);
              setClipSuggestion(null);
            }}
          >
            <IconClose width={13} height={13} />
          </button>
        </div>
      )}

      {error && (
        <div className="addbar-error" role="alert">
          {error}
        </div>
      )}

      {open && (
        <div className="addbar-options">
          <label className="field grow">
            <span>Save to</span>
            <div className="field-inline">
              <input value={directory} onChange={(e) => setDirectory(e.target.value)} spellCheck={false} />
              <button type="button" className="btn btn-ghost" onClick={browse}>
                <IconFolder width={16} height={16} /> Browse…
              </button>
            </div>
          </label>
          <label className="field">
            <span>File name {batch ? '(from server)' : '(optional)'}</span>
            <input
              value={fileName}
              disabled={!!batch}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="Use the server's name"
              spellCheck={false}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={startPaused} onChange={(e) => setStartPaused(e.target.checked)} />
            <span>Add paused</span>
          </label>
        </div>
      )}
    </form>
    {picking && (
      <MediaPicker
        url={picking}
        directory={directory || settings?.downloadDirectory || ''}
        startPaused={startPaused}
        onClose={() => {
          setPicking(null);
          input.current?.focus();
        }}
        onAdded={(summary) => {
          offered.current.add(picking);
          setPicking(null);
          reset();
          notify(summary);
        }}
        onOpenSettings={() => {
          setPicking(null);
          onOpenSettings();
        }}
      />
    )}
    </>
  );
});

function shorten(u: string): string {
  try {
    const x = new URL(u);
    const name = x.pathname.split('/').filter(Boolean).pop() ?? '';
    return `${x.host}${name ? `/…/${name}` : ''}`;
  } catch {
    return u.slice(0, 60);
  }
}
