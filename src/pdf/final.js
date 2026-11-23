// Monta o PDF final: original + rodape de verificacao em todas as paginas
// + "Termo de assinaturas" + "Relatorio de evidencias" (com selfie, IP, aparelho, aceite e QR de verificacao).
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { fmtLocal, fmtUtc, formatCpf } from '../util.js';

const W = 595.28, H = 841.89, M = 46;
const INK = rgb(0.1, 0.12, 0.16), MUTED = rgb(0.38, 0.42, 0.5), LINE = rgb(0.82, 0.85, 0.9), BLUE = rgb(0.15, 0.25, 0.56);

const AUTH_LABEL = {
  'tela-desenho': 'Assinatura desenhada na tela',
  'tela-digitado': 'Assinatura com o nome digitado na tela',
};
const EVENT_LABEL = {
  created: (e) => `Documento criado${e.byName ? ` por ${e.byName}` : ''}`,
  viewed: (e) => `Link aberto por ${e.signerName}`,
  signed: (e) => `${e.signerName} assinou o documento`,
  refused: (e) => `${e.signerName} recusou assinar`,
  completed: () => 'Todas as assinaturas coletadas; documento finalizado',
};

function makeSafe(font) {
  const cache = new Map();
  return (s) => {
    let out = '';
    for (const ch of String(s ?? '').replace(/[\r\n\t]+/g, ' ')) {
      let ok = cache.get(ch);
      if (ok === undefined) { try { font.encodeText(ch); ok = true; } catch { ok = false; } cache.set(ch, ok); }
      out += ok ? ch : '?';
    }
    return out;
  };
}

function wrap(font, text, size, maxW) {
  const lines = [];
  for (const para of String(text).split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxW) { // palavra maior que a linha (hash, UA)
        let cut = w.length;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxW) cut--;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const trial = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(trial, size) <= maxW) line = trial;
      else { lines.push(line); line = w; }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

// Uint8Array proprio (copia): o pdf-lib le imagens por buffer.buffer, e um Buffer do Node pode vir do pool compartilhado
const readIf = (p) => (p && fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null);

