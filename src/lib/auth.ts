import { query } from './db';
import { forbidden, unauthorized } from './http';
import {
  LOGIN_MAX_FAILURES_IDENTITY,
  LOGIN_MAX_FAILURES_IP,
  LOGIN_WINDOW_MINUTES,
} from './config';

export const API_KEY_HEADER = 'x-hub-api-key';

export interface AuthContext {
  avlUserId: string;
  tenantId: string;
  userAvlCode: string;
}

interface AvlUserRow {
  id: string;
  tenant_id: string;
  user_avl_code: string;
  is_active: boolean;
}

/**
 * Autenticación de todos los endpoints salvo login.
 *
 * Distinción DELIBERADA y no negociable (§0.1):
 *   - header ausente o api_key que NO EXISTE  → 401 (la app sigue trackeando)
 *   - api_key que EXISTE con is_active=false  → 403 (la app detiene el tracking)
 *
 * Devuelve el contexto, o una Response de error lista para retornar.
 */
export async function authenticate(
  req: Request,
): Promise<{ ctx: AuthContext } | { error: Response }> {
  const apiKey = req.headers.get(API_KEY_HEADER)?.trim();
  if (!apiKey) {
    return { error: unauthorized('Falta el header X-Hub-Api-Key') };
  }

  const { rows } = await query<AvlUserRow>(
    `select id, tenant_id, user_avl_code, is_active
       from avl_users
      where api_key = $1
      limit 1`,
    [apiKey],
  );

  const user = rows[0];

  // La key no existe: typo o credencial vieja. NUNCA 403 acá.
  if (!user) {
    return { error: unauthorized('API Key desconocida') };
  }

  // La key existe pero el operador la dio de baja: esto SÍ es 403.
  if (!user.is_active) {
    return { error: forbidden('Credencial revocada por el operador') };
  }

  return {
    ctx: {
      avlUserId: user.id,
      tenantId: user.tenant_id,
      userAvlCode: user.user_avl_code,
    },
  };
}

// ---------------------------------------------------------------------
// Rate limit de login — contra mobile_login_attempts.
//
// Reemplaza el conteo en memoria del proceso (que era por instancia de
// Vercel, no global). La tabla registra CADA intento, exitoso o fallido, y
// el bloqueo cuenta solo los fallidos de la ventana: 5 por documento+patente
// o 20 por IP en 15 minutos.
// ---------------------------------------------------------------------

/** IP y user agent del request. En Vercel la IP viene en x-forwarded-for
 *  (primer salto); si falta, centinela 'unknown' — la columna es NOT NULL y
 *  un header ausente jamás puede tumbar un login. */
export function extractClientContext(req: Request): { ipAddress: string; userAgent: string | null } {
  const forwarded = req.headers.get('x-forwarded-for');
  const ipAddress = forwarded?.split(',')[0]?.trim() || 'unknown';
  return { ipAddress: ipAddress.slice(0, 45), userAgent: req.headers.get('user-agent') };
}

/**
 * @returns segundos de Retry-After si está bloqueado, o null si puede seguir.
 *
 * FAIL-OPEN deliberado: si la consulta falla (base inaccesible), se loguea y
 * el login continúa. Dejar a todos los conductores afuera por una falla del
 * anti-fuerza-bruta sería peor que el riesgo que mitiga.
 */
export async function isLoginRateLimited(
  documentId: string,
  plate: string,
  ipAddress: string,
): Promise<number | null> {
  try {
    const { rows } = await query<{
      ident_failures: string;
      ip_failures: string;
      ident_oldest: string | null;
      ip_oldest: string | null;
    }>(
      `select
         count(*) filter (where document_id = $1 and plate = $2)          as ident_failures,
         count(*) filter (where ip_address = $3)                          as ip_failures,
         min(created_at) filter (where document_id = $1 and plate = $2)   as ident_oldest,
         min(created_at) filter (where ip_address = $3)                   as ip_oldest
       from mobile_login_attempts
      where success = false
        and created_at > now() - ($4 || ' minutes')::interval
        and ((document_id = $1 and plate = $2) or ip_address = $3)`,
      [documentId, plate, ipAddress, String(LOGIN_WINDOW_MINUTES)],
    );
    const r = rows[0];
    const identBlocked = Number(r.ident_failures) >= LOGIN_MAX_FAILURES_IDENTITY;
    const ipBlocked = Number(r.ip_failures) >= LOGIN_MAX_FAILURES_IP;
    if (!identBlocked && !ipBlocked) return null;

    // El bloqueo se levanta cuando el fallo más viejo sale de la ventana.
    const oldest = identBlocked ? r.ident_oldest : r.ip_oldest;
    if (!oldest) return LOGIN_WINDOW_MINUTES * 60;
    const liftMs = new Date(oldest).getTime() + LOGIN_WINDOW_MINUTES * 60_000 - Date.now();
    return Math.max(1, Math.ceil(liftMs / 1000));
  } catch (err) {
    console.error('[auth] rate limit no disponible (el login sigue):', (err as Error).message);
    return null;
  }
}

/**
 * Registra un intento de login. NUNCA puede tumbar el login: cualquier fallo
 * del INSERT se loguea y se sigue — misma regla que la config operativa.
 * Los valores se truncan al ancho real de cada columna para que un input
 * largo no convierta el registro en un error.
 */
export async function recordLoginAttempt(attempt: {
  documentId: string;
  plate: string;
  ipAddress: string;
  userAgent: string | null;
  success: boolean;
  failureReason?: string;
}): Promise<void> {
  try {
    await query(
      `insert into mobile_login_attempts
         (document_id, plate, ip_address, user_agent, success, failure_reason)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        attempt.documentId.slice(0, 20),
        attempt.plate.slice(0, 10),
        (attempt.ipAddress || 'unknown').slice(0, 45),
        attempt.userAgent,
        attempt.success,
        attempt.failureReason?.slice(0, 50) ?? null,
      ],
    );
  } catch (err) {
    console.error('[auth] no se pudo registrar el intento de login (se sigue):', (err as Error).message);
  }
}
