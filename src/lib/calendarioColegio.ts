// Calendario escolar del colegio del hijo de Valentina (22 nov 2026: "que me avise cuando viene feriado,
// vacaciones, todo, por lo menos con un mes de anticipación para organizarme y cerrar o abrir días o bloques").
// Colegio: Lycée Antoine de Saint-Exupéry · Corporación Educacional Alianza Francesa de Santiago.
// Fuente oficial: https://lafase.cl/home-espacio-familias/ (imágenes "Calendrier Scolaire").
//   2026: https://lafase.cl/wp-content/uploads/2026/10/Calendario-2026-Oct.webp
//   2027 (versión preliminar "v1", puede cambiar): https://lafase.cl/wp-content/uploads/2026/11/Calendario-2027.webp
// Fechas leídas y verificadas a mano el 21 nov 2026. Cuando el colegio publique la versión final de 2027, revisarlas.
// Los feriados que caen en fin de semana no se listan (no cambian la semana de clases).

export type DiaColegio = { desde: string; hasta: string; que: string; preliminar?: boolean };

export const CALENDARIO_COLEGIO: DiaColegio[] = [
  // 2026 (lo que queda desde noviembre)
  { desde: '2026-12-07', hasta: '2026-12-08', que: 'Lunes 7 sin clases y martes 8 feriado' },
  { desde: '2026-12-18', hasta: '2027-02-28', que: 'Vacaciones de verano (el jueves 17 de diciembre es el último día de clases)' },
  // 2027 · versión preliminar del colegio
  { desde: '2027-03-01', hasta: '2027-03-01', que: 'Vuelta a clases después del verano', preliminar: true },
  { desde: '2027-03-26', hasta: '2027-03-26', que: 'Feriado (Viernes Santo)', preliminar: true },
  { desde: '2027-05-03', hasta: '2027-05-14', que: 'Vacaciones de otoño', preliminar: true },
  { desde: '2027-05-21', hasta: '2027-05-21', que: 'Feriado', preliminar: true },
  { desde: '2027-06-21', hasta: '2027-06-21', que: 'Feriado', preliminar: true },
  { desde: '2027-06-28', hasta: '2027-06-28', que: 'Feriado', preliminar: true },
  { desde: '2027-07-12', hasta: '2027-07-30', que: 'Vacaciones de invierno (vuelve a clases el lunes 2 de agosto)', preliminar: true },
  { desde: '2027-09-13', hasta: '2027-09-17', que: 'Vacaciones de Fiestas Patrias', preliminar: true },
  { desde: '2027-10-11', hasta: '2027-10-11', que: 'Feriado', preliminar: true },
  { desde: '2027-11-01', hasta: '2027-11-01', que: 'Feriado', preliminar: true },
  { desde: '2027-12-08', hasta: '2027-12-08', que: 'Feriado', preliminar: true },
  { desde: '2027-12-20', hasta: '2027-12-31', que: 'Vacaciones de verano (el viernes 17 de diciembre es el último día de clases)', preliminar: true },
];

const DIAS_AVISO = 31; // "por lo menos con un mes de anticipación"

const diasEntre = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

/** Días del colegio que empiezan en los próximos 31 días (o ya empezaron y siguen). */
export function proximosDelColegio(hoy: string): Array<DiaColegio & { id: string; enDias: number }> {
  return CALENDARIO_COLEGIO
    .filter((d) => d.hasta >= hoy && diasEntre(hoy, d.desde) <= DIAS_AVISO)
    .map((d) => ({ ...d, id: `colegio:${d.desde}`, enDias: Math.max(0, diasEntre(hoy, d.desde)) }));
}
