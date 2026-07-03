import { supabase } from './supabase';

export interface GReview {
  author:   string;
  rating:   number;
  text:     string;
  time:     number;
  relative?: string;
  photo?:   string;
}
export interface ReviewsCache {
  rating: number | null;
  total:  number | null;
  reviews: GReview[];
  updated: string;
}

async function getConfig() {
  const { data } = await supabase
    .from('settings').select('key, value').in('key', ['google_place_id', 'google_places_api_key']);
  const s: Record<string, string> = {};
  (data ?? []).forEach((r: { key: string; value: string }) => { s[r.key] = r.value; });
  const placeId = s.google_place_id ?? '';
  const apiKey  = s.google_places_api_key ?? import.meta.env.GOOGLE_PLACES_API_KEY ?? '';
  return { placeId, apiKey };
}

/** Consulta en vivo la API de Google Places (gasta cuota). */
export async function fetchGoogleReviewsLive(): Promise<ReviewsCache | null> {
  const { placeId, apiKey } = await getConfig();
  if (!placeId || !apiKey) return null;

  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=rating,user_ratings_total,reviews&reviews_sort=newest&language=es&key=${apiKey}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (json.status !== 'OK') return null;

  const reviews: GReview[] = (json.result?.reviews ?? []).map((r: Record<string, unknown>) => ({
    author:   r.author_name as string,
    rating:   r.rating as number,
    text:     (r.text as string) ?? '',
    time:     r.time as number,
    relative: r.relative_time_description as string,
    photo:    r.profile_photo_url as string,
  }));

  return {
    rating: (json.result?.rating as number) ?? null,
    total:  (json.result?.user_ratings_total as number) ?? null,
    reviews,
    updated: new Date().toISOString(),
  };
}

/** Refresca la caché en la BD. Llamado por el cron diario y por el botón del admin. */
export async function refreshGoogleReviewsCache(): Promise<{ ok: boolean; count?: number; error?: string }> {
  const data = await fetchGoogleReviewsLive();
  if (!data) return { ok: false, error: 'Google no está configurado o no respondió.' };
  const { error } = await supabase.from('settings')
    .upsert({ key: 'google_reviews_cache', value: JSON.stringify(data) }, { onConflict: 'key' });
  if (error) return { ok: false, error: error.message };
  return { ok: true, count: data.reviews.length };
}

/** Lee la caché guardada (sin llamar a Google). La usa el hero público. */
export async function getCachedReviews(): Promise<ReviewsCache | null> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'google_reviews_cache').maybeSingle();
  if (!data?.value) return null;
  try { return JSON.parse(data.value) as ReviewsCache; } catch { return null; }
}
