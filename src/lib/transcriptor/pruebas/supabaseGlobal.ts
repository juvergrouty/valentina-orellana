// Solo para pruebas (presencialRutas.test.ts): reemplaza a src/lib/supabase.ts cuando las RUTAS reales
// del grabador (/api/admin/transcriptor/*) se ejecutan en node:test. Reenvía cada llamada a la base en
// memoria que la prueba deja en globalThis.__voSupabasePrueba (SupabaseMemoria.cliente).
export const supabase = new Proxy({} as Record<string, unknown>, {
  get(_, k) {
    const db = (globalThis as { __voSupabasePrueba?: Record<string | symbol, unknown> }).__voSupabasePrueba;
    if (!db) throw new Error('supabaseGlobal: la prueba no definió globalThis.__voSupabasePrueba');
    const v = db[k];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(db) : v;
  },
});
