import { authenticate } from '@/lib/auth';
import { conflict, guarded, json, notFound, unprocessable } from '@/lib/http';
import { completeTrip } from '@/lib/trips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/v1/trips/{tripId}/complete — cierre IDEMPOTENTE.
 *
 * 200 → se cerró ahora
 * 409 → ya estaba cerrado (la app lo trata como éxito y limpia PENDING_TRIP_CLOSE)
 * 404 → el viaje no existe (la app también lo trata como cerrado)
 *
 * También limpia driver_state (FIX-10): un viaje terminado no tiene estado
 * operativo.
 */
export const POST = guarded(
  async (req: Request, { params }: { params: { tripId: string } }) => {
    const auth = await authenticate(req);
    if ('error' in auth) return auth.error;

    const { tripId } = params;
    if (!UUID_RE.test(tripId)) {
      return unprocessable('tripId debe ser un UUID válido');
    }

    const result = await completeTrip(auth.ctx, tripId);

    switch (result.kind) {
      case 'completed':
        return json(result.trip, 200);
      case 'already_completed':
        return conflict('El viaje ya estaba cerrado', {
          tripId: result.trip.tripId,
          status: result.trip.status,
        });
      case 'not_found':
        return notFound('Viaje no encontrado');
    }
  },
);
