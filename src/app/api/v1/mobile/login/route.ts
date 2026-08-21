import { query } from '@/lib/db';
import { extractClientContext, isLoginRateLimited, recordLoginAttempt } from '@/lib/auth';
import { MOBILE_AVL_USER_CODE } from '@/lib/config';
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
  id: string;
  tenant_id: string;
  vigente: boolean;
  used_at: string | null;
  driver_document: string | null;
  vehicle_plate: string;
  vehicle_avl_active: boolean | null;
}

interface MobileAvlRow {
  user_avl_code: string;
  api_key: string;
  is_active: boolean;
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
 * tenant_mobile_config voltearía la consulta principal y el login entero.
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
 * POST /api/v1/mobile/login — único endpoint SIN X-Hub-Api-Key.
 *
 * Contra la base del SaaS: mobile_activation_codes (vigencia por
 * revoked_at/expires_at, sin is_active) + avl_user compartido de ingesta
 * 'Rusertech_Mobile' (el avl_user del VEHÍCULO solo aporta el switch de
 * revocación por vehículo).
 *
 * Distinción de códigos — regla dura del proyecto, la app depende de ella:
 *   401 → código inválido, revocado o expirado
 *   404 → el código existe pero documento o patente no coinciden
 *   403 → avl_user desactivado (revocación deliberada del operador; la app
 *         detiene el tracking y bloquea el botón de inicio)
 *   429 → rate limit (mobile_login_attempts: 5 fallos por documento+patente
 *         o 20 por IP, en 15 minutos)
 *
 * Cada intento —exitoso o no— queda registrado en mobile_login_attempts.
 */
export const POST = guarded(async (req: Request) => {
  const { ipAddress, userAgent } = extractClientContext(req);
  const parsed = validateLogin(await readJson(req));
  if (!parsed.ok) {
    await recordLoginAttempt({
      documentId: '', plate: '', ipAddress, userAgent,
      success: false, failureReason: 'invalid_payload',
    });
    return unprocessable(parsed.message);
  }

  const { documentId, plate, activationCode } = parsed.value;
  const attempt = { documentId, plate, ipAddress, userAgent };

  // Rate limit ANTES de validar credenciales (y el intento frenado también
  // se registra: sigue contando para la ventana).
  const retryAfter = await isLoginRateLimited(documentId, plate, ipAddress);
  if (retryAfter !== null) {
    await recordLoginAttempt({ ...attempt, success: false, failureReason: 'rate_limited' });
    return tooManyRequests('Demasiados intentos, esperá unos minutos', retryAfter);
  }

  // Búsqueda POR CÓDIGO solo (sin filtrar por documento/patente en el JOIN):
  // filtrar en SQL colapsaría 401 y 404 en un mismo "no hay fila". El código
  // se busca, y documento/patente se comparan después — así cada causa
  // conserva su código HTTP.
  const { rows } = await query<ActivationRow>(
    `select mac.id,
            mac.tenant_id,
            (mac.revoked_at is null and mac.expires_at > now()) as vigente,
            mac.used_at,
            d.document      as driver_document,
            v.plate         as vehicle_plate,
            vau.is_active   as vehicle_avl_active
       from mobile_activation_codes mac
       join drivers  d  on d.id = mac.driver_id
       join vehicles v  on v.id = mac.vehicle_id
       left join avl_users vau on vau.id = v.avl_user_id
      where mac.activation_code = $1
      limit 1`,
    [activationCode],
  );

  const act = rows[0];

  // Código inexistente, revocado o expirado → 401, indistinguibles a
  // propósito (no confirmar a un atacante que un código existe).
  if (!act || !act.vigente) {
    await recordLoginAttempt({ ...attempt, success: false, failureReason: 'invalid_code' });
    return unauthorized('Código de activación inválido o expirado');
  }

  // El código es correcto, pero tiene que ser de ESTE conductor y ESTE vehículo.
  const documentMatches = (act.driver_document ?? '').trim() === documentId;
  const plateMatches = act.vehicle_plate.trim().toUpperCase() === plate;
  if (!documentMatches || !plateMatches) {
    await recordLoginAttempt({ ...attempt, success: false, failureReason: 'identity_mismatch' });
    return notFound('Documento o patente no encontrados');
  }

  // Revocación deliberada por vehículo: el avl_user del vehículo está de
  // baja. (Si el vehículo no tiene avl_user asignado, no hay switch: sigue.)
  if (act.vehicle_avl_active === false) {
    await recordLoginAttempt({ ...attempt, success: false, failureReason: 'avl_disabled' });
    return forbidden('Conductor o vehículo no asociado a este operador');
  }

  // Credenciales de ingesta: el avl_user compartido Rusertech_Mobile del
  // tenant. Todo payload viaja con User_avl = su código.
  const { rows: avlRows } = await query<MobileAvlRow>(
    `select user_avl_code, api_key, is_active
       from avl_users
      where tenant_id = $1 and user_avl_code = $2
      limit 1`,
    [act.tenant_id, MOBILE_AVL_USER_CODE],
  );
  const mobileAvl = avlRows[0];

  if (!mobileAvl) {
    // Tenant mal aprovisionado: error claro, no inventar credenciales.
    await recordLoginAttempt({ ...attempt, success: false, failureReason: 'tenant_misprovisioned' });
    return json(
      { error: `Tenant sin avl_user '${MOBILE_AVL_USER_CODE}': contactá al operador` },
      500,
    );
  }
  if (!mobileAvl.is_active) {
    // Kill-switch deliberado de toda la ingesta mobile del tenant.
    await recordLoginAttempt({ ...attempt, success: false, failureReason: 'avl_disabled' });
    return forbidden('Conductor o vehículo no asociado a este operador');
  }

  // Trazabilidad de primer uso. No bloquea reusos: el código sigue siendo
  // válido hasta revoked_at/expires_at. Y jamás tumba el login.
  if (!act.used_at) {
    try {
      await query(
        `update mobile_activation_codes set used_at = now()
          where id = $1 and used_at is null`,
        [act.id],
      );
    } catch (err) {
      console.error('[login] no se pudo marcar used_at (el login sigue):', (err as Error).message);
    }
  }

  await recordLoginAttempt({ ...attempt, success: true });

  // Configuración operativa por tenant: se incluye si existe (puede no
  // existir — la app opera con sus defaults locales).
  const config = await fetchOperationalConfig(act.tenant_id);
  return json(
    {
      avlUserCode: mobileAvl.user_avl_code,
      apiKey: mobileAvl.api_key,
      ...(config ? { config } : {}),
    },
    200,
  );
});
