// Pruebas de la versión de texto plano de los correos (4 nov 2026).
// Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlATexto } from './htmlATexto';

test('texto plano: quita estilos, conserva párrafos y decodifica tildes', () => {
  const html = '<html><head><style>p{color:red}</style><title>x</title></head><body><!-- nota -->'
    + '<p>Hola Pedro,</p><p>Tu sesi&oacute;n es el <strong>4&nbsp;de noviembre</strong> &middot; 09:00</p></body></html>';
  assert.equal(htmlATexto(html), 'Hola Pedro,\n\nTu sesión es el 4 de noviembre · 09:00');
});

test('texto plano: los enlaces muestran su dirección y los mailto quedan como texto', () => {
  const html = '<p><a href="https://www.valentinaorellana.cl/consentimiento/abc" style="x">Firmar consentimiento</a></p>'
    + '<p><a href="mailto:consulta@valentinaorellana.cl">consulta@valentinaorellana.cl</a></p>'
    + '<p><a href="https://wa.me/56972735696">https://wa.me/56972735696</a></p>';
  assert.equal(htmlATexto(html),
    'Firmar consentimiento (https://www.valentinaorellana.cl/consentimiento/abc)\n\nconsulta@valentinaorellana.cl\n\nhttps://wa.me/56972735696');
});

test('texto plano: tablas y listas en líneas separadas, sin líneas vacías de más', () => {
  const html = '<table><tr><td>Fecha</td><td>4 nov</td></tr><tr><td>Hora</td><td>09:00</td></tr></table>'
    + '<ul><li>Uno</li><li>Dos</li></ul><div></div><div></div><br><br><br><p>Fin</p>';
  assert.equal(htmlATexto(html), 'Fecha 4 nov\nHora 09:00\n\n• Uno\n• Dos\n\nFin');
});

test('texto plano: entidades inválidas y enlaces sin cerrar no rompen ni demoran el envío', () => {
  assert.equal(htmlATexto('<p>a &#99999999; b</p>'), 'a &#99999999; b');
  const t0 = Date.now();
  htmlATexto('<p>' + '<a href="https://x.cl/a">uno '.repeat(4000) + '"fin"</p>');
  assert.ok(Date.now() - t0 < 1000);
});
