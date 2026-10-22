import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from 'react';
import type { DownloadState, DownloadView, PowerState, Settings } from '../shared/types';
import { CATEGORIES, categoryOf } from '../shared/categories';
import { formatBytes, formatSpeed } from '../shared/format';
import { api } from './api';
import { AddBar, type AddBarHandle } from './components/AddBar';
import { DownloadCard, type CardAction } from './components/DownloadCard';
import { ChangeLinkDialog, RemoveDialog, SettingsPanel, ShutdownDialog } from './components/Panels';
import { BrandMark, IconBroom, IconGear, IconPause, IconPlay, IconPower } from './components/Icons';

type Filter = 'all' | DownloadState;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'downloading', label: 'Active' },
  { key: 'queued', label: 'Queued' },
  { key: 'paused', label: 'Paused' },
  { key: 'completed', label: 'Done' },
  { key: 'failed', label: 'Failed' },
  { key: 'cancelled', label: 'Cancelled' },
];

type Action = { type: 'load'; items: DownloadView[] } | { type: 'upsert'; item: DownloadView } | { type: 'remove'; id: string };

function reducer(state: Map<string, DownloadView>, a: Action): Map<string, DownloadView> {
  switch (a.type) {
    case 'load':
      return new Map(a.items.map((d) => [d.id, d]));
    case 'upsert': {
      const next = new Map(state);
      next.set(a.item.id, a.item);
      return next;
    }
    case 'remove': {
      if (!state.has(a.id)) return state;
      const next = new Map(state);
      next.delete(a.id);
      return next;
    }
  }
}

interface Toast {
  id: number;
  msg: string;
  kind: 'info' | 'error';
}

