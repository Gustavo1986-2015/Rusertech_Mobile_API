/**
 * Validación y normalización de los payloads del contrato (§3.2).
 *
 * Los nombres de campo son los que emite la app Kotlin (kotlinx-serialization
 * con @SerialName en PascalCase para HubRawPayload, camelCase para el resto).
 * El backend se adapta a la app, no al revés.
 */

import { MOBILE_CODE_PREFIX, normalizeDocument, normalizePlate } from './config';

// ---------------------------------------------------------------------
// HubRawPayload
// ---------------------------------------------------------------------

export interface HubRawPayload {
  Asset: string; // patente
  Date: string; // ISO-8601
  Latitude: number;
  Longitude: number;
  Speed?: number | null;
  Course?: number | null;
  Ignition?: number | boolean | null;
  Battery?: number | null;
  Code?: string | null;
  DriverDNI?: string | null;
  TripId?: string | null;
  MobileCode?: string | null;
  DriverState?: string | null;
  [k: string]: unknown; // el raw_payload se guarda tal cual llegó
}

export interface NormalizedPoint {
  raw: HubRawPayload;
  plate: string;
  timestamp: Date;
  latitude: number;
  longitude: number;
  speedKmh: number | null;
  headingDegrees: number | null;
  ignition: boolean | null;
  batteryPct: number | null;
  providerCode: string | null;
  tripId: string | null;
  driverDni: string | null;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return isFiniteNumber(v) ? v : NaN; // NaN marca "vino algo pero no es número"
}

export function validatePoint(input: unknown): Validated<NormalizedPoint> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'El punto debe ser un objeto JSON' };
  }
  const p = input as HubRawPayload;

  // --- obligatorios ---
  if (typeof p.Asset !== 'string' || !p.Asset.trim()) {
    return { ok: false, message: 'Asset (patente) es obligatorio' };
  }
  if (typeof p.Date !== 'string' || !p.Date.trim()) {
    return { ok: false, message: 'Date es obligatorio (ISO-8601)' };
  }
  const timestamp = new Date(p.Date);
  if (Number.isNaN(timestamp.getTime())) {
    return { ok: false, message: `Date no es ISO-8601 válido: ${p.Date}` };
  }
  if (!isFiniteNumber(p.Latitude) || p.Latitude < -90 || p.Latitude > 90) {
    return { ok: false, message: 'Latitude debe ser un número entre -90 y 90' };
  }
  if (!isFiniteNumber(p.Longitude) || p.Longitude < -180 || p.Longitude > 180) {
    return { ok: false, message: 'Longitude debe ser un número entre -180 y 180' };
  }

  // --- opcionales ---
  const speed = toNullableNumber(p.Speed);
  if (speed !== null && Number.isNaN(speed)) {
    return { ok: false, message: 'Speed debe ser numérico o null' };
  }

  const course = toNullableNumber(p.Course);
  if (course !== null && Number.isNaN(course)) {
    return { ok: false, message: 'Course debe ser numérico o null' };
  }
  // heading_degrees es smallint: redondear y acotar a 0..359 para no
  // desbordar el tipo con datos sucios del GPS.
  const headingDegrees =
    course === null ? null : ((Math.round(course) % 360) + 360) % 360;

  const battery = toNullableNumber(p.Battery);
  if (battery !== null && Number.isNaN(battery)) {
    return { ok: false, message: 'Battery debe ser numérico o null' };
  }

  // Ignition: 1→true, 0→false, null→null. También se acepta booleano.
  let ignition: boolean | null = null;
  if (p.Ignition !== null && p.Ignition !== undefined) {
    if (typeof p.Ignition === 'boolean') ignition = p.Ignition;
    else if (p.Ignition === 1 || p.Ignition === 0) ignition = p.Ignition === 1;
    else return { ok: false, message: 'Ignition debe ser 1, 0, booleano o null' };
  }

  let providerCode: string | null = null;
  if (p.Code !== null && p.Code !== undefined) {
    if (typeof p.Code !== 'string') {
      return { ok: false, message: 'Code debe ser string o null' };
    }
    const code = p.Code.trim();
    if (code) {
      // §0.2: todo código de evento móvil lleva prefijo MOB_.
      if (!code.startsWith(MOBILE_CODE_PREFIX)) {
        return {
          ok: false,
          message: `Code debe llevar prefijo ${MOBILE_CODE_PREFIX}: recibido "${code}"`,
        };
      }
      providerCode = code;
    }
  }

  let tripId: string | null = null;
  if (p.TripId !== null && p.TripId !== undefined && p.TripId !== '') {
    if (typeof p.TripId !== 'string' || !UUID_RE.test(p.TripId)) {
      return { ok: false, message: 'TripId debe ser un UUID válido o null' };
    }
    tripId = p.TripId;
  }

  return {
    ok: true,
    value: {
      raw: p,
      plate: normalizePlate(p.Asset),
      timestamp,
      latitude: p.Latitude,
      longitude: p.Longitude,
      speedKmh: speed,
      headingDegrees,
      ignition,
      batteryPct: battery,
      providerCode,
      tripId,
      driverDni:
        typeof p.DriverDNI === 'string' && p.DriverDNI.trim()
          ? normalizeDocument(p.DriverDNI)
          : null,
    },
  };
}

