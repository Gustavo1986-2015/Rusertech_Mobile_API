#!/usr/bin/env bash
# =====================================================================
# Rusertech Mobile API — SUITE VERIFY
#
# Implementa la secuencia de §4.6 y §4.8 del SPEC v1.3.1, más los gates
# de FIX-10 (estados operativos) y de la regla no negociable 401 vs 403.
#
# Uso:
#   BASE_URL=http://127.0.0.1:3000 ./verify.sh            # gate local
#   BASE_URL=https://xxx.vercel.app ./verify.sh           # contra Vercel
#
# Variables:
#   BASE_URL          raíz del deployment            (obligatoria)
#   DNI               documento del conductor        (default 12345678)
#   PLATE             patente                        (default AB123CD)
#   ACTIVATION_CODE   código de activación           (default PILOTO01)
#   PSQL              comando psql para las asertaciones de base.
#                     Si no se define, se saltean los chequeos de SQL
#                     (útil corriendo contra Vercel sin acceso a la base).
# =====================================================================
set -uo pipefail

BASE_URL="${BASE_URL:?definí BASE_URL}"
DNI="${DNI:-12345678}"
PLATE="${PLATE:-AB123CD}"
ACTIVATION_CODE="${ACTIVATION_CODE:-PILOTO01}"
PSQL="${PSQL:-}"

PASS=0; FAIL=0
RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; BOLD=$'\e[1m'; OFF=$'\e[0m'

