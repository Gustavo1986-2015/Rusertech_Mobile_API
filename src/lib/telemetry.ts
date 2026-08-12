import type { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import type { AuthContext } from './auth';
import type { NormalizedPoint } from './payload';
import {
  DRIVER_STATE_BY_CODE,
  MOBILE_MARKER_KEY,
  TRIP_STATUS_ACTIVE,
  severityForCode,
} from './config';

export interface NotifiableEvent {
  code: string;
  plate: string;
  driverDni: string | null;
  latitude: number;
  longitude: number;
  timestamp: string;
  tripId: string | null;
}

export type IngestResult =
  | {
      ok: true;
      received: number;
      inserted: number;
      duplicates: number;
      events: NotifiableEvent[];
    }
  | { ok: false; index: number; message: string };

/** Clave del índice `telemetry_mobile_dedupe`. */
const dedupeKey = (vehicleId: string, ts: Date, providerCode: string | null) =>
  `${vehicleId}|${ts.toISOString()}|${providerCode ?? ''}`;

/**
 * Inserta puntos de telemetría.
 *
 * Todo ocurre en UNA transacción: si se inserta la telemetría pero falla el
 * trip_events, el dashboard quedaría inconsistente. O entra todo, o nada.
 *
 * Dedupe: `on conflict do nothing` SIN target explícito. El índice
 * `telemetry_mobile_dedupe` es PARCIAL y con EXPRESIÓN — la forma sin target
 * cubre cualquier violación de unicidad y es la única que no depende de que
 * el planner infiera un índice con predicado. Verificado contra PG16.
 */
export async function ingestPoints(
  ctx: AuthContext,
  points: NormalizedPoint[],
): Promise<IngestResult> {
  if (points.length === 0) {
    return { ok: true, received: 0, inserted: 0, duplicates: 0, events: [] };
  }

  // --- 1. Resolver patentes → vehicle_id (lectura, fuera de la transacción)
  const plates = [...new Set(points.map((p) => p.plate))];
  const { rows: vehicleRows } = await query<{ id: string; plate: string }>(
    `select id, plate from vehicles where tenant_id = $1 and plate = any($2::text[])`,
    [ctx.tenantId, plates],
  );
  const vehicleByPlate = new Map(vehicleRows.map((v) => [v.plate, v.id]));

  // telemetry NO tiene foreign keys (deliberado, por performance de ingesta),
  // así que si no validamos acá se insertarían UUIDs fantasma sin que nadie
  // se entere. El 422 es la única defensa.
  const missing = points.findIndex((p) => !vehicleByPlate.has(p.plate));
  if (missing >= 0) {
    return {
      ok: false,
      index: missing,
      message: `Patente no registrada para este operador: ${points[missing].plate}`,
    };
  }

  // --- 2. Deduplicar dentro del propio lote -------------------------------
  // Si el mismo punto viene dos veces en el batch, `on conflict do nothing`
  // inserta uno solo; sin este paso el segundo se contaría como insertado y
  // duplicaría su trip_event.
  const seen = new Set<string>();
  const unique: NormalizedPoint[] = [];
  for (const p of points) {
    const key = dedupeKey(vehicleByPlate.get(p.plate)!, p.timestamp, p.providerCode);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  // --- 3. Viajes válidos de este tenant -----------------------------------
  // Un TripId viejo o de otro tenant NO puede tirar abajo la telemetría:
  // se ignora el trip_events y el punto se persiste igual.
  const tripIds = [...new Set(unique.map((p) => p.tripId).filter(Boolean))] as string[];
  let validTrips = new Set<string>();
  if (tripIds.length > 0) {
    const { rows } = await query<{ id: string }>(
      `select id from trips where tenant_id = $1 and id = any($2::uuid[])`,
      [ctx.tenantId, tripIds],
    );
    validTrips = new Set(rows.map((r) => r.id));
  }

  return withTransaction(async (client) => {
    // --- 4. INSERT multi-fila con dedupe -----------------------------------
    const cols = 12;
    const values: any[] = [];
    const tuples = unique.map((p, i) => {
      const base = i * cols;
      const raw = { ...p.raw };
      // La PRESENCIA de esta clave es lo que activa el índice parcial de
      // dedupe. Si la app no la manda, el dedupe no aplicaría y se
      // duplicaría telemetría en silencio. La API es la autoridad sobre el
      // hecho "esta fila vino del móvil", así que la garantiza.
      if (raw[MOBILE_MARKER_KEY] == null) raw[MOBILE_MARKER_KEY] = ctx.userAvlCode;

      values.push(
        ctx.tenantId,
        vehicleByPlate.get(p.plate)!,
        ctx.avlUserId,
        p.timestamp.toISOString(),
        p.latitude,
        p.longitude,
        p.speedKmh,
        p.headingDegrees,
        p.ignition,
        p.batteryPct,
        p.providerCode,
        JSON.stringify(raw),
      );
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12}::jsonb)`;
    });

    // `location` se OMITE a propósito: la completa el trigger
    // trg_telemetry_fill_location. `is_duplicate` y `event_type` quedan
    // en su default (event_type lo llena el EventEngine cuando exista).
    const { rows: insertedRows } = await client.query<{
      vehicle_id: string;
      timestamp: Date;
      pc: string;
    }>(
      `insert into telemetry
         (tenant_id, vehicle_id, avl_user_id, "timestamp", latitude, longitude,
          speed_kmh, heading_degrees, ignition, battery_pct, provider_code, raw_payload)
       values ${tuples.join(',')}
       on conflict do nothing
       returning vehicle_id, "timestamp", coalesce(provider_code, '') as pc`,
      values,
    );

    const insertedKeys = new Set(
      insertedRows.map((r) => dedupeKey(r.vehicle_id, new Date(r.timestamp), r.pc || null)),
    );

    // --- 5. trip_events + driver_state, solo para lo REALMENTE insertado ---
    const events: NotifiableEvent[] = [];
    const stateChanges: { tripId: string; state: string; ts: Date }[] = [];

    for (const p of unique) {
      const key = dedupeKey(vehicleByPlate.get(p.plate)!, p.timestamp, p.providerCode);
      if (!insertedKeys.has(key)) continue; // era duplicado: ya se registró antes
      if (!p.providerCode) continue;

      events.push({
        code: p.providerCode,
        plate: p.plate,
        driverDni: p.driverDni,
        latitude: p.latitude,
        longitude: p.longitude,
        timestamp: p.timestamp.toISOString(),
        tripId: p.tripId,
      });

      if (!p.tripId || !validTrips.has(p.tripId)) continue;

      await insertTripEvent(client, ctx.tenantId, p);

      const newState = DRIVER_STATE_BY_CODE[p.providerCode];
      if (newState) stateChanges.push({ tripId: p.tripId, state: newState, ts: p.timestamp });
    }

    // Si el lote trae varios cambios de estado, gana el más reciente.
    stateChanges.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    const lastByTrip = new Map<string, string>();
    for (const c of stateChanges) lastByTrip.set(c.tripId, c.state);

    for (const [tripId, state] of lastByTrip) {
      await client.query(
        `update trips set driver_state = $1
          where id = $2 and tenant_id = $3 and status = $4`,
        [state, tripId, ctx.tenantId, TRIP_STATUS_ACTIVE],
      );
    }

    return {
      ok: true as const,
      received: points.length,
      inserted: insertedRows.length,
      duplicates: points.length - insertedRows.length,
      events,
    };
  });
}

async function insertTripEvent(
  client: PoolClient,
  tenantId: string,
  p: NormalizedPoint,
): Promise<void> {
  // `location` se omite: lo completa trg_trip_events_fill_location.
  await client.query(
    `insert into trip_events
       (tenant_id, trip_id, event_type, severity, latitude, longitude, "timestamp", metadata_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      tenantId,
      p.tripId,
      p.providerCode,
      severityForCode(p.providerCode!),
      p.latitude,
      p.longitude,
      p.timestamp.toISOString(),
      JSON.stringify(p.raw),
    ],
  );
}
