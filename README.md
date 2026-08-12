# Rusertech Mobile API

Backend de ingesta para la app Android **Rusertech Mobile**. Next.js (App Router)
sobre Vercel, contra la base Supabase **compartida** con Rusertech Web.

> **Regla de oro:** el contrato de API es definitivo. Cuando el backend de
> Rusertech Web esté en línea, el swap es UN cambio en la app: el
> `buildConfigField` de `BACKEND_BASE_URL`. Nada de este repo debe requerir
> que la app se toque.

---

## Endpoints

| Método | Path | Auth | Descripción |
|---|---|---|---|
| POST | `/api/v1/mobile/login` | no | DNI + patente + código de activación → credenciales |
| POST | `/api/v1/telemetry/ingest` | key | 1 `HubRawPayload` (camino rápido del SOS) |
| POST | `/api/v1/telemetry/ingest/batch` | key | array de `HubRawPayload` (máx. 50) |
| POST | `/api/v1/trips` | key | crea viaje, devuelve el `tripId` del servidor |
| POST | `/api/v1/trips/{tripId}/complete` | key | cierra viaje (idempotente) |
| GET | `/api/v1/trips/active?plate=XXX` | key | viaje activo o `null` |
| POST | `/api/v1/trips/attachments` | key | multipart, foto de carga |
| GET | `/api/v1/health` | key | gate de despliegue: valida esquema y env vars |

Autenticación por header `X-Hub-Api-Key` salvo login.

### Semántica de status codes — no negociable

| Código | Significado | Qué hace la app |
|---|---|---|
| `401` | header ausente, o API Key que **no existe** (typo/malformada) | **sigue trackeando**, banner ámbar, datos en Room |
| `403` | API Key que **existe** pero el operador la revocó | **detiene el tracking** y bloquea el botón |
| `409` | conflicto idempotente (viaje ya cerrado / ya hay uno en curso) | lo trata como éxito |
| `422` | payload inválido | **no reintenta** ese ítem |
| `429` | rate limit (solo login) | pide esperar |

Nunca devolver 403 por un typo. Es la distinción que separa "hay un problema
de red" de "el operador te dio de baja".

---

## Arquitectura de acceso a datos

**`pg` (node-postgres) vía el Transaction Pooler de Supavisor para TODO el
acceso a base. `supabase-js` sobrevive únicamente para Storage.**

Esto se desvía del §4 del spec, que decía `supabase-js` para todo. El motivo
es concreto y no estético:

1. El dedupe de telemetría necesita `ON CONFLICT DO NOTHING` contra
   `telemetry_mobile_dedupe`, un índice único **parcial** y con **expresión**
   (`coalesce(provider_code,'')` … `where raw_payload ? 'MobileCode'`).
   PostgREST no puede apuntar un `on_conflict` a eso.
2. Un punto con código `MOB_` dentro de un viaje son **tres escrituras**
   (`telemetry` + `trip_events` + `trips.driver_state`). Por PostgREST serían
   tres round trips sin transacción: si la primera entra y la segunda falla,
   el dashboard queda inconsistente. Acá es una sola transacción.
3. La base está congelada, así que resolverlo con funciones RPC no era opción.

El contrato de API no cambia en absoluto: es implementación interna.

### Reglas del pool (obligatorias en serverless)

- `DATABASE_URL` apunta al **Transaction Pooler (puerto 6543)**, nunca a la
  conexión directa 5432. Serverless abre muchas conexiones cortas.
- El pool vive a **nivel de módulo**, `max: 3`, idle timeout 10 s. Vercel
  reutiliza instancias; un pool por request agota la base en el primer pico.
- **Sin prepared statements con nombre** — el transaction mode de Supavisor no
  los soporta. `pg` en modo default no los usa mientras no se pase `name`, y
  acá no se pasa nunca. Por eso tampoco hay ORM.
- La conexión entra como rol `postgres` y bypassea RLS. Es lo esperado del
  lado servidor, misma postura que la service role key.

