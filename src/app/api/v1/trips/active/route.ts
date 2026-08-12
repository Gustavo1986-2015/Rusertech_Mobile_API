import { authenticate } from '@/lib/auth';
import { guarded, json, unprocessable } from '@/lib/http';
import { normalizePlate } from '@/lib/config';
import { findActiveTripByPlate } from '@/lib/trips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/trips/active?plate=XXX
 *
 * Devuelve el viaje en curso o `null`. Se responde 200 con cuerpo `null`
 * (no 204): la app declara `Response<TripResponse?>` y un cuerpo vacío
 * rompería el converter de kotlinx-serialization.
 */
export const GET = guarded(async (req: Request) => {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  const plateParam = new URL(req.url).searchParams.get('plate');
  if (!plateParam?.trim()) {
    return unprocessable('El parámetro plate es obligatorio');
  }

  const trip = await findActiveTripByPlate(auth.ctx, normalizePlate(plateParam));
  return json(trip, 200);
});
