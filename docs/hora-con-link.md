# Link a una hora (`/hora/<token>`)

Pedido por Vale el 22 nov 2026. Rama `claude/link-pago-hora-251a14`. Requiere la migración
`supabase/migrations/0028_hora_con_link.sql` (sin ella, crear una hora con link responde
`falta_migracion_0028` y no crea nada; el resto del sitio funciona igual).

## Qué hace

1. Vale (panel, «Agendar hora» → «Link a esta hora») o el asistente de WhatsApp elige servicio,
   fecha y hora, y da solo **nombre + teléfono** o **nombre + correo**.
2. Se crea la reserva `pending_payment` con `created_by_admin = true` (no vence a los 30 min de
   `expireBooking.ts`) y su propio plazo `link_vence_at` (Configuración → «Link a una hora», 24 h
   por defecto, nunca después del inicio de la sesión). El cron de cada 5 min
   (`cron/boletas-pendientes`) la libera si vence sin pago y avisa a Vale (Inicio + correo).
3. La paciente abre `/hora/<token>`: solo esa hora, modalidad, valor y tres formas de pago
   (Flow, SumUp, transferencia). Flow exige correo: si la reserva no tiene, lo pide ahí mismo.
4. Al pagar, los mismos envíos de siempre (`tareasEnvio.ts`). Si se agendó con teléfono, la tarea
   «confirmacion» manda por WhatsApp fecha, cómo llegar o el Meet y el link de Pasos a seguir
   (`enviarPasosWhatsapp`). Si WhatsApp no puede, Vale ve en el Inicio el mensaje listo (wa.me).
5. Datos para la boleta (RUT, dirección, comuna) son **opcionales** después de pagar. Sin RUT, la
   sesión queda «Pagada · boleta pendiente de datos»; al escribir el RUT (paciente o Vale en la
   sesión) la boleta sale con la **fecha del pago** (`fechaEmisionBoleta`).

## Para el asistente de WhatsApp

```ts
import { crearHoraConLink } from '../lib/horaLink';

const r = await crearHoraConLink({
  servicio: 'online',          // id de services_catalog, o 'online' | 'presencial' | 'pareja-online' | 'pareja-presencial'
  fecha: '2026-11-25',         // hora de Chile
  hora: '18:00',
  nombre: 'Ana Soto',
  telefono: '+56912345678',    // o correo; basta uno
  correo: null,
  origen: 'asistente',         // 'panel' | 'asistente' | 'whatsapp' | 'otro'
});
if (r.ok) {
  // r.url            → link /hora/<token> para mandarle
  // r.mensajeWhatsapp → texto cercano ya armado (hora, link y hasta cuándo se guarda)
  // r.venceAt        → ISO: hasta cuándo se retiene
} else {
  // r.codigo: 'datos' | 'servicio' | 'precio' | 'ocupada' | 'no_disponible' | 'pasada'
  //           | 'falta_migracion_0028' | 'base_de_datos'
  // r.error: texto en español para mostrar
}
```

- Con origen distinto de `'panel'`, solo acepta horas que aparecen libres en la agenda web
  (`horaDisponible`: horario de Vale + Google Calendar). Para ofrecer horas, usar
  `calcularDisponibilidad` de `src/lib/disponibilidad.ts`.
- No manda nada por WhatsApp: el asistente envía `r.mensajeWhatsapp` en su conversación. Con solo
  correo, sí le manda el link por correo (se apaga con `enviarCorreo: false`).
- Plantilla opcional para los Pasos fuera de la ventana de 24 h de Meta: settings
  `whatsapp_pasos_template_name` (+ `whatsapp_pasos_template_lang`), con un solo parámetro de texto.

## Transferencias (todos los flujos)

- La foto del comprobante deja la sesión pagada y con todos los envíos al instante (como antes),
  más la marca `BoletaEsperaBanco`: la boleta no sale todavía.
- Con Gmail conectado (Configuración → «Revisar transferencias en tu correo», permiso de solo
  lectura, conexión aparte de Calendar), el cron busca el aviso del banco con el monto exacto entre
  2 días antes y 3 después: monto + nombre → boleta; monto sin nombre → aviso para que Vale decida;
  nada en 48 h → aviso y sin boleta.
- Sin Gmail, o en cualquier caso, «Ya la vi: emitir boleta» en el Inicio emite la boleta.
- El texto de los correos no se guarda; solo el id del mensaje que calzó.

## Medición (dataLayer)

`hora_link_abierto` (estado), `hora_link_pago_inicio` (metodo: flow | sumup),
`hora_link_transferencia`, `hora_link_pagado` (metodo, value, currency). Sin datos personales.
`?vista=vale` (botón «Ver la página» del panel) no dispara eventos. `purchase` sigue igual en
`confirmacion.astro` (solo reservas web). Faltan las etiquetas en GTM.