step()  { printf '\n%s▶ %s%s\n' "$BOLD" "$1" "$OFF"; }
pass()  { PASS=$((PASS+1)); printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
fail()  { FAIL=$((FAIL+1)); printf '  %s✗%s %s\n' "$RED" "$OFF" "$1"; }
skip()  { printf '  %s–%s %s\n' "$YELLOW" "$OFF" "$1"; }

# assert_status <esperado> <obtenido> <descripción>
assert_status() {
  if [ "$1" = "$2" ]; then pass "$3 (HTTP $2)"; else fail "$3 — esperaba $1, obtuve $2"; fi
}
assert_eq() {
  if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 — esperaba '$1', obtuve '$2'"; fi
}

# req <método> <path> [body] [content-type] → escribe BODY y CODE
req() {
  local method="$1" path="$2" body="${3:-}" ctype="${4:-application/json}"
  local args=(-s -o /tmp/verify_body -w '%{http_code}' -X "$method" "$BASE_URL$path")
  [ -n "${APIKEY:-}" ] && args+=(-H "X-Hub-Api-Key: $APIKEY")
  if [ -n "$body" ]; then args+=(-H "Content-Type: $ctype" -d "$body"); fi
  CODE=$(curl "${args[@]}")
  BODY=$(cat /tmp/verify_body)
}

# noauth_req: igual pero sin API key
noauth_req() {
  local method="$1" path="$2" body="${3:-}"
  CODE=$(curl -s -o /tmp/verify_body -w '%{http_code}' -X "$method" \
    -H 'Content-Type: application/json' -d "$body" "$BASE_URL$path")
  BODY=$(cat /tmp/verify_body)
}

sql() { [ -n "$PSQL" ] && $PSQL -At -c "$1" 2>/dev/null; }
have_sql() { [ -n "$PSQL" ]; }

jqr() { echo "$BODY" | jq -r "$1" 2>/dev/null; }

# Los timestamps llevan una fracción de segundo única por corrida: así la
# suite se puede correr N veces seguidas sin que el dedupe marque como
# duplicados los puntos de la corrida anterior.
TS_BASE=$(date -u +%Y-%m-%dT%H:%M)
RUN_FRAC=$(printf '%06d' $(( (RANDOM * 32768 + RANDOM) % 1000000 )))

point() { # point <segundos> <code|null> <tripid|null>
  local sec="$1" code="$2" trip="$3"
  local codev tripv
  [ "$code" = "null" ] && codev=null || codev="\"$code\""
  [ "$trip" = "null" ] && tripv=null || tripv="\"$trip\""
  cat <<JSON
{"Asset":"$PLATE","Date":"${TS_BASE}:$(printf '%02d' "$sec").${RUN_FRAC}Z",
 "Latitude":-34.6037,"Longitude":-58.3816,"Speed":45.5,"Course":181.4,
 "Ignition":1,"Battery":78,"Code":$codev,"DriverDNI":"$DNI",
 "TripId":$tripv,"MobileCode":"RT-TEST-01"}
JSON
}

printf '%s== VERIFY Rusertech Mobile API ==%s\n' "$BOLD" "$OFF"
echo "BASE_URL: $BASE_URL"
have_sql && echo "SQL: habilitado" || echo "SQL: deshabilitado (solo HTTP)"

# ---------------------------------------------------------------------
step "1. Login correcto"
noauth_req POST /api/v1/mobile/login \
  "{\"documentId\":\"$DNI\",\"plate\":\"$PLATE\",\"activationCode\":\"$ACTIVATION_CODE\"}"
assert_status 200 "$CODE" "login con credenciales válidas"
APIKEY=$(jqr '.apiKey')
AVLCODE=$(jqr '.avlUserCode')
[ -n "$APIKEY" ] && [ "$APIKEY" != "null" ] \
  && pass "devuelve apiKey real (avlUserCode=$AVLCODE)" \
  || { fail "no devolvió apiKey — no se puede seguir"; exit 1; }

# ---------------------------------------------------------------------
step "2. Login con código de activación inválido → 401"
noauth_req POST /api/v1/mobile/login \
  "{\"documentId\":\"$DNI\",\"plate\":\"$PLATE\",\"activationCode\":\"CODIGOMALO\"}"
assert_status 401 "$CODE" "código inexistente"

step "2b. Login con código válido pero patente que no corresponde → 404"
noauth_req POST /api/v1/mobile/login \
  "{\"documentId\":\"$DNI\",\"plate\":\"ZZ999ZZ\",\"activationCode\":\"$ACTIVATION_CODE\"}"
assert_status 404 "$CODE" "patente no coincide con la activación"

# ---------------------------------------------------------------------
step "3. Health check del deployment"
req GET /api/v1/health
if [ "$CODE" = "200" ]; then
  pass "esquema y env vars completos"
else
  fail "health devolvió $CODE: $(jqr '.problems | join("; ")')"
fi

# ---------------------------------------------------------------------
step "4. Ingest con API Key real → 200 + fila en telemetry"
BEFORE=$(sql "select count(*) from telemetry" || echo 0)
req POST /api/v1/telemetry/ingest "$(point 10 null null)"
assert_status 200 "$CODE" "ingest de un punto"
assert_eq "1" "$(jqr '.inserted')" "reporta 1 insertado"
if have_sql; then
  AFTER=$(sql "select count(*) from telemetry")
  assert_eq "$((BEFORE+1))" "$AFTER" "hay una fila nueva en telemetry"
  assert_eq "t" "$(sql "select (raw_payload ? 'MobileCode') from telemetry order by \"timestamp\" desc limit 1")" \
    "raw_payload conserva MobileCode (activa el índice de dedupe)"
  assert_eq "t" "$(sql "select (location is not null) from telemetry order by \"timestamp\" desc limit 1")" \
    "el trigger completó location (la API la omitió)"
  assert_eq "181" "$(sql "select heading_degrees from telemetry order by \"timestamp\" desc limit 1")" \
    "Course 181.4 → heading_degrees 181 (smallint)"
  assert_eq "t" "$(sql "select ignition from telemetry order by \"timestamp\" desc limit 1")" \
    "Ignition 1 → true"
else
  skip "asertaciones SQL de telemetry"
fi

# ---------------------------------------------------------------------
step "5. Dedupe: mismo punto otra vez → 200 sin fila nueva"
BEFORE=$(sql "select count(*) from telemetry" || echo 0)
req POST /api/v1/telemetry/ingest "$(point 10 null null)"
assert_status 200 "$CODE" "reenvío del mismo punto"
assert_eq "0" "$(jqr '.inserted')" "reporta 0 insertados"
assert_eq "1" "$(jqr '.duplicates')" "reporta 1 duplicado"
if have_sql; then
  assert_eq "$BEFORE" "$(sql "select count(*) from telemetry")" "no se agregó fila"
