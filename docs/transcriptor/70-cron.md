# Transcriptor IA — job de pg_cron del orquestador (P6, 16 oct 2026)

> **17 oct 2026:** además del job de cada minuto, el webhook de AssemblyAI corre el orquestador apenas
> llega "completed"/"error" (después de responder 200, con `waitUntil` de Vercel), y la misma corrida que
> guarda la transcripción escribe el resumen. El job de cada minuto sigue siendo la red de seguridad.

`/api/cron/transcriptor` (src/pages/api/cron/transcriptor.ts → src/lib/transcriptor/pipeline.ts) debe
llamarse **cada minuto**. Igual que el job existente `tareas-cada-5-min` (expire-pending, reminders,
boletas-pendientes), lo dispara Supabase con **pg_cron + pg_net** y se autentica con
`Authorization: Bearer <settings.cron_interno_secret>` (la clave que generó la propia base; ver
`src/lib/cronAuth.ts`). Nadie la escribe ni la ve: el SQL la lee de `settings` en cada ejecución.

**NO está aplicado.** Aplicarlo solo cuando Vale lo apruebe, después de 0014, 0015 y 0016, y con
`transcriptor_activo` todavía en `'false'` (el endpoint igual responde y solo escribe el latido).

## 0. Mirar el job existente (la forma de referencia)

El comando del job `tareas-cada-5-min` vive solo en la base (no está en el repo). Antes de crear el
nuevo, compararlo y, si usa otra forma (por ejemplo, otra manera de leer la clave), copiar esa forma:

```sql
select jobid, jobname, schedule, active, command
from cron.job
where jobname = 'tareas-cada-5-min';
```

## 1. Crear el job (cada minuto)

Firma de `net.http_get` según la documentación oficial de Supabase (pg_net):
`net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 2000)`.
El tiempo por defecto (2 s) es demasiado corto. Desde el 16 oct la función de Vercel tiene
`maxDuration: 300` (astro.config.mjs; Fluid compute activo en el proyecto, región iad1) porque un
resumen de una sesión larga puede tardar más de 60 s (revisión de código A1; el tope por resumen
~240 s está en pipeline.ts). Por eso va `timeout_milliseconds := 290000` (290 s, bajo los 300 s de
la función: así pg_net no corta la conexión antes que Vercel). pg_net hace la petición en segundo
plano, así que no bloquea la base ni los otros jobs; con el job cada minuto puede haber varias
corridas solapadas, y no se pisan porque cada grabación se toma por fila.

```sql
select cron.schedule(
  'transcriptor-cada-1-min',
  '* * * * *',
  $$
  select net.http_get(
    url := 'https://www.valentinaorellana.cl/api/cron/transcriptor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from public.settings where key = 'cron_interno_secret')
    ),
    timeout_milliseconds := 290000
  ) as request_id;
  $$
);
```

(Ojo con el SQL Editor: autocierra corchetes y comillas; pegar el bloque completo de una vez.)

## 2. Verificar

```sql
-- Ejecuciones del job (deben salir 'succeeded' cada minuto)
select status, start_time, return_message
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'transcriptor-cada-1-min')
order by start_time desc limit 10;

-- Respuestas HTTP (200 = ok; 207 = algún paso falló y lo dice en "errores"; 401 = clave mal)
select status_code, left(content::text, 300) as cuerpo, created
from net._http_response
order by created desc limit 10;

-- Latido que escribe el orquestador en cada pasada (lo vigila el chequeo diario 'pg_cron')
select value from public.settings where key = 'transcriptor_latido';
```

La respuesta solo trae conteos por paso (`vigilar`, `bots`, `resumenes`, `envios`, `transcripciones`,
`limpieza`), nunca datos de pacientes.

## 3. Pausar o quitar

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'transcriptor-cada-1-min'), active := false);
select cron.unschedule('transcriptor-cada-1-min');
```

Apagar el transcriptor no exige tocar el job: con `transcriptor_activo = 'false'` el orquestador no
despacha bots ni procesa (solo apaga máquinas del bot olvidadas y escribe el latido) y avisa en el
panel si quedaron grabaciones detenidas a mitad de proceso.

### Job creado antes con `58000` (60 s)

Se corrige sin recrearlo:

```sql
select cron.alter_job(
  (select jobid from cron.job where jobname = 'transcriptor-cada-1-min'),
  command := $$
  select net.http_get(
    url := 'https://www.valentinaorellana.cl/api/cron/transcriptor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select value from public.settings where key = 'cron_interno_secret')
    ),
    timeout_milliseconds := 290000
  ) as request_id;
  $$
);
```

## 4. Antes de publicar: encabezados y llaves (revisión de seguridad 16 oct, B1/B5 y A2/M1)

**Encabezados en el preview de Vercel.** `vercel.json` excluye `/admin/grabar` de la regla general
con `(?!admin/grabar$)` y le da su propia regla: los mismos encabezados (incluida la
`Content-Security-Policy`) con un solo cambio, `microphone=(self)`. Correr contra la URL del preview
(reemplazar `PREVIEW`; no hace falta sesión, el encabezado sale también en la redirección al login):

```sh
PREVIEW=https://<tu-preview>.vercel.app
curl -sI "$PREVIEW/admin/grabar" | grep -iE '^(permissions-policy|content-security-policy|x-frame-options|strict-transport-security|referrer-policy|x-content-type-options):'
curl -sI "$PREVIEW/admin"        | grep -iE '^(permissions-policy|content-security-policy):'
curl -sI "$PREVIEW/admin/grabar/" | grep -iE '^permissions-policy:'
```

Esperado:
- `/admin/grabar`: **una sola** línea `permissions-policy: camera=(), microphone=(self), …` y la
  `content-security-policy` igual a la del resto del sitio.
- `/admin` (y cualquier otra ruta): `microphone=()` y la misma CSP.
- Si en `/admin/grabar` salen DOS `permissions-policy`, o falta la CSP, no publicar: revisar el
  patrón de `vercel.json`.

**Llaves fuera del bundle.** Antes de cada publicación que toque el transcriptor:

```sh
export PATH=~/pinokio/bin/miniconda/bin:$PATH
node scripts/verificar-secretos-build.mjs
```

Hace `astro build` con valores falsos únicos en todas las llaves (Supabase service role, Resend,
Anthropic, AssemblyAI, R2, B2, Fly, `BOT_TOKEN_SECRET`, `TRANSCRIPTOR_KEK_*`, `ADMIN_SECRET`,
`ADMIN_PASSWORD`, `CRON_SECRET`), los busca en `.vercel/output` y falla si aparece alguno; al
terminar borra `.vercel/output`. Las llaves se leen solo en tiempo de ejecución
(`src/lib/secretos.ts` y `src/lib/transcriptor/entorno.ts`); nunca `import.meta.env.<LLAVE>` ni
`import.meta.env` como objeto.
