// Transcriptor IA — botón "Reintentar" / "Reintentar resumen" del aviso del panel (paquete P8).
// No ejecuta el paso: deja la grabación en el estado correcto según estados.ts para que el cron
// (P6, /api/cron/transcriptor, cada minuto) la vuelva a tomar.
//   • estado 'error'       → reintentar() de estados.ts: vuelve a estado_antes_error (atómico).
//   • estado intermedio que el cron procesa solo (subida, transcribiendo, transcrita, resumiendo,
//     bot_lanzando, creada) pero atascado → se libera la toma (tomada_en = null).
//   • Si vuelve a 'resumiendo' y el último resumen quedó en 'error' → ese resumen vuelve a
//     'pendiente' con intentos = 0 (si no, el cron no lo vuelve a intentar).
//   • grabando / pausada / subiendo / bot_en_lobby → no se puede desde el servidor: mensaje claro.
import { TIEMPOS, type EstadoGrabacion, type Grabacion, type Origen } from './tipos';
import { destinoReintento, TERMINALES } from './estados';

export type AccionReintento = 'reintentar' | 'reintentar_resumen';

export type PlanReintento =
  /** enTelefono: vuelve a un estado del grabador presencial; el audio lo sube el iPhone (no el cron). */
  | { tipo: 'reintentar_error'; destino: EstadoGrabacion; reabrirResumen: boolean; enTelefono?: boolean }
  | { tipo: 'soltar'; estado: EstadoGrabacion; reabrirResumen: boolean }
  | { tipo: 'manual'; mensaje: string }
  | { tipo: 'nada'; mensaje: string };

/** Estados que el cron retoma solo si nadie tiene la toma. */
export const RETOMABLES_POR_CRON: readonly EstadoGrabacion[] = ['creada', 'bot_lanzando', 'subida', 'transcribiendo', 'transcrita', 'resumiendo'];

export interface EstadoParaReintento {
  estado: EstadoGrabacion;
  estado_antes_error: EstadoGrabacion | null;
  origen: Origen;
}

/** Decide qué hacer (función pura, con pruebas para cada estado). */
export function planReintento(g: EstadoParaReintento, accion: AccionReintento, resumenEnError: boolean): PlanReintento {
  if (g.estado === 'error') {
    const destino = destinoReintento(g);
    if (!destino) {
      return { tipo: 'manual', mensaje: 'No quedó registrado en qué paso falló, así que no se puede reintentar sola. Revísala en la página Transcriptor.' };
    }
    const delTelefono = ['creada', 'grabando', 'pausada', 'subiendo'].includes(destino);
    if (delTelefono && g.origen === 'online') {
      // El bot ya no está en la reunión: volver a 'grabando' la dejaría quieta para siempre.
      return { tipo: 'manual', mensaje: 'El bot se cayó antes de entregar el audio y no se puede recuperar desde aquí. Revisa la sesión en la página Transcriptor.' };
    }
    if (delTelefono) {
      // Presencial: grabacion-finalizar acepta creada/grabando/pausada/subiendo, así el iPhone puede volver a subir.
      return { tipo: 'reintentar_error', destino, reabrirResumen: false, enTelefono: true };
    }
    if (!RETOMABLES_POR_CRON.includes(destino)) {
      return { tipo: 'manual', mensaje: 'No se puede reintentar desde aquí. Revísala en la página Transcriptor.' };
    }
    return { tipo: 'reintentar_error', destino, reabrirResumen: destino === 'resumiendo' && resumenEnError };
  }
  if (g.estado === 'creada' && g.origen === 'presencial') {
    return { tipo: 'manual', mensaje: 'El audio todavía está en el teléfono con que grabaste. Abre la página Grabar en ese teléfono (con internet) y se sube solo.' };
  }
  if (RETOMABLES_POR_CRON.includes(g.estado)) {
    return { tipo: 'soltar', estado: g.estado, reabrirResumen: g.estado === 'resumiendo' && resumenEnError };
  }
  if (g.estado === 'grabando' || g.estado === 'pausada' || g.estado === 'subiendo') {
    return {
      tipo: 'manual',
      mensaje: g.origen === 'presencial'
        ? 'El audio todavía está en el teléfono con que grabaste. Abre la página Grabar en ese teléfono (con internet) y se sube solo.'
        : 'El bot no terminó de entregar el audio. Revisa la sesión en la página Transcriptor.',
    };
  }
  if (g.estado === 'bot_en_lobby') {
    return { tipo: 'manual', mensaje: 'El bot quedó esperando en la sala de Meet. Si la sesión ya terminó, se retira solo; si no, admítelo.' };
  }
  if (g.estado === 'lista') {
    return { tipo: 'nada', mensaje: accion === 'reintentar_resumen' ? 'La sesión ya tiene su resumen listo.' : 'La sesión ya está lista.' };
  }
  if (TERMINALES.includes(g.estado) || g.estado === 'sin_consentimiento') {
    return { tipo: 'nada', mensaje: 'Esta grabación ya no tiene pasos pendientes.' };
  }
  return { tipo: 'manual', mensaje: 'No se puede reintentar desde aquí. Revísala en la página Transcriptor.' };
}

