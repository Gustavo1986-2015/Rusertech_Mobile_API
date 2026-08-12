import { isUniqueViolation, query, withTransaction } from './db';
import type { AuthContext } from './auth';
import type { CreateTripInput } from './payload';
import { TRIP_STATUS_ACTIVE, TRIP_STATUS_COMPLETED, toApiTripStatus } from './config';

/** Lo que ve la app. Se mantiene MÍNIMO a propósito: el modelo Kotlin es la
 *  referencia y campos de más pueden romper la deserialización si el Json
 *  de la app no ignora claves desconocidas. */
export interface TripResponse {
  tripId: string;
  status: string; // "active" | "completed"
}

export const SYSTEM_USER_EMAIL = 'mobile@system.rusertech';

export type CreateTripResult =
  | { kind: 'created'; trip: TripResponse }
  | { kind: 'already_active'; trip: TripResponse }
  | { kind: 'vehicle_not_found'; plate: string }
  | { kind: 'vehicle_blocked'; reason: string | null }
  | { kind: 'driver_not_found'; document: string }
  | { kind: 'system_user_missing' };

interface VehicleRow {
  id: string;
  is_blocked: boolean;
  block_reason: string | null;
}

export async function createTrip(
  ctx: AuthContext,
  input: CreateTripInput,
): Promise<CreateTripResult> {
  // --- vehículo -----------------------------------------------------------
  const { rows: vehicles } = await query<VehicleRow>(
    `select id, is_blocked, block_reason
       from vehicles where tenant_id = $1 and plate = $2 limit 1`,
    [ctx.tenantId, input.plate],
  );
  const vehicle = vehicles[0];
  if (!vehicle) return { kind: 'vehicle_not_found', plate: input.plate };
  if (vehicle.is_blocked) {
    return { kind: 'vehicle_blocked', reason: vehicle.block_reason };
  }

  // --- conductor ----------------------------------------------------------
  const { rows: drivers } = await query<{ id: string }>(
    `select id from drivers where tenant_id = $1 and document = $2 limit 1`,
    [ctx.tenantId, input.driverDocument],
  );
  const driver = drivers[0];
  if (!driver) return { kind: 'driver_not_found', document: input.driverDocument };

  // --- usuario de sistema que firma el viaje ------------------------------
  const { rows: sysUsers } = await query<{ id: string }>(
    `select id from users where tenant_id = $1 and email = $2 limit 1`,
    [ctx.tenantId, SYSTEM_USER_EMAIL],
  );
  const systemUser = sysUsers[0];
  if (!systemUser) return { kind: 'system_user_missing' };

  // --- nombre y notas -----------------------------------------------------
  const stamp = new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Argentina/Buenos_Aires',
  })
    .format(new Date())
    .replace(',', '');
  const name = `Viaje móvil ${input.plate} ${stamp}`;

  // `trips` no tiene columna cargo_type: se antepone a notes (§4.4).
  const notes = input.cargoType
    ? `Carga: ${input.cargoType}.${input.notes ? ` ${input.notes}` : ''}`
    : input.notes;

  // corridor_meters / criticality / reinforced_monitoring NO se envían:
  // la base ya tiene defaults (500 / 'normal' / false). No inventar valores.
  try {
    const { rows } = await query<{ id: string; status: string }>(
      `insert into trips (
         tenant_id, vehicle_id, driver_id, created_by_user_id, name,
         origin_address, origin_lat, origin_lng,
         destination_address, destination_lat, destination_lng,
         notes, planned_start, planned_end, actual_start, status, driver_state)
       values (
         $1, $2, $3, $4, $5,
         $6, $7, $8,
         $9, $10, $11,
         $12, now(), now() + ($13 || ' hours')::interval, now(), $14, 'en_route')
       returning id, status`,
      [
        ctx.tenantId,
        vehicle.id,
        driver.id,
        systemUser.id,
        name,
        input.originAddress,
        input.originLat,
        input.originLng,
        input.destinationAddress,
        input.destinationLat,
        input.destinationLng,
        notes,
        String(input.plannedHours),
        TRIP_STATUS_ACTIVE,
      ],
    );
    return {
      kind: 'created',
      trip: { tripId: rows[0].id, status: toApiTripStatus(rows[0].status) },
    };
  } catch (err) {
    // La BASE es la autoridad: el índice único parcial
    // trips_one_in_progress_per_vehicle garantiza un solo viaje en curso por
    // vehículo. Sin chequeo previo — se captura el 23505 y se devuelve el
    // viaje existente para que la app lo adopte.
    if (!isUniqueViolation(err)) throw err;

    const existing = await findActiveTripByVehicle(ctx.tenantId, vehicle.id);
    if (!existing) throw err; // no era ese índice: que suba como 500
    return { kind: 'already_active', trip: existing };
  }
}

export async function findActiveTripByVehicle(
  tenantId: string,
  vehicleId: string,
): Promise<TripResponse | null> {
  const { rows } = await query<{ id: string; status: string }>(
    `select id, status from trips
      where tenant_id = $1 and vehicle_id = $2 and status = $3
      limit 1`,
    [tenantId, vehicleId, TRIP_STATUS_ACTIVE],
  );
  if (!rows[0]) return null;
  return { tripId: rows[0].id, status: toApiTripStatus(rows[0].status) };
}

export async function findActiveTripByPlate(
  ctx: AuthContext,
  plate: string,
): Promise<TripResponse | null> {
  const { rows } = await query<{ id: string; status: string }>(
    `select t.id, t.status
       from trips t
       join vehicles v on v.id = t.vehicle_id
      where t.tenant_id = $1 and v.plate = $2 and t.status = $3
      limit 1`,
    [ctx.tenantId, plate, TRIP_STATUS_ACTIVE],
  );
  if (!rows[0]) return null;
  return { tripId: rows[0].id, status: toApiTripStatus(rows[0].status) };
}

export type CompleteTripResult =
  | { kind: 'completed'; trip: TripResponse }
  | { kind: 'already_completed'; trip: TripResponse }
  | { kind: 'not_found' };

/**
 * Cierre idempotente. Se resuelve en una sola transacción para que dos
 * reintentos simultáneos del SyncWorker no puedan pisarse.
 */
export async function completeTrip(
  ctx: AuthContext,
  tripId: string,
): Promise<CompleteTripResult> {
  return withTransaction(async (client) => {
    const { rows: updated } = await client.query<{ id: string; status: string }>(
      `update trips
          set status = $1, actual_end = now(), driver_state = null
        where id = $2 and tenant_id = $3 and status = $4
        returning id, status`,
      [TRIP_STATUS_COMPLETED, tripId, ctx.tenantId, TRIP_STATUS_ACTIVE],
    );

    if (updated[0]) {
      return {
        kind: 'completed' as const,
        trip: { tripId: updated[0].id, status: toApiTripStatus(updated[0].status) },
      };
    }

    const { rows: existing } = await client.query<{ id: string; status: string }>(
      `select id, status from trips where id = $1 and tenant_id = $2 limit 1`,
      [tripId, ctx.tenantId],
    );
    if (!existing[0]) return { kind: 'not_found' as const };

    // Ya estaba cerrado (o cancelado): 409, que la app trata como éxito.
    return {
      kind: 'already_completed' as const,
      trip: { tripId: existing[0].id, status: toApiTripStatus(existing[0].status) },
    };
  });
}
