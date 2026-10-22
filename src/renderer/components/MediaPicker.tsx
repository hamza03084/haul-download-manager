import { useEffect, useMemo, useRef, useState } from 'react';
import { mediaSiteOfUrl, type AudioFormat, type MediaInfo, type MediaMode, type MediaQuality, type ToolInstallStatus } from '../../shared/types';
import { formatBytes, formatDuration } from '../../shared/format';
import { api } from '../api';
import { IconClose, IconFolder } from './Icons';

interface Props {
  url: string;
  directory: string;
  startPaused: boolean;
  onClose: () => void;
  onAdded: (summary: string) => void;
  onOpenSettings: () => void;
}

const MODES: { key: MediaMode; label: string; hint: string }[] = [
  { key: 'video', label: 'Video + sound', hint: 'One MP4 file, ready to play' },
  { key: 'video-only', label: 'Video only', hint: 'No sound track (where the site offers the picture separately)' },
  { key: 'audio', label: 'Audio only', hint: 'Music or speech only' },
];

/** MP3 is re-encoded at the highest VBR setting, which averages about 245 kbit/s. */
const MP3_KBPS = 245;

function defaultQuality(qualities: MediaQuality[]): MediaQuality | undefined {
  return qualities.find((q) => q.height === 1080) ?? qualities.find((q) => q.height < 1080) ?? qualities[qualities.length - 1];
}

