import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { config } from './config.js';
import { db, logEvent } from './db.js';
import { ensureFirstAdmin, verifyPassword, hashPassword, startSession, endSession, currentUser, requireAuth, rateLimit } from './auth.js';
import { finalizeDocument, initSealer, sealerStatus } from './finalize.js';
import { sendCopies, mailEnabled } from './mail.js';
import { validatePdf, loadTrustedRoots } from './pdf/validate.js';
import { emit } from './notify.js';
import {
  nowIso, randomToken, sha256Hex, verificationCode, isValidCpf, onlyDigits, normalizePhone, todayLocalDate,
  safeFilename, dataUrlToBuffer, isPng, isJpeg, isPdf, pngSize,
} from './util.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const abs = (kind, file) => path.join(config.storageDir, kind, file);
const pub = path.join(config.root, 'src', 'public');

export const app = express();
const tp = config.trustProxy;
app.set('trust proxy', tp === '0' || tp === '' ? false : /^\d+$/.test(tp) ? Number(tp) : tp);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
  });
  if (!req.path.endsWith('/pdf') && !req.path.includes('/original') && !req.path.includes('/final')) {
    res.set('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'; media-src 'self' blob:; object-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  }
  next();
});
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.limits.pdfBytes, files: config.limits.files, fields: 20 } });
const uploadValidar = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const json = express.json({ limit: '100kb' });
const jsonBig = express.json({ limit: '4mb' });

// ---------------- paginas ----------------
app.get('/', (req, res) => res.redirect('/admin/'));
app.get('/s/:token', (req, res) => res.sendFile(path.join(pub, 'sign', 'index.html')));
app.get('/verificar/:code', (req, res) => res.sendFile(path.join(pub, 'verificar.html')));
// pdf.js (so o painel usa, para mostrar as paginas e escolher onde cada pessoa assina)
app.use('/vendor/pdfjs', express.static(path.join(config.root, 'node_modules/pdfjs-dist/legacy/build'), { maxAge: '7d', index: false }));
app.use('/vendor/pdfjs-fonts', express.static(path.join(config.root, 'node_modules/pdfjs-dist/standard_fonts'), { maxAge: '7d', index: false }));
app.use(express.static(pub, { index: 'index.html', maxAge: 0 }));

