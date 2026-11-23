import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { db, logEvent } from './db.js';

// Envio da copia final assinada: para cada signatario com e-mail e para as caixas internas (MAIL_COPY).
// Usa SMTP comum (ex.: Google Workspace com "senha de app"). Cada pessoa recebe a propria mensagem,
// assim um cliente nao ve o e-mail do outro. Falha de e-mail NUNCA desfaz a assinatura do documento.
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
export const mailEnabled = () => !!(config.mail.host && config.mail.user && config.mail.pass);

let transport = null;
function getTransport() {
  if (!transport) {
    const { host, port, user, pass } = config.mail;
    transport = nodemailer.createTransport({
      host, port, secure: port === 465, auth: { user, pass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 45000,
    });
  }
  return transport;
}

const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function recipientsOf(signers) {
  const seen = new Set();
  const out = [];
  const add = (email, name, internal) => {
    const e = clean(email).toLowerCase();
    if (!EMAIL_RE.test(e) || seen.has(e)) return;
    seen.add(e);
    out.push({ email: e, name: clean(name), internal });
  };
  for (const s of signers) add(s.email, s.name, false);
  for (const e of config.mail.copy) add(e, '', true);
  return out;
}

function build(doc, r, verifyUrl) {
  const title = clean(doc.title);
  const org = config.org.name;
  const hello = r.internal ? `Cópia interna do ${org}.` : `Olá${r.name ? `, ${r.name.split(/\s+/)[0]}` : ''}!`;
  const text = [
    hello, '',
    `O documento "${title}" foi assinado por todos os signatários. Segue em anexo a cópia final em PDF, com o termo de assinaturas, o relatório de evidências e o selo digital ICP-Brasil do ${org}.`,
    '', `Código de verificação: ${doc.code}`, `Confira a autenticidade: ${verifyUrl}`, '',
    'Guarde este arquivo. Qualquer alteração depois do selo é detectada pelos leitores de PDF e pelo validador do ITI (validar.iti.gov.br).',
    '', `${org}`,
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#161b26;max-width:560px">
<p>${esc(hello)}</p>
<p>O documento <b>${esc(title)}</b> foi assinado por todos os signatários. Segue em anexo a cópia final em PDF, com o termo de assinaturas, o relatório de evidências e o selo digital ICP-Brasil do ${esc(org)}.</p>
<p style="background:#f3f4f7;border-radius:8px;padding:10px 14px">Código de verificação: <b>${esc(doc.code)}</b><br><a href="${esc(verifyUrl)}">${esc(verifyUrl)}</a></p>
<p style="color:#5a6275;font-size:13px">Guarde este arquivo. Qualquer alteração depois do selo é detectada pelos leitores de PDF e pelo validador do ITI (validar.iti.gov.br).</p>
<p style="color:#5a6275;font-size:13px">${esc(org)}</p></div>`;
  return { subject: `Documento assinado: ${title}`.slice(0, 200), text, html };
}

export async function sendCopies(docId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
  if (!doc || !doc.final_file) return { sent: [], failed: [], error: 'O documento final ainda não está pronto.' };
  if (!mailEnabled()) return { sent: [], failed: [], error: 'O envio de e-mail não está configurado no servidor.' };
  const signers = db.prepare("SELECT name, COALESCE(NULLIF(email_declared, ''), email) AS email FROM signers WHERE document_id = ? ORDER BY ord, id").all(docId);
  const rcpts = recipientsOf(signers);
  if (!rcpts.length) return { sent: [], failed: [], error: 'Nenhum e-mail para enviar.' };
  const file = path.join(config.storageDir, 'finals', doc.final_file);
  const verifyUrl = `${config.publicUrl}/verificar/${doc.code}`;
  const from = config.mail.from || `${config.org.name} <${config.mail.user}>`;
  const filename = `${clean(doc.title).replace(/[\\/:*?"<>|]/g, '-').slice(0, 100) || 'documento'} (assinado).pdf`;
  const sent = [], failed = [];
  for (const r of rcpts) {
    const m = build(doc, r, verifyUrl);
    try {
      await getTransport().sendMail({ from, to: r.name && !r.internal ? { name: r.name.replace(/[",<>]/g, ''), address: r.email } : r.email, ...m,
        attachments: [{ filename, content: fs.readFileSync(file), contentType: 'application/pdf' }] });
      sent.push(r.email);
    } catch (e) {
      failed.push({ email: r.email, error: String(e.message).slice(0, 200) });
      console.error(`E-mail da copia assinada falhou (${r.email}):`, e.message);
    }
  }
  if (sent.length) logEvent(docId, null, 'mail_sent', { detail: { message: `para ${sent.join(', ')}` } });
  if (failed.length) logEvent(docId, null, 'mail_failed', { detail: { message: `${failed.map((f) => f.email).join(', ')}: ${failed[0].error}` } });
  return { sent, failed };
}
