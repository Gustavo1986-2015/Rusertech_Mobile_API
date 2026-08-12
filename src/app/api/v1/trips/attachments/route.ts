import { authenticate } from '@/lib/auth';
import { query } from '@/lib/db';
import { guarded, json, unprocessable } from '@/lib/http';
import { ATTACHMENT_MAX_BYTES, normalizeDocument, normalizePlate } from '@/lib/config';
import { buildStoragePath, signAttachmentUrl, uploadAttachment } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const field = (form: FormData, name: string): string | null => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

const numField = (form: FormData, name: string): number | null => {
  const raw = field(form, name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * POST /api/v1/trips/attachments — foto de carga (multipart, ≤ 2 MB).
 *
 * Sube al bucket privado y devuelve `{ id, url }` con URL firmada de corta
 * duración. La app ya comprime a ≤ 500 KB antes de subir (ImageCompressor);
 * el límite de 2 MB es el techo duro del backend.
 */
export const POST = guarded(async (req: Request) => {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return unprocessable('El body debe ser multipart/form-data');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return unprocessable('Falta el archivo en el campo "file"');
  }
  if (file.size === 0) return unprocessable('El archivo está vacío');
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return unprocessable(
      `El archivo supera el máximo de ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB`,
    );
  }

  const contentType = file.type || 'image/jpeg';
  const ext = EXT_BY_MIME[contentType];
  if (!ext) return unprocessable(`Tipo de imagen no soportado: ${contentType}`);

  const plateRaw = field(form, 'plate') ?? field(form, 'vehicleId');
  if (!plateRaw) return unprocessable('plate es obligatorio');
  const plate = normalizePlate(plateRaw);

  const type = field(form, 'type');
  if (!type) return unprocessable('type es obligatorio');

  const tripId = field(form, 'tripId');
  if (tripId && !UUID_RE.test(tripId)) {
    return unprocessable('tripId debe ser un UUID válido');
  }

  // --- vehículo del tenant ------------------------------------------------
  const { rows: vehicles } = await query<{ id: string }>(
    `select id from vehicles where tenant_id = $1 and plate = $2 limit 1`,
    [auth.ctx.tenantId, plate],
  );
  if (!vehicles[0]) {
    return unprocessable(`Patente no registrada para este operador: ${plate}`);
  }

  // El viaje es opcional (la foto puede sacarse fuera de un viaje), pero si
  // viene tiene que ser de este tenant: si no, se guarda sin viaje asociado.
  let tripIdToStore: string | null = null;
  if (tripId) {
    const { rows } = await query<{ id: string }>(
      `select id from trips where id = $1 and tenant_id = $2 limit 1`,
      [tripId, auth.ctx.tenantId],
    );
    tripIdToStore = rows[0]?.id ?? null;
  }

  // --- subida -------------------------------------------------------------
  const storagePath = buildStoragePath(auth.ctx.tenantId, plate, ext);
  await uploadAttachment(storagePath, await file.arrayBuffer(), contentType);

  const driverDocument = field(form, 'driverDocument') ?? field(form, 'driverDni');

  const { rows } = await query<{ id: string }>(
    `insert into trip_attachments
       (tenant_id, trip_id, vehicle_id, driver_document, type, notes,
        latitude, longitude, storage_path)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [
      auth.ctx.tenantId,
      tripIdToStore,
      vehicles[0].id,
      driverDocument ? normalizeDocument(driverDocument) : null,
      type,
      field(form, 'notes'),
      numField(form, 'latitude'),
      numField(form, 'longitude'),
      storagePath,
    ],
  );

  return json({ id: rows[0].id, url: await signAttachmentUrl(storagePath) }, 200);
});