// Carimbo da assinatura no lugar escolhido (nas paginas do documento original). Respeita paginas giradas.
// Coordenadas guardadas: fracao da pagina como aparece na tela (origem no canto superior esquerdo).
async function stampPlacements(pdf, doc, signers, regular, bold, safeR, safeB) {
  let list = [];
  try { list = doc.placements ? JSON.parse(doc.placements) : []; } catch { list = []; }
  if (!list.length) return;
  const byId = new Map(signers.map((s) => [s.id, s]));
  const imgCache = new Map();
  const pages = pdf.getPages();
  for (const pl of list) {
    const s = byId.get(pl.signer_id);
    const page = pages[pl.page - 1];
    if (!s || !page || s.status !== 'signed') continue;
    const bytes = readIf(s.signature_path);
    if (!bytes) continue;
    if (!imgCache.has(s.id)) imgCache.set(s.id, await pdf.embedPng(bytes));
    const img = imgCache.get(s.id);
    const { width: PW, height: PH } = page.getSize();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const vw = rot === 90 || rot === 270 ? PH : PW, vh = rot === 90 || rot === 270 ? PW : PH;
    const bw = pl.w * vw, bh = pl.h * vh, vx = pl.x * vw, vy = pl.y * vh;
    // origem (canto inferior esquerdo da caixa) em coordenadas do PDF + angulo; offsets locais giram junto
    let ox, oy;
    if (rot === 0) { ox = vx; oy = PH - (vy + bh); }
    else if (rot === 90) { ox = vy + bh; oy = vx; }
    else if (rot === 180) { ox = PW - vx; oy = vy + bh; }
    else { ox = PW - (vy + bh); oy = PH - vx; }
    const a = (rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const at = (dx, dy) => ({ x: ox + dx * cos - dy * sin, y: oy + dx * sin + dy * cos });
    const fs_ = Math.min(Math.max(bw / 34, 4.5), 7.5);
    const capH = fs_ * 2.6 + 2;
    const sigH = Math.max(bh - capH, bh * 0.45);
    const f = Math.min((bw - 4) / img.width, (sigH - 2) / img.height, 1);
    const iw = img.width * f, ih = img.height * f;
    const ip = at((bw - iw) / 2, capH + (sigH - ih) / 2);
    page.drawImage(img, { x: ip.x, y: ip.y, width: iw, height: ih, rotate: degrees(rot) });
    const lp = at(0, capH - 1);
    page.drawLine({ start: at(2, capH - 1), end: at(bw - 2, capH - 1), thickness: 0.5, color: LINE });
    void lp;
    const shrink = (str, font) => { let size = fs_; while (size > 3.5 && font.widthOfTextAtSize(str, size) > bw - 4) size -= 0.25; return size; };
    const l1 = safeB(`${s.name}`), l2 = safeR(`Assinado eletronicamente em ${fmtLocal(s.signed_at)} · ${doc.code}`);
    const p1 = at(2, fs_ * 1.5 + 1), p2 = at(2, 2);
    page.drawText(l1, { x: p1.x, y: p1.y, size: shrink(l1, bold), font: bold, color: INK, rotate: degrees(rot) });
    page.drawText(l2, { x: p2.x, y: p2.y, size: shrink(l2, regular), font: regular, color: MUTED, rotate: degrees(rot) });
  }
}

export async function buildFinalPdf({ originalBytes, doc, signers, events, sealInfo }) {
  const pdf = await PDFDocument.load(originalBytes, { updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safeR = makeSafe(regular), safeB = makeSafe(bold);
  const verifyUrl = `${config.publicUrl}/verificar/${doc.code}`;
  await stampPlacements(pdf, doc, signers, regular, bold, safeR, safeB);

  let page, y;
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const ensure = (h) => { if (!page || y - h < M + 26) newPage(); };
  const text = (s, { size = 9, b = false, color = INK, x = M, maxW = W - 2 * M - (x - M), gap = 2.5 } = {}) => {
    const font = b ? bold : regular;
    for (const line of wrap(font, (b ? safeB : safeR)(s), size, maxW)) {
      ensure(size + gap);
      y -= size;
      page.drawText(line, { x, y, size, font, color });
      y -= gap;
    }
  };
  const rule = (gap = 6) => { y -= gap; page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINE }); y -= gap; };

  const fitImage = (img, maxW, maxH) => {
    const s = Math.min(maxW / img.width, maxH / img.height, 1);
    return { w: img.width * s, h: img.height * s };
  };

  // ---------- Termo de assinaturas ----------
  newPage();
  text('Termo de assinaturas eletrônicas', { size: 17, b: true, color: BLUE, gap: 6 });
  text(`Documento: ${doc.title}`, { size: 10.5, b: true, gap: 3 });
  text(`Código de verificação: ${doc.code}`, { size: 9 });
  text(`Emitido por: ${config.org.name}`, { size: 9 });
  text(`SHA-256 do documento original: ${doc.original_sha256}`, { size: 7.5, color: MUTED });
  rule(8);

  for (const s of signers) {
    ensure(104);
    const top = y;
    page.drawRectangle({ x: M, y: top - 96, width: W - 2 * M, height: 96, borderColor: LINE, borderWidth: 0.8 });
    const sigBytes = readIf(s.signature_path);
    if (sigBytes) {
      const img = await pdf.embedPng(sigBytes);
      const f = fitImage(img, 170, 74);
      page.drawImage(img, { x: M + 12, y: top - 10 - f.h - (74 - f.h) / 2, width: f.w, height: f.h });
    }
    const tx = M + 200;
    const put = (str, dy, o = {}) => page.drawText((o.b ? safeB : safeR)(str), { x: tx, y: top - dy, size: o.size || 8.5, font: o.b ? bold : regular, color: o.color || INK });
    put(s.name, 20, { size: 11, b: true });
    put(`CPF: ${formatCpf(s.cpf_declared || s.cpf) || 'não informado'}`, 36);
    put(`Assinou em ${fmtLocal(s.signed_at)} (horário de Rio Branco)`, 50);
    put(`Método: ${AUTH_LABEL[s.auth_method] || 'Assinatura na tela'}${s.selfie_path ? ' + selfie' : ''}`, 63);
    put(`IP: ${s.ip || 'não registrado'}`, 76, { color: MUTED });
    y = top - 96 - 8;
  }
  y -= 4;
  text('Este termo faz parte do documento. Cada assinatura foi coletada pelo link individual de cada signatário, com registro de data, hora, endereço IP e aparelho. Os detalhes estão no relatório de evidências a seguir.', { size: 8, color: MUTED });

  // ---------- Relatorio de evidencias ----------
  newPage();
  text('Relatório de evidências', { size: 17, b: true, color: BLUE, gap: 6 });
  text(`Documento: ${doc.title}  ·  Código ${doc.code}`, { size: 9, color: MUTED, gap: 6 });

  for (const s of signers) {
    ensure(170);
    const startY = y;
    rule(4);
    text(s.name, { size: 11, b: true, gap: 4 });
    const selfie = readIf(s.selfie_path);
    const hasSelfie = !!selfie;
    const labelW = 118;
    const valW = W - 2 * M - labelW - (hasSelfie ? 104 : 0);
    const row = (label, value) => {
      const lines = wrap(regular, safeR(value || '—'), 8.5, valW);
      ensure(lines.length * 11 + 2);
      page.drawText(safeB(label), { x: M, y: y - 8.5, size: 8, font: bold, color: MUTED });
      for (const l of lines) { y -= 8.5; page.drawText(l, { x: M + labelW, y, size: 8.5, font: regular, color: INK }); y -= 2.6; }
      y -= 1.5;
    };
    const rowsStart = y;
    row('CPF', formatCpf(s.cpf_declared || s.cpf) || 'não informado');
    row('E-mail', s.email_declared || s.email);
    row('Telefone', s.phone ? `+${s.phone}` : '');
    row('Link aberto', s.first_viewed_at ? `${fmtLocal(s.first_viewed_at)} (${s.view_count} acesso${s.view_count === 1 ? '' : 's'})` : '');
    row('Assinou em', `${fmtLocal(s.signed_at)} (Rio Branco)  ·  ${fmtUtc(s.signed_at)}`);
    row('Método', `${AUTH_LABEL[s.auth_method] || 'Assinatura na tela'}${hasSelfie ? ' + selfie' : ''}`);
    row('Endereço IP', s.ip);
    row('Aparelho', s.user_agent);
    row('Localização', s.geo_lat != null ? `${s.geo_lat.toFixed(5)}, ${s.geo_lng.toFixed(5)}${s.geo_acc ? ` (precisão ~${Math.round(s.geo_acc)} m)` : ''}` : 'não informada pelo signatário');
    row('Aceite', s.consent_text);
    if (hasSelfie) {
      const img = await pdf.embedJpg(selfie);
      const f = fitImage(img, 92, 92);
      page.drawText('Selfie', { x: W - M - 92, y: rowsStart - 8, size: 7.5, font: bold, color: MUTED });
      page.drawImage(img, { x: W - M - 92, y: rowsStart - 12 - f.h, width: f.w, height: f.h });
      if (y > rowsStart - 12 - f.h - 6) y = rowsStart - 12 - f.h - 6;
    }
    void startY;
  }

  rule(6);
  text('Histórico', { size: 11, b: true, gap: 4 });
  const seenView = new Set();
  const lines = [];
  for (const e of events) {
    if (e.type === 'viewed') { if (seenView.has(e.signer_id)) continue; seenView.add(e.signer_id); }
    const fn = EVENT_LABEL[e.type];
    if (!fn) continue;
    lines.push(`${fmtLocal(e.at)}  —  ${fn(e)}${e.ip ? `  (IP ${e.ip})` : ''}`);
  }
  for (const l of lines.slice(0, 80)) text(l, { size: 8 });

  rule(8);
  text('Integridade', { size: 11, b: true, gap: 4 });
  text(`SHA-256 do documento original: ${doc.original_sha256}`, { size: 7.5 });
  text('O hash do arquivo final (com este relatório) não pode constar dentro dele mesmo; ele é mostrado na página de verificação e permite conferir qualquer cópia do arquivo.', { size: 8, color: MUTED });
  if (sealInfo) {
    text(`Selo digital: este arquivo foi selado com o certificado digital de ${sealInfo.subject} (emitido por ${sealInfo.issuer}, válido até ${fmtLocal(sealInfo.notAfter).slice(0, 10)}) no padrão PAdES. Qualquer alteração posterior ao selo é detectável em leitores de PDF e no Validar do ITI (https://validar.iti.gov.br).`, { size: 8, gap: 3 });
  }

  ensure(104);
  const qr = await pdf.embedPng(await QRCode.toBuffer(verifyUrl, { margin: 1, width: 240, errorCorrectionLevel: 'M' }));
  const qy = y - 90;
  page.drawImage(qr, { x: M, y: qy, width: 84, height: 84 });
  const q = (s, dy, o = {}) => page.drawText(safeR(s), { x: M + 98, y: y - dy, size: o.size || 8.5, font: o.b ? bold : regular, color: o.color || INK });
  page.drawText(safeB('Verifique a autenticidade deste documento'), { x: M + 98, y: y - 14, size: 10, font: bold, color: BLUE });
  q(verifyUrl, 30, { size: 8.5 });
  q(`Código: ${doc.code}`, 44);
  q('Envie o arquivo na página para comparar o hash e confirmar que é o original.', 58, { size: 8, color: MUTED });
  y = qy - 6;

  // ---------- rodape em todas as paginas ----------
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    if (p.getRotation().angle % 360 !== 0) return;
    const { width } = p.getSize();
    let s = `Assinado eletronicamente · AssinadorMR12 · ${doc.code} · ${verifyUrl} · pág. ${i + 1}/${pages.length}`;
    let size = 6.5;
    if (regular.widthOfTextAtSize(safeR(s), size) > width - 24) s = `Assinado eletronicamente · ${doc.code} · pág. ${i + 1}/${pages.length}`;
    s = safeR(s);
    const w = regular.widthOfTextAtSize(s, size);
    p.drawText(s, { x: (width - w) / 2, y: 11, size, font: regular, color: MUTED });
  });

  pdf.setTitle(`${doc.title} (assinado)`);
  pdf.setProducer('AssinadorMR12');
  pdf.setCreator('AssinadorMR12');
  return pdf;
}
