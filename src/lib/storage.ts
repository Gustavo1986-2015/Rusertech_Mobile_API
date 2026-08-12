import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * supabase-js sobrevive ÚNICAMENTE para Storage: subir las fotos de carga al
 * bucket privado. Storage no es Postgres, así que no hay forma de llegar por
 * DATABASE_URL. Todo el acceso a datos va por `pg` (ver db.ts).
 *
 * La service role key es SOLO server-side: nunca sale de las env vars.
 */

declare global {
  // eslint-disable-next-line no-var
  var __rusertechStorage: SupabaseClient | undefined;
}

export const BUCKET = process.env.ATTACHMENTS_BUCKET ?? 'cargo-photos';

export function getStorageClient(): SupabaseClient {
  if (!global.__rusertechStorage) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY sin definir');
    }
    global.__rusertechStorage = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return global.__rusertechStorage;
}

/** `cargo-photos/{tenant_id}/{plate}/{yyyy-MM}/{uuid}.jpg` */
export function buildStoragePath(
  tenantId: string,
  plate: string,
  ext: string,
): string {
  const now = new Date();
  const yyyyMM = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${tenantId}/${plate}/${yyyyMM}/${crypto.randomUUID()}.${ext}`;
}

export async function uploadAttachment(
  path: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const { error } = await getStorageClient()
    .storage.from(BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (error) throw new Error(`Storage: ${error.message}`);
}

/** URL firmada de corta duración (10 min). El bucket es privado. */
export async function signAttachmentUrl(path: string): Promise<string | null> {
  const { data, error } = await getStorageClient()
    .storage.from(BUCKET)
    .createSignedUrl(path, 600);
  if (error) {
    console.error('[storage] no se pudo firmar la URL:', error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}
