import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

const accessToken = import.meta.env.MP_ACCESS_TOKEN;

if (!accessToken) {
  throw new Error('Falta la variable de entorno MP_ACCESS_TOKEN');
}

export const mpClient = new MercadoPagoConfig({ accessToken });

export interface CreatePreferenceParams {
  bookingId: string;
  title: string;
  amount: number;
  patientEmail: string;
  patientName: string;
  siteUrl: string;
}

export async function createPaymentPreference(params: CreatePreferenceParams) {
  const preference = new Preference(mpClient);

  const response = await preference.create({
    body: {
      items: [
        {
          id: params.bookingId,
          title: params.title,
          quantity: 1,
          unit_price: params.amount,
          currency_id: 'CLP',
        },
      ],
      payer: {
        email: params.patientEmail,
        name: params.patientName,
      },
      back_urls: {
        success: `${params.siteUrl}/confirmacion?status=approved&id=${params.bookingId}`,
        failure: `${params.siteUrl}/confirmacion?status=rejected&id=${params.bookingId}`,
        pending: `${params.siteUrl}/confirmacion?status=pending&id=${params.bookingId}`,
      },
      auto_return: 'approved',
      notification_url: `${params.siteUrl}/api/payment-webhook`,
      external_reference: params.bookingId,
      statement_descriptor: 'Ps. Valentina Orellana',
    },
  });

  return response;
}

export async function getPaymentById(paymentId: string) {
  const payment = new Payment(mpClient);
  return payment.get({ id: paymentId });
}
