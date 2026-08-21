-- =====================================================================
-- Rusertech Mobile — SEED de staging (IDEMPOTENTE)
--
-- Para la base del SaaS (`rudaqsfgjorryuqayqyd`) o su réplica local.
-- La base del SaaS YA tiene el tenant `demo` sembrado (21/08/2026): contra
-- ella este seed es un no-op que solo completa lo que falte. Su valor está
-- en la réplica local del gate VERIFY y en entornos futuros.
--
-- Se puede correr N veces sin duplicar nada. NO ejecuta DDL.
--
-- Qué crea (si falta):
--   1. tenant demo (slug 'demo')
--   2. usuario de sistema mobile@system.rusertech (role_code 'driver')
--      con password_hash 'SYSTEM-NO-LOGIN' → no es un hash bcrypt válido,
--      así que ninguna verificación de password puede pasar. Firma los
--      trips creados desde la app, no es una puerta de entrada.
--   3. avl_user compartido de ingesta 'Rusertech_Mobile' con su api_key
--   4. driver + vehicle de prueba (el vehicle apunta su avl_user_id al
--      avl_user mobile: es el switch de revocación por vehículo)
--   5. mobile_activation_codes con el código vigente 1 año
--   6. canal de aviso de eventos críticos
--   7. configuración operativa del tenant
--
-- El bucket privado `cargo-photos` NO va acá: se crea a mano en
-- Supabase → Storage → New bucket → privado.
--
-- Al final imprime las credenciales que necesita el VERIFY con curl.
-- =====================================================================

do $$
declare
  -- ---------------- CONFIGURACIÓN — editar antes de correr ----------------
  v_tenant_name     text := 'Demo';
  v_tenant_slug     text := 'demo';
  v_avl_code        text := 'Rusertech_Mobile';
  v_driver_document text := '12345678';
  v_driver_name     text := 'Conductor Piloto';
  v_plate           text := 'AB123CD';
  v_activation_code text := 'RUTA2648';
  v_alert_email     text := 'operaciones@clientepiloto.com';
  -- ------------------------------------------------------------------------

  v_tenant_id     uuid;
  v_user_id       uuid;
  v_avl_user_id   uuid;
  v_driver_id     uuid;
  v_vehicle_id    uuid;
begin
  -- 1) Tenant (por slug: es el identificador estable del SaaS) --------------
  select id into v_tenant_id from tenants where slug = v_tenant_slug;
  if v_tenant_id is null then
    insert into tenants (name, slug) values (v_tenant_name, v_tenant_slug)
    returning id into v_tenant_id;
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

  -- 3) avl_user compartido de ingesta mobile -------------------------------
  --    El login devuelve SUS credenciales y todo payload viaja con
  --    User_avl = este código.
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
    -- avl_user_id: switch de revocación por vehículo (403 del login).
    insert into vehicles (tenant_id, plate, is_blocked, avl_user_id)
    values (v_tenant_id, upper(trim(v_plate)), false, v_avl_user_id)
    returning id into v_vehicle_id;
    raise notice 'vehicle creado: %', v_vehicle_id;
  else
    -- Completar el switch si el vehicle existía sin avl_user asignado.
    update vehicles set avl_user_id = v_avl_user_id
     where id = v_vehicle_id and avl_user_id is null;
  end if;

  -- 5) Código de activación ------------------------------------------------
  --    Vigencia por revoked_at/expires_at (sin is_active). used_at queda
  --    null: lo setea el primer login exitoso.
  insert into mobile_activation_codes
    (tenant_id, driver_id, vehicle_id, activation_code, expires_at)
  select v_tenant_id, v_driver_id, v_vehicle_id, v_activation_code, now() + interval '1 year'
  where not exists (
    select 1 from mobile_activation_codes where activation_code = v_activation_code
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
  t.slug                as tenant,
  mac.activation_code   as activation_code,
  mac.expires_at        as vence,
  mac.used_at           as primer_uso,
  d.document            as dni,
  v.plate               as patente,
  au.user_avl_code      as avl_user_code,
  au.api_key            as api_key,
  au.is_active          as avl_activo,
  u.email               as usuario_sistema
from mobile_activation_codes mac
join tenants   t  on t.id  = mac.tenant_id
join drivers   d  on d.id  = mac.driver_id
join vehicles  v  on v.id  = mac.vehicle_id
left join avl_users au on au.tenant_id = mac.tenant_id and au.user_avl_code = 'Rusertech_Mobile'
left join users u on u.tenant_id = mac.tenant_id and u.email = 'mobile@system.rusertech'
order by mac.created_at desc;
