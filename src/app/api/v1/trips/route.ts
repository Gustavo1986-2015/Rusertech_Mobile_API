import { authenticate } from '@/lib/auth';
import {
  conflict,
  forbidden,
  guarded,
  json,
  readJson,
  serverError,
  unprocessable,
} from '@/lib/http';
import { validateCreateTrip } from '@/lib/payload';
import { createTrip } from '@/lib/trips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/trips — crea el viaje y devuelve el tripId REAL del servidor.
 *
 * La app exige red para crear viaje (decisión de producto, FIX-2): solo con
 * un 200 acá se persiste ActiveTrip en DataStore.
 */
export const POST = guarded(async (req: Request) => {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  const parsed = validateCreateTrip(await readJson(req));
  if (!parsed.ok) return unprocessable(parsed.message);

  const result = await createTrip(auth.ctx, parsed.value);

  switch (result.kind) {
    case 'created':
      return json(result.trip, 200);

    // La base es la autoridad: ya había un viaje en curso para ese vehículo.
    // Se devuelve para que la app lo adopte en vez de crear uno nuevo.
    case 'already_active':
      return conflict('El vehículo ya tiene un viaje en curso', {
        tripId: result.trip.tripId,
        status: result.trip.status,
      });

    case 'vehicle_not_found':
      return unprocessable(
        `Patente no registrada para este operador: ${result.plate}`,
      );

    case 'vehicle_blocked':
      return forbidden(
        result.reason ?? 'El operador bloqueó este vehículo',
      );

    case 'driver_not_found':
      return unprocessable('Conductor no registrado por el operador');

    case 'system_user_missing':
      // Falta correr seed_staging.sql en este tenant.
      console.error(
        '[trips] falta el usuario de sistema mobile@system.rusertech en el tenant',
        auth.ctx.tenantId,
      );
      return serverError(
        'El operador no tiene configurado el usuario de sistema mobile',
      );
  }
});