export interface OpsReintento {
  leer(grabacionId: string): Promise<{ grabacion: EstadoParaReintento; resumenErrorId: string | null } | null>;
  reintentar(grabacionId: string): Promise<Pick<Grabacion, 'estado'> | null>;
  /** Libera la toma SOLO si está vencida (no pisa un proceso en curso). true si la liberó o no había. */
  soltar(grabacionId: string): Promise<boolean>;
  /** Último resumen en 'error' → 'pendiente' (intentos 0). true si lo cambió. */
  reabrirResumen(resumenId: string): Promise<boolean>;
}

export interface ResultadoReintento {
  ok: boolean;
  /** true = la alerta se puede cerrar (se reintentó o ya no había nada que hacer). */
  resolver: boolean;
  mensaje: string;
  desde?: EstadoGrabacion;
  hacia?: EstadoGrabacion;
}

export async function ejecutarReintento(grabacionId: string, accion: AccionReintento, ops: OpsReintento): Promise<ResultadoReintento> {
  const datos = await ops.leer(grabacionId);
  if (!datos) return { ok: false, resolver: false, mensaje: 'No se encontró la grabación.' };
  const { grabacion: g, resumenErrorId } = datos;
  const plan = planReintento(g, accion, !!resumenErrorId);
  switch (plan.tipo) {
    case 'manual':
      return { ok: false, resolver: false, mensaje: plan.mensaje, desde: g.estado };
    case 'nada':
      return { ok: true, resolver: true, mensaje: plan.mensaje, desde: g.estado, hacia: g.estado };
    case 'reintentar_error': {
      const r = await ops.reintentar(grabacionId);
      if (!r) return { ok: false, resolver: false, mensaje: 'La grabación cambió mientras tanto. Recarga la página.', desde: g.estado };
      if (plan.reabrirResumen && resumenErrorId) await ops.reabrirResumen(resumenErrorId);
      const mensaje = plan.enTelefono
        ? 'Listo: abre la página Grabar en el teléfono con que grabaste (con internet) y el audio se sube solo.'
        : 'Listo: se vuelve a intentar en el próximo minuto.';
      return { ok: true, resolver: true, mensaje, desde: 'error', hacia: r.estado };
    }
    case 'soltar': {
      if (!(await ops.soltar(grabacionId))) {
        return { ok: false, resolver: false, mensaje: 'Se está procesando en este momento. Espera unos minutos y vuelve a mirar.', desde: g.estado };
      }
      if (plan.reabrirResumen && resumenErrorId) await ops.reabrirResumen(resumenErrorId);
      return { ok: true, resolver: true, mensaje: 'Listo: se vuelve a intentar en el próximo minuto.', desde: g.estado, hacia: g.estado };
    }
  }
}

/** Operaciones reales sobre Supabase (usa reintentar/soltar de estados.ts). */
export async function opsReintentoSupabase(): Promise<OpsReintento> {
  const { supabase: db } = await import('../supabase');
  const estados = await import('./estados');
  return {
    async leer(id) {
      const { data: g, error } = await db.from('grabaciones').select('id, estado, estado_antes_error, origen').eq('id', id).maybeSingle();
      if (error) throw new Error(`leer grabación: ${error.message}`);
      if (!g) return null;
      const { data: rs } = await db.from('resumenes_ia').select('id, estado').eq('grabacion_id', id)
        .eq('autor', 'ia').order('version', { ascending: false }).limit(1);
      const ultimo = (rs?.[0] as { id: string; estado: string } | undefined) ?? null;
      return { grabacion: g as EstadoParaReintento, resumenErrorId: ultimo?.estado === 'error' ? ultimo.id : null };
    },
    reintentar: (id) => estados.reintentar(id, db),
    async soltar(id) {
      // Condicional en la misma consulta: solo si nadie tiene una toma vigente (lease de estados.ts).
      const limite = new Date(Date.now() - TIEMPOS.leaseTomaMs).toISOString();
      const { data, error } = await db.from('grabaciones').update({ tomada_en: null })
        .eq('id', id).or(`tomada_en.is.null,tomada_en.lt.${limite}`).select('id').maybeSingle();
      if (error) throw new Error(`soltar: ${error.message}`);
      return !!data;
    },
    async reabrirResumen(rid) {
      const { data, error } = await db.from('resumenes_ia').update({ estado: 'pendiente', intentos: 0, ultimo_error: null })
        .eq('id', rid).eq('estado', 'error').select('id').maybeSingle();
      if (error) throw new Error(`reabrir resumen: ${error.message}`);
      return !!data;
    },
  };
}
