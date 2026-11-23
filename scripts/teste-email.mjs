// Manda um e-mail de teste para as caixas internas (MAIL_COPY): docker compose exec app node scripts/teste-email.mjs
import nodemailer from 'nodemailer';
import { config } from '../src/config.js';
const { host, port, user, pass, from, copy } = config.mail;
if (!host || !user || !pass) { console.error('SMTP nao configurado (SMTP_HOST, SMTP_USER, SMTP_PASS no .env).'); process.exit(1); }
const to = copy.length ? copy : [user];
try {
  const t = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
  await t.verify();
  const r = await t.sendMail({ from: from || `${config.org.name} <${user}>`, to,
    subject: 'Teste do AssinadorMR12: e-mail funcionando',
    text: 'Se você recebeu esta mensagem, o AssinadorMR12 já consegue enviar a cópia dos documentos assinados por e-mail.\n\nGRUPO MR12' });
  console.log('E-MAIL DE TESTE ENVIADO para:', to.join(', '), '|', r.response || 'ok');
} catch (e) {
  console.error('FALHOU:', e.message);
  if (/535|Username and Password|Application-specific|InvalidSecondFactor/i.test(e.message)) console.error('Dica: o Google recusou a senha. Gere uma "senha de app" na conta de e-mail (precisa da verificacao em duas etapas) e rode o atualizar de novo.');
  process.exit(1);
}
