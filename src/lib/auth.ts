import { query } from './db';
import { forbidden, unauthorized } from './http';
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } from './config';

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

/**
 * Rate limit de login: máx. 5 intentos FALLIDOS por DNI cada 10 min (§4.5).
 *
 * Se cuenta en memoria del proceso. Limitación conocida y aceptada para el
 * piloto: Vercel puede tener varias instancias de función vivas, así que el
 * límite es por instancia, no global. La base está congelada (no se pueden
 * crear tablas) y no se quiso sumar otro servicio (KV/Redis) por una función
 * anti-fuerza-bruta de un piloto. Si el volumen lo justifica, el reemplazo
 * natural es Vercel KV sin tocar nada más de este archivo.
 */
const attempts = new Map<string, number[]>();

function prune(list: number[], now: number): number[] {
  return list.filter((t) => now - t < LOGIN_WINDOW_MS);
}

export function isLoginRateLimited(documentId: string): number | null {
  const now = Date.now();
  const list = prune(attempts.get(documentId) ?? [], now);
  attempts.set(documentId, list);
  if (list.length < LOGIN_MAX_ATTEMPTS) return null;
  const oldest = list[0];
  return Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - oldest)) / 1000));
}

export function recordFailedLogin(documentId: string): void {
  const now = Date.now();
  const list = prune(attempts.get(documentId) ?? [], now);
  list.push(now);
  attempts.set(documentId, list);
}

export function clearLoginAttempts(documentId: string): void {
  attempts.delete(documentId);
}
