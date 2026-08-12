import { authenticate } from '@/lib/auth';
import { guarded, json, readJson, unprocessable } from '@/lib/http';
import { validatePoint } from '@/lib/payload';
import { ingestPoints } from '@/lib/telemetry';
import { after, dispatchAlerts } from '@/lib/notifier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/telemetry/ingest — UN HubRawPayload.
 *
 * Es el camino rápido del SOS: insert directo, sin trabajo extra antes de
 * responder. Los avisos salen DESPUÉS de la respuesta (§4.8).
 */
export const POST = guarded(async (req: Request) => {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  const parsed = validatePoint(await readJson(req));
  if (!parsed.ok) return unprocessable(parsed.message);

  const result = await ingestPoints(auth.ctx, [parsed.value]);
  if (!result.ok) return unprocessable(result.message);

  // Se responde YA. El email/webhook nunca entra en el presupuesto del SOS.
  if (result.events.length > 0) after(dispatchAlerts(auth.ctx, result.events));

  return json({ inserted: result.inserted, duplicates: result.duplicates }, 200);
});
