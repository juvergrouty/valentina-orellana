import { supabase } from './supabase';
import { getBoletaAlerts, type BoletaAlert } from './boletaAlerts';
import { getConsentAlerts, type ConsentAlert } from './consent';
import { getBlockedDayAlerts, resumenDiaCompleto, leerCierresOk, claveCierre, type BlockedDayAlert } from './blockedDayAlerts';
import { feriadosPorDecidir, type FeriadoEstado } from './feriados';
import { corregirPrefijoInvitacionesUnaVez } from './syncCalendar';
import { leerRebotes, type Rebote } from './rebotes';
import { getComprobanteAlerts, type ComprobanteAlert } from './comprobantes';
import { avisosCambioTarifa, type AvisoTarifa } from './cambiosTarifa';
import { avisosSalud, type AvisoSalud } from './saludSitio';
import { avisosBoxCala, type AvisosBox } from './boxCala';
import { avisosImpuestos, type MesImpuestos } from './impuestos';
import { cobrosProximos, type CobroProximo } from './cobrosProximos';
import { contarCorreosFallidos } from './correosAutomaticos';
import { avisosPagosPorDevolver, type PagoPorDevolver } from './pagosPorDevolver';

// Avisos del panel (antes calculados dentro de AdminLayout.astro). Salen a
// este archivo (14 oct 2026) para que el Inicio (/admin) los use en su lista
// "Para hacer" sin consultarlos dos veces: la página los carga, los muestra y
// se los pasa al layout.