// ---------------- login / usuarios ----------------
const loginLimit = rateLimit({ windowMs: 10 * 60_000, max: 10 });
const DUMMY = hashPassword('dummy-password-for-timing');
app.post('/api/login', loginLimit, json, (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = verifyPassword(password, u ? u.password_hash : DUMMY) && !!u;
  if (!ok) throw new HttpError(401, 'E-mail ou senha incorretos.');
  startSession(res, u.id);
  res.json({ ok: true, user: { id: u.id, name: u.name, email: u.email } });
});
app.post('/api/logout', (req, res) => { endSession(req, res); res.json({ ok: true }); });
app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Faça login.' });
  res.json({ user: u, org: config.org.name, publicUrl: config.publicUrl, seal: sealerStatus(), mail: mailEnabled() });
});
app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, name, email, created_at FROM users ORDER BY id').all());
});
app.post('/api/users', requireAuth, json, (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Informe nome e e-mail válidos.');
  if (password.length < 10) throw bad('A senha precisa ter pelo menos 10 caracteres.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Já existe um usuário com esse e-mail.');
  const r = db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?)').run(email, name, hashPassword(password), nowIso());
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

// ---------------- documentos (painel) ----------------
const linkOf = (token) => `${config.publicUrl}/s/${token}`;

app.get('/api/documents', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT d.id, d.code, d.title, d.status, d.created_at, d.completed_at, d.deadline,
      (SELECT COUNT(*) FROM signers s WHERE s.document_id = d.id) AS signers,
      (SELECT COUNT(*) FROM signers s WHERE s.document_id = d.id AND s.status = 'signed') AS signed
    FROM documents d ORDER BY d.id DESC LIMIT 300`).all();
  res.json(rows);
});

// Valida um PDF enviado e devolve o numero de paginas.
async function checkPdf(bytes, label) {
  if (!isPdf(bytes)) throw bad(`${label}: o arquivo precisa ser um PDF.`);
  if (/\/ByteRange\s*\[/.test(bytes.toString('latin1'))) {
    throw bad(`${label}: este PDF já tem assinatura digital. Adicionar páginas a ele invalidaria a assinatura existente. Envie uma versão sem assinatura.`);
  }
  try {
    const t = await PDFDocument.load(bytes, { updateMetadata: false });
    const n = t.getPageCount();
    if (n < 1 || n > 300) throw new Error('paginas');
    return n;
  } catch {
    throw bad(`${label}: não consegui abrir este PDF (pode estar protegido por senha, corrompido ou ter mais de 300 páginas).`);
  }
}

// Posicoes das assinaturas: [{signer, file, page, x, y, w, h}] com x,y,w,h em fracao (0 a 1) da pagina como aparece na tela.
function parsePlacements(raw, nSigners, pageCounts) {
  if (!raw) return [];
  let arr;
  try { arr = JSON.parse(raw); } catch { throw bad('Posições das assinaturas inválidas.'); }
  if (!Array.isArray(arr) || arr.length > config.limits.placements) throw bad('Posições das assinaturas inválidas.');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  return arr.map((p, i) => {
    const signer = Number(p?.signer), file = Number(p?.file ?? 0), page = Number(p?.page);
    if (!Number.isInteger(signer) || signer < 0 || signer >= nSigners) throw bad(`Posição ${i + 1}: signatário inexistente.`);
    if (!Number.isInteger(file) || file < 0 || file >= pageCounts.length) throw bad(`Posição ${i + 1}: arquivo inexistente.`);
    if (!Number.isInteger(page) || page < 1 || page > pageCounts[file]) throw bad(`Posição ${i + 1}: página inexistente.`);
    let w = num(p.w), h = num(p.h), x = num(p.x), y = num(p.y);
    if ([w, h, x, y].some(Number.isNaN)) throw bad(`Posição ${i + 1}: medidas inválidas.`);
    w = Math.min(Math.max(w, 0.04), 0.9); h = Math.min(Math.max(h, 0.025), 0.5);
    x = Math.min(Math.max(x, 0), 1 - w); y = Math.min(Math.max(y, 0), 1 - h);
    return { signer, file, page, x, y, w, h };
  });
}

app.post('/api/documents', requireAuth, upload.array('file', config.limits.files), async (req, res) => {
  const files = req.files ?? [];
  if (!files.length) throw bad('Envie o arquivo PDF.');
  const mode = req.body?.mode === 'separate' && files.length > 1 ? 'separate' : 'together';
  let titles = [];
  if (mode === 'separate') { try { titles = JSON.parse(req.body?.titles ?? '[]'); } catch { titles = []; } }
  const checkTitle = (t) => { t = String(t ?? '').trim(); if (t.length < 2 || t.length > 200) throw bad('Informe um título de 2 a 200 caracteres para cada documento.'); return t; };
  const docTitles = mode === 'separate' ? files.map((f, i) => checkTitle(titles[i] || String(f.originalname || '').replace(/\.pdf$/i, ''))) : [checkTitle(req.body?.title)];

  const pageCounts = [];
  for (let i = 0; i < files.length; i++) pageCounts.push(await checkPdf(files[i].buffer, files.length > 1 ? `Arquivo ${i + 1}` : 'O arquivo'));

  let list;
  try { list = JSON.parse(req.body?.signers ?? '[]'); } catch { throw bad('Lista de signatários inválida.'); }
  if (!Array.isArray(list) || list.length < 1 || list.length > config.limits.signers) throw bad(`Informe de 1 a ${config.limits.signers} signatários.`);
  const deadline = String(req.body?.deadline ?? '').trim();
  if (deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || deadline < todayLocalDate())) throw bad('O prazo precisa ser uma data de hoje em diante.');
  const ordered = req.body?.ordered === '1' || req.body?.ordered === 'true';
  const placements = parsePlacements(req.body?.placements, list.length, pageCounts);

  const clean = list.map((s, i) => {
    const name = String(s.name ?? '').trim();
    if (name.length < 2 || name.length > 120) throw bad(`Signatário ${i + 1}: informe o nome.`);
    const cpf = onlyDigits(s.cpf);
    if (cpf && !isValidCpf(cpf)) throw bad(`Signatário ${i + 1}: CPF inválido.`);
    const email = String(s.email ?? '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad(`Signatário ${i + 1}: e-mail inválido.`);
    const phone = s.phone ? normalizePhone(s.phone) : '';
    if (s.phone && !phone) throw bad(`Signatário ${i + 1}: telefone inválido (use DDD + número).`);
    return { name, cpf, email, phone, ord: ordered ? i + 1 : 1, selfie: s.requireSelfie ? 1 : 0, reqCpf: s.requireCpf === false ? 0 : 1, reqGeo: s.requireGeo === false ? 0 : 1 };
  });

  // Cada "grupo" vira um documento: tudo junto = 1 PDF unico com as paginas dos arquivos em sequencia.
  const groups = [];
  if (mode === 'separate') {
    files.forEach((f, i) => groups.push({ title: docTitles[i], bytes: f.buffer, pl: placements.filter((p) => p.file === i).map((p) => ({ ...p, file: 0 })) }));
  } else if (files.length === 1) {
    groups.push({ title: docTitles[0], bytes: files[0].buffer, pl: placements });
  } else {
    const merged = await PDFDocument.create();
    const offsets = [];
    let off = 0;
    for (let i = 0; i < files.length; i++) {
      const src = await PDFDocument.load(files[i].buffer, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((pg) => merged.addPage(pg));
      offsets.push(off); off += pages.length;
    }
    merged.setTitle(docTitles[0]);
    groups.push({ title: docTitles[0], bytes: Buffer.from(await merged.save({ useObjectStreams: false })), pl: placements.map((p) => ({ ...p, page: offsets[p.file] + p.page, file: 0 })) });
  }

  const created = [];
  for (const g of groups) {
    const fileName = `${randomToken(12)}.pdf`;
    fs.writeFileSync(abs('originals', fileName), g.bytes, { mode: 0o600 });
    const code = verificationCode();
    const id = db.transaction(() => {
      const r = db.prepare(`INSERT INTO documents (code, title, ordered, deadline, original_file, original_sha256, created_by, created_at)
                            VALUES (?,?,?,?,?,?,?,?)`).run(code, g.title, ordered ? 1 : 0, deadline || null, fileName, sha256Hex(g.bytes), req.user.id, nowIso());
      const docId = Number(r.lastInsertRowid);
      const ins = db.prepare(`INSERT INTO signers (document_id, token, name, cpf, email, phone, ord, require_selfie, require_cpf, require_geo)
                              VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const signerIds = clean.map((s) => Number(ins.run(docId, randomToken(24), s.name, s.cpf || null, s.email || null, s.phone || null, s.ord, s.selfie, s.reqCpf, s.reqGeo).lastInsertRowid));
      if (g.pl.length) db.prepare('UPDATE documents SET placements = ? WHERE id = ?')
        .run(JSON.stringify(g.pl.map((p) => ({ signer_id: signerIds[p.signer], page: p.page, x: p.x, y: p.y, w: p.w, h: p.h }))), docId);
      logEvent(docId, null, 'created', { ip: req.ip, ua: req.get('user-agent') });
      return docId;
    })();
    created.push({ id, code, title: g.title });
  }
  res.status(201).json({ id: created[0].id, code: created[0].code, documents: created });
});

