import type { DriveItem } from './types.js';

const imageTypes: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon'
};
export function imageMime(item: Pick<DriveItem, 'name' | 'file' | 'folder'>): string | undefined {
  if (item.folder || !item.file) return;
  const mime = item.file.mimeType?.split(';')[0].trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream') return /^image\/[a-z0-9.+-]+$/.test(mime) ? mime : undefined;
  return imageTypes[item.name.split('.').pop()?.toLowerCase() || ''];
}
export type ThumbnailSize = 'medium' | 'large';
