// STUB P6 — lo reemplaza P8 (alertas en el panel, decisión 8 de 01-decisiones-16oct.md).
// Solo fija la interfaz que usa el orquestador (pipeline.ts). Mientras P8 no esté, cada
// alerta queda registrada en la bitácora (transcriptor_auditoria, acción 'alerta') para no
// perderla. NUNCA contenido clínico en titulo/detalle: solo fecha, hora, tipo de sesión.

export type AlertaTipo = 'subida' | 'transcripcion' | 'resumen' | 'bot' | 'respaldo' | 'salud' | 'costo' | 'config';

export interface NuevaAlerta {
  tipo: AlertaTipo;
  titulo: string;
  detalle?: string;
  grabacionId?: string | null;
  accion?: 'reintentar' | 'reintentar_resumen' | 'revisar' | 'ninguna';
  clave?: string; /* para no duplicar */
}

export async function registrarAlerta(a: NuevaAlerta): Promise<void> {
  console.warn(`[transcriptor/alerta] ${a.tipo}: ${a.titulo}`);
  const { auditar } = await import('./auditoria');
  await auditar('sistema', 'alerta', {
    grabacionId: a.grabacionId ?? null,
    resultado: 'error',
    detalle: { tipo: a.tipo, titulo: a.titulo, detalle: a.detalle ?? null, accion: a.accion ?? 'revisar', clave: a.clave ?? null },
  });
}

export async function resolverAlertasDe(_grabacionId: string, _tipo?: AlertaTipo): Promise<void> {
  // P8: marcar como resueltas las alertas abiertas de esa grabación.
}