fi

# ---------------------------------------------------------------------
step "6. Regla 401 vs 403 (no conflatar)"
SAVED_KEY="$APIKEY"
APIKEY="clave-que-no-existe-en-la-tabla"
req POST /api/v1/telemetry/ingest "$(point 11 null null)"
assert_status 401 "$CODE" "API Key inexistente (typo) → 401, la app SIGUE trackeando"
APIKEY="$SAVED_KEY"

req POST /api/v1/telemetry/ingest "$(point 11 null null)" >/dev/null
APIKEY=""
req POST /api/v1/telemetry/ingest "$(point 12 null null)"
assert_status 401 "$CODE" "sin header X-Hub-Api-Key → 401"
APIKEY="$SAVED_KEY"

if have_sql; then
  sql "update avl_users set is_active = false where api_key = '$APIKEY'" >/dev/null
  req POST /api/v1/telemetry/ingest "$(point 13 null null)"
  assert_status 403 "$CODE" "credencial REVOCADA por el operador → 403, la app DETIENE el tracking"
  sql "update avl_users set is_active = true where api_key = '$APIKEY'" >/dev/null
  req POST /api/v1/telemetry/ingest "$(point 13 null null)"
  assert_status 200 "$CODE" "reactivada → vuelve a aceptar"
else
  skip "revocación (requiere SQL)"
fi

# ---------------------------------------------------------------------
step "7. Validación de payload → 422"
req POST /api/v1/telemetry/ingest \
  "{\"Asset\":\"$PLATE\",\"Date\":\"no-es-fecha\",\"Latitude\":0,\"Longitude\":0}"
assert_status 422 "$CODE" "Date no ISO-8601"

req POST /api/v1/telemetry/ingest \
  "{\"Asset\":\"NOEXISTE9\",\"Date\":\"${TS_BASE}:20Z\",\"Latitude\":0,\"Longitude\":0}"
assert_status 422 "$CODE" "patente no registrada para el operador"

req POST /api/v1/telemetry/ingest \
  "{\"Asset\":\"$PLATE\",\"Date\":\"${TS_BASE}:21Z\",\"Latitude\":0,\"Longitude\":0,\"Code\":\"SOS\"}"
assert_status 422 "$CODE" "Code sin prefijo MOB_ (regla §0.2)"

# ---------------------------------------------------------------------
step "8. Batch"
BATCH=$(printf '[%s,%s,%s]' "$(point 30 null null)" "$(point 31 null null)" "$(point 32 null null)")
req POST /api/v1/telemetry/ingest/batch "$BATCH"
assert_status 200 "$CODE" "lote de 3 puntos"
assert_eq "3" "$(jqr '.inserted')" "3 insertados"

req POST /api/v1/telemetry/ingest/batch "$BATCH"
assert_status 200 "$CODE" "reenvío del MISMO lote → 200 aunque todo sea duplicado"
assert_eq "0" "$(jqr '.inserted')" "0 insertados en el reenvío"

DUPES=$(printf '[%s,%s]' "$(point 40 null null)" "$(point 40 null null)")
req POST /api/v1/telemetry/ingest/batch "$DUPES"
assert_eq "1" "$(jqr '.inserted')" "duplicado DENTRO del mismo lote se colapsa a 1"

BIG="[$(for i in $(seq 1 51); do point "$i" null null; echo -n ,; done | sed 's/,$//')]"
req POST /api/v1/telemetry/ingest/batch "$BIG"
assert_status 422 "$CODE" "lote de 51 puntos supera el máximo"

BAD=$(printf '[%s,{"Asset":"%s","Date":"roto"}]' "$(point 50 null null)" "$PLATE")
req POST /api/v1/telemetry/ingest/batch "$BAD"
assert_status 422 "$CODE" "ítem malformado en el lote"
assert_eq "1" "$(jqr '.index')" "el 422 identifica el índice del ítem"

