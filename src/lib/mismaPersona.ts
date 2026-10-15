// ¿Dos nombres son la misma persona? (sin tildes ni mayúsculas): mismo primer
// nombre y, si ambos traen más, al menos un apellido en común. Sirve para
// reconocer una sesión de Encuadrado ("Luis Rafael Medina Mendez") como la
// misma de la página ("Luis Medina Mendez"). Misma regla que el Inicio.
const palabras = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-zñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

export function mismaPersona(a: string, b: string): boolean {
  const x = palabras(a), y = palabras(b);
  if (!x.length || !y.length || x[0] !== y[0]) return false;
  const restoX = x.slice(1), restoY = y.slice(1);
  return !restoX.length || !restoY.length || restoX.some((w) => restoY.includes(w));
}
