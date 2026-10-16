# Transcriptor IA — Configurar Cloudflare R2, Backblaze B2 y la llave maestra (paso a paso para Vale)

Paquete P1 · 16 oct 2026. Pasos revisados en la documentación oficial (enlaces al final de cada parte).
Donde la documentación no confirma el nombre exacto de un botón, dice **[mirar en pantalla]**: el paso existe, pero el texto del botón puede variar un poco.

## Regla de oro: las llaves nunca pasan por el chat

Durante todo este proceso vas a ver claves secretas (en Cloudflare, en Backblaze y la llave maestra que generas en tu Mac).

- Cada clave se copia **de la página del proveedor directo a Vercel** y, si se pide, a tu gestor de contraseñas. Nada más.
- **Nunca** las pegues en este chat, en Claude, en correo, WhatsApp, Notion, notas del iPhone ni capturas de pantalla.
- Cuando termines, me escribes solo "listo, cargué las variables". Yo reviso que el sistema funcione **sin ver los valores**.
- Si por error pegas una clave donde no correspondía, avísame (sin repetirla): se anula y se crea otra. Es un trámite de 5 minutos.

Tiempo total estimado: 40–60 minutos. Costo: $0 con el volumen de la consulta (R2 incluye 10 GB al mes gratis; B2, 10 GB gratis).

---

## Parte 1 · Cloudflare R2 (audio temporal y transcripciones)

Se crean **dos "buckets"** (carpetas en la nube):

| Bucket | Qué guarda | Cuánto vive |
|---|---|---|
| `vo-audio-temporal` | El audio de la sesión mientras se transcribe | Se borra solo apenas termina la transcripción; como red de seguridad, una regla lo borra al día |
| `vo-transcripciones` | La transcripción **cifrada** (nadie la puede leer sin la llave maestra) | 15 años (ficha clínica) |

### 1.1 Activar R2
1. Entra a https://dash.cloudflare.com con tu cuenta (activa la verificación en dos pasos si no la tienes: **Mi perfil → Autenticación**).
2. En el menú de la izquierda: **R2 object storage → Overview**.
3. Si es la primera vez, Cloudflare pide aceptar el plan de R2 y agregar un medio de pago. El plan tiene capa gratuita; con el uso de la consulta no debería cobrar nada. **[mirar en pantalla]**
4. En la página **Overview**, anota (sin compartir) el **Account ID** que aparece en "Account Details": lo vas a pegar en Vercel como `R2_ACCOUNT_ID`. (No es secreto, pero igual va directo a Vercel.)

### 1.2 Crear el bucket de audio (con jurisdicción de EE.UU.)
1. **R2 object storage → Overview → Create bucket**.
2. Nombre: `vo-audio-temporal`
3. En **Location**, elige **Specify jurisdiction** y selecciona **United States** (código `us`).
   ⚠️ La jurisdicción **no se puede cambiar después**. Si te equivocas, borra el bucket y créalo de nuevo.
4. **Create bucket**.
5. Dentro del bucket, ve a **Settings** y confirma que el acceso público esté **desactivado** ("Public Development URL" / r2.dev en *Disabled* y sin dominio propio conectado). Viene así por defecto. **[mirar en pantalla]**

### 1.3 CORS del bucket de audio (permite que tu iPhone suba el audio desde tu sitio)
1. Bucket `vo-audio-temporal` → **Settings** → **CORS Policy** → **Add CORS policy**.
2. En la pestaña **JSON**, borra lo que haya y pega exactamente esto:

```json
[
  {
    "AllowedOrigins": ["https://www.valentinaorellana.cl", "https://valentinaorellana.cl"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 600
  }
]
```

3. **Save**. La política aparece en la página Settings del bucket.

Por qué así: solo tu sitio puede subir (ninguna otra página), solo se permite subir (no leer ni borrar desde el navegador) y `ETag` deja que el grabador confirme que cada parte llegó antes de borrarla del iPhone.

