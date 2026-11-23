import crypto from 'node:crypto';
import { config } from './config.js';

// Avisos opcionais para outro sistema (ex.: ZapiaMR mandar WhatsApp "Fulano assinou").
// A URL vem so da configuracao do servidor (nunca de dados do usuario).
export function emit(event, data) {
  if (!config.notify.url) return;
  const body = JSON.stringify({ event, at: new Date().toISOString(), ...data });
  const headers = { 'content-type': 'application/json' };
  if (config.notify.secret) headers['x-assinador-signature'] = crypto.createHmac('sha256', config.notify.secret).update(body).digest('hex');
  fetch(config.notify.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })
    .catch((e) => console.warn('Webhook de aviso falhou:', e.message));
}