// Aviso de errores nuevos, visible en TODAS las páginas del admin — a pedido
// explícito de Valentina (24 sep 2026): "queda visible en /admin/logs" no
// sirve de nada si nadie va a mirarlo. Un correo tampoco: ya está saturada de
// correos. Esto se compara contra la última vez que abrió /admin/logs
// (guardado en settings) — si hay errores más nuevos que esa visita, se avisa
// acá mismo, en cualquier página que abra, sin que tenga que acordarse de nada.
// Los avisos se consultan EN PARALELO (antes uno tras otro, unas 12
// consultas en serie antes de mostrar cada página del panel). Cada uno
// tiene su propio catch: una falla no debe tumbar el resto del admin.
async function contarErroresNuevos(): Promise<number> {
  const { data: setting } = await supabase.from('settings').select('value').eq('key', 'logs_last_seen_at').maybeSingle();
  const lastSeen = setting?.value || '1970-01-01T00:00:00.000Z';
  const { count } = await supabase
    .from('admin_logs')
    .select('id', { count: 'exact', head: true })
    .eq('level', 'error')
    .gt('created_at', lastSeen);
  return count ?? 0;
}
// Días cerrados (feriados/vacaciones) de las próximas 2 semanas, con las horas
// que se pierden por modalidad (ver src/lib/blockedDayAlerts.ts). Antes del
// aviso se cierran los feriados confirmados que se acercan (también lo hace la
// tarea diaria google-reviews-refresh; esto solo escribe si falta alguno).
// Los que Valentina ya marcó "OK" no se muestran, salvo que se haya agendado
// otra sesión en ese día después del OK (12 oct 2026).
async function avisosDiasCerrados(): Promise<BlockedDayAlert[]> {
  const [alertas, oks] = await Promise.all([getBlockedDayAlerts(), leerCierresOk().catch(() => new Map<string, number>())]);
  return alertas
    .filter(a => a.presencial.length || a.online.length || a.agendadas)
    .filter(a => { const ok = oks.get(claveCierre(a)); return ok === undefined || a.agendadas > ok; });
}
// Feriados de las próximas 2 semanas sin decidir (ya no se cierran solos:
// Valentina elige "Cerrar el día" o "Atender normal" desde el aviso).
export type FeriadoAviso = FeriadoEstado & { presencial: number; online: number; agendadas: number };
async function avisosFeriados(): Promise<FeriadoAviso[]> {
  const lista = await feriadosPorDecidir();
  if (!lista.length) return [];
  const resumen = await resumenDiaCompleto(lista.map(f => f.fecha));
  return lista.map(f => ({ ...f, ...(resumen[f.fecha] ?? { presencial: 0, online: 0, agendadas: 0 }) }));
}
// Google Calendar: si no está conectado, o falla al leer los horarios ocupados,
// los eventos personales de Valentina dejan de bloquear horas en la agenda web
// (la agenda sigue mostrando horas para no quedar vacía). Antes nadie se enteraba.
async function estadoGoogle(): Promise<'ok' | 'desconectado' | 'fallando'> {
  const { data: rt } = await supabase.from('settings').select('value').eq('key', 'google_refresh_token').maybeSingle();
  if (!rt?.value) return 'desconectado';
  const desde = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase.from('admin_logs').select('id', { count: 'exact', head: true })
    .eq('context', 'availability/google').gt('created_at', desde);
  return (count ?? 0) >= 3 ? 'fallando' : 'ok';
}
// Cumpleaños de hoy (hora de Chile) de pacientes activos con fecha de
// nacimiento en la ficha. Un 29 de febrero se saluda el 28 en años no bisiestos.
export type Cumple = { id: string; nombre: string; edad: number | null; wa: string | null; tieneTel: boolean };
async function cumpleanosHoy(): Promise<Cumple[]> {
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [y, m, d] = hoy.split('-').map(Number);
  const bisiesto = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const { data } = await supabase.from('patients').select('id, name, phone, birthdate').eq('active', true).not('birthdate', 'is', null);
  return (data ?? []).flatMap((p) => {
    const [by, bm, bd] = String(p.birthdate).slice(0, 10).split('-').map(Number);
    const esHoy = (bm === m && bd === d) || (!bisiesto && bm === 2 && bd === 29 && m === 2 && d === 28);
    if (!esHoy || !p.name) return [];
    const digitos = String(p.phone ?? '').replace(/\D/g, '');
    const telWa = digitos.length === 9 ? '56' + digitos : digitos;
    const nombre = String(p.name).trim().split(/\s+/)[0];
    const texto = mensajeCumpleanos(nombre);
    return [{
      id: p.id, nombre: String(p.name).trim(),
      edad: by > 1900 && by < y ? y - by : null,
      wa: telWa.length >= 10 && telWa.length <= 15 ? `https://wa.me/${telWa}?text=${encodeURIComponent(texto)}` : null,
      tieneTel: !!digitos,
    }];
  });
}
// Correos que rebotaron (aviso de Resend) con la paciente a la que pertenecen.
export type ReboteAviso = Rebote & { paciente: { id: string; name: string } | null };
async function avisosRebotes(): Promise<ReboteAviso[]> {
  const lista = await leerRebotes();
  if (!lista.length) return [];
  const { data } = await supabase.from('patients').select('id, name, email').in('email', lista.map((r) => r.correo));
  return lista.map((r) => ({ ...r, paciente: (data ?? []).find((p) => String(p.email).toLowerCase() === r.correo) ?? null }));
}
// Saludo por WhatsApp: Valentina lo envía desde su teléfono y puede editarlo antes.
function mensajeCumpleanos(nombre: string): string {
  return `${nombre}, feliz cumpleaños! 🎉 Te mando un saludo grande, que hoy lo disfrutes mucho y que este nuevo año venga con cosas lindas para ti`;
}


export type { BoletaAlert, ConsentAlert, BlockedDayAlert, ComprobanteAlert, AvisoTarifa, AvisoSalud, AvisosBox, MesImpuestos, CobroProximo, PagoPorDevolver };

export type AvisosPanel = {
  newErrorCount: number;
  boletaAlerts: BoletaAlert[];
  consentAlerts: ConsentAlert[];
  comprobanteAlerts: ComprobanteAlert[];
  blockedDayAlerts: BlockedDayAlert[];
  feriadoAlerts: FeriadoAviso[];
  google: 'ok' | 'desconectado' | 'fallando';
  cumpleanos: Cumple[];
  rebotes: ReboteAviso[];
  tarifas: AvisoTarifa[];
  mantencion: AvisoSalud[];
  box: AvisosBox;
  cobros: CobroProximo[] | null;
  impuestos: MesImpuestos[];
  // Correos automáticos que fallaron desde la última vez que se miró la pestaña.
  correosFallidos: number;
  // Sesiones pagadas que se anularon o vencieron, hasta "Resuelto" (19 oct 2026).
  // null = no se pudo revisar (el panel lo dice en vez de callar).
  pagosPorDevolver: PagoPorDevolver[] | null;
};

