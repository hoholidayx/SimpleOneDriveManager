export interface Account { id: string; name: string; username: string }
export interface AuthStatus { configured: boolean; missing: string[]; connected: boolean; account: Account | null; csrfToken: string; redirectUri: string; origin: string }
export interface Drive { id: string; name: string; driveType: string; quota?: { total?: number; used?: number; remaining?: number; state?: string } }
export interface DriveItem {
  id: string; name: string; size: number; eTag?: string; lastModifiedDateTime?: string;
  webUrl?: string; folder?: { childCount: number }; file?: { mimeType?: string };
  parentReference?: { id?: string; driveId?: string; path?: string };
}
export interface FolderPage { items: DriveItem[]; nextCursor?: string }
export interface Breadcrumb { id: string; name: string }
export interface ItemDetails { item: DriveItem; breadcrumbs: Breadcrumb[] }
export type ConflictBehavior = 'fail' | 'replace' | 'rename';
export type UploadState = 'pending' | 'uploading' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'expired';
export interface UploadTask {
  id: string; name: string; sourceName?: string; size: number; lastModified: number; parentId: string;
  offset: number; state: UploadState; expiresAt?: string; error?: string;
  createdAt: number; updatedAt: number; item?: DriveItem;
}
export interface BatchResult { id: string; ok: boolean; error?: string; code?: string }
export interface ApiErrorBody { error: { code: string; message: string; requestId?: string } }
export const CHUNK_SIZE = 10 * 1024 * 1024;
