// Reenvío del consentimiento para autorizar la grabación (29 oct 2026): una paciente firmó sin autorizar
// grabar y ahora sí quiere. Vale le manda uno nuevo desde la ficha ("Enviar nuevo consentimiento"); se crea
// otra fila, la firmada queda intacta y manda la última firma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { pendienteOCrear } from './pareja';
import { evaluarConsentimientos } from './consentimiento';
import { estadoConsentimiento, vigentePropio } from './estadoConsentimiento';

const PID = '00000000-0000-4000-8000-0000000000aa';
const firmada = {
  id: '00000000-0000-4000-8000-0000000000b1', patient_id: PID, token: 'viejo', version: '2026-10-v3',
  created_at: '2026-10-20T12:00:00Z', sent_at: '2026-10-20T12:00:00Z', signed_at: '2026-10-20T12:05:00Z',
  signer_name: 'Ana Pérez', signer_rut: '12.345.678-5', accept_treatment: true, accept_recording: false,
  accept_case_review: false, revoked_at: null, recording_revoked_at: null,
};
const evaluar = (filas: any[]) => evaluarConsentimientos({ patientId: PID, tipo: 'individual', fichaPareja: false, fechaNacimiento: null, filas, hoy: '2026-10-29' });

test('firmó sin grabación → reenvío crea otra fila y al firmar con grabación se puede grabar', async () => {
  const db = new SupabaseMemoria();
  db.tabla('consents').push({ ...firmada });
  assert.equal(estadoConsentimiento({ filas: db.tabla('consents') as any, fichaPareja: false }), 'sin_grabacion');
  assert.equal(evaluar(db.tabla('consents')).puede, false);

  // "Enviar nuevo consentimiento": lo mismo que hace /api/admin/consent (getOrCreatePendingConsent).
  const nuevo = await pendienteOCrear(db.cliente, PID, 1, '2026-10-v3', () => 'nuevo');
  assert.notEqual(nuevo.id, firmada.id);
  assert.equal(db.tabla('consents').length, 2);
  // Volver a apretar no crea otra: reusa el pendiente.
  const otraVez = await pendienteOCrear(db.cliente, PID, 1, '2026-10-v3', () => 'otro');
  assert.equal(otraVez.id, nuevo.id);
  // Mientras no firme, sigue firmado sin grabación (no aparece "sin consentimiento").
  assert.equal(estadoConsentimiento({ filas: db.tabla('consents') as any, fichaPareja: false }), 'sin_grabacion');

  // Firma (lo que guarda /api/consentimiento), ahora marcando la grabación.
  const fila = db.tabla('consents').find((f) => f.id === nuevo.id)!;
  Object.assign(fila, { signed_at: '2026-10-29T15:00:00Z', signer_name: 'Ana Pérez', signer_rut: '12345678-5', accept_treatment: true, accept_recording: true });

  const filas = db.tabla('consents') as any[];
  assert.equal(vigentePropio(filas)?.id, nuevo.id);
  assert.equal(estadoConsentimiento({ filas, fichaPareja: false }), 'firmado');
  const v = evaluar(filas);
  assert.equal(v.puede, true);
  assert.deepEqual(v.consentIds, [nuevo.id]);
  // El firmado antes queda intacto (evidencia).
  const vieja = filas.find((f) => f.id === firmada.id)!;
  assert.equal(vieja.accept_recording, false);
  assert.equal(vieja.signed_at, firmada.signed_at);
});

test('había retirado solo la grabación → con la firma nueva vuelve a poder grabar', async () => {
  const filas: any[] = [{ ...firmada, accept_recording: true, recording_revoked_at: '2026-10-22T10:00:00Z' }];
  assert.equal(evaluar(filas).puede, false);
  filas.push({ ...firmada, id: '00000000-0000-4000-8000-0000000000b2', token: 'n', signed_at: '2026-10-29T15:00:00Z', accept_recording: true });
  assert.equal(evaluar(filas).puede, true);
});

test('si en la firma nueva tampoco marca la grabación, sigue sin poder grabar', () => {
  const filas: any[] = [{ ...firmada }, { ...firmada, id: '00000000-0000-4000-8000-0000000000b3', token: 'n', signed_at: '2026-10-29T15:00:00Z' }];
  assert.equal(evaluar(filas).puede, false);
  assert.equal(estadoConsentimiento({ filas, fichaPareja: false }), 'sin_grabacion');
});
