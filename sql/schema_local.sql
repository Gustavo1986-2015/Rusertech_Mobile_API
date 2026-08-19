-- =====================================================================
-- Rusertech Mobile — RÉPLICA LOCAL del esquema real de Supabase
-- Fuente de verdad: DB SNAPSHOT 12/08/2026 (verificado por Gustavo).
--
-- Este archivo NO se ejecuta nunca contra Supabase. Existe solo para
-- levantar un Postgres 16 local idéntico y correr el gate VERIFY de §4.6
-- contra el código real antes de desplegar.
--
-- Solo se replican las tablas que el backend Mobile toca. Las tablas del
-- EventEngine (event_logs, event_rules, geofences, routes, ...) no se
-- replican porque el backend no las toca.
-- =====================================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------
-- Tablas web (la API solo LEE de estas)
-- ---------------------------------------------------------------------

create table if not exists tenants (
  id          uuid primary key default gen_random_uuid(),
  name        varchar not null,
  created_at  timestamptz not null default now()
);

create table if not exists avl_users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  user_avl_code varchar not null,
  api_key       varchar not null unique,   -- índice avl_users_api_key_key
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists vehicles (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  plate        varchar not null,
  is_blocked   boolean not null default false,
  block_reason text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, plate)
);

create table if not exists drivers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  document   varchar,                      -- NULLABLE en la base real
  full_name  varchar,
  created_at timestamptz not null default now()
);
-- índice UNIQUE parcial: (tenant_id, document) where document is not null
create unique index if not exists drivers_tenant_document
  on drivers (tenant_id, document) where document is not null;

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  email         varchar not null,
  password_hash text not null,
  full_name     varchar,
  -- roles reales: account_owner, driver, manager, operator, rusertech_admin, viewer
  role_code     varchar not null,
  status        varchar not null default 'active',
  created_at    timestamptz not null default now(),
  unique (tenant_id, email)
);

-- ---------------------------------------------------------------------
-- telemetry — PARTICIONADA por rango en "timestamp"  (difiere del spec §4)
-- ---------------------------------------------------------------------

create table if not exists telemetry (
  id              uuid not null default uuid_generate_v4(),
  tenant_id       uuid not null,
  vehicle_id      uuid not null,
  avl_user_id     uuid not null,
  "timestamp"     timestamptz not null,
  latitude        double precision not null,
  longitude       double precision not null,
  location        geography,               -- la completa el trigger; la API la OMITE
  speed_kmh       real,
  heading_degrees smallint,
  ignition        boolean,
  altitude_meters real,
  odometer_km     real,
  battery_pct     real,
  temperature_c   real,
  humidity_pct    real,
  direction_label varchar,
  provider_code   varchar,
  event_type      varchar,
  is_duplicate    boolean not null default false,
  raw_payload     jsonb not null,
  primary key (id, "timestamp")
  -- SIN foreign keys: deliberado (performance de ingesta). La API resuelve los UUIDs.
) partition by range ("timestamp");

-- Particiones mensuales. En la base real van de 2026_08 a 2028_12; acá
-- alcanzan las del período de prueba más la default.
create table if not exists telemetry_2026_07 partition of telemetry
  for values from ('2026-07-01') to ('2026-08-01');
create table if not exists telemetry_2026_08 partition of telemetry
  for values from ('2026-08-01') to ('2026-09-01');
create table if not exists telemetry_2026_09 partition of telemetry
  for values from ('2026-09-01') to ('2026-10-01');
create table if not exists telemetry_default partition of telemetry default;

create index if not exists telemetry_vehicle_ts
  on telemetry (vehicle_id, "timestamp" desc);
create index if not exists telemetry_events
  on telemetry (provider_code, "timestamp" desc) where provider_code is not null;

-- Dedupe mobile. Índice PARCIAL + EXPRESIÓN sobre tabla particionada.
-- Verificado creable y funcional en PG16: incluye la columna de partición
-- ("timestamp"), por eso la unicidad se garantiza globalmente.
create unique index if not exists telemetry_mobile_dedupe
  on telemetry (vehicle_id, "timestamp", coalesce(provider_code, ''))
  where (raw_payload ? 'MobileCode');

-- ---------------------------------------------------------------------
-- trips
-- ---------------------------------------------------------------------

