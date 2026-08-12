/**
 * Constantes del contrato. TODO valor que la app o la base graban en piedra
 * vive acá y en ningún otro lado: si mañana cambia el vocabulario de la base
 * o el backend se reemplaza por Rusertech Web, este es el único archivo a tocar.
 */

// --- Vocabulario de trips.status (CHECK real en la base) ---------------
// draft / scheduled / in_progress / completed / cancelled
export const TRIP_STATUS_ACTIVE = 'in_progress';
export const TRIP_STATUS_COMPLETED = 'completed';

// --- Vocabulario que ve la APP (contrato de API, no de base) -----------
// TripResponse.status ∈ {"active","completed"} — §3.2 del spec.
export const API_TRIP_STATUS_ACTIVE = 'active';
export const API_TRIP_STATUS_COMPLETED = 'completed';

/** Traduce el status de la base al vocabulario que espera la app. */
export function toApiTripStatus(dbStatus: string): string {
  return dbStatus === TRIP_STATUS_COMPLETED
    ? API_TRIP_STATUS_COMPLETED
    : API_TRIP_STATUS_ACTIVE;
}

// --- Estados operativos del conductor (FIX-10) -------------------------
// CHECK real en trips.driver_state
export const DRIVER_STATE_EN_ROUTE = 'en_route';

/**
 * Códigos MOB_ que cambian el estado operativo del conductor.
 * Cualquier otro código NO toca trips.driver_state.
 */
export const DRIVER_STATE_BY_CODE: Record<string, string> = {
  MOB_WAYPOINT: 'stopped_waypoint',
  MOB_STOP_AUTH: 'stopped_authorized',
  MOB_STOP_SANIT: 'stopped_sanitary',
  MOB_RESUME: DRIVER_STATE_EN_ROUTE,
};

// --- Severidad de trip_events (§4.3) -----------------------------------
export function severityForCode(code: string): string {
  if (code === 'MOB_SOS') return 'critical';
  if (code === 'MOB_STOP') return 'warning'; // parada NO declarada
  return 'info';
}

// --- Límites -----------------------------------------------------------
export const BATCH_MAX_ITEMS = 50;
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 min

/** Prefijo obligatorio de todo código de evento móvil (§0.2). */
export const MOBILE_CODE_PREFIX = 'MOB_';

/**
 * Clave cuya PRESENCIA en telemetry.raw_payload activa el índice parcial
 * de dedupe `telemetry_mobile_dedupe`. Sin esta clave el dedupe no aplica,
 * así que la API garantiza que siempre esté (ver telemetry.ts).
 */
export const MOBILE_MARKER_KEY = 'MobileCode';

// --- Normalizadores ----------------------------------------------------
export const normalizePlate = (v: string) => v.trim().toUpperCase();
export const normalizeDocument = (v: string) => v.trim();
