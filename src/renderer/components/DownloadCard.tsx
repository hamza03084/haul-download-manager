import { memo, type ReactElement } from 'react';
import type { DownloadView } from '../../shared/types';
import { formatBytes, formatDuration, formatSpeed } from '../../shared/format';
import { IconFolder, IconOpen, IconPause, IconPlay, IconRetry, IconStop, IconTrash } from './Icons';

export type CardAction = 'pause' | 'resume' | 'retry' | 'cancel' | 'remove' | 'open' | 'folder';

interface Props {
  d: DownloadView;
  expanded: boolean;
  onToggle: (id: string) => void;
  onAction: (d: DownloadView, action: CardAction) => void;
  index: number;
}

export const STATE_LABEL: Record<DownloadView['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const DownloadCard = memo(function DownloadCard({ d, expanded, onToggle, onAction, index }: Props) {
  const pct = d.totalBytes ? Math.min(100, (d.downloadedBytes / d.totalBytes) * 100) : null;
  const ext = extensionOf(d.fileName);
  const host = hostOf(d.url);
  const indeterminate = d.state === 'downloading' && pct === null;

  return (
    <article
      className={`card state-${d.state} ${expanded ? 'is-expanded' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 28}ms` }}
      aria-label={`${d.fileName}, ${STATE_LABEL[d.state]}`}
    >
      <div className="card-notch" aria-hidden />
      <button className="card-main" onClick={() => onToggle(d.id)} aria-expanded={expanded}>
        <span className="ext-tag" data-ext={ext}>
          {ext || 'FILE'}
        </span>
        <span className="card-titles">
          <span className="card-name" title={d.fileName}>
            {d.fileName}
          </span>
          <span className="card-host">
            {host}
            {d.media && <span className="media-tag">{d.media.label}</span>}
          </span>
        </span>
        <span className={`state-pill pill-${d.state}`}>{STATE_LABEL[d.state]}</span>
      </button>

      <div className="card-progress">
        <div
          className={`track ${d.state === 'downloading' ? 'is-moving' : ''} ${indeterminate ? 'is-indeterminate' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct === null ? undefined : Math.round(pct)}
          aria-label="Progress"
        >
          <div className="track-fill" style={{ width: indeterminate ? '35%' : `${d.state === 'completed' ? 100 : pct ?? 0}%` }} />
        </div>
        <span className="pct mono">
          {d.state === 'completed' ? '100%' : pct === null || d.state === 'cancelled' ? '—' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}
        </span>
      </div>

      <div className="card-meta">
        <span className="meta-left">
          <span className="meta-text">{metaLine(d)}</span>
          <ResumeTag d={d} />
        </span>
        <div className="card-actions">{actionsFor(d, onAction)}</div>
      </div>

      {d.state === 'failed' && d.error && (
        <p className="card-error" role="alert">
          {d.error}
        </p>
      )}
      {d.notice && <p className="card-notice">{d.notice}</p>}

      {expanded && (
        <dl className="card-details">
          <div>
            <dt>Source</dt>
            <dd className="mono selectable">{d.url}</dd>
          </div>
          {d.media && (
            <div>
              <dt>Quality</dt>
              <dd>
                {d.media.label}
                {d.media.thumbnail ? ' + thumbnail' : ''}
                {d.media.subtitles ? ` + ${d.media.subtitles} subtitles` : ''} (via yt-dlp)
              </dd>
            </div>
          )}
          {d.finalUrl && d.finalUrl !== d.url && (
            <div>
              <dt>Redirected to</dt>
              <dd className="mono selectable">{hostOf(d.finalUrl)}</dd>
            </div>
          )}
          <div>
            <dt>Saved to</dt>
            <dd className="mono selectable">
              {d.directory}
              {d.directory.endsWith('\\') ? '' : '\\'}
              {d.fileName}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {d.totalBytes === null
                ? 'Unknown until the server reports it'
                : d.kind === 'media' && d.state !== 'completed'
                  ? `about ${formatBytes(d.totalBytes)} (estimated by YouTube)`
                  : `${formatBytes(d.totalBytes)} (${d.totalBytes.toLocaleString()} bytes)`}
            </dd>
          </div>
          <div>
            <dt>Resume</dt>
            <dd>{d.resumable === true ? 'Supported by the server' : d.resumable === false ? 'Not supported: pausing restarts the download' : 'Not known yet'}</dd>
          </div>
          <div>
            <dt>Added</dt>
            <dd>{new Date(d.createdAt).toLocaleString()}</dd>
          </div>
          {d.completedAt && (
            <div>
              <dt>Finished</dt>
              <dd>{new Date(d.completedAt).toLocaleString()}</dd>
            </div>
          )}
        </dl>
      )}
    </article>
  );
});

function metaLine(d: DownloadView): string {
  const of = d.totalBytes !== null ? `${formatBytes(d.downloadedBytes)} of ${formatBytes(d.totalBytes)}` : formatBytes(d.downloadedBytes);
  switch (d.state) {
    case 'downloading': {
      const parts = [of, formatSpeed(d.speed)];
      if (d.etaSeconds !== null) parts.push(`${formatDuration(d.etaSeconds)} left`);
      // Media downloads say which stage they are in; while joining or converting no bytes move.
      if (d.phase && !d.phase.startsWith('Downloading')) return `${d.phase}  ·  ${of}`;
      if (d.phase) parts.unshift(d.phase);
      return parts.join('  ·  ');
    }
    case 'queued':
      return d.downloadedBytes > 0 ? `Waiting for a free slot  ·  ${of}` : 'Waiting for a free slot';
    case 'paused':
      return d.downloadedBytes > 0 ? `Paused at ${of}` : 'Paused';
    case 'completed':
      return d.fileExists
        ? `${formatBytes(d.totalBytes ?? d.downloadedBytes)}  ·  finished ${d.completedAt ? new Date(d.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`
        : 'The file was moved or deleted';
    case 'failed':
      return d.downloadedBytes > 0 ? `Stopped at ${of}` : 'Did not start';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Whether pausing keeps progress, shown once the server's answer is known. */
function ResumeTag({ d }: { d: DownloadView }) {
  const unfinished = d.state === 'downloading' || d.state === 'paused' || d.state === 'queued' || d.state === 'failed';
  if (!unfinished || d.resumable === null) return null;
  return d.resumable ? (
    <span className="resume-tag yes" title="The server supports resuming: pausing, closing Haul or losing the connection keeps the progress.">
      Resumable
    </span>
  ) : (
    <span className="resume-tag no" title="This server does not support resuming: pausing or any interruption restarts the download from the beginning.">
      No resume
    </span>
  );
}

function actionsFor(d: DownloadView, on: Props['onAction']) {
  const b = (action: CardAction, label: string, icon: ReactElement, cls = '') => (
    <button key={action} className={`icon-btn ${cls}`} onClick={() => on(d, action)} title={label} aria-label={label}>
      {icon}
    </button>
  );
  // The main action for the current state is a labelled button so it is easy to find.
  const main = (action: CardAction, label: string, text: string, icon: ReactElement, cls = '') => (
    <button key={action} className={`act-btn ${cls}`} onClick={() => on(d, action)} title={label} aria-label={label}>
      {icon}
      <span>{text}</span>
    </button>
  );
  const out: ReactElement[] = [];
  if (d.state === 'downloading' || d.state === 'queued') out.push(main('pause', 'Pause', 'Pause', <IconPause width={15} height={15} />));
  if (d.state === 'paused') out.push(main('resume', 'Resume', 'Resume', <IconPlay width={15} height={15} />, 'is-primary'));
  if (d.state === 'failed' || d.state === 'cancelled') out.push(main('retry', 'Retry', 'Retry', <IconRetry width={15} height={15} />, 'is-primary'));
  if (d.state === 'completed' && d.fileExists) out.push(main('open', 'Open file', 'Open', <IconOpen width={15} height={15} />, 'is-primary'));
  out.push(b('folder', 'Show in folder', <IconFolder />));
  if (d.state === 'downloading' || d.state === 'queued' || d.state === 'paused') out.push(b('cancel', 'Cancel download', <IconStop />, 'is-danger'));
  out.push(b('remove', 'Remove from list', <IconTrash />, 'is-danger'));
  return out;
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase() : '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
