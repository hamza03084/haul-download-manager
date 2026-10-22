// Types shared by the main process, the preload bridge and the renderer.
// This file must only contain types, plain constants and pure helpers (no Node or DOM imports).
// The sandboxed preload may import it for types only.

export type DownloadState = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** `http`: a direct file link fetched by Haul's own engine. `media`: a video page fetched through yt-dlp. */
export type DownloadKind = 'http' | 'media';

export interface DownloadRecord {
  id: string;
  kind: DownloadKind;
  /** The URL the user asked for. Resumes always restart from this URL (redirect targets may expire). */
  url: string;
  /** Last URL reached after following redirects. */
  finalUrl: string | null;
  fileName: string;
  directory: string;
  /** True once the file name is final (chosen by the user or derived from the first server response). */
  fileNameSettled: boolean;
  state: DownloadState;
  totalBytes: number | null;
  downloadedBytes: number;
  /** null = unknown, true = server advertised byte ranges, false = server cannot resume. */
  resumable: boolean | null;
  etag: string | null;
  lastModified: string | null;
  error: string | null;
  /** Informational message, e.g. "Server does not support resume; restarted from the beginning". */
  notice: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** For `media` downloads: what was chosen in the quality picker. */
  media: MediaSpec | null;
  /**
   * True while the download still has to be moved into a category subfolder (Video, Music…) of
   * `directory` once its file name is known. Cleared as soon as that has been done.
   */
  autoCategory: boolean;
}

export interface DownloadView extends DownloadRecord {
  /** Bytes per second averaged over the last few seconds (0 when not downloading). */
  speed: number;
  /** Estimated seconds remaining, or null when it cannot be estimated. */
  etaSeconds: number | null;
  /** For completed downloads: false when the file has since been moved or deleted. */
  fileExists: boolean;
  /** What a running media download is doing right now, e.g. "Downloading audio (2 of 2)". */
  phase: string | null;
}

export interface Settings {
  downloadDirectory: string;
  maxConcurrent: number;
  resumeOnStartup: boolean;
  /** Full path of yt-dlp.exe, or '' to find it automatically (Haul's own copy, PATH, winget). */
  ytDlpPath: string;
  /** Download yt-dlp, FFmpeg and Deno into Haul's own folder when needed, and keep yt-dlp up to date. */
  autoMediaTools: boolean;
  /** Total download speed limit in bytes per second, shared by all downloads; 0 = no limit. */
  speedLimit: number;
  /** Save downloads in a subfolder of the download folder named after their type (Video, Music, …). */
  categoriesEnabled: boolean;
  /** Start Haul (hidden in the notification area) when the user signs in to Windows. */
  startWithWindows: boolean;
  /** Closing the window keeps Haul running in the notification area instead of quitting. */
  closeToTray: boolean;
}

export const MAX_CONCURRENT_LIMIT = 10;
/** Highest accepted speed limit: 1 GB/s (anything above is "no limit" in practice). */
export const MAX_SPEED_LIMIT = 1024 * 1024 * 1024;

/** Every setting except the download folder, as on a fresh profile. */
export const SETTINGS_DEFAULTS: Omit<Settings, 'downloadDirectory'> = {
  maxConcurrent: 3,
  resumeOnStartup: true,
  ytDlpPath: '',
  autoMediaTools: true,
  speedLimit: 0,
  categoriesEnabled: false,
  startWithWindows: false,
  closeToTray: false,
};

/** "Shut down the PC when downloads finish": whether it is armed, and the countdown once everything is done. */
export interface PowerState {
  armed: boolean;
  /** Time (ms since epoch) at which Windows will be shut down, or null while no countdown is running. */
  shutdownAt: number | null;
  /** True when this build cannot shut down the PC (not Windows); the option is then hidden. */
  unavailable: boolean;
}

// ------------------------------------------------------------------ video pages (yt-dlp)

export type MediaMode = 'video' | 'video-only' | 'audio';
export type AudioFormat = 'm4a' | 'mp3';

/** What the user picked in the quality chooser. */
export interface MediaChoice {
  mode: MediaMode;
  /** Video height in pixels (e.g. 1080) for the video modes. */
  height: number | null;
  /** Container for audio-only downloads. */
  audioFormat: AudioFormat | null;
  /** Also save the thumbnail as a .jpg next to the file. */
  thumbnail: boolean;
  /** Language code of subtitles to save as .srt next to the file, or null. */
  subtitles: string | null;
  /** yt-dlp format IDs of the streams shown in the picker (fallbacks are used if they disappear). */
  videoFormatId: string | null;
  audioFormatId: string | null;
}

export interface MediaSpec extends MediaChoice {
  videoId: string;
  title: string;
  /** Short description shown on the card, e.g. "1080p60 · H.264". */
  label: string;
  /** Size estimates from the probe (bytes), used until real sizes are known. */
  estimateVideo: number | null;
  estimateAudio: number | null;
}

