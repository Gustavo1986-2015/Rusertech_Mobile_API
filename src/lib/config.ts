/**
 * Constantes del contrato. TODO valor que la app o la base graban en piedra
 * vive acá y en ningún otro lado: si mañana cambia el vocabulario de la base
 * o el backend se reemplaza por Rusertech Web, este es el único archivo a tocar.
 */

// --- Vocabulario de trips.status (base del SaaS) -----------------------
// La web usa el vocabulario en ESPAÑOL (verificado en su repo):
// PROGRAMADO / EN_CURSO / FINALIZADO / CANCELADO. Un viaje cerrado con otro
// valor queda en un limbo: la web no lo muestra ni activo ni finalizado.
// Regla: las ESCRITURAS van en español; las LECTURAS toleran también el
// vocabulario heredado en inglés ('in_progress'), igual que el índice único
// de viaje activo, que cubre ambos. Si la web cambia de vocabulario, este
// es el único lugar a tocar. (La API no cancela viajes; si algún día lo
// hace, el valor es 'CANCELADO'.)
export const TRIP_STATUS_ACTIVE = 'EN_CURSO';
export const TRIP_STATUS_ACTIVE_SET = ['EN_CURSO', 'in_progress'];
export const TRIP_STATUS_COMPLETED = 'FINALIZADO';

// --- Vocabulario que ve la APP (contrato de API, no de base) -----------
// TripResponse.status ∈ {"active","completed"} — §3.2 del spec.
export const API_TRIP_STATUS_ACTIVE = 'active';
export const API_TRIP_STATUS_COMPLETED = 'completed';

/** Traduce el status de la base al vocabulario que espera la app. */
export function toApiTripStatus(dbStatus: string): string {
  return (TRIP_STATUS_ACTIVE_SET as readonly string[]).includes(dbStatus)
    ? API_TRIP_STATUS_ACTIVE
    : API_TRIP_STATUS_COMPLETED;
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

// Rate limit de login, contra mobile_login_attempts (global entre instancias).
export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_MAX_FAILURES_IDENTITY = 5; // por documento + patente
export const LOGIN_MAX_FAILURES_IP = 20;

// avl_user compartido de ingesta mobile: el login devuelve SUS credenciales
// y todo payload viaja con User_avl = este código.
export const MOBILE_AVL_USER_CODE = 'Rusertech_Mobile';

// Duración asumida de un viaje cuando el conductor no declara ninguna.
// Queda registrada en trips.metadata_json para distinguirla de una declarada.
export const PLANNED_HOURS_FALLBACK = 8;

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
