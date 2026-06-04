/**
 * Cliente para la API de Flow.cl
 * Documentación: https://www.flow.cl/app/web/api.html
 *
 * Flow requiere que todos los parámetros se firmen con HMAC-SHA256:
 *  1. Tomar todos los parámetros (excepto 's')
 *  2. Ordenarlos alfabéticamente por nombre de clave
 *  3. Concatenar como: "clave1valor1clave2valor2..."
 *  4. HMAC-SHA256(secretKey, cadena) → firma hexadecimal
 */

import { createHmac } from 'node:crypto';

// ─── Config ──────────────────────────────────────────────────────────────────

export const FLOW_URLS = {
  sandbox:    'https://sandbox.flow.cl/api',
  production: 'https://www.flow.cl/api',
} as const;

const IS_SANDBOX = import.meta.env.FLOW_ENV !== 'production';
export const FLOW_BASE_URL = IS_SANDBOX ? FLOW_URLS.sandbox : FLOW_URLS.production;

// Keys por defecto según env var FLOW_ENV
// En sandbox usa FLOW_SANDBOX_API_KEY si existe, si no cae en FLOW_API_KEY
const API_KEY    = import.meta.env.FLOW_API_KEY;
const SECRET_KEY = import.meta.env.FLOW_SECRET_KEY;
const SANDBOX_API_KEY    = import.meta.env.FLOW_SANDBOX_API_KEY    ?? API_KEY;
const SANDBOX_SECRET_KEY = import.meta.env.FLOW_SANDBOX_SECRET_KEY ?? SECRET_KEY;

// ─── Firma ───────────────────────────────────────────────────────────────────

type Params = Record<string, string | number>;

/** Genera la firma HMAC-SHA256 requerida por Flow */
function sign(params: Params, secretKey: string): string {
  const keys   = Object.keys(params).sort();
  const concat = keys.map(k => `${k}${params[k]}`).join('');
  return createHmac('sha256', secretKey).update(concat).digest('hex');
}

/** Construye un body form-encoded con todos los params + firma */
function buildBody(params: Params, secretKey: string): URLSearchParams {
  const s    = sign(params, secretKey);
  const body = new URLSearchParams();
  Object.keys(params).sort().forEach(k => body.append(k, String(params[k])));
  body.append('s', s);
  return body;
}

/** Construye query string con todos los params + firma */
function buildQuery(params: Params, secretKey: string): URLSearchParams {
  return buildBody(params, secretKey);
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface FlowOrder {
  url:       string;   // URL base de pago de Flow
  token:     string;   // Token único — redirigir a url?token=token
  flowOrder: number;   // Número de orden interno de Flow
}

export interface FlowStatus {
  flowOrder:      number;
  commerceOrder:  string;         // = merchantTransactionId = nuestro booking ID
  requestDate:    string;
  status:         1 | 2 | 3 | 4; // 1=pendiente, 2=pagado, 3=rechazado, 4=anulado
  subject:        string;
  currency:       string;
  amount:         number;
  payer:          string;
  paymentData?: {
    date:           string;
    media:          string;       // 'webpay', 'mach', etc.
    conversionRate: number;
  };
}

// ─── Funciones públicas ───────────────────────────────────────────────────────

/**
 * Crea una orden de pago en Flow.
 * El usuario debe ser redirigido a: `${order.url}?token=${order.token}`
 */
export async function createPaymentOrder(opts: {
  subject:          string;
  amount:           number;
  email:            string;
  orderId:          string;
  urlConfirmation:  string;
  urlReturn:        string;
  baseUrl?:         string;  // sobreescribe FLOW_BASE_URL (desde settings de admin)
}): Promise<FlowOrder> {
  const base      = opts.baseUrl ?? FLOW_BASE_URL;
  const isSandbox = base === FLOW_URLS.sandbox;
  const apiKey    = isSandbox ? SANDBOX_API_KEY    : API_KEY;
  const secretKey = isSandbox ? SANDBOX_SECRET_KEY : SECRET_KEY;
  const params: Params = {
    apiKey:          apiKey,
    subject:         opts.subject,
    currency:        'CLP',
    amount:          opts.amount,
    email:           opts.email,
    urlConfirmation: opts.urlConfirmation,
    urlReturn:       opts.urlReturn,
    commerceOrder:   opts.orderId,
  };

  const res = await fetch(`${base}/payment/create`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    buildBody(params, secretKey).toString(),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.status.toString());
    throw new Error(`Flow /payment/create ${res.status}: ${msg}`);
  }

  return res.json() as Promise<FlowOrder>;
}

/**
 * Consulta el estado de un pago por su token.
 * Usar tanto en el webhook como en la página de confirmación.
 */
export async function getPaymentStatus(token: string, baseUrl?: string): Promise<FlowStatus> {
  const base      = baseUrl ?? FLOW_BASE_URL;
  const isSandbox = base === FLOW_URLS.sandbox;
  const apiKey    = isSandbox ? SANDBOX_API_KEY    : API_KEY;
  const secretKey = isSandbox ? SANDBOX_SECRET_KEY : SECRET_KEY;
  const params: Params = { apiKey, token };
  const qs = buildQuery(params, secretKey);

  const res = await fetch(`${base}/payment/getStatus?${qs}`);

  if (!res.ok) {
    const msg = await res.text().catch(() => res.status.toString());
    throw new Error(`Flow /payment/getStatus ${res.status}: ${msg}`);
  }

  return res.json() as Promise<FlowStatus>;
}

/** Mapea el código de estado de Flow a texto legible */
export function flowStatusLabel(status: number): 'pending' | 'paid' | 'rejected' | 'annulled' {
  const map: Record<number, 'pending' | 'paid' | 'rejected' | 'annulled'> = {
    1: 'pending',
    2: 'paid',
    3: 'rejected',
    4: 'annulled',
  };
  return map[status] ?? 'pending';
}
