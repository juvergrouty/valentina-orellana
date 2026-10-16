#!/bin/bash
# Respaldo semanal de Supabase → Backblaze B2, cifrado (el plan Free de Supabase no respalda).
# Corre en una máquina programada de Fly (`fly machine run --schedule weekly`, ver
# bot/README.md §Respaldo). Pasos: pg_dump (formato custom) → verificación con pg_restore
# --list → cifrado con age a la LLAVE PÚBLICA de Vale (la máquina no puede descifrar: la
# llave privada vive offline con Vale) → PUT a B2 (API S3, firma SigV4 con curl) → HEAD para
# verificar tamaño → actualiza respaldos/ultimo.txt (lo lee el chequeo diario de salud).
# La rotación (8 semanas) la hace la regla de ciclo de vida del bucket, no este script.
#
# Variables (secrets de la app de Fly del respaldo, NO de la app del bot):
#   DATABASE_URL            cadena de conexión de Supabase (Session pooler, puerto 5432)
#   B2_ENDPOINT             p. ej. https://s3.us-west-004.backblazeb2.com
#   B2_REGION               p. ej. us-west-004
#   B2_BUCKET               bucket de respaldo
#   B2_KEY_ID / B2_APPLICATION_KEY  llave de aplicación SOLO para ese bucket y prefijo respaldos/
#   RESPALDO_AGE_RECIPIENT  llave pública age de Vale (age1…); no es secreta
set -euo pipefail

for v in DATABASE_URL B2_ENDPOINT B2_REGION B2_BUCKET B2_KEY_ID B2_APPLICATION_KEY RESPALDO_AGE_RECIPIENT; do
  if [ -z "${!v:-}" ]; then echo "respaldo: falta la variable $v" >&2; exit 2; fi
done
case "$RESPALDO_AGE_RECIPIENT" in age1*) ;; *) echo "respaldo: RESPALDO_AGE_RECIPIENT no es una llave pública age" >&2; exit 2;; esac

fecha="$(date -u +%Y%m%dT%H%M%SZ)"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

echo "respaldo: volcando la base ($fecha)"
pg_dump "$DATABASE_URL" --format=custom --compress=6 --no-owner --no-privileges \
  --schema=public --file="$dir/db.dump"

# Verificación mínima: el volcado se puede leer y trae los datos de tablas clave.
pg_restore --list "$dir/db.dump" > "$dir/lista.txt"
for tabla in bookings patients session_notes consents settings; do
  if ! grep -q "TABLE DATA public $tabla " "$dir/lista.txt"; then
    echo "respaldo: el volcado no trae la tabla $tabla; se cancela" >&2; exit 3
  fi
done

age -r "$RESPALDO_AGE_RECIPIENT" -o "$dir/db.dump.age" "$dir/db.dump"
rm -f "$dir/db.dump"

subir() { # $1 archivo, $2 llave, $3 content-type
  local sha bytes url
  sha="$(sha256sum "$1" | cut -d' ' -f1)"
  bytes="$(stat -c %s "$1")"
  url="${B2_ENDPOINT%/}/${B2_BUCKET}/$2"
  curl --fail --silent --show-error --retry 3 --retry-all-errors \
    --aws-sigv4 "aws:amz:${B2_REGION}:s3" --user "${B2_KEY_ID}:${B2_APPLICATION_KEY}" \
    -H "x-amz-content-sha256: ${sha}" -H "Content-Type: $3" \
    -T "$1" "$url" >/dev/null
  # Verificación: el objeto existe con el mismo tamaño.
  local remoto
  remoto="$(curl --fail --silent --show-error --head \
    --aws-sigv4 "aws:amz:${B2_REGION}:s3" --user "${B2_KEY_ID}:${B2_APPLICATION_KEY}" \
    -H "x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" \
    "$url" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{print $2}')"
  if [ "$remoto" != "$bytes" ]; then echo "respaldo: tamaño en B2 ($remoto) ≠ local ($bytes)" >&2; exit 4; fi
  echo "$sha"
}

llave="respaldos/supabase-${fecha}.dump.age"
sha="$(subir "$dir/db.dump.age" "$llave" application/octet-stream)"
printf '%s\n%s\n%s\n' "$fecha" "$llave" "$sha" > "$dir/ultimo.txt"
subir "$dir/ultimo.txt" "respaldos/ultimo.txt" text/plain >/dev/null
echo "respaldo: listo ($llave)"