function docDetail(id) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!doc) return null;
  const signers = db.prepare('SELECT * FROM signers WHERE document_id = ? ORDER BY ord, id').all(id).map((s) => ({
    id: s.id, name: s.name, cpf: s.cpf, email: s.email_declared || s.email, phone: s.phone, order: s.ord, status: s.status,
    requireSelfie: !!s.require_selfie, requireCpf: !!s.require_cpf, requireGeo: !!s.require_geo,
    geo: s.geo_lat != null ? { lat: s.geo_lat, lng: s.geo_lng, acc: s.geo_acc } : null, viewCount: s.view_count,
    firstViewedAt: s.first_viewed_at, signedAt: s.signed_at, hasSelfie: !!s.selfie_file, link: linkOf(s.token),
  }));
  const names = new Map(signers.map((s) => [s.id, s.name]));
  const events = db.prepare('SELECT type, signer_id, ip, at, detail FROM events WHERE document_id = ? ORDER BY at, id').all(id)
    .map((e) => ({ type: e.type, signer: names.get(e.signer_id) || null, ip: e.ip, at: e.at, detail: e.detail ? JSON.parse(e.detail) : null }));
  return {
    id: doc.id, code: doc.code, title: doc.title, status: doc.status, ordered: !!doc.ordered, deadline: doc.deadline,
    createdAt: doc.created_at, completedAt: doc.completed_at, originalSha256: doc.original_sha256, finalSha256: doc.final_sha256,
    sealed: !!doc.seal_info, seal: doc.seal_info ? JSON.parse(doc.seal_info) : null, error: doc.error,
    verifyUrl: `${config.publicUrl}/verificar/${doc.code}`, signers, events,
  };
}