# ---------------------------------------------------------------------
step "9. Crear viaje"
TRIP_BODY="{\"vehicleId\":\"$PLATE\",\"driverId\":\"$DNI\",\"originAddress\":\"Depósito Central\",\"destinationAddress\":\"Puerto\",\"cargoType\":\"Electrónica\",\"notes\":\"Carga frágil\",\"plannedHours\":6}"
req POST /api/v1/trips "$TRIP_BODY"
assert_status 200 "$CODE" "crear viaje con red"
TRIP_ID=$(jqr '.tripId')
assert_eq "active" "$(jqr '.status')" "status del contrato es 'active'"
[ -n "$TRIP_ID" ] && [ "$TRIP_ID" != "null" ] \
  && pass "tripId emitido por el servidor: $TRIP_ID" || fail "sin tripId"

if have_sql; then
  assert_eq "in_progress" "$(sql "select status from trips where id='$TRIP_ID'")" \
    "en base el status es 'in_progress'"
  assert_eq "en_route" "$(sql "select driver_state from trips where id='$TRIP_ID'")" \
    "driver_state arranca en 'en_route' (FIX-10)"
  assert_eq "6" "$(sql "select round(extract(epoch from (planned_end - planned_start))/3600) from trips where id='$TRIP_ID'")" \
    "planned_end = planned_start + 6 h (plannedHours)"
  assert_eq "t" "$(sql "select notes like 'Carga: Electrónica.%' from trips where id='$TRIP_ID'")" \
    "cargo_type quedó al inicio de notes"
  assert_eq "500" "$(sql "select corridor_meters from trips where id='$TRIP_ID'")" \
    "corridor_meters usa el default de la base (no se inventó valor)"
  assert_eq "mobile@system.rusertech" \
    "$(sql "select u.email from trips t join users u on u.id=t.created_by_user_id where t.id='$TRIP_ID'")" \
    "created_by_user_id = usuario de sistema"
fi

step "9b. Segundo viaje para la misma patente → 409"
req POST /api/v1/trips "$TRIP_BODY"
assert_status 409 "$CODE" "la base rechaza el segundo viaje en curso"
assert_eq "$TRIP_ID" "$(jqr '.tripId')" "el 409 devuelve el viaje activo para que la app lo adopte"

step "9c. GET /trips/active"
req GET "/api/v1/trips/active?plate=$PLATE"
assert_status 200 "$CODE" "consulta de viaje activo"
assert_eq "$TRIP_ID" "$(jqr '.tripId')" "devuelve el viaje en curso"

req GET "/api/v1/trips/active?plate=ZZ999ZZ"
assert_eq "null" "$(jqr '.')" "patente sin viaje → null"

step "9d. Conductor no registrado → 422"
req POST /api/v1/trips "{\"vehicleId\":\"$PLATE\",\"driverId\":\"00000000\"}"
assert_status 422 "$CODE" "DNI que no existe en drivers"

step "9e. plannedHours fuera del selector → 422"
req POST /api/v1/trips "{\"vehicleId\":\"$PLATE\",\"driverId\":\"$DNI\",\"plannedHours\":7}"
assert_status 422 "$CODE" "solo se aceptan 2/4/6/10/12"

# ---------------------------------------------------------------------
step "10. Evento MOB_SOS con viaje → telemetry + trip_events"
EV_BEFORE=$(sql "select count(*) from trip_events where trip_id='$TRIP_ID'" || echo 0)
START=$(date +%s%N)
req POST /api/v1/telemetry/ingest "$(point 55 MOB_SOS "$TRIP_ID")"
ELAPSED=$(( ($(date +%s%N) - START) / 1000000 ))
assert_status 200 "$CODE" "ingest del SOS"
if [ "$ELAPSED" -lt 1000 ]; then
  pass "respondió en ${ELAPSED} ms (< 1 s: el aviso no bloquea)"
else
  fail "respondió en ${ELAPSED} ms — el aviso está retrasando la respuesta"