### 1.4 Regla de ciclo de vida del audio (borrar a 1 día)
1. Bucket `vo-audio-temporal` → **Settings** → **Object Lifecycle Rules** → **Add rule**.
2. Completa:
   - Nombre de la regla: `borrar-audio-1-dia`
   - Aplicar a prefijo: `a/` **[mirar en pantalla: puede decir "prefix" o "Apply to objects with prefix"]**
   - Borrar objetos (*expire / delete objects*) después de **1 día**.
   - Si aparece la opción de cancelar subidas multiparte incompletas (*abort incomplete multipart uploads*), ponla también en **1 día** (por defecto Cloudflare las borra a los 7).
3. **Save changes**.

Cloudflare borra normalmente dentro de las 24 h siguientes al vencimiento: es solo la red de seguridad; el sistema borra el audio apenas guarda la transcripción.

### 1.5 Crear el bucket de transcripciones
1. **Create bucket** → nombre `vo-transcripciones` → **Location: Specify jurisdiction → United States** → **Create bucket**.
2. **No** le pongas CORS (el navegador nunca toca este bucket).
3. **No** le pongas regla de borrado (son ficha clínica: 15 años).
4. Confirma que el acceso público esté desactivado, igual que en 1.2 paso 5.
5. No actives "bucket locks" (impedirían cumplir una solicitud de supresión).

### 1.6 Token de acceso con permisos mínimos
1. **R2 object storage → Overview** → en "Account Details", **Manage** junto a **API Tokens**.
2. **Create Account API token**.
3. Nombre: `transcriptor-sitio`.
4. **Permissions: Object Read & Write** (no elijas "Admin").
5. Limita el token a **solo estos dos buckets**: `vo-audio-temporal` y `vo-transcripciones` (opción de aplicar a buckets específicos). Si la lista separa buckets por jurisdicción, búscalos en la de **United States**. **[mirar en pantalla]**
6. Si ofrece fecha de vencimiento (TTL), elige 1 año y anota en tu calendario "renovar token R2" una semana antes.
7. Crea el token. Aparecen **Access Key ID** y **Secret Access Key**.
   ⚠️ El **Secret Access Key se muestra una sola vez**. Ten Vercel abierto en otra pestaña (Parte 4) y cópialo directo ahí antes de cerrar la página. Si cierras sin copiarlo, borra el token y crea otro.

