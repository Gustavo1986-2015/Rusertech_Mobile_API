import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/**
 * Pool de conexiones a Postgres.
 *
 * Reglas de producción (Vercel + Supabase Supavisor):
 *  1. DATABASE_URL DEBE apuntar al Transaction Pooler (puerto 6543), nunca
 *     a la conexión directa 5432. Serverless = muchas conexiones cortas.
 *  2. El pool vive a NIVEL DE MÓDULO: Vercel reutiliza instancias de función,
 *     así que un pool por request agotaría la base en el primer pico.
 *  3. `max` bajo: cada instancia de lambda mantiene como mucho 3 conexiones.
 *  4. Sin prepared statements CON NOMBRE: el transaction mode de Supavisor
 *     no los soporta. `pg` en modo default no los usa mientras no se pase
 *     `name` en la query — y acá no se pasa nunca. Por eso tampoco hay ORM.
 *  5. La conexión entra como rol `postgres` y por lo tanto bypassea RLS.
 *     Es lo esperado del lado servidor (misma postura que la service role key).
 *     DATABASE_URL jamás sale de las env vars de Vercel.
 */

declare global {
  // eslint-disable-next-line no-var
  var __rusertechPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL no está definida');
  }

  const isLocal =
    connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

  return new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // Supabase presenta un certificado que no está en el trust store por
    // defecto de Node; sin esto el pooler rechaza. En local no hay TLS.
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
  });
}

export function getPool(): Pool {
  if (!global.__rusertechPool) {
    global.__rusertechPool = createPool();
    global.__rusertechPool.on('error', (err) => {
      console.error('[db] error en cliente idle del pool:', err.message);
    });
  }
  return global.__rusertechPool;
}

/** Query suelta, sin transacción. */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params: any[] = [],
) {
  return getPool().query<T>(text, params);
}

/**
 * Ejecuta `fn` dentro de una transacción y garantiza el release del cliente.
 * Si `fn` lanza, hace ROLLBACK y re-lanza.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* la conexión ya puede estar rota: no tapar el error original */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Código SQLSTATE de violación de índice único. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== PG_UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return (e.constraint ?? '').includes(constraint);
}
