# Transcriptor IA — job de pg_cron del orquestador (P6, 16 oct 2026)

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
El tiempo por defecto (2 s) es demasiado corto: el orquestador trabaja hasta ~50 s (maxDuration 60 s),
por eso va `timeout_milliseconds := 58000`. pg_net hace la petición en segundo plano, así que no bloquea
la base ni los otros jobs.

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
    timeout_milliseconds := 58000
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
