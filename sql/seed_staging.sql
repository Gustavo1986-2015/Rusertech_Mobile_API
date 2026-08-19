-- =====================================================================
-- Rusertech Mobile — SEED de staging (IDEMPOTENTE)
--
-- Se puede correr N veces sin duplicar nada: todo INSERT va con
-- "where not exists" o "on conflict do nothing".
--
-- NO ejecuta DDL. NO altera tablas existentes. Solo INSERTA filas.
--
-- Qué crea (si falta):
--   1. tenant piloto
--   2. usuario de sistema mobile@system.rusertech (role_code 'driver')
--      con password_hash 'SYSTEM-NO-LOGIN' → no es un hash bcrypt válido,
--      así que ninguna verificación de password puede pasar. Firma los
--      trips creados desde la app, no es una puerta de entrada.
--   3. avl_user mobile del tenant, con su api_key
--   4. driver + vehicle de prueba
--   5. mobile_activations con el código de activación
--   6. canal de aviso de eventos críticos
--
-- El bucket privado `cargo-photos` NO va acá: se crea a mano en
-- Supabase → Storage → New bucket → privado.
--
-- Al final imprime las credenciales que necesita el VERIFY con curl.
-- =====================================================================

do $$
declare
  -- ---------------- CONFIGURACIÓN — editar antes de correr ----------------
  v_tenant_name     text := 'Rusertech Piloto';
  v_avl_code        text := 'mobile_app_01';
  v_driver_document text := '12345678';
  v_driver_name     text := 'Conductor Piloto';
  v_plate           text := 'AB123CD';
  v_activation_code text := 'PILOTO01';
  v_alert_email     text := 'operaciones@clientepiloto.com';
  -- ------------------------------------------------------------------------

  v_tenant_id     uuid;
  v_user_id       uuid;
  v_avl_user_id   uuid;
  v_driver_id     uuid;
  v_vehicle_id    uuid;
begin
  -- 1) Tenant --------------------------------------------------------------
  select id into v_tenant_id from tenants where name = v_tenant_name;
  if v_tenant_id is null then
    insert into tenants (name) values (v_tenant_name) returning id into v_tenant_id;
    raise notice 'tenant creado: %', v_tenant_id;
  else
    raise notice 'tenant ya existía: %', v_tenant_id;
  end if;

  -- 2) Usuario de sistema que firma trips.created_by_user_id ---------------
  select id into v_user_id
    from users
   where tenant_id = v_tenant_id and email = 'mobile@system.rusertech';
  if v_user_id is null then
    insert into users (tenant_id, email, password_hash, full_name, role_code, status)
    values (v_tenant_id, 'mobile@system.rusertech', 'SYSTEM-NO-LOGIN',
            'Usuario Sistema Mobile', 'driver', 'active')
    returning id into v_user_id;
    raise notice 'usuario de sistema creado: %', v_user_id;
  else
    raise notice 'usuario de sistema ya existía: %', v_user_id;
  end if;

  -- 3) avl_user mobile -----------------------------------------------------
  select id into v_avl_user_id
    from avl_users
   where tenant_id = v_tenant_id and user_avl_code = v_avl_code;
  if v_avl_user_id is null then
    insert into avl_users (tenant_id, user_avl_code, api_key, is_active)
    values (v_tenant_id, v_avl_code, encode(gen_random_bytes(24), 'hex'), true)
    returning id into v_avl_user_id;
    raise notice 'avl_user creado: %', v_avl_user_id;
  else
    raise notice 'avl_user ya existía: %', v_avl_user_id;
  end if;

  -- 4) Driver + Vehicle ----------------------------------------------------
  select id into v_driver_id
    from drivers where tenant_id = v_tenant_id and document = v_driver_document;
  if v_driver_id is null then
    insert into drivers (tenant_id, document, full_name)
    values (v_tenant_id, v_driver_document, v_driver_name)
    returning id into v_driver_id;
    raise notice 'driver creado: %', v_driver_id;
  end if;

  select id into v_vehicle_id
    from vehicles where tenant_id = v_tenant_id and plate = upper(trim(v_plate));
  if v_vehicle_id is null then
    insert into vehicles (tenant_id, plate, is_blocked)
    values (v_tenant_id, upper(trim(v_plate)), false)
    returning id into v_vehicle_id;
    raise notice 'vehicle creado: %', v_vehicle_id;
  end if;

  -- 5) Activación mobile ---------------------------------------------------
  --    Doble guarda: activation_code es UNIQUE global y (driver_id, vehicle_id)
  --    también es UNIQUE. on conflict do nothing cubre ambas.
  insert into mobile_activations
    (tenant_id, driver_id, vehicle_id, avl_user_id, activation_code, is_active)
  select v_tenant_id, v_driver_id, v_vehicle_id, v_avl_user_id, v_activation_code, true
  where not exists (
    select 1 from mobile_activations where activation_code = v_activation_code
  )
  on conflict do nothing;

  -- 6) Canal de aviso de eventos críticos ----------------------------------
  insert into mobile_alert_channels (tenant_id, channel_type, target, notify_codes, is_active)
  select v_tenant_id, 'email', v_alert_email, '{MOB_SOS}', true
  where not exists (
    select 1 from mobile_alert_channels
     where tenant_id = v_tenant_id and channel_type = 'email' and target = v_alert_email
  );

  -- 7) Configuración operativa del tenant ----------------------------------
  --    Con los valores por defecto (los mismos que la app trae de fábrica):
  --    el login la devuelve y la app se comporta idéntico que sin config.
  insert into tenant_mobile_config (tenant_id)
  values (v_tenant_id)
  on conflict (tenant_id) do nothing;

  raise notice 'seed completo para tenant %', v_tenant_id;
end;
$$;

-- =====================================================================
-- Credenciales para el VERIFY con curl. Copiar estos valores.
-- =====================================================================
select
  t.name                as tenant,
  ma.activation_code    as activation_code,
  d.document            as dni,
  v.plate               as patente,
  au.user_avl_code      as avl_user_code,
  au.api_key            as api_key,
  au.is_active          as avl_activo,
  u.email               as usuario_sistema
from mobile_activations ma
join tenants   t  on t.id  = ma.tenant_id
join drivers   d  on d.id  = ma.driver_id
join vehicles  v  on v.id  = ma.vehicle_id
join avl_users au on au.id = ma.avl_user_id
left join users u on u.tenant_id = ma.tenant_id and u.email = 'mobile@system.rusertech'
order by ma.created_at desc;
