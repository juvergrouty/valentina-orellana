// Guardia de silencio durante la grabación (9 nov 2026).
// Dos sesiones online (28 oct y 3 nov) grabaron 53–56 min de silencio aunque a la máquina le llegaban
// datos de Meet al mismo ritmo que en sesiones buenas. Esta guardia mira el pico de audio que el robot
// mide en cada lectura (cada 15 s): si con 2 o más personas en la reunión no hay voz por `repararTras` lecturas seguidas,
// pide reenganchar el audio; si sigue sin voz hasta `avisarTras`, avisa a Vale (una vez por sesión)
// para que grabe de respaldo con su celular. Un minuto con voz reinicia la cuenta.

export type AccionSilencio = 'nada' | 'reparar' | 'avisar';

export class GuardiaSilencio {
  private seguidos = 0;
  private avisado = false;
  private reparaciones = 0;

  constructor(private readonly o: { umbral: number; repararTras: number; avisarTras: number; maxReparaciones: number }) {}

  /** Una lectura (cada 15 s): `pico` 0–1 de la mezcla y cuántas personas (sin el robot) hay en la reunión. */
  observar(pico: number, personas: number): AccionSilencio {
    // Con voz se reinicia todo (también reparaciones y aviso): una pausa larga normal al comienzo no
    // debe gastar la ayuda para una falla real más tarde. Con menos de 2 personas solo se reinicia la cuenta.
    if (pico >= this.o.umbral) { this.seguidos = 0; this.reparaciones = 0; this.avisado = false; return 'nada'; }
    if (personas < 2) { this.seguidos = 0; return 'nada'; }
    this.seguidos++;
    if (this.seguidos >= this.o.avisarTras && !this.avisado) { this.avisado = true; return 'avisar'; }
    if (this.seguidos >= this.o.repararTras && this.reparaciones < this.o.maxReparaciones
        && (this.seguidos - this.o.repararTras) % this.o.repararTras === 0) {
      this.reparaciones++;
      return 'reparar';
    }
    return 'nada';
  }

  get lecturasSeguidas(): number { return this.seguidos; }
}
