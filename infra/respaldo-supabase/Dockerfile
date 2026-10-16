# Imagen mínima del respaldo semanal: cliente de Postgres 17 (pg_dump ≥ versión del servidor
# de Supabase), age (cifrado) y curl (subida S3 a B2 con --aws-sigv4).
FROM postgres:17-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends age curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY respaldo.sh /usr/local/bin/respaldo.sh
RUN chmod 0755 /usr/local/bin/respaldo.sh
USER postgres
# Sin servidor de Postgres: solo el script, que termina (la máquina programada se detiene).
ENTRYPOINT ["/usr/local/bin/respaldo.sh"]