export async function cargarAvisosPanel(origen: string): Promise<AvisosPanel> {
  const [newErrorCount, boletaAlerts, consentAlerts, comprobanteAlerts, blockedDayAlerts, feriadoAlerts, google, , cumpleanos, rebotes, tarifas, mantencion, box, cobros, impuestos, correosFallidos, pagosPorDevolver] = await Promise.all([
    // Errores nuevos desde la última visita a /admin/logs (pedido explícito de
    // Valentina, 24 sep 2026: "queda visible en /admin/logs" no sirve si nadie mira).
    contarErroresNuevos().catch(() => 0),
    // Boletas con error de emisión/envío: visibles hasta que se resuelvan.
    getBoletaAlerts().catch((): BoletaAlert[] => []),
    // Pacientes activos sin consentimiento firmado (Ley 21.719).
    getConsentAlerts().catch((): ConsentAlert[] => []),
    // Comprobantes de transferencia por confirmar (ver src/lib/comprobantes.ts).
    getComprobanteAlerts().catch((): ComprobanteAlert[] => []),
    avisosDiasCerrados().catch((): BlockedDayAlert[] => []),
    avisosFeriados().catch((): FeriadoAviso[] => []),
    estadoGoogle().catch(() => 'ok' as const),
    // Corrección única de invitaciones ya enviadas con "Por pagar" (ver syncCalendar.ts).
    corregirPrefijoInvitacionesUnaVez().catch(() => undefined),
    cumpleanosHoy().catch((): Cumple[] => []),
    avisosRebotes().catch((): ReboteAviso[] => []),
    // Cambios de tarifa de pacientes actuales (ver src/lib/cambiosTarifa.ts).
    avisosCambioTarifa().catch((): AvisoTarifa[] => []),
    // Dominio, Resend, WhatsApp, Instagram, tareas automáticas y reseñas que hay
    // que renovar o reconectar para que la página no se caiga (8 oct 2026, ver src/lib/saludSitio.ts).
    avisosSalud().catch((): AvisoSalud[] => []),
    // Horas de box por comprar (o liberar) en Espacio Cala para cada sesión
    // presencial (12 oct 2026, ver src/lib/boxCala.ts).
    avisosBoxCala().catch((): AvisosBox => ({ pendientes: [], liberar: [], error: true })),
    // Sesiones sin pagar que empiezan en las próximas 32 horas, con el WhatsApp
    // de cobro listo (14 oct 2026, ver src/lib/cobrosProximos.ts).
    cobrosProximos(origen).catch((): CobroProximo[] | null => null),
    // Pagar impuestos desde el día 16 de cada mes, hasta "Ya lo hice" (14 oct 2026, ver src/lib/impuestos.ts).
    avisosImpuestos().catch((): MesImpuestos[] => []),
    // Correos automáticos que no se pudieron enviar (16 oct 2026, ver src/lib/correosAutomaticos.ts).
    contarCorreosFallidos().catch(() => 0),
    // Pago por devolver o reagendar: sesión pagada que se anuló o venció, hasta que
    // Valentina aprieta "Resuelto" (19 oct 2026, ver src/lib/pagosPorDevolver.ts).
    avisosPagosPorDevolver().catch((): PagoPorDevolver[] | null => null),
  ]);
  return { newErrorCount, boletaAlerts, consentAlerts, comprobanteAlerts, blockedDayAlerts, feriadoAlerts, google, cumpleanos, rebotes, tarifas, mantencion, box, cobros, impuestos, correosFallidos, pagosPorDevolver };
}