app.get('/api/documents/:id', requireAuth, (req, res) => {
  const d = docDetail(Number(req.params.id));
  if (!d) throw new HttpError(404, 'Documento não encontrado.');
  res.json(d);
});

function sendPdf(res, file, name, inline) {
  const p = file;
  if (!fs.existsSync(p)) throw new HttpError(404, 'Arquivo não encontrado.');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(name)}.pdf"`, 'Cache-Control': 'private, no-store' });
  res.send(fs.readFileSync(p));
}

app.get('/api/documents/:id/original', requireAuth, (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!d) throw new HttpError(404, 'Documento não encontrado.');
  sendPdf(res, abs('originals', d.original_file), `${d.title}_original`, req.query.inline === '1');
});
app.get('/api/documents/:id/final', requireAuth, (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!d || !d.final_file) throw new HttpError(404, 'O documento final ainda não está pronto.');
  sendPdf(res, abs('finals', d.final_file), `${d.title}_assinado`, req.query.inline === '1');
});

app.post('/api/documents/:id/cancel', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare("UPDATE documents SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
  if (!r.changes) throw new HttpError(409, 'Só é possível cancelar documentos que ainda estão aguardando assinaturas.');
  logEvent(id, null, 'cancelled', { ip: req.ip });
  res.json({ ok: true });
});

app.post('/api/documents/:id/finalize', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare("UPDATE documents SET status = 'finalizing' WHERE id = ? AND status = 'error'").run(id);
  if (!r.changes) throw new HttpError(409, 'Só é possível tentar de novo documentos com erro na finalização.');
  initSealer(); // relê o certificado (útil depois de corrigir a configuração)
  const out = await finalizeDocument(id);
  res.status(out.ok ? 200 : 500).json(out.ok ? { ok: true } : { error: out.error });
});

app.post('/api/documents/:id/send-copies', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const d = db.prepare('SELECT status FROM documents WHERE id = ?').get(id);
  if (!d) throw new HttpError(404, 'Documento não encontrado.');
  if (d.status !== 'signed') throw new HttpError(409, 'Só dá para enviar cópias de documentos já assinados por todos.');
  if (!mailEnabled()) throw new HttpError(409, 'O envio de e-mail ainda não está configurado no servidor (SMTP_*).');
  const out = await sendCopies(id);
  if (out.error) throw new HttpError(409, out.error);
  if (!out.sent.length) throw new HttpError(502, `Não consegui enviar: ${out.failed[0]?.error || 'erro desconhecido'}`);
  res.json({ ok: true, sent: out.sent.length, failed: out.failed.length });
});

// ---------------- validador (painel) ----------------
app.post('/api/validar', requireAuth, uploadValidar.single('file'), (req, res) => {
  if (!req.file || !isPdf(req.file.buffer)) throw bad('Envie um arquivo PDF.');
  res.json(validatePdf(req.file.buffer, { trustedRoots: loadTrustedRoots(config.trustedRootsDir) }));
});

// ---------------- assinatura (publico, por link) ----------------
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const pubLimit = rateLimit({ windowMs: 60_000, max: 60 });
const signLimit = rateLimit({ windowMs: 10 * 60_000, max: 20 });

function loadSigner(token) {
  if (!TOKEN_RE.test(token)) throw new HttpError(404, 'Link inválido.');
  const s = db.prepare('SELECT * FROM signers WHERE token = ?').get(token);
  if (!s) throw new HttpError(404, 'Link inválido ou expirado.');
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(s.document_id);
  return { s, doc };
}

function blockedReason(s, doc) {
  if (s.status === 'signed') return null;
  if (s.status === 'refused') return 'Você recusou assinar este documento.';
  if (doc.status === 'cancelled') return 'Este documento foi cancelado pelo remetente.';
  if (doc.status !== 'pending') return 'Este documento não está disponível para assinatura.';
  if (doc.deadline && todayLocalDate() > doc.deadline) return 'O prazo para assinar este documento terminou.';
  if (doc.ordered && db.prepare("SELECT 1 FROM signers WHERE document_id = ? AND ord < ? AND status != 'signed'").get(doc.id, s.ord)) {
    return 'Ainda não é a sua vez: aguarde a assinatura dos signatários anteriores.';
  }
  return null;
}

function consentText(s, orgName) {
  return `Li o documento e concordo com o seu conteúdo. Declaro que sou ${s.name} e que esta assinatura eletrônica, registrada com data, hora, endereço IP e aparelho${s.require_geo ? ', localização aproximada' : ''}${s.require_selfie ? ' e com a minha selfie' : ''}, vale como a minha assinatura neste documento. Autorizo ${orgName} a usar esses dados somente para comprovar esta assinatura, conforme a LGPD.`;
}