export interface MediaQuality {
  height: number;
  fps: number | null;
  /** Codec family yt-dlp is expected to pick at this height, e.g. "H.264", "VP9", "AV1". */
  codec: string;
  label: string;
  /** Estimated bytes of the video stream alone. */
  videoBytes: number | null;
  formatId: string;
}

/** Result of asking yt-dlp what a video page offers. */
export interface MediaInfo {
  url: string;
  videoId: string;
  title: string;
  uploader: string | null;
  durationSeconds: number | null;
  qualities: MediaQuality[];
  /** Estimated bytes of the best audio stream. */
  audioBytes: number | null;
  audioKbps: number | null;
  audioFormatId: string | null;
  subtitles: { code: string; name: string }[];
  hasThumbnail: boolean;
}

export interface MediaToolsStatus {
  ytDlp: string | null;
  ytDlpVersion: string | null;
  ffmpeg: string | null;
  /** JavaScript runtime yt-dlp needs for YouTube (Deno or Node.js), if found. */
  jsRuntime: string | null;
  /** Human-readable summary of what is missing, or null when everything needed is there. */
  problem: string | null;
  /** True when the yt-dlp in use is the copy Haul downloaded and keeps up to date. */
  managed: boolean;
  /** Progress of getting the tools automatically, or null when that is turned off. */
  install: ToolInstallStatus | null;
}

/** Haul getting yt-dlp, FFmpeg and Deno by itself. */
export interface ToolInstallStatus {
  /** `idle`: nothing running. `installing`: downloading `tool`. `failed`: the last attempt failed with `error`. */
  state: 'idle' | 'installing' | 'failed';
  /** Name of the tool being downloaded, e.g. "FFmpeg". */
  tool: string | null;
  received: number;
  total: number | null;
  error: string | null;
}

export interface AddDownloadRequest {
  url: string;
  directory?: string;
  fileName?: string;
  /** Add in the paused state instead of queueing immediately. */
  startPaused?: boolean;
  /** For video pages: the choice from the quality picker plus what the probe reported. */
  media?: MediaChoice & { videoId: string; title: string; label: string; estimateVideo: number | null; estimateAudio: number | null };
}

export type ActionResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

/** API exposed to the renderer by the preload script as `window.haul`. */
export interface HaulApi {
  listDownloads(): Promise<DownloadView[]>;
  addDownload(req: AddDownloadRequest): Promise<ActionResult<DownloadView>>;
  pause(id: string): Promise<ActionResult>;
  resume(id: string): Promise<ActionResult>;
  retry(id: string): Promise<ActionResult>;
  cancel(id: string): Promise<ActionResult>;
  /** Replaces the link of a paused, failed or cancelled download (for expired links) and starts it again. */
  changeUrl(id: string, url: string): Promise<ActionResult<DownloadView>>;
  remove(id: string, deleteFile: boolean): Promise<ActionResult>;
  pauseAll(): Promise<ActionResult>;
  resumeAll(): Promise<ActionResult>;
  clearFinished(): Promise<ActionResult>;
  openFile(id: string): Promise<ActionResult>;
  showInFolder(id: string): Promise<ActionResult>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<ActionResult<Settings>>;
  chooseDirectory(initial?: string): Promise<string | null>;
  chooseExecutable(initial?: string): Promise<string | null>;
  readClipboardUrl(): Promise<string | null>;
  takePendingAddRequests(): Promise<string[]>;
  getVersion(): Promise<string>;
  probeMedia(url: string): Promise<ActionResult<MediaInfo>>;
  cancelProbe(): Promise<void>;
  getMediaTools(): Promise<MediaToolsStatus>;
  /** Gets missing tools and checks for a newer yt-dlp now. */
  updateMediaTools(): Promise<ActionResult>;
  onMediaToolsProgress(cb: (s: ToolInstallStatus) => void): () => void;
  getPower(): Promise<PowerState>;
  /** Arms or disarms "shut down the PC when downloads finish"; disarming also stops a running countdown. */
  setShutdownWhenDone(armed: boolean): Promise<ActionResult<PowerState>>;
  onPowerChanged(cb: (s: PowerState) => void): () => void;
  onDownloadChanged(cb: (d: DownloadView) => void): () => void;
  onDownloadRemoved(cb: (id: string) => void): () => void;
  onAddRequest(cb: (url: string) => void): () => void;
}

/** Hosts whose links are video pages handled through yt-dlp rather than direct downloads. */
export const MEDIA_PAGE_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

export function isMediaPageUrl(input: string): boolean {
  try {
    const u = new URL(input.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && MEDIA_PAGE_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}
