// Download categories: which subfolder a file goes into (when turned on in Settings) and the category
// filter in the list. Pure functions only: shared by the engine and the UI.

export type Category = 'video' | 'music' | 'images' | 'documents' | 'programs' | 'archives';

export interface CategoryInfo {
  key: Category;
  /** Folder name under the download folder, also the label shown in the UI. */
  folder: string;
  extensions: string[];
}

export const CATEGORIES: CategoryInfo[] = [
  { key: 'video', folder: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', '3gp', 'ogv'] },
  { key: 'music', folder: 'Music', extensions: ['mp3', 'm4a', 'flac', 'wav', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'alac'] },
  { key: 'images', folder: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'avif', 'ico'] },
  {
    key: 'documents',
    folder: 'Documents',
    extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'epub', 'csv', 'md'],
  },
  { key: 'programs', folder: 'Programs', extensions: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'apk', 'jar', 'dmg', 'deb', 'rpm'] },
  { key: 'archives', folder: 'Archives', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'cab', 'img'] },
];

const BY_EXTENSION = new Map<string, CategoryInfo>();
for (const c of CATEGORIES) for (const e of c.extensions) BY_EXTENSION.set(e, c);

/** The category of a file name by its extension, or null for anything else (saved in the main folder). */
export function categoryOf(fileName: string): CategoryInfo | null {
  const m = /\.([a-z0-9]{1,12})$/i.exec(fileName.trim());
  return m ? (BY_EXTENSION.get(m[1].toLowerCase()) ?? null) : null;
}

export function categoryByKey(key: string): CategoryInfo | null {
  return CATEGORIES.find((c) => c.key === key) ?? null;
}
