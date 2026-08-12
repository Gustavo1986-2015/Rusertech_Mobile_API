import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { query } from './db';
import type { AuthContext } from './auth';
import type { NotifiableEvent } from './telemetry';

/**
 * Notificador de eventos críticos (§4.8) — puente hasta que Rusertech Web
 * esté en línea y corra el EventEngine.
 *
 * REGLA DE LATENCIA (crítica): el aviso NUNCA retrasa la respuesta HTTP del
 * ingest. El presupuesto de <5 s del SOS es para que el dato quede
 * persistido, no para que salgan los emails.
 */

interface ChannelRow {
  channel_type: 'email' | 'webhook';
  target: string;
  secret: string | null;
  notify_codes: string[];
}

/**
 * Ejecuta la promesa DESPUÉS de responder. En Vercel usa waitUntil() para que
 * la función siga viva; fuera de Vercel simplemente se deja correr.
 */
export function after(promise: Promise<unknown>): void {
  const swallowed = promise.catch((err) =>
    console.error('[notifier] fallo despachando avisos:', err),
  );
  try {
    // En Vercel, waitUntil() mantiene viva la función tras responder, así que
    // el email/webhook NUNCA entra en el presupuesto de latencia del SOS.
    waitUntil(swallowed);
  } catch {
    // Fuera de Vercel (tests locales) no hay contexto de request: la promesa
    // corre igual, solo que sin la garantía de waitUntil.
  }
}

/**
 * Despacha los avisos de los eventos que correspondan.
 * Un canal que falla se loguea y no frena a los demás (Promise.allSettled).
 */
export async function dispatchAlerts(
  ctx: AuthContext,
  events: NotifiableEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const codes = [...new Set(events.map((e) => e.code))];

  const { rows: channels } = await query<ChannelRow>(
    `select channel_type, target, secret, notify_codes
       from mobile_alert_channels
      where tenant_id = $1 and is_active = true and notify_codes && $2::text[]`,
    [ctx.tenantId, codes],
  );

  const opsEmail = process.env.RUSERTECH_OPS_EMAIL;
  const tasks: Promise<unknown>[] = [];

  for (const event of events) {
    // 1) Rusertech siempre. Solo para los códigos que algún canal escucha,
    //    o para MOB_SOS, que es crítico por definición.
    const watched =
      event.code === 'MOB_SOS' ||
      channels.some((c) => c.notify_codes.includes(event.code));
    if (!watched) continue;

    if (opsEmail) tasks.push(sendEmail(opsEmail, event));

    // 2) Canales del cliente del tenant.
    for (const ch of channels) {
      if (!ch.notify_codes.includes(event.code)) continue;
      if (ch.channel_type === 'email') tasks.push(sendEmail(ch.target, event));
      else tasks.push(sendWebhook(ch.target, ch.secret, event));
    }
  }

  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) console.error(`[notifier] ${failed}/${results.length} avisos fallaron`);
}

// ---------------------------------------------------------------------
// Email (Resend por HTTP directo, sin SDK)
// ---------------------------------------------------------------------

const mapsLink = (lat: number, lng: number) =>
  `https://www.google.com/maps?q=${lat},${lng}`;

async function sendEmail(to: string, e: NotifiableEvent): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.ALERTS_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn('[notifier] RESEND_API_KEY o ALERTS_FROM_EMAIL sin definir');
    return;
  }
  const base = process.env.RESEND_BASE_URL ?? 'https://api.resend.com';

  const fecha = new Date(e.timestamp).toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
  });

  const html = `
    <h2>🚨 ${e.code} — ${e.plate}</h2>
    <ul>
      <li><b>Conductor (DNI):</b> ${e.driverDni ?? 'no informado'}</li>
      <li><b>Patente:</b> ${e.plate}</li>
      <li><b>Fecha/hora:</b> ${fecha}</li>
      <li><b>Ubicación:</b> <a href="${mapsLink(e.latitude, e.longitude)}">
          ${e.latitude}, ${e.longitude}</a></li>
      ${e.tripId ? `<li><b>Viaje:</b> ${e.tripId}</li>` : ''}
    </ul>`;

  const res = await fetchWithTimeout(`${base}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `🚨 ${e.code} — ${e.plate}`,
      html,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend respondió ${res.status}: ${await safeText(res)}`);
  }
}

// ---------------------------------------------------------------------
// Webhook con firma HMAC-SHA256
// ---------------------------------------------------------------------

async function sendWebhook(
  url: string,
  secret: string | null,
  e: NotifiableEvent,
): Promise<void> {
  const body = JSON.stringify({
    code: e.code,
    plate: e.plate,
    driverDni: e.driverDni,
    latitude: e.latitude,
    longitude: e.longitude,
    timestamp: e.timestamp,
    tripId: e.tripId,
  });

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) {
    headers['X-Rusertech-Signature'] = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
  }

  // Timeout 5 s, 1 reintento. Sin más: la fiabilidad del webhook es
  // responsabilidad del cliente.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { method: 'POST', headers, body });
      if (res.ok) return;
      lastErr = new Error(`webhook respondió ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 5_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
