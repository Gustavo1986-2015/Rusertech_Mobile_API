import { NextResponse } from 'next/server';

/**
 * Helpers de respuesta.
 *
 * La semántica de códigos es CONTRATO (§0.1 y §3.1) y no se toca:
 *   401 → credencial ausente / desconocida / malformada. La app SIGUE
 *         trackeando y muestra banner ámbar.
 *   403 → credencial CONOCIDA pero revocada por el operador. La app DETIENE
 *         el tracking. Nunca devolver 403 por un typo.
 *   409 → conflicto idempotente (viaje ya cerrado / ya hay uno en curso).
 *   422 → payload inválido. La app NO reintenta ese ítem.
 *   429 → rate limit (solo login).
 */

export const json = (body: unknown, status = 200) =>
  NextResponse.json(body as any, { status });

export const ok = (body: unknown = { ok: true }) => json(body, 200);

export const badRequest = (message: string, extra: Record<string, unknown> = {}) =>
  json({ error: 'invalid_request', message, ...extra }, 400);

/** 401: la credencial no existe o no vino. NO es una revocación. */
export const unauthorized = (message = 'Credencial ausente o desconocida') =>
  json({ error: 'unauthorized', message }, 401);

/** 403: la credencial existe pero el operador la revocó/deshabilitó. */
export const forbidden = (message = 'Credencial revocada por el operador') =>
  json({ error: 'forbidden', message }, 403);

export const notFound = (message = 'No encontrado') =>
  json({ error: 'not_found', message }, 404);

export const conflict = (message: string, extra: Record<string, unknown> = {}) =>
  json({ error: 'conflict', message, ...extra }, 409);

/** 422: payload inválido. `index` identifica el ítem en un batch. */
export const unprocessable = (
  message: string,
  extra: Record<string, unknown> = {},
) => json({ error: 'unprocessable_entity', message, ...extra }, 422);

export const tooManyRequests = (message: string, retryAfterSeconds?: number) => {
  const res = json({ error: 'too_many_requests', message }, 429);
  if (retryAfterSeconds) res.headers.set('Retry-After', String(retryAfterSeconds));
  return res;
};

export const serverError = (message = 'Error del servidor') =>
  json({ error: 'server_error', message }, 500);

/**
 * Envuelve un handler para que un error no capturado sea 500 con log,
 * nunca un stack trace filtrado al cliente.
 */
export function guarded<A extends any[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error('[api] error no capturado:', err);
      return serverError();
    }
  };
}

/** Lee el body JSON; devuelve `undefined` si no es JSON válido. */
export async function readJson<T>(req: Request): Promise<T | undefined> {
  try {
    return (await req.json()) as T;
  } catch {
    return undefined;
  }
}