---

## Variables de entorno (Vercel)

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Supabase → Connect → **Transaction pooler (6543)** |
| `SUPABASE_URL` | Storage |
| `SUPABASE_SERVICE_ROLE_KEY` | Storage — **solo server-side** |
| `ATTACHMENTS_BUCKET` | `cargo-photos` |
| `RESEND_API_KEY` | avisos por email (§4.8) |
| `ALERTS_FROM_EMAIL` | remitente de los avisos |
| `RUSERTECH_OPS_EMAIL` | casilla de Rusertech que recibe todo evento crítico |

`RESEND_BASE_URL` existe solo para tests locales. En producción **no definirla**.

Ninguna de estas variables lleva prefijo `NEXT_PUBLIC_`: nada de esto puede
terminar en el bundle del cliente.

---

## Puesta en marcha

1. **Bucket:** Supabase → Storage → New bucket → `cargo-photos`, **privado**.
2. **Seed:** correr `sql/seed_staging.sql` en el SQL Editor. Es idempotente;
   se puede correr las veces que haga falta. Devuelve el `activation_code`,
   el DNI, la patente y la `api_key` que necesita el VERIFY.
3. **Deploy:** importar el repo en Vercel, cargar las env vars, desplegar.
4. **Gate:** `GET /api/v1/health` con una API Key válida debe devolver `200`
   y `{"ok":true,"problems":[]}`. Si devuelve `503`, el array `problems` dice
   exactamente qué falta (columna, índice, usuario de sistema o env var).
5. **VERIFY completo:**
   ```bash
   BASE_URL=https://rusertech-mobile-api.vercel.app \
   DNI=12345678 PLATE=AB123CD ACTIVATION_CODE=PILOTO01 \
   ./verify/verify.sh
   ```
   Sin `PSQL` definido corre solo las asertaciones HTTP. Con acceso a la base:
   ```bash
   PSQL="psql $DATABASE_URL" ./verify/verify.sh
   ```

---

## Limitaciones conocidas

- **Rate limit de login en memoria del proceso.** El límite de 5 intentos por
  DNI cada 10 min se cuenta por instancia de función, no globalmente: la base
  está congelada (no se pueden crear tablas) y no se quiso sumar Redis/KV por
  una defensa anti-fuerza-bruta de un piloto. Con el volumen del piloto una
  sola instancia atiende casi todo. El reemplazo natural es Vercel KV, sin
  tocar nada fuera de `src/lib/auth.ts`.
- **Sin EventEngine.** Mientras Rusertech Web no esté en línea no hay
  `event_logs` ni alertas en vivo; por eso existe el notificador de §4.8 como
  puente. `telemetry` y `trip_events` quedan completos y correctos.
- **`MobileCode` garantizado por la API.** El índice de dedupe solo aplica a
  filas cuyo `raw_payload` tiene esa clave. Si la app no la manda, la API la
  inyecta con el `user_avl_code`: sin eso el dedupe no aplicaría y se
  duplicaría telemetría en silencio.

---

## Estructura

```
src/
  lib/
    config.ts      constantes del contrato (status, estados, severidades, límites)
    db.ts          pool de pg + helper de transacción
    auth.ts        X-Hub-Api-Key (401 vs 403) + rate limit de login
    http.ts        helpers de respuesta con la semántica de códigos
    payload.ts     validación de HubRawPayload / Login / CreateTrip
    telemetry.ts   ingesta: dedupe + trip_events + driver_state, en 1 transacción
    trips.ts       alta, cierre idempotente y consulta de viaje activo
    notifier.ts    §4.8 — Resend + webhook firmado, siempre post-respuesta
    storage.ts     supabase-js, solo para el bucket de fotos
  app/api/v1/...   route handlers (todos runtime nodejs, force-dynamic)
```

Si cambia el vocabulario de la base o el backend se reemplaza, `config.ts` es
el único archivo que debería necesitar cambios.