/** The quality picker for a video page: asks yt-dlp what is available, then adds the chosen download. */
export function MediaPicker({ url, directory, startPaused, onClose, onAdded, onOpenSettings }: Props) {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState<MediaMode>('video');
  const [height, setHeight] = useState<number | null>(null);
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('m4a');
  const [thumbnail, setThumbnail] = useState(false);
  const [subtitles, setSubtitles] = useState('');
  const [adding, setAdding] = useState(false);
  const [install, setInstall] = useState<ToolInstallStatus | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // The first video link may have to wait while Haul downloads yt-dlp, FFmpeg and Deno.
  useEffect(() => api.onMediaToolsProgress(setInstall), []);

  useEffect(() => {
    let alive = true;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    void api.probeMedia(url).then((res) => {
      clearInterval(timer);
      if (!alive) return;
      if (res.ok) {
        setInfo(res.value);
        setHeight(defaultQuality(res.value.qualities)?.height ?? null);
        if (res.value.qualities.length === 0) setMode('audio');
      } else setError(res.error);
    });
    return () => {
      alive = false;
      clearInterval(timer);
      void api.cancelProbe();
    };
  }, [url]);

  useEffect(() => {
    if (info) confirmRef.current?.focus();
  }, [info]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  // "Video only" needs a stream without sound, which not every site offers at every size.
  const listed = (info?.qualities ?? []).filter((q) => mode !== 'video-only' || q.videoOnlyFormatId);
  const quality = listed.find((q) => q.height === height) ?? listed[0] ?? null;
  const videoOnlyPossible = !!info?.qualities.some((q) => q.videoOnlyFormatId);
  const mp3Bytes = info?.durationSeconds ? Math.round((info.durationSeconds * MP3_KBPS * 1000) / 8) : null;
  const site = info?.site ?? mediaSiteOfUrl(url) ?? 'Video page';

  const sizeFor = (q: MediaQuality | null, m: MediaMode): number | null => {
    if (!info) return null;
    if (m === 'audio') return audioFormat === 'mp3' ? mp3Bytes : info.audioBytes ?? (info.qualities[0]?.hasAudio ? info.qualities[0].videoBytes : null);
    if (!q?.videoBytes) return null;
    return m === 'video' && !q.hasAudio ? q.videoBytes + (info.audioBytes ?? 0) : q.videoBytes;
  };
  const total = sizeFor(quality, mode);
  const label = useMemo(() => {
    if (mode === 'audio') return `Audio · ${audioFormat.toUpperCase()}`;
    if (!quality) return '';
    return `${quality.label.replace(/ \(.*\)$/, '')} · ${mode === 'video' ? quality.codec : `${quality.codec}, no sound`}`;
  }, [mode, audioFormat, quality]);

  // Missing tools, or Haul could not get them (network, checksum, full disk…): Settings can help.
  const toolsMissing =
    !!error && (install?.state === 'failed' || (/not found|could not be started/i.test(error) && /yt-dlp|FFmpeg/.test(error)) || /tools video downloads need|Could not download (yt-dlp|FFmpeg|Deno)/.test(error));
  // Audio without a listed stream still works: yt-dlp takes the sound out of the best video it finds.
  const canAdd = !!info && !adding && (mode === 'audio' || !!quality);

  const add = async () => {
    if (!info || !canAdd) return;
    setAdding(true);
    const res = await api.addDownload({
      url,
      directory: directory.trim() || undefined,
      startPaused,
      media: {
        mode,
        height: mode === 'audio' ? null : quality!.height,
        audioFormat: mode === 'audio' ? audioFormat : null,
        thumbnail: thumbnail && info.hasThumbnail,
        subtitles: subtitles || null,
        videoFormatId: mode === 'audio' ? null : mode === 'video-only' ? quality!.videoOnlyFormatId : quality!.formatId,
        // A stream that has its sound built in needs no separate audio stream.
        audioFormatId: mode === 'video-only' || (mode === 'video' && quality!.hasAudio) ? null : info.audioFormatId,
        videoId: info.videoId,
        title: info.title,
        label,
        estimateVideo: mode === 'audio' ? null : quality?.videoBytes ?? null,
        estimateAudio: mode === 'video-only' || (mode === 'video' && quality?.hasAudio) ? null : mode === 'audio' && audioFormat === 'mp3' ? mp3Bytes : info.audioBytes,
      },
    });
    setAdding(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onAdded(`Added “${info.title}” (${label}).`);
  };

  return (
    <div className="overlay overlay-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal picker" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <header className="picker-head">
          <span className="picker-kicker mono">{site}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </header>

        {!info && !error && (
          <div className="picker-loading" role="status">
            <span className="spinner" aria-hidden />
            <div>
              {install?.state === 'installing' ? (
                <>
                  <h2 id="picker-title">Getting the video tools ready…</h2>
                  <p>
                    First time only: Haul is downloading {install.tool ?? 'the tools'} from its official GitHub page
                    {install.received > 0 && (
                      <span className="mono">
                        {' '}
                        ({formatBytes(install.received)}
                        {install.total ? ` of ${formatBytes(install.total)}` : ''})
                      </span>
                    )}
                    .
                  </p>
                </>
              ) : (
                <>
                  <h2 id="picker-title">Finding available qualities…</h2>
                  <p>
                    yt-dlp is asking {site} which video and audio versions exist. This usually takes 5–20 seconds.
                    <span className="mono picker-elapsed"> {elapsed} s</span>
                  </p>
                </>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="picker-error">
            <h2 id="picker-title">{toolsMissing ? 'The video tools are not ready' : 'Could not use this video'}</h2>
            <p className="form-error" role="alert">
              {error}
            </p>
            <div className="modal-actions">
              {toolsMissing && (
                <button className="btn btn-ghost" onClick={onOpenSettings}>
                  Open Settings
                </button>
              )}
              <button className="btn btn-accent" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {info && !error && (
          <>
            <h2 id="picker-title" className="picker-title" title={info.title}>
              {info.title}
            </h2>
            <p className="picker-meta mono">
              {[info.uploader, info.durationSeconds ? formatDuration(info.durationSeconds) : null].filter(Boolean).join('  ·  ')}
            </p>

            <div className="chips picker-modes" role="tablist" aria-label="What to download">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  role="tab"
                  aria-selected={mode === m.key}
                  className={`chip ${mode === m.key ? 'is-on' : ''}`}
                  onClick={() => setMode(m.key)}
                  disabled={(m.key !== 'audio' && info.qualities.length === 0) || (m.key === 'video-only' && !videoOnlyPossible)}
                  title={m.hint}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {mode !== 'audio' ? (
              <div className="picker-list" role="radiogroup" aria-label="Quality">
                {listed.map((q) => (
                  <label key={q.height} className={`picker-row ${height === q.height ? 'is-on' : ''}`}>
                    <input type="radio" name="quality" checked={height === q.height} onChange={() => setHeight(q.height)} />
                    <span className="picker-q">{q.label}</span>
                    <span className="picker-codec mono">{q.codec}{q.hasAudio && mode === 'video' ? ' + sound' : ''}</span>
                    <span className="picker-size mono">{sizeFor(q, mode) ? `≈ ${formatBytes(sizeFor(q, mode))}` : 'size unknown'}</span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="picker-list" role="radiogroup" aria-label="Audio format">
                <label className={`picker-row ${audioFormat === 'm4a' ? 'is-on' : ''}`}>
                  <input type="radio" name="audio" checked={audioFormat === 'm4a'} onChange={() => setAudioFormat('m4a')} />
                  <span className="picker-q">M4A</span>
                  <span className="picker-codec mono">original{info.audioKbps ? `, ${info.audioKbps} kbit/s` : ''}</span>
                  <span className="picker-size mono">{info.audioBytes ? `≈ ${formatBytes(info.audioBytes)}` : 'size unknown'}</span>
                </label>
                <label className={`picker-row ${audioFormat === 'mp3' ? 'is-on' : ''}`}>
                  <input type="radio" name="audio" checked={audioFormat === 'mp3'} onChange={() => setAudioFormat('mp3')} />
                  <span className="picker-q">MP3</span>
                  <span className="picker-codec mono">converted, plays everywhere</span>
                  <span className="picker-size mono">{mp3Bytes ? `≈ ${formatBytes(mp3Bytes)}` : 'size unknown'}</span>
                </label>
              </div>
            )}

            {mode !== 'audio' && quality && quality.height > 1080 && (
              <p className="picker-note">
                {quality.label} is only available as {quality.codec}. Windows' Media Player and VLC play it; some older players and TVs may not.
              </p>
            )}

            <div className="picker-extras">
              {info.hasThumbnail && (
                <label className="check">
                  <input type="checkbox" checked={thumbnail} onChange={(e) => setThumbnail(e.target.checked)} />
                  <span>Also save the thumbnail image (JPG)</span>
                </label>
              )}
              {info.subtitles.length > 0 && (
                <label className="field">
                  <span>Subtitles</span>
                  <select value={subtitles} onChange={(e) => setSubtitles(e.target.value)}>
                    <option value="">No subtitles</option>
                    {info.subtitles.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name} (.srt)
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <p className="picker-dest mono" title={directory}>
              <IconFolder width={14} height={14} /> {directory}
            </p>
            <p className="picker-legal">
              Only save videos you have the right to keep, such as your own uploads or videos with a free licence. Downloads use the free
              tool yt-dlp; most sites' terms otherwise allow offline viewing only in their own apps.
            </p>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button ref={confirmRef} className="btn btn-accent" onClick={add} disabled={!canAdd}>
                {adding ? 'Adding…' : `Download ${label}${total ? ` (≈ ${formatBytes(total)})` : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
