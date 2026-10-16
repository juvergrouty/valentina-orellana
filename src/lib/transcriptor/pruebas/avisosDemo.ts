// Avisos de prueba para ver el aviso rojo y la página de acción en `astro dev` (?demo=avisos).
// Solo se usan con import.meta.env.DEV (en producción la rama no existe). Nombres inventados.
import type { AlertaAbierta, SesionDeAlerta } from '../alertas';

const hoy = () => new Date().toISOString().slice(0, 10);
const id = (n: number) => `00000000-0000-4000-8000-00000000d0${String(n).padStart(2, '0')}`;

function sesion(p: Partial<SesionDeAlerta>): SesionDeAlerta {
  return {
    session_date: hoy(), inicio_at: `${hoy()}T19:00:00Z`, origen: 'presencial', estado: 'error', estado_antes_error: 'resumiendo',
    patient_id: 'demo-p1', paciente: 'Camila Rojas', hora_fin_prevista: null, bot_machine_id: null, segmentos_subidos: 1, b2_pendientes: 0, ...p,
  };
}

export function alertasDemo(): AlertaAbierta[] {
  const ahora = new Date().toISOString();
  const base = { creada_at: ahora, ultima_vez: ahora, veces: 1, resuelta_at: null, resuelta_por: null, correo_enviado_at: null } as const;
  return [
    { ...base, id: id(1), tipo: 'resumen', titulo: 'No se pudo generar el resumen automático de la sesión presencial de hoy', detalle: 'Claude: sobrecargado (HTTP 529)', grabacion_id: id(91), accion: 'reintentar_resumen', clave: `resumen:${id(91)}`, veces: 3, sesion: sesion({}) },
    { ...base, id: id(2), tipo: 'respaldo', titulo: '1 transcripción no tiene copia en Backblaze B2', detalle: 'Están guardadas (cifradas) en R2, pero falta la segunda copia de seguridad.', grabacion_id: null, accion: 'revisar', clave: 'salud:copias_b2', sesion: null },
    { ...base, id: id(3), tipo: 'config', titulo: 'Faltan 1 variable de configuración en Vercel', detalle: 'Faltan: ANTHROPIC_API_KEY. Sin ellas el transcriptor no puede funcionar.', grabacion_id: null, accion: 'revisar', clave: 'salud:config', sesion: null },
    { ...base, id: id(4), tipo: 'bot', titulo: 'El asistente de notas no llegó a la sesión online de hoy', detalle: 'La máquina se creó pero nunca avisó que estaba en la sala de espera. Esa sesión no quedó grabada.', grabacion_id: id(92), accion: 'revisar', clave: `bot:${id(92)}`, sesion: sesion({ origen: 'online', estado_antes_error: 'bot_lanzando', hora_fin_prevista: '2026-01-01T00:00:00Z', segmentos_subidos: 0, paciente: 'Diego Pérez' }) },
  ];
}