export function App() {
  const [downloads, dispatch] = useReducer(reducer, new Map<string, DownloadView>());
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [removing, setRemoving] = useState<DownloadView | null>(null);
  const [changingLink, setChangingLink] = useState<DownloadView | null>(null);
  const [category, setCategory] = useState('all');
  const [power, setPower] = useState<PowerState>({ armed: false, shutdownAt: null, unavailable: true });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addBar = useRef<AddBarHandle>(null);

  const notify = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);

  useEffect(() => {
    void api.listDownloads().then((items) => {
      dispatch({ type: 'load', items });
      setLoaded(true);
    });
    void api.getSettings().then(setSettings);
    void api.getPower().then(setPower);
    const offs = [
      api.onDownloadChanged((item) => dispatch({ type: 'upsert', item })),
      api.onDownloadRemoved((id) => dispatch({ type: 'remove', id })),
      api.onAddRequest((url) => addBar.current?.prefill(url, true)),
      api.onPowerChanged(setPower),
    ];
    void api.takePendingAddRequests().then((urls) => {
      if (urls.length) addBar.current?.prefill(urls[urls.length - 1], true);
    });
    const keys = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L' || e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        addBar.current?.focus();
      }
    };
    window.addEventListener('keydown', keys);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener('keydown', keys);
    };
  }, []);

  const all = useMemo(() => [...downloads.values()].sort((a, b) => b.createdAt - a.createdAt), [downloads]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: all.length, queued: 0, downloading: 0, paused: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const d of all) c[d.state]++;
    return c;
  }, [all]);
  const totalSpeed = useMemo(() => all.reduce((s, d) => s + (d.state === 'downloading' ? d.speed : 0), 0), [all]);
  const knownUrls = useMemo(() => new Set(all.map((d) => d.url)), [all]);
  const unfinishedUrls = useMemo(
    () => new Set(all.filter((d) => d.state === 'queued' || d.state === 'downloading' || d.state === 'paused').map((d) => d.url)),
    [all],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inCategory = (d: DownloadView) => {
      if (category === 'all') return true;
      const c = categoryOf(d.fileName);
      return category === 'other' ? c === null : c?.key === category;
    };
    return all.filter(
      (d) =>
        (filter === 'all' || d.state === filter) && inCategory(d) && (!q || d.fileName.toLowerCase().includes(q) || d.url.toLowerCase().includes(q)),
    );
  }, [all, filter, category, query]);

  const run = useCallback(
    async (p: Promise<{ ok: boolean; error?: string }>) => {
      const res = await p;
      if (!res.ok) notify(res.error ?? 'Something went wrong.', 'error');
      return res.ok;
    },
    [notify],
  );

  const onAction = useCallback(
    (d: DownloadView, action: CardAction) => {
      switch (action) {
        case 'pause':
          return void run(api.pause(d.id));
        case 'resume':
          return void run(api.resume(d.id));
        case 'retry':
          return void run(api.retry(d.id));
        case 'cancel':
          return void run(api.cancel(d.id));
        case 'open':
          return void run(api.openFile(d.id));
        case 'folder':
          return void run(api.showInFolder(d.id));
        case 'changeLink':
          return setChangingLink(d);
        case 'tryVideo':
          return addBar.current?.pickVideo(d.url);
        case 'remove':
          return setRemoving(d);
      }
    },
    [run],
  );

  const toggleShutdown = useCallback(async () => {
    const res = await api.setShutdownWhenDone(!power.armed);
    if (!res.ok) notify(res.error, 'error');
    else {
      setPower(res.value);
      notify(res.value.armed ? 'Haul will shut down the PC once every download has finished (with a 60-second warning).' : 'Shutdown when done turned off.');
    }
  }, [power.armed, notify]);

  const toggle = useCallback((id: string) => setExpanded((e) => (e === id ? null : id)), []);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <BrandMark />
          <div>
            <h1>Haul</h1>
            <span className="brand-sub">download manager</span>
          </div>
        </div>
        <AddBar
          ref={addBar}
          settings={settings}
          knownUrls={knownUrls}
          unfinishedUrls={unfinishedUrls}
          notify={notify}
          onOpenSettings={() => setShowSettings(true)}
        />
        <button className="icon-btn top-settings" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings" disabled={!settings}>
          <IconGear width={20} height={20} />
        </button>
      </header>

      <section className="manifest" aria-label="Summary">
        <Stat label="Throughput" value={formatSpeed(totalSpeed)} accent />
        <Stat label="Active" value={String(counts.downloading)} />
        <Stat label="Queued" value={String(counts.queued)} />
        <Stat label="Paused" value={String(counts.paused)} />
        <Stat label="Done" value={String(counts.completed)} />
        <Stat label="Failed" value={String(counts.failed)} warn={counts.failed > 0} />
      </section>

      <nav className="filters" aria-label="Filter downloads">
        <div className="chips" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`chip ${filter === f.key ? 'is-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="chip-count mono">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="filters-right">
          <select className="category-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by type">
            <option value="all">All types</option>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.folder}
              </option>
            ))}
            <option value="other">Other</option>
          </select>
          <input className="search" type="search" placeholder="Search name or link" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search downloads" />
          <button className="btn btn-ghost sm" onClick={() => run(api.resumeAll())} disabled={counts.paused === 0} title="Resume all paused">
            <IconPlay width={15} height={15} /> Resume all
          </button>
          <button className="btn btn-ghost sm" onClick={() => run(api.pauseAll())} disabled={counts.downloading + counts.queued === 0} title="Pause everything">
            <IconPause width={15} height={15} /> Pause all
          </button>
          <button
            className="btn btn-ghost sm"
            onClick={() => run(api.clearFinished())}
            disabled={counts.completed + counts.cancelled === 0}
            title="Remove done and cancelled entries from the list (files are kept)"
          >
            <IconBroom width={15} height={15} /> Clear finished
          </button>
          {!power.unavailable && (
            <button
              className={`btn btn-ghost sm ${power.armed ? 'is-on' : ''}`}
              onClick={() => void toggleShutdown()}
              aria-pressed={power.armed}
              title={power.armed ? 'The PC will shut down when every download has finished. Click to turn this off.' : 'Shut down the PC when every download has finished'}
            >
              <IconPower width={15} height={15} /> {power.armed ? 'Shutting down when done' : 'Shut down when done'}
            </button>
          )}
        </div>
      </nav>

      <main className="list" aria-live="polite">
        {!loaded ? null : all.length === 0 ? (
          <Empty
            title="Nothing in the hold yet"
            body="Paste a link in the bar above and press Haul it. Downloads keep their place in this list across restarts."
            action={<button className="btn btn-accent" onClick={() => addBar.current?.focus()}>Add a link</button>}
          />
        ) : visible.length === 0 ? (
          <Empty title="No matches" body={query ? `Nothing matches “${query}”.` : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} downloads.`} />
        ) : (
          visible.map((d, i) => <DownloadCard key={d.id} d={d} index={i} expanded={expanded === d.id} onToggle={toggle} onAction={onAction} />)
        )}
      </main>

      <footer className="statusbar">
        <span className="mono" title="Default download folder">
          ⤓ {settings?.downloadDirectory ?? '…'}
        </span>
        <span>
          {settings ? `${settings.maxConcurrent} at a time` : ''}
          {settings && settings.speedLimit > 0 ? ` · limit ${formatBytes(settings.speedLimit)}/s` : ''}
          {settings && settings.connections > 1 ? ` · ${settings.connections} connections` : ''}
          {settings?.categoriesEnabled ? ' · sorted by type' : ''} · {all.length} in history
        </span>
      </footer>

      {showSettings && settings && <SettingsPanel initial={settings} onClose={() => setShowSettings(false)} onSaved={setSettings} />}
      {changingLink && (
        <ChangeLinkDialog
          d={changingLink}
          onClose={() => setChangingLink(null)}
          onChanged={(msg) => {
            setChangingLink(null);
            notify(msg);
          }}
        />
      )}
      {power.shutdownAt !== null && (
        <ShutdownDialog
          power={power}
          onCancel={() => {
            void api.setShutdownWhenDone(false).then((res) => {
              if (res.ok) {
                setPower(res.value);
                notify('Shutdown cancelled.');
              }
            });
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          d={removing}
          onClose={() => setRemoving(null)}
          onConfirm={async (deleteFile) => {
            const d = removing;
            setRemoving(null);
            if (await run(api.remove(d.id, deleteFile))) notify(deleteFile ? `Removed and deleted ${d.fileName}.` : `Removed ${d.fileName} from the list.`);
          }}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, accent, warn }: { label: string; value: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={`stat ${accent ? 'stat-accent' : ''} ${warn ? 'stat-warn' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value mono">{value}</span>
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: ReactElement }) {
  return (
    <div className="empty">
      <svg width="88" height="88" viewBox="0 0 88 88" aria-hidden className="empty-art">
        <rect x="14" y="30" width="60" height="44" rx="6" />
        <path d="M14 44h60M34 30v14M54 30v14M44 6v16M36 15l8 8 8-8" />
      </svg>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}