create table if not exists trips (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants(id),
  vehicle_id             uuid not null references vehicles(id),
  driver_id              uuid references drivers(id) on delete set null,  -- NULLABLE
  created_by_user_id     uuid not null references users(id),
  name                   varchar not null default '',
  origin_address         text,
  origin_lat             double precision,
  origin_lng             double precision,
  destination_address    text,
  destination_lat        double precision,
  destination_lng        double precision,
  notes                  text,
  planned_start          timestamptz not null,
  planned_end            timestamptz not null,
  actual_start           timestamptz,
  actual_end             timestamptz,
  status                 varchar not null default 'draft'
                         check (status in ('draft','scheduled','in_progress','completed','cancelled')),
  driver_state           varchar
                         check (driver_state in ('en_route','stopped_waypoint','stopped_authorized','stopped_sanitary')),
  corridor_meters        integer not null default 500,
  criticality            varchar not null default 'normal',
  reinforced_monitoring  boolean not null default false,
  created_at             timestamptz not null default now()
);

create index if not exists trips_tenant_vehicle_status
  on trips (tenant_id, vehicle_id, status);
create index if not exists trips_driver
  on trips (driver_id) where driver_id is not null;

-- Un solo viaje en curso por vehículo. Un segundo INSERT falla con 23505
-- y la API responde 409 devolviendo el viaje existente.
create unique index if not exists trips_one_in_progress_per_vehicle
  on trips (vehicle_id) where status = 'in_progress';

-- ---------------------------------------------------------------------
-- trip_events
-- ---------------------------------------------------------------------

create table if not exists trip_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id),
  trip_id       uuid not null references trips(id) on delete cascade,
  event_type    varchar not null,
  severity      varchar not null default 'info',
  latitude      double precision,
  longitude     double precision,
  location      geography,                 -- trigger
  "timestamp"   timestamptz not null default now(),
  metadata_json jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists trip_events_trip_ts on trip_events (trip_id, "timestamp" desc);

-- ---------------------------------------------------------------------
-- Trigger fn_fill_location — completa location desde lat/lng si viene null
-- ---------------------------------------------------------------------

create or replace function fn_fill_location() returns trigger as $$
begin
  if new.location is null and new.latitude is not null and new.longitude is not null then
    new.location := st_setsrid(st_makepoint(new.longitude, new.latitude), 4326)::geography;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_telemetry_fill_location on telemetry;
create trigger trg_telemetry_fill_location
  before insert on telemetry
  for each row execute function fn_fill_location();

drop trigger if exists trg_trip_events_fill_location on trip_events;
create trigger trg_trip_events_fill_location
  before insert on trip_events
  for each row execute function fn_fill_location();

-- ---------------------------------------------------------------------
-- Tablas mobile (ya existen en la base real — acá se replican)
-- ---------------------------------------------------------------------

create table if not exists mobile_activations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  driver_id       uuid not null references drivers(id),
  vehicle_id      uuid not null references vehicles(id),
  avl_user_id     uuid not null references avl_users(id),
  activation_code varchar not null unique,   -- único GLOBAL: el login no conoce el tenant
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (driver_id, vehicle_id)
);

-- Configuración operativa por tenant que el login devuelve a la app.
-- Réplica de la tabla que YA EXISTE en producción (este archivo jamás se
-- ejecuta contra Supabase). Los CHECK espejan los rangos que la app también
-- valida por su cuenta.
create table if not exists tenant_mobile_config (
  tenant_id                   uuid primary key references tenants(id),
  heartbeat_interval_minutes  integer not null default 5
    check (heartbeat_interval_minutes between 1 and 120),
  stop_threshold_minutes      integer not null default 5
    check (stop_threshold_minutes between 1 and 120),
  interval_moving_seconds     integer not null default 5
    check (interval_moving_seconds between 1 and 300),
  interval_idle_seconds       integer not null default 30
    check (interval_idle_seconds between 1 and 600),
  min_displacement_meters     integer not null default 10
    check (min_displacement_meters between 0 and 500),
  max_accuracy_meters         integer not null default 50
    check (max_accuracy_meters between 5 and 1000),
  auto_resume_minutes         integer not null default 3
    check (auto_resume_minutes between 1 and 60),
  updated_at                  timestamptz not null default now()
);

create table if not exists trip_attachments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  trip_id         uuid references trips(id),
  vehicle_id      uuid not null references vehicles(id),
  driver_document varchar,
  type            varchar not null,
  notes           text,
  latitude        double precision,
  longitude       double precision,
  storage_path    text not null,
  created_at      timestamptz not null default now()
);

create table if not exists mobile_alert_channels (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  channel_type varchar not null check (channel_type in ('email','webhook')),
  target       text not null,
  secret       text,
  notify_codes text[] not null default '{MOB_SOS}',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