app.get('/api/s/:token', pubLimit, (req, res) => {
  const { s, doc } = loadSigner(req.params.token);
  const blocked = blockedReason(s, doc);
  if (!blocked && s.status !== 'signed') {
    db.prepare(`UPDATE signers SET view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, ?),
                status = CASE WHEN status = 'new' THEN 'viewed' ELSE status END WHERE id = ?`).run(nowIso(), s.id);
    logEvent(doc.id, s.id, 'viewed', { ip: req.ip, ua: req.get('user-agent') });
  }
  res.json({
    org: config.org.name,
    doc: { title: doc.title, code: doc.code, status: doc.status },
    signer: { name: s.name, status: s.status, requireSelfie: !!s.require_selfie, requireCpf: !!s.require_cpf, requireGeo: !!s.require_geo, cpfPreset: !!s.cpf, emailPreset: s.email_declared || s.email || '' },
    blocked,
    done: s.status === 'signed',
    finalReady: doc.status === 'signed',
    consent: consentText(s, config.org.name),
  });
});

app.get('/api/s/:token/pdf', pubLimit, (req, res) => {
  const { s, doc } = loadSigner(req.params.token);
  if (blockedReason(s, doc) && s.status !== 'signed') throw new HttpError(403, 'Documento indisponível.');
  sendPdf(res, abs('originals', doc.original_file), doc.title, true);
});

app.get('/api/s/:token/final', pubLimit, (req, res) => {
  const { s, doc } = loadSigner(req.params.token);
  if (s.status !== 'signed' || doc.status !== 'signed' || !doc.final_file) throw new HttpError(404, 'A cópia assinada ainda não está pronta.');
  sendPdf(res, abs('finals', doc.final_file), `${doc.title}_assinado`, false);
});

app.post('/api/s/:token/sign', signLimit, jsonBig, async (req, res) => {
  const { s, doc } = loadSigner(req.params.token);
  if (s.status === 'signed') throw new HttpError(409, 'Você já assinou este documento.');
  const blocked = blockedReason(s, doc);
  if (blocked) throw new HttpError(403, blocked);
  const b = req.body ?? {};
  if (b.consent !== true) throw bad('É preciso aceitar o termo para assinar.');

  const sig = dataUrlToBuffer(b.signaturePng, ['image/png']);
  if (!sig || !isPng(sig) || sig.length > 600_000) throw bad('Assinatura inválida. Desenhe ou digite sua assinatura de novo.');
  const { w, h } = pngSize(sig);
  if (w < 40 || h < 20 || w > 2400 || h > 1200) throw bad('Assinatura inválida (tamanho).');
  const kind = b.signatureKind === 'digitado' ? 'tela-digitado' : 'tela-desenho';

  let selfie = null;
  if (s.require_selfie) {
    selfie = dataUrlToBuffer(b.selfieJpeg, ['image/jpeg']);
    if (!selfie || !isJpeg(selfie) || selfie.length > 1_800_000) throw bad('A selfie é obrigatória. Tire a foto do seu rosto para continuar.');
  }

  let cpfDeclared = null;
  if (s.require_cpf) {
    cpfDeclared = onlyDigits(b.cpf);
    if (!isValidCpf(cpfDeclared)) throw bad('Informe um CPF válido.');
    if (s.cpf && s.cpf !== cpfDeclared) throw bad('O CPF informado não confere com o cadastrado para este link.');
  } else if (s.cpf) cpfDeclared = s.cpf;

  // e-mail onde o signatario recebe a via do documento assinado (obrigatorio; vem preenchido se o remetente cadastrou)
  const emailDeclared = String(b.email ?? '').trim().slice(0, 120) || s.email || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailDeclared)) throw bad('Informe um e-mail válido para receber a sua via do documento assinado.');

  const g = b.geo;
  const geoOk = g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180;
  if (s.require_geo && !geoOk) throw bad('Não consegui registrar a sua localização. Permita o acesso à localização no navegador e tente de novo.');

  const sigFile = `${s.id}-${randomToken(10)}.png`;
  const selfieFile = selfie ? `${s.id}-${randomToken(10)}.jpg` : null;
  fs.writeFileSync(abs('signatures', sigFile), sig, { mode: 0o600 });
  if (selfie) fs.writeFileSync(abs('selfies', selfieFile), selfie, { mode: 0o600 });

  let finalizeNow = false;
  try {
    finalizeNow = db.transaction(() => {
      const fresh = db.prepare('SELECT * FROM signers WHERE id = ?').get(s.id);
      const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
      if (fresh.status === 'signed') throw new HttpError(409, 'Você já assinou este documento.');
      const why = blockedReason(fresh, d);
      if (why) throw new HttpError(403, why);
      db.prepare(`UPDATE signers SET status = 'signed', signed_at = ?, cpf_declared = ?, email_declared = ?, ip = ?, user_agent = ?, geo_lat = ?, geo_lng = ?,
                  geo_acc = ?, auth_method = ?, signature_file = ?, selfie_file = ?, consent_text = ? WHERE id = ?`)
        .run(nowIso(), cpfDeclared, emailDeclared, req.ip, String(req.get('user-agent') ?? '').slice(0, 300),
          geoOk ? g.lat : null, geoOk ? g.lng : null, geoOk && Number.isFinite(g.acc) ? g.acc : null,
          kind, sigFile, selfieFile, consentText(s, config.org.name), s.id);
      logEvent(doc.id, s.id, 'signed', { ip: req.ip, ua: req.get('user-agent') });
      const left = db.prepare("SELECT COUNT(*) c FROM signers WHERE document_id = ? AND status != 'signed'").get(doc.id).c;
      return left === 0 && db.prepare("UPDATE documents SET status = 'finalizing' WHERE id = ? AND status = 'pending'").run(doc.id).changes === 1;
    })();
  } catch (e) {
    fs.rmSync(abs('signatures', sigFile), { force: true });
    if (selfieFile) fs.rmSync(abs('selfies', selfieFile), { force: true });
    throw e;
  }

  emit('signer_signed', { documentId: doc.id, code: doc.code, title: doc.title, signer: s.name });
  if (finalizeNow) await finalizeDocument(doc.id);
  const after = db.prepare('SELECT status FROM documents WHERE id = ?').get(doc.id);
  res.json({ ok: true, finalReady: after.status === 'signed', docStatus: after.status });
});