// ---------------------------------------------------------------------
// LoginRequest
// ---------------------------------------------------------------------

export interface LoginInput {
  documentId: string;
  plate: string;
  activationCode: string;
}

export function validateLogin(input: unknown): Validated<LoginInput> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: 'Body inválido' };
  }
  const b = input as Record<string, unknown>;
  const documentId = typeof b.documentId === 'string' ? b.documentId.trim() : '';
  const plate = typeof b.plate === 'string' ? b.plate.trim() : '';
  const activationCode =
    typeof b.activationCode === 'string' ? b.activationCode.trim() : '';

  if (!documentId) return { ok: false, message: 'documentId es obligatorio' };
  if (!plate) return { ok: false, message: 'plate es obligatorio' };
  if (!activationCode) {
    return { ok: false, message: 'activationCode es obligatorio' };
  }

  return {
    ok: true,
    value: {
      documentId: normalizeDocument(documentId),
      plate: normalizePlate(plate),
      // El código de activación se compara tal cual lo dicta el operador,
      // solo normalizado en mayúsculas y sin espacios.
      activationCode: activationCode.toUpperCase(),
    },
  };
}

// ---------------------------------------------------------------------
// CreateTripRequest
// ---------------------------------------------------------------------

/** Opciones cerradas del selector de duración (FIX-2 punto 5). */
export const PLANNED_HOURS_OPTIONS = [2, 4, 6, 10, 12] as const;
export const PLANNED_HOURS_DEFAULT = 12;

export interface CreateTripInput {
  plate: string; // vehicleId = patente
  driverDocument: string; // driverId = DNI
  originAddress: string | null;
  originLat: number | null;
  originLng: number | null;
  destinationAddress: string | null;
  destinationLat: number | null;
  destinationLng: number | null;
  cargoType: string | null;
  notes: string | null;
  plannedHours: number;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null => (isFiniteNumber(v) ? v : null);

export function validateCreateTrip(input: unknown): Validated<CreateTripInput> {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: 'Body inválido' };
  }
  const b = input as Record<string, unknown>;

  // vehicleId = patente, driverId = DNI (documentado en §4.4 del spec).
  const plateRaw = str(b.vehicleId) ?? str(b.plate);
  const docRaw = str(b.driverId) ?? str(b.driverDocument);
  if (!plateRaw) return { ok: false, message: 'vehicleId (patente) es obligatorio' };
  if (!docRaw) return { ok: false, message: 'driverId (DNI) es obligatorio' };

  let plannedHours = PLANNED_HOURS_DEFAULT;
  if (b.plannedHours !== null && b.plannedHours !== undefined) {
    if (!isFiniteNumber(b.plannedHours)) {
      return { ok: false, message: 'plannedHours debe ser numérico' };
    }
    plannedHours = Math.round(b.plannedHours);
    if (!(PLANNED_HOURS_OPTIONS as readonly number[]).includes(plannedHours)) {
      return {
        ok: false,
        message: `plannedHours debe ser uno de ${PLANNED_HOURS_OPTIONS.join('/')}`,
      };
    }
  }

  return {
    ok: true,
    value: {
      plate: normalizePlate(plateRaw),
      driverDocument: normalizeDocument(docRaw),
      originAddress: str(b.originAddress),
      originLat: num(b.originLat),
      originLng: num(b.originLng),
      destinationAddress: str(b.destinationAddress),
      destinationLat: num(b.destinationLat),
      destinationLng: num(b.destinationLng),
      cargoType: str(b.cargoType),
      notes: str(b.notes),
      plannedHours,
    },
  };
}