fi
if have_sql; then
  assert_eq "$((EV_BEFORE+1))" "$(sql "select count(*) from trip_events where trip_id='$TRIP_ID'")" \
    "se creó la fila en trip_events"
  assert_eq "critical" "$(sql "select severity from trip_events where trip_id='$TRIP_ID' and event_type='MOB_SOS'")" \
    "severity 'critical' para MOB_SOS"
  assert_eq "t" "$(sql "select (location is not null) from trip_events where event_type='MOB_SOS' limit 1")" \
    "el trigger completó location en trip_events"
fi

step "10b. Duplicado de un evento NO duplica trip_events"
req POST /api/v1/telemetry/ingest "$(point 55 MOB_SOS "$TRIP_ID")"
assert_eq "0" "$(jqr '.inserted')" "el punto es duplicado"
if have_sql; then
  assert_eq "1" "$(sql "select count(*) from trip_events where trip_id='$TRIP_ID' and event_type='MOB_SOS'")" \
    "sigue habiendo UNA sola fila de MOB_SOS"
fi

step "10c. TripId inexistente no tira abajo la telemetría"
GHOST="00000000-0000-4000-8000-000000000000"
req POST /api/v1/telemetry/ingest "$(point 56 MOB_CHKPT "$GHOST")"
assert_status 200 "$CODE" "el punto se persiste igual"
assert_eq "1" "$(jqr '.inserted')" "telemetría insertada pese al viaje fantasma"

# ---------------------------------------------------------------------
step "11. FIX-10 — estados operativos del conductor"
req POST /api/v1/telemetry/ingest "$(point 57 MOB_STOP_AUTH "$TRIP_ID")"
assert_status 200 "$CODE" "declara parada autorizada"
if have_sql; then
  assert_eq "stopped_authorized" "$(sql "select driver_state from trips where id='$TRIP_ID'")" \
    "trips.driver_state = 'stopped_authorized'"
fi

req POST /api/v1/telemetry/ingest "$(point 58 MOB_RESUME "$TRIP_ID")"
if have_sql; then
  assert_eq "en_route" "$(sql "select driver_state from trips where id='$TRIP_ID'")" \
    "MOB_RESUME devuelve a 'en_route'"
fi

req POST /api/v1/telemetry/ingest "$(point 59 MOB_STOP "$TRIP_ID")"
if have_sql; then
  assert_eq "warning" "$(sql "select severity from trip_events where trip_id='$TRIP_ID' and event_type='MOB_STOP'")" \
    "MOB_STOP (parada no declarada) → severity 'warning'"
  assert_eq "en_route" "$(sql "select driver_state from trips where id='$TRIP_ID'")" \
    "MOB_STOP NO cambia driver_state"
fi

# ---------------------------------------------------------------------
step "12. Notificador §4.8"
if [ -n "${MOCK_LOG:-}" ] && [ -f "$MOCK_LOG" ]; then
  sleep 1
  EMAILS=$(jq '.emails | length' "$MOCK_LOG")
  HOOKS=$(jq '.webhooks | length' "$MOCK_LOG")
  [ "$EMAILS" -ge 2 ] \
    && pass "salieron $EMAILS emails (ops de Rusertech + canal del tenant)" \
    || fail "esperaba ≥2 emails, hubo $EMAILS"
  [ "$HOOKS" -ge 1 ] && pass "el webhook del cliente recibió el POST" \
    || fail "el webhook no recibió nada"
  assert_eq "true" "$(jq -r '.webhooks[-1].signatureValid' "$MOCK_LOG")" \
    "firma X-Rusertech-Signature (HMAC-SHA256) válida"
  assert_eq "MOB_SOS" "$(jq -r '.webhooks[-1].body.code' "$MOCK_LOG")" \
    "el webhook solo se disparó por MOB_SOS"
  assert_eq "1" "$(jq '[.webhooks[]] | length' "$MOCK_LOG")" \
    "telemetría normal (Code=null) NO generó avisos"
else
  skip "asertaciones del notificador (requiere MOCK_LOG del gate local)"
fi