app.post('/api/s/:token/refuse', signLimit, json, (req, res) => {
  const { s, doc } = loadSigner(req.params.token);
  if (s.status === 'signed') throw new HttpError(409, 'Você já assinou este documento.');
  if (doc.status !== 'pending') throw new HttpError(409, 'Este documento não está mais aguardando assinaturas.');
  const reason = String(req.body?.reason ?? '').trim().slice(0, 300);
  db.transaction(() => {
    db.prepare("UPDATE signers SET status = 'refused', refused_reason = ? WHERE id = ?").run(reason || null, s.id);
    db.prepare("UPDATE documents SET status = 'cancelled' WHERE id = ?").run(doc.id);
    logEvent(doc.id, s.id, 'refused', { ip: req.ip, ua: req.get('user-agent'), detail: reason ? { reason } : null });
  })();
  emit('signer_refused', { documentId: doc.id, code: doc.code, title: doc.title, signer: s.name });
  res.json({ ok: true });
});

// ---------------- verificacao publica ----------------
app.get('/api/verificar/:code', pubLimit, (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) throw new HttpError(404, 'Código inválido.');
  const d = db.prepare('SELECT * FROM documents WHERE code = ?').get(code);
  if (!d) throw new HttpError(404, 'Documento não encontrado.');
  const signers = db.prepare('SELECT name, signed_at, status FROM signers WHERE document_id = ? ORDER BY ord, id').all(d.id);
  const seal = d.seal_info ? JSON.parse(d.seal_info) : null;
  res.json({
    code: d.code, title: d.title, status: d.status, org: config.org.name, createdAt: d.created_at, completedAt: d.completed_at,
    originalSha256: d.original_sha256, finalSha256: d.final_sha256,
    sealed: !!seal, sealSubject: seal?.subject ?? null,
    signers: signers.map((x) => ({ name: x.name, status: x.status, signedAt: x.signed_at })),
  });
});

// ---------------- erros ----------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo muito grande.' : 'Envio inválido.' });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Envio grande demais.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requisição inválida.' });
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Erro interno. Tente novamente.' : err.message });
});

// ---------------- inicio ----------------
export function start() {
  ensureFirstAdmin();
  initSealer();
  return app.listen(config.port, () => console.log(`AssinadorMR12 em ${config.publicUrl} (porta ${config.port})`));
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) start();
