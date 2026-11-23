// Pruebas del origen marcado a mano (22 nov 2026). Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { origenManual, unirOrigen, utmEnUrl } from './origen';

test('origen manual: canal elegido, o calculado desde los UTM', () => {
  assert.equal(origenManual({ canal: '', via: 'panel' }), null);
  assert.equal(origenManual({ canal: 'inventado', via: 'panel' }), null);
  const o = origenManual({ canal: 'Recomendación', via: 'panel' })!;
  assert.equal(o.canal, 'Recomendación');
  assert.equal(o.manual, true);
  const u = origenManual({ utm: { utm_source: 'instagram', utm_campaign: 'agenda' }, via: 'asistente' })!;
  assert.equal(u.canal, 'Instagram');
  assert.equal(u.last?.utm_campaign, 'agenda');
});

test('unir con el navegador: conserva el canal de Vale', () => {
  const g = origenManual({ canal: 'Anuncio de Instagram o Facebook', via: 'panel' });
  const n = { canal: 'Google Ads', first: { gclid: 'x' }, last: { gclid: 'x' } };
  assert.equal(unirOrigen(g, n)?.canal, 'Anuncio de Instagram o Facebook');
  assert.equal(unirOrigen(g, n)?.first?.gclid, 'x');
  assert.equal(unirOrigen(null, { canal: 'Directo / desconocido', first: null, last: null }), null);
  assert.equal(unirOrigen({ canal: 'Google Ads', first: { gclid: 'a' }, last: null }, n), null); // ya tenía: no se toca
});

test('UTM en el link', () => {
  assert.equal(utmEnUrl('https://x.cl/hora/t', { utm_source: 'whatsapp', utm_campaign: 'c1' }), 'https://x.cl/hora/t?utm_source=whatsapp&utm_campaign=c1');
  assert.equal(utmEnUrl('https://x.cl/hora/t', null), 'https://x.cl/hora/t');
});
