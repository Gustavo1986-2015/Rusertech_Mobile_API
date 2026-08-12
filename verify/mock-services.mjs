/**
 * Servidor de apoyo para el gate VERIFY local.
 *
 * Sustituye los tres servicios externos a los que el sandbox no tiene salida,
 * hablando exactamente el mismo protocolo que ellos:
 *   - Resend            → POST /resend/emails
 *   - Supabase Storage  → POST /supabase/storage/v1/object/{bucket}/{path}
 *                         POST /supabase/storage/v1/object/sign/{bucket}/{path}
 *   - Webhook de cliente→ POST /webhook   (verifica la firma HMAC-SHA256)
 *
 * Todo lo recibido queda en verify/received.json para poder asertar.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = 4010;
const LOG = new URL('./received.json', import.meta.url).pathname;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'secreto-de-prueba';

const received = { emails: [], uploads: [], webhooks: [] };
const flush = () => fs.writeFileSync(LOG, JSON.stringify(received, null, 2));
flush();

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = await readBody(req);
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // ---- Resend ----------------------------------------------------------
  if (url.pathname === '/resend/emails' && req.method === 'POST') {
    const payload = JSON.parse(body.toString() || '{}');
    received.emails.push({ to: payload.to, subject: payload.subject, html: payload.html });
    flush();
    return send(200, { id: crypto.randomUUID() });
  }

  // ---- Supabase Storage: upload ----------------------------------------
  const upload = url.pathname.match(/^\/supabase\/storage\/v1\/object\/(?!sign\/)(.+)$/);
  if (upload && req.method === 'POST') {
    received.uploads.push({
      path: decodeURIComponent(upload[1]),
      bytes: body.length,
      contentType: req.headers['content-type'],
    });
    flush();
    return send(200, { Key: upload[1] });
  }

  // ---- Supabase Storage: signed url ------------------------------------
  const sign = url.pathname.match(/^\/supabase\/storage\/v1\/object\/sign\/(.+)$/);
  if (sign && req.method === 'POST') {
    return send(200, {
      signedURL: `/object/sign/${sign[1]}?token=${crypto.randomBytes(8).toString('hex')}`,
    });
  }

  // ---- Webhook del cliente ---------------------------------------------
  if (url.pathname === '/webhook' && req.method === 'POST') {
    const signature = req.headers['x-rusertech-signature'];
    const expected = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(body)
      .digest('hex');
    received.webhooks.push({
      body: JSON.parse(body.toString() || '{}'),
      signature,
      signatureValid: signature === expected,
    });
    flush();
    return send(200, { ok: true });
  }

  send(404, { error: 'not_found', path: url.pathname });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-services escuchando en http://127.0.0.1:${PORT}`);
});
