import { query } from '@/lib/db';
import { clearLoginAttempts, isLoginRateLimited, recordFailedLogin } from '@/lib/auth';
import {
  forbidden,
  guarded,
  json,
  notFound,
  readJson,
  tooManyRequests,
  unauthorized,
  unprocessable,
} from '@/lib/http';
import { validateLogin } from '@/lib/payload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ActivationRow {
  is_active: boolean;
  driver_document: string | null;
  vehicle_plate: string;
  avl_is_active: boolean;
  user_avl_code: string;
  api_key: string;
}

/**
 * POST /api/v1/mobile/login  — único endpoint SIN X-Hub-Api-Key.
 *
 * 401 → código de activación inválido o dado de baja
 * 404 → el código existe pero el DNI/patente no coinciden
 * 403 → el avl_user del operador está desactivado
 * 429 → más de 5 intentos fallidos con el mismo DNI en 10 min
 */
export const POST = guarded(async (req: Request) => {
  const parsed = validateLogin(await readJson(req));
  if (!parsed.ok) return unprocessable(parsed.message);

  const { documentId, plate, activationCode } = parsed.value;

  const retryAfter = isLoginRateLimited(documentId);
  if (retryAfter !== null) {
    return tooManyRequests('Demasiados intentos, esperá unos minutos', retryAfter);
  }

  // activation_code es UNIQUE GLOBAL: el login no conoce el tenant.
  const { rows } = await query<ActivationRow>(
    `select ma.is_active,
            d.document      as driver_document,
            v.plate         as vehicle_plate,
            au.is_active    as avl_is_active,
            au.user_avl_code,
            au.api_key
       from mobile_activations ma
       join drivers   d  on d.id  = ma.driver_id
       join vehicles  v  on v.id  = ma.vehicle_id
       join avl_users au on au.id = ma.avl_user_id
      where ma.activation_code = $1
      limit 1`,
    [activationCode],
  );

  const act = rows[0];

  if (!act || !act.is_active) {
    recordFailedLogin(documentId);
    return unauthorized('Código de activación inválido o expirado');
  }

  // El código es correcto, pero tiene que ser de ESTE conductor y ESTE vehículo.
  const documentMatches = (act.driver_document ?? '').trim() === documentId;
  const plateMatches = act.vehicle_plate.trim().toUpperCase() === plate;
  if (!documentMatches || !plateMatches) {
    recordFailedLogin(documentId);
    return notFound('Documento o patente no encontrados');
  }

  // Revocación deliberada del operador → 403, no 401.
  if (!act.avl_is_active) {
    return forbidden('Conductor o vehículo no asociado a este operador');
  }

  clearLoginAttempts(documentId);
  return json({ avlUserCode: act.user_avl_code, apiKey: act.api_key }, 200);
});
