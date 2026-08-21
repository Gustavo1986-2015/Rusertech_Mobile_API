import { authenticate } from '@/lib/auth';
import { MOBILE_AVL_USER_CODE } from '@/lib/config';
import { query } from '@/lib/db';
import { guarded, json } from '@/lib/http';
import { SYSTEM_USER_EMAIL } from '@/lib/trips';
import { BUCKET } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/health — gate de despliegue.
 *
 * Verifica contra la base REAL que exista todo lo que la API escribe, antes
 * de que un conductor descubra el problema en la calle. Está autenticado con
 * X-Hub-Api-Key para no exponer el esquema a cualquiera.
 *
 * Si `ok` es false, el deployment NO está listo: el detalle dice qué falta.
 */

/** Columnas que la API ESCRIBE. Si alguna no existe, el INSERT explota. */
const REQUIRED: Record<string, string[]> = {
  telemetry: [
    'tenant_id', 'vehicle_id', 'avl_user_id', 'timestamp', 'latitude', 'longitude',
    'speed_kmh', 'heading_degrees', 'ignition', 'battery_pct', 'provider_code',
    'raw_payload',
  ],
  trips: [
    'tenant_id', 'vehicle_id', 'driver_id', 'created_by_user_id', 'name',
    'origin_address', 'origin_lat', 'origin_lng',
    'destination_address', 'destination_lat', 'destination_lng',
    'notes', 'planned_start', 'planned_end', 'actual_start', 'actual_end',
    'status', 'driver_state', 'metadata_json',
  ],
  trip_events: [
    'tenant_id', 'trip_id', 'event_type', 'severity', 'latitude', 'longitude',
    'timestamp', 'metadata_json',
  ],
  trip_attachments: [
    'tenant_id', 'trip_id', 'vehicle_id', 'driver_document', 'type', 'notes',
    'latitude', 'longitude', 'storage_path',
  ],
  // Base del SaaS: mobile_activation_codes (vigencia por revoked_at /
  // expires_at) reemplaza a la vieja mobile_activations.
  mobile_activation_codes: [
    'tenant_id', 'driver_id', 'vehicle_id', 'activation_code',
    'revoked_at', 'expires_at', 'used_at',
  ],
  mobile_login_attempts: [
    'document_id', 'plate', 'ip_address', 'success', 'failure_reason', 'user_agent',
  ],
  mobile_alert_channels: ['tenant_id', 'channel_type', 'target', 'secret', 'notify_codes', 'is_active'],
  avl_users: ['tenant_id', 'user_avl_code', 'api_key', 'is_active'],
  vehicles: ['tenant_id', 'plate', 'is_blocked', 'block_reason', 'avl_user_id'],
  drivers: ['tenant_id', 'document'],
  users: ['tenant_id', 'email', 'role_code', 'status'],
};

/** Índices de los que depende la lógica (dedupe y viaje único). */
const REQUIRED_INDEXES = ['telemetry_mobile_dedupe', 'trips_one_in_progress_per_vehicle'];

export const GET = guarded(async (req: Request) => {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  const problems: string[] = [];

  // --- columnas -----------------------------------------------------------
  const wanted = Object.entries(REQUIRED).flatMap(([table, cols]) =>
    cols.map((col) => ({ table, col })),
  );
  const { rows: present } = await query<{ table_name: string; column_name: string }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])`,
    [Object.keys(REQUIRED)],
  );
  const presentSet = new Set(present.map((r) => `${r.table_name}.${r.column_name}`));
  for (const { table, col } of wanted) {
    if (!presentSet.has(`${table}.${col}`)) problems.push(`falta columna ${table}.${col}`);
  }

  // --- índices ------------------------------------------------------------
  const { rows: indexes } = await query<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'public' and indexname = any($1::text[])`,
    [REQUIRED_INDEXES],
  );
  const indexSet = new Set(indexes.map((r) => r.indexname));
  for (const idx of REQUIRED_INDEXES) {
    if (!indexSet.has(idx)) problems.push(`falta índice ${idx}`);
  }

  // --- usuario de sistema del tenant --------------------------------------
  const { rows: sysUser } = await query<{ id: string }>(
    `select id from users where tenant_id = $1 and email = $2 limit 1`,
    [auth.ctx.tenantId, SYSTEM_USER_EMAIL],
  );
  if (!sysUser[0]) {
    problems.push(`falta el usuario de sistema ${SYSTEM_USER_EMAIL} (correr seed_staging.sql)`);
  }

  // --- avl_user compartido de ingesta mobile ------------------------------
  const { rows: mobileAvl } = await query<{ is_active: boolean }>(
    `select is_active from avl_users where tenant_id = $1 and user_avl_code = $2 limit 1`,
    [auth.ctx.tenantId, MOBILE_AVL_USER_CODE],
  );
  if (!mobileAvl[0]) {
    problems.push(`falta el avl_user '${MOBILE_AVL_USER_CODE}' del tenant (el login no puede emitir credenciales)`);
  } else if (!mobileAvl[0].is_active) {
    problems.push(`el avl_user '${MOBILE_AVL_USER_CODE}' está desactivado (todos los logins darán 403)`);
  }

  // --- env vars -----------------------------------------------------------
  const envs = [
    'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'ATTACHMENTS_BUCKET', 'RESEND_API_KEY', 'ALERTS_FROM_EMAIL', 'RUSERTECH_OPS_EMAIL',
  ];
  for (const name of envs) {
    if (!process.env[name]) problems.push(`falta env var ${name}`);
  }

  return json(
    {
      ok: problems.length === 0,
      tenantId: auth.ctx.tenantId,
      bucket: BUCKET,
      problems,
    },
    problems.length === 0 ? 200 : 503,
  );
});
