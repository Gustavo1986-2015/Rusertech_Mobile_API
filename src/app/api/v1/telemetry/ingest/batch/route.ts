import { authenticate } from '@/lib/auth';
import { guarded, json, readJson, unprocessable } from '@/lib/http';
import { validatePoint, type NormalizedPoint } from '@/lib/payload';
import { ingestPoints } from '@/lib/telemetry';
import { BATCH_MAX_ITEMS } from '@/lib/config';
import { after, dispatchAlerts } from '@/lib/notifier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/telemetry/ingest/batch — array de HubRawPayload (máx. 50).
 *
 * Devuelve 200 aunque TODO el lote sea duplicado: para la app significa
 * "el backend ya tiene estos puntos, borralos de Room".
 * Un ítem malformado devuelve 422 con su índice; la app no reintenta ese ítem.
 */
export const POST = guarded(async (req: Request) => {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  const body = await readJson<unknown>(req);
  if (!Array.isArray(body)) {
    return unprocessable('El body debe ser un array de HubRawPayload');
  }
  if (body.length > BATCH_MAX_ITEMS) {
    return unprocessable(`El lote supera el máximo de ${BATCH_MAX_ITEMS} puntos`, {
      max: BATCH_MAX_ITEMS,
      received: body.length,
    });
  }

  const points: NormalizedPoint[] = [];
  for (let i = 0; i < body.length; i++) {
    const parsed = validatePoint(body[i]);
    if (!parsed.ok) return unprocessable(parsed.message, { index: i });
    points.push(parsed.value);
  }

  const result = await ingestPoints(auth.ctx, points);
  if (!result.ok) return unprocessable(result.message, { index: result.index });

  if (result.events.length > 0) after(dispatchAlerts(auth.ctx, result.events));

  return json(
    {
      received: result.received,
      inserted: result.inserted,
      duplicates: result.duplicates,
    },
    200,
  );
});
