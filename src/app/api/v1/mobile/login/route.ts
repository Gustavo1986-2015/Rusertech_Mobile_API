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
  tenant_id: string;
}

/** Fila de tenant_mobile_config (los CHECK de rango viven en la base). */
interface ConfigRow {
  heartbeat_interval_minutes: number;
  stop_threshold_minutes: number;
  interval_moving_seconds: number;
  interval_idle_seconds: number;
  min_displacement_meters: number;
  max_accuracy_meters: number;
  auto_resume_minutes: number;
}

/** Objeto `config` de la respuesta — contrato en CONTRATO_CONFIG_OPERATIVA.md. */
interface OperationalConfig {
  heartbeatIntervalMinutes: number;
  stopThresholdMinutes: number;
  intervalMovingSeconds: number;
  intervalIdleSeconds: number;
  minDisplacementMeters: number;
  maxAccuracyMeters: number;
  autoResumeMinutes: number;
}

/**
 * Configuración operativa del tenant, para incluir en la respuesta del login.
 *
 * - Sin fila para el tenant → undefined → la clave `config` se OMITE de la
 *   respuesta (ni null ni objeto vacío). Los defaults viven en la app:
 *   duplicarlos acá crearía dos fuentes de verdad.
 * - Cualquier fallo (tabla inaccesible, timeout) → undefined + error en el
 *   log. Un problema de configuración jamás deja a un conductor sin poder
 *   trabajar: el login responde igual.
 *
 * Query SEPARADA y no LEFT JOIN a propósito: con un JOIN, un problema en
 * tenant_mobile_config voltearía la query de activación completa y el login
 * entero. El costo es un round-trip extra SOLO en logins exitosos (el login
 * ocurre una vez por registro, no está en el camino de la telemetría).
 */
async function fetchOperationalConfig(tenantId: string): Promise<OperationalConfig | undefined> {
  try {
    const { rows } = await query<ConfigRow>(
      `select heartbeat_interval_minutes,
              stop_threshold_minutes,
              interval_moving_seconds,
              interval_idle_seconds,
              min_displacement_meters,
              max_accuracy_meters,
              auto_resume_minutes
         from tenant_mobile_config
        where tenant_id = $1
        limit 1`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) return undefined;
    // snake_case (base) → camelCase (JSON), uno a uno.
    return {
      heartbeatIntervalMinutes: row.heartbeat_interval_minutes,
      stopThresholdMinutes: row.stop_threshold_minutes,
      intervalMovingSeconds: row.interval_moving_seconds,
      intervalIdleSeconds: row.interval_idle_seconds,
      minDisplacementMeters: row.min_displacement_meters,
      maxAccuracyMeters: row.max_accuracy_meters,
      autoResumeMinutes: row.auto_resume_minutes,
    };
  } catch (err) {
    console.error(
      '[login] config operativa no disponible (el login sigue sin config):',
      (err as Error).message,
    );
    return undefined;
  }
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
  // ma.tenant_id sale de acá mismo: es lo que la config operativa necesita.
  const { rows } = await query<ActivationRow>(
    `select ma.is_active,
            ma.tenant_id,
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

  // Solo en el login exitoso: los caminos 401/403/404 no pagan la query.
  const config = await fetchOperationalConfig(act.tenant_id);
  return json(
    {
      avlUserCode: act.user_avl_code,
      apiKey: act.api_key,
      // Sin fila o con fallo: la clave no existe en la respuesta.
      ...(config ? { config } : {}),
    },
    200,
  );
});