Fuentes: [jurisdicción](https://developers.cloudflare.com/r2/reference/data-location/) · [CORS](https://developers.cloudflare.com/r2/buckets/cors/) · [ciclo de vida](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) · [tokens](https://developers.cloudflare.com/r2/api/tokens/) · [URLs prefirmadas](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

---

## Parte 2 · Backblaze B2 (copia de seguridad de las transcripciones)

### 2.1 Cuenta (atención a la región)
1. Crea la cuenta en https://www.backblaze.com (B2 Cloud Storage) con tu correo de la consulta.
2. ⚠️ Al registrarte hay un selector de **región** junto al botón de registro. Elige **US East** o **US West** (cualquiera de EE.UU.; mismo precio). **La región no se puede cambiar después** (habría que crear otra cuenta).
3. Activa la verificación en dos pasos (**My Settings / Account → Security**). **[mirar en pantalla]**

### 2.2 Crear el bucket
1. Menú izquierdo **B2 Cloud Storage → Buckets → Create a Bucket**.
2. Nombre: `vo-respaldo-` seguido de 6 letras o números al azar (ej.: `vo-respaldo-k7q2mz`). Los nombres son únicos en todo Backblaze; si dice que está ocupado, cambia las letras.
3. **Files in Bucket are: Private** (privado).
4. **Default Encryption: Enable** (cifrado SSE-B2 de Backblaze, además del nuestro). Si no aparece al crear, se activa después en la configuración del bucket. **[mirar en pantalla]**
5. **Object Lock: Disable** (no lo actives: una vez activado no se puede apagar y podría impedir borrar algo que la ley pida suprimir).
6. **Create a Bucket**.
7. En la tarjeta del bucket, anota (directo a Vercel) el valor **Endpoint**, por ejemplo `s3.us-west-004.backblazeb2.com`.
   - `B2_ENDPOINT` = ese valor completo.
   - `B2_REGION` = la parte del medio, entre `s3.` y `.backblazeb2.com` (en el ejemplo: `us-west-004`).

### 2.3 Ciclo de vida: no guardar versiones ocultas
Backblaze, por defecto, guarda **todas las versiones** de cada archivo: uno "borrado" queda oculto pero recuperable. Para que lo borrado se borre de verdad:
1. En la tarjeta del bucket → **Lifecycle Settings**.
2. Elige **Keep only the last version of the file** (guarda solo la última versión: lo oculto se elimina 1 día después).
3. Guarda.

(El sistema además borra todas las versiones al momento cuando se elimina una transcripción; esta regla es la red de seguridad.)

### 2.4 Llave de aplicación restringida (nunca la "Master Application Key")
1. Menú izquierdo **Application Keys → Add a New Application Key**.
2. **Name of Key**: `transcriptor-sitio`
3. **Allow access to Bucket(s)**: elige **solo** tu bucket `vo-respaldo-…` (no "All").
4. **Type of Access: Read and Write**.
5. **Allow List All Bucket Names**: déjalo **sin marcar**.
6. **File name prefix**: déjalo vacío (el mismo bucket guarda las transcripciones y el respaldo semanal).
7. **Duration (seconds)**: `31536000` (1 año). Anota en tu calendario "renovar llave B2" una semana antes.
8. **Create New Key**. Aparecen **keyID** y **applicationKey**.
   ⚠️ La **applicationKey se muestra una sola vez**: cópiala directo a Vercel (Parte 4).

Fuentes: [regiones](https://www.backblaze.com/docs/cloud-storage-data-regions) · [buckets](https://www.backblaze.com/docs/cloud-storage-create-and-manage-buckets) · [ciclo de vida](https://www.backblaze.com/docs/cloud-storage-lifecycle-rules) · [llaves](https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys) · [cifrado](https://www.backblaze.com/docs/cloud-storage-server-side-encryption) · [Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock)

---

## Parte 3 · La llave maestra (KEK) — la parte más importante

La llave maestra cifra todas las transcripciones. **Si se pierde, las transcripciones se pierden para siempre** (no hay recuperación, ni Cloudflare ni Backblaze ni yo podemos abrirlas). Por eso se guarda en dos lugares: Vercel y una copia offline tuya.

### 3.1 Generarla en tu Mac (sin que aparezca en pantalla)
1. Abre la app **Terminal** (Spotlight: ⌘ + espacio, escribe "Terminal").
2. Escribe esto y presiona Enter:

```
openssl rand -base64 32 | pbcopy
```

   No muestra nada: la llave quedó **copiada en el portapapeles** (son 44 caracteres terminados en `=`).

### 3.2 Guardar la copia offline (primero esto)
1. Abre la app **Contraseñas** de tu Mac (o tu gestor de contraseñas habitual) → nueva entrada.
2. Nombre: `Transcriptor KEK v1 (valentinaorellana.cl)`. En el campo contraseña: pega (⌘ + V).
3. En notas escribe: "Llave maestra de transcripciones. Va en Vercel como TRANSCRIPTOR_KEK_V1. No compartir."
4. Recomendado además: escríbela a mano en un papel y guárdalo con tus documentos importantes (no en el escritorio de la consulta).

### 3.3 Pegarla en Vercel
En la Parte 4, crea `TRANSCRIPTOR_KEK_V1` y pega (⌘ + V) el mismo valor. Después crea `TRANSCRIPTOR_KEK_ACTIVA` con el valor `v1`.

### 3.4 Limpiar el portapapeles
En Terminal escribe `pbcopy < /dev/null` y Enter (vacía el portapapeles). Cierra Terminal.

> Rotación (una vez al año o si sospechas filtración): se genera `TRANSCRIPTOR_KEK_V2` igual que arriba, se cambia `TRANSCRIPTOR_KEK_ACTIVA` a `v2` y yo corro el proceso que re-cifra todo con la nueva. La V1 se borra de Vercel solo cuando el sistema confirma que ya nada la usa. Las copias offline de ambas se guardan hasta entonces.

---

## Parte 4 · Cargar todo en Vercel

1. https://vercel.com → proyecto del sitio → **Settings → Environment Variables**.
2. Para cada fila de la tabla: **Add** → escribe el **Key** exactamente como aparece (mayúsculas y guiones bajos), pega el valor, **Type: Secret**, entorno **Production** solamente → **Save**.
   (Los "Secret" no se pueden volver a leer después de guardarlos: eso es lo que queremos.)

| Key (nombre exacto) | Valor | De dónde sale |
|---|---|---|
| `R2_ACCOUNT_ID` | Account ID | Cloudflare, 1.1 |
| `R2_JURISDICCION` | `us` | fijo |
| `R2_BUCKET_AUDIO` | `vo-audio-temporal` | 1.2 |
| `R2_BUCKET_TRANSCRIPCIONES` | `vo-transcripciones` | 1.5 |
| `R2_ACCESS_KEY_ID` | Access Key ID | 1.6 |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key | 1.6 (se ve una sola vez) |
| `B2_ENDPOINT` | ej. `s3.us-west-004.backblazeb2.com` | Backblaze, 2.2 |
| `B2_REGION` | ej. `us-west-004` | 2.2 |
| `B2_BUCKET` | `vo-respaldo-…` | 2.2 |
| `B2_KEY_ID` | keyID | 2.4 |
| `B2_APPLICATION_KEY` | applicationKey | 2.4 (se ve una sola vez) |
| `TRANSCRIPTOR_KEK_V1` | la llave de 44 caracteres | 3.1 |
| `TRANSCRIPTOR_KEK_ACTIVA` | `v1` | fijo |

3. Al terminar: **Deployments** → en el último → menú ⋯ → **Redeploy** (las variables nuevas solo llegan a un despliegue nuevo).
4. Escríbeme "listo, cargué las variables". **No me mandes los valores.** Yo verifico con la prueba automática (sube un objeto de prueba cifrado a R2 y B2, lo lee, lo descifra y lo borra, sin datos de pacientes) y te digo si algo falta, solo por el **nombre** de la variable.

---

## Lista de verificación final (para marcar)

- [ ] Cloudflare y Backblaze con verificación en dos pasos.
- [ ] `vo-audio-temporal` y `vo-transcripciones` creados con jurisdicción **United States**, sin acceso público.
- [ ] CORS pegado solo en `vo-audio-temporal`.
- [ ] Regla de 1 día en `vo-audio-temporal` (prefijo `a/`).
- [ ] Token R2 **Object Read & Write** solo para esos dos buckets.
- [ ] Bucket B2 privado, cifrado por defecto activado, sin Object Lock, "Keep only the last version of the file".
- [ ] Llave B2 restringida a ese bucket, Read and Write, 1 año.
- [ ] KEK guardada offline (gestor de contraseñas + papel) **antes** de pegarla en Vercel.
- [ ] 13 variables en Vercel como **Secret**, solo **Production**, y redeploy hecho.
- [ ] Recordatorios en el calendario: renovar token R2 y llave B2 en 1 año.

## Notas técnicas (para el equipo, no para Vale)

- Código: `src/lib/transcriptor/{cifrado,almacenamiento,entorno}.ts`. Endpoint R2 = `https://<R2_ACCOUNT_ID>.us.r2.cloudflarestorage.com` (los buckets con jurisdicción solo responden en su endpoint), `region: 'auto'`, path-style.
- Las llaves (KEK, secretos R2/B2) se leen solo de `process.env` en tiempo de ejecución para que Vite no las incruste en el bundle.
- Checksums del SDK en `WHEN_REQUIRED`: sin eso, `@aws-sdk/client-s3` ≥ 3.729 mete `x-amz-checksum-*` en las URLs prefirmadas y el navegador no puede subir.
- **[VERIFICAR en integración]**: la doc de R2 lista GET/HEAD/PUT/DELETE como prefirmables; `UploadPart` es un PUT con `partNumber`/`uploadId`, pero la doc no lo nombra explícitamente. Probar en el preview con una subida real de 3 partes de 8 MiB desde Safari iPhone antes de dar por cerrado P4.
- **[VERIFICAR en integración]**: que "Read and Write" de B2 incluya `deleteFiles` (la doc de capacidades no lo mapea). El chequeo canario `b2` (P8) lo prueba borrando todas las versiones de su objeto.