# ---------------------------------------------------------------------
step "13. Cierre de viaje idempotente"
req POST "/api/v1/trips/$TRIP_ID/complete"
assert_status 200 "$CODE" "primer cierre"
assert_eq "completed" "$(jqr '.status')" "status 'completed'"
if have_sql; then
  assert_eq "completed" "$(sql "select status from trips where id='$TRIP_ID'")" "status en base"
  assert_eq "" "$(sql "select coalesce(driver_state,'') from trips where id='$TRIP_ID'")" \
    "driver_state se limpió al completar (FIX-10)"
  assert_eq "t" "$(sql "select (actual_end is not null) from trips where id='$TRIP_ID'")" "actual_end seteado"
fi

req POST "/api/v1/trips/$TRIP_ID/complete"
assert_status 409 "$CODE" "segundo cierre → 409 (la app lo trata como éxito)"

req POST "/api/v1/trips/$GHOST/complete"
assert_status 404 "$CODE" "cierre de viaje inexistente → 404"

# ---------------------------------------------------------------------
step "14. Foto de carga"
PHOTO=/tmp/verify_photo.jpg
printf '\xff\xd8\xff\xe0' > "$PHOTO"; head -c 20000 /dev/urandom >> "$PHOTO"
CODE=$(curl -s -o /tmp/verify_body -w '%{http_code}' -X POST \
  -H "X-Hub-Api-Key: $APIKEY" \
  -F "file=@$PHOTO;type=image/jpeg" \
  -F "plate=$PLATE" -F "type=carga" -F "notes=Foto de prueba" \
  -F "latitude=-34.6037" -F "longitude=-58.3816" -F "driverDocument=$DNI" \
  "$BASE_URL/api/v1/trips/attachments")
BODY=$(cat /tmp/verify_body)
assert_status 200 "$CODE" "upload de la foto"
ATT_ID=$(jqr '.id')
[ -n "$ATT_ID" ] && [ "$ATT_ID" != "null" ] && pass "devuelve id de trip_attachments" || fail "sin id"
[ "$(jqr '.url')" != "null" ] && pass "devuelve URL firmada" || fail "sin URL firmada"
if have_sql; then
  assert_eq "1" "$(sql "select count(*) from trip_attachments where id='$ATT_ID'")" \
    "fila en trip_attachments"
  assert_eq "t" "$(sql "select storage_path like '%/$PLATE/%' from trip_attachments where id='$ATT_ID'")" \
    "storage_path con el layout {tenant}/{plate}/{yyyy-MM}/{uuid}.jpg"
fi

step "14b. Foto de más de 2 MB → 422"
BIGPHOTO=/tmp/verify_big.jpg
head -c 2200000 /dev/urandom > "$BIGPHOTO"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "X-Hub-Api-Key: $APIKEY" -F "file=@$BIGPHOTO;type=image/jpeg" \
  -F "plate=$PLATE" -F "type=carga" "$BASE_URL/api/v1/trips/attachments")
assert_status 422 "$CODE" "se rechaza por tamaño"

# ---------------------------------------------------------------------
step "15. Rate limit de login (5 intentos por DNI cada 10 min)"
RL_DNI="99999999"
for i in 1 2 3 4 5; do
  noauth_req POST /api/v1/mobile/login \
    "{\"documentId\":\"$RL_DNI\",\"plate\":\"$PLATE\",\"activationCode\":\"MALO$i\"}" >/dev/null
done
noauth_req POST /api/v1/mobile/login \
  "{\"documentId\":\"$RL_DNI\",\"plate\":\"$PLATE\",\"activationCode\":\"MALO6\"}"
assert_status 429 "$CODE" "el sexto intento se frena"

# ---------------------------------------------------------------------
printf '\n%s================================%s\n' "$BOLD" "$OFF"
printf '%sPASS: %d%s   ' "$GREEN" "$PASS" "$OFF"
if [ "$FAIL" -gt 0 ]; then printf '%sFAIL: %d%s\n' "$RED" "$FAIL" "$OFF"; else printf 'FAIL: 0\n'; fi
printf '%s================================%s\n' "$BOLD" "$OFF"
[ "$FAIL" -eq 0 ]
