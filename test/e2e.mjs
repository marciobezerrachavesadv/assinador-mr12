// Teste de ponta a ponta: sobe o servidor, cria documento, assina com 2 pessoas, sela com A1 de teste e valida.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { validatePdf, loadTrustedRoots } from '../src/pdf/validate.js';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr12-e2e-'));
const port = 3400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const p12 = path.join(root, 'certs/teste/teste.p12');
const rootsDir = path.join(root, 'certs/teste/raizes');
if (!fs.existsSync(p12)) execFileSync(path.join(root, 'scripts/make-test-cert.sh'), { stdio: 'inherit' });

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };

// Servidor SMTP de mentira: guarda o que o assinador tentar enviar (nao sai e-mail de verdade nos testes).
const inbox = [];
const smtp = net.createServer((sock) => {
  let buf = '', data = false, cur = { to: [], raw: '' };
  const w = (t) => sock.write(t + '\r\n');
  w('220 sink ESMTP');
  sock.on('data', (c) => {
    buf += c.toString('latin1');
    let i;
    while (data ? (i = buf.indexOf('\r\n.\r\n')) >= 0 : (i = buf.indexOf('\r\n')) >= 0) {
      if (data) { cur.raw = buf.slice(0, i); buf = buf.slice(i + 5); data = false; inbox.push(cur); cur = { to: [], raw: '' }; w('250 ok queued'); }
      else {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^(EHLO|HELO)/i.test(line)) { sock.write('250-sink\r\n250 AUTH PLAIN LOGIN\r\n'); }
        else if (/^AUTH/i.test(line)) w('235 ok');
        else if (/^RCPT TO:/i.test(line)) { cur.to.push(line.match(/<([^>]+)>/)[1]); w('250 ok'); }
        else if (/^DATA/i.test(line)) { data = true; w('354 go'); }
        else if (/^QUIT/i.test(line)) { w('221 bye'); sock.end(); }
        else w('250 ok');
      }
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
const smtpPort = smtp.address().port;

const env = { ...process.env, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_USER: 'contato@teste.com', SMTP_PASS: 'abcd efgh ijkl mnop', MAIL_COPY: 'contato@teste.com, financeiro@teste.com', PORT: String(port), PUBLIC_URL: base, DATA_DIR: path.join(tmp, 'data'), STORAGE_DIR: path.join(tmp, 'storage'),
  ADMIN_EMAIL: 'adv@teste.com', ADMIN_PASSWORD: 'senha-bem-grande-123', ORG_NAME: 'GRUPO MR12',
  ICP_P12_PATH: p12, ICP_P12_PASSWORD: 'teste123', TRUSTED_ROOTS_DIR: rootsDir };
const srv = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
const stop = () => { srv.kill(); };
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`${base}/api/me`); if (r.status === 401) return; } catch { /* ainda subindo */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('Servidor não subiu:\n' + srvLog);
}

let cookie = '';
async function api(p, { method = 'GET', json, form, auth = true, raw = false } = {}) {
  const headers = {};
  if (auth && cookie) headers.cookie = cookie;
  let body;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(base + p, { method, headers, body });
  const sc = res.headers.get('set-cookie'); if (sc && p === '/api/login') cookie = sc.split(';')[0];
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  let data = null; try { data = await res.json(); } catch { /* vazio */ }
  return { status: res.status, data };
}

async function samplePdf() {
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) { const p = d.addPage([595, 842]); p.drawText(`Contrato de teste - pagina ${i}\nAcentuação: ção ã é ü – “aspas”`, { x: 60, y: 760, size: 14, font: f }); }
  return Buffer.from(await d.save({ useObjectStreams: false }));
}
const png = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'test/fixtures/assinatura.png')).toString('base64');
const jpg = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(root, 'test/fixtures/selfie.jpg')).toString('base64');
const CPF = '52998224725';

try {
  await waitUp();
  console.log('Servidor no ar em', base);

  console.log('\n[login]');
  ok((await api('/api/documents')).status === 401, 'rota protegida sem login = 401');
  ok((await api('/api/login', { method: 'POST', json: { email: 'adv@teste.com', password: 'errada' } })).status === 401, 'senha errada = 401');
  const lg = await api('/api/login', { method: 'POST', json: { email: 'adv@teste.com', password: 'senha-bem-grande-123' } });
  ok(lg.status === 200 && cookie.startsWith('mr12sid='), 'login correto');
  const me = await api('/api/me');
  ok(me.data.seal?.enabled === true, 'selo ICP ativo no painel', JSON.stringify(me.data.seal));

  console.log('\n[criar documento]');
  const pdf = await samplePdf();
  const mk = (title, signers, extra = {}) => { const f = new FormData(); f.append('title', title); f.append('file', new Blob([pdf], { type: 'application/pdf' }), 'c.pdf'); f.append('signers', JSON.stringify(signers)); for (const [k, v] of Object.entries(extra)) f.append(k, v); return api('/api/documents', { method: 'POST', form: f }); };
  ok((await mk('x', [{ name: 'A', cpf: '111' }])).status === 400, 'rejeita CPF inválido');
  const bad = new FormData(); bad.append('title', 'Falso'); bad.append('file', new Blob(['nao sou pdf'], { type: 'application/pdf' }), 'x.pdf'); bad.append('signers', '[{"name":"Fulano"}]');
  ok((await api('/api/documents', { method: 'POST', form: bad })).status === 400, 'rejeita arquivo que não é PDF');
  const created = await mk('Contrato de honorários', [
    { name: 'Maria da Silva', cpf: '529.982.247-25', phone: '(68) 99999-0000', email: 'maria@cliente.com', requireSelfie: false },
    { name: 'João Pereira', requireSelfie: true, requireCpf: true },
  ], { ordered: '1' });
  ok(created.status === 201, 'documento criado', JSON.stringify(created.data));
  const id = created.data.id;
  const det = await api(`/api/documents/${id}`);
  const [s1, s2] = det.data.signers;
  const t1 = s1.link.split('/').pop(), t2 = s2.link.split('/').pop();
  ok(s1.link.startsWith(base + '/s/') && t1.length >= 20, 'links únicos gerados');
  ok(s1.phone === '5568999990000', 'telefone normalizado com 55', s1.phone);

  console.log('\n[assinar]');
  const info2 = await api(`/api/s/${t2}`, { auth: false });
  ok(info2.data.blocked && /vez/.test(info2.data.blocked), 'ordem: segundo é bloqueado');
  const body = (extra) => ({ signaturePng: png, signatureKind: 'desenho', consent: true, cpf: CPF, email: 'cliente.declarado@teste.com', geo: { lat: -9.9747, lng: -67.8243, acc: 18 }, ...extra });
  ok((await api(`/api/s/${t2}/sign`, { method: 'POST', json: body({ selfieJpeg: jpg }), auth: false })).status === 403, 'ordem: tentativa fora de vez = 403');
  ok((await api(`/api/s/${t1}/sign`, { method: 'POST', json: body({ consent: false }), auth: false })).status === 400, 'sem aceite do termo = 400');
  ok((await api(`/api/s/${t1}/sign`, { method: 'POST', json: body({ cpf: '11144477735' }), auth: false })).status === 400, 'CPF diferente do cadastrado = 400');
  ok((await api(`/api/s/${t1}/sign`, { method: 'POST', json: body({ signaturePng: 'data:image/png;base64,AAAA' }), auth: false })).status === 400, 'PNG falso = 400');
  const r1 = await api(`/api/s/${t1}/sign`, { method: 'POST', json: body({ geo: { lat: -9.97, lng: -67.81, acc: 20 } }), auth: false });
  ok(r1.status === 200 && r1.data.finalReady === false, 'primeiro assina', JSON.stringify(r1.data));
  ok((await api(`/api/s/${t1}/sign`, { method: 'POST', json: body(), auth: false })).status === 409, 'não assina duas vezes');
  ok((await api(`/api/s/${t2}/sign`, { method: 'POST', json: body({ cpf: '11144477735' }), auth: false })).status === 400, 'selfie obrigatória sem selfie = 400');
  ok((await api(`/api/s/${t2}/sign`, { method: 'POST', json: body({ cpf: '111.444.777-35', selfieJpeg: jpg, geo: undefined, email: 'joao@cliente.com' }), auth: false })).status === 400, 'localização obrigatória: sem localização = 400');
  ok((await api(`/api/s/${t2}/sign`, { method: 'POST', json: body({ cpf: '111.444.777-35', selfieJpeg: jpg, email: 'sem-arroba' }), auth: false })).status === 400, 'e-mail inválido na hora de assinar = 400');
  ok((await api(`/api/s/${t2}/sign`, { method: 'POST', json: body({ cpf: '111.444.777-35', selfieJpeg: jpg, email: '' }), auth: false })).status === 400, 'sem e-mail (e sem e-mail cadastrado) = 400');
  const r2 = await api(`/api/s/${t2}/sign`, { method: 'POST', json: body({ cpf: '111.444.777-35', selfieJpeg: jpg, signatureKind: 'digitado', email: 'joao@cliente.com' }), auth: false });
  ok(r2.status === 200 && r2.data.finalReady === true, 'segundo assina e documento finaliza', JSON.stringify(r2.data));

  console.log('\n[PDF final]');
  const fin = await api(`/api/documents/${id}/final`, { raw: true });
  ok(fin.status === 200 && fin.buf.subarray(0, 5).toString() === '%PDF-', 'baixou PDF final');
  const finPath = path.join(tmp, 'final.pdf'); fs.writeFileSync(finPath, fin.buf);
  const det2 = await api(`/api/documents/${id}`);
  ok(det2.data.status === 'signed' && det2.data.sealed, 'status signed e selado', JSON.stringify({ s: det2.data.status, e: det2.data.error }));
  ok(det2.data.finalSha256 === crypto.createHash('sha256').update(fin.buf).digest('hex'), 'hash registrado = hash do arquivo');
  console.log('\n[e-mail da cópia assinada]');
  for (let i = 0; i < 40 && inbox.length < 4; i++) await new Promise((r) => setTimeout(r, 250));
  const dest = inbox.map((m) => m.to.join(',')).sort();
  ok(inbox.length === 4, 'enviou 4 e-mails (2 clientes + contato + financeiro)', JSON.stringify(dest));
  ok(JSON.stringify(dest) === JSON.stringify(['cliente.declarado@teste.com', 'contato@teste.com', 'financeiro@teste.com', 'joao@cliente.com']), 'vai para o e-mail que o cliente informou ao assinar (não o cadastrado), um e-mail para cada', JSON.stringify(dest));
  ok(inbox.every((m) => m.to.length === 1), 'ninguém vê o e-mail do outro (um destinatário por mensagem)');
  const first = inbox.find((m) => m.to[0] === 'cliente.declarado@teste.com');
  ok(!!first && first.raw.includes('Content-Type: application/pdf') && /\.pdf/.test(first.raw.replace(/;\r\n filename\*1\*=/, '')), 'anexo PDF assinado presente');
  const at = first.raw.slice(first.raw.indexOf('Content-Type: application/pdf'));
  const b64 = at.slice(at.indexOf('\r\n\r\n') + 4).split('\r\n--')[0].replace(/\s/g, '');
  ok(Buffer.from(b64, 'base64').equals(fin.buf), 'o anexo é exatamente o PDF final selado');
  ok(/Subject: =\?UTF-8\?Q\?Documento_assinado/.test(first.raw), 'assunto em português');
  const rs = await api(`/api/documents/${id}/send-copies`, { method: 'POST', json: {} });
  ok(rs.status === 200 && rs.data.sent === 4, 'botão reenviar cópias envia de novo', JSON.stringify(rs.data));
  ok((await api(`/api/documents/${id}`)).data.events.some((e) => e.type === 'mail_sent'), 'histórico registra o envio');
  const pages = (await PDFDocument.load(fin.buf)).getPageCount();
  ok(pages >= 4, `páginas: original(2) + termo + evidências = ${pages}`);
  const dl = await api(`/api/s/${t1}/final`, { raw: true, auth: false });
  ok(dl.status === 200, 'signatário baixa a cópia final pelo próprio link');

  console.log('\n[validador interno]');
  const v = validatePdf(fin.buf, { trustedRoots: loadTrustedRoots(rootsDir) });
  const sg = v.signatures[0];
  ok(v.signatures.length === 1, 'uma assinatura digital encontrada');
  ok(sg?.integrity.digestMatches && sg.integrity.signatureValid && sg.integrity.coversWholeFile, 'integridade ok', JSON.stringify(sg?.integrity));
  ok(sg?.verdict === 'integra_cadeia_confiavel', 'cadeia confiável (raiz de teste)', sg?.verdict);
  ok(sg?.signer.cnpj === '00000000000191' || /00000000000191/.test(JSON.stringify(sg?.signer)), 'CNPJ lido do certificado', JSON.stringify(sg?.signer));
  const tampered = Buffer.from(fin.buf); const i = tampered.indexOf('Termo'); tampered[i >= 0 ? i : 100] ^= 1;
  const vt = validatePdf(tampered, { trustedRoots: loadTrustedRoots(rootsDir) });
  ok(vt.signatures[0]?.verdict !== 'integra_cadeia_confiavel', 'arquivo adulterado NÃO passa', vt.signatures[0]?.verdict);
  const appended = Buffer.concat([fin.buf, Buffer.from('\n%% lixo depois\n')]);
  const va = validatePdf(appended, { trustedRoots: loadTrustedRoots(rootsDir) });
  ok(va.signatures[0]?.verdict === 'integra_alterado_depois', 'conteúdo anexado depois é detectado', va.signatures[0]?.verdict);
  const vf = new FormData(); vf.append('file', new Blob([fin.buf], { type: 'application/pdf' }), 'f.pdf');
  const vr = await api('/api/validar', { method: 'POST', form: vf });
  ok(vr.status === 200 && vr.data.signatures.length === 1, 'endpoint /api/validar funciona');

  console.log('\n[verificação independente]');
  try {
    const out = execFileSync('pdfsig', [finPath], { encoding: 'utf8' });
    ok(/Signature is Valid|Signature Validation: Signature is Valid/.test(out) || /Total document signed/.test(out), 'pdfsig (poppler) lê a assinatura', out.split('\n').slice(0, 14).join(' | '));
    ok(/Signature Type:\s+ETSI\.CAdES\.detached/.test(out), 'formato ETSI.CAdES.detached');
  } catch (e) { ok(false, 'pdfsig executou', String(e.message).slice(0, 200)); }
  try {
    const ossl = execFileSync('sh', ['-c', `qpdf --show-npages "${finPath}" && qpdf --check "${finPath}" 2>&1 | tail -2`], { encoding: 'utf8' });
    ok(/No syntax or stream encoding errors/.test(ossl), 'qpdf --check sem erros');
  } catch (e) { ok(false, 'qpdf --check', String(e.stdout || e.message).slice(0, 200)); }

  console.log('\n[público]');
  const code = det2.data.code;
  const pv = await api(`/api/verificar/${code}`, { auth: false });
  ok(pv.status === 200 && pv.data.status === 'signed' && pv.data.signers.length === 2, 'verificação pública do código');
  ok(JSON.stringify(pv.data).indexOf('529') === -1, 'verificação pública não expõe CPF');
  ok((await api('/api/verificar/AAAA-BBBB-CCCC', { auth: false })).status === 404, 'código inexistente = 404');
  ok((await api('/api/s/token-que-nao-existe-0000000000', { auth: false })).status === 404, 'token inexistente = 404');
  ok((await api(`/api/documents/${id}/original`, { auth: false })).status === 401, 'original exige login');
  for (const pth of ['/', '/admin/', '/admin/app.js', `/s/${t1}`, `/verificar/${code}`, '/style.css', '/sign/sign.js', '/verificar.js']) {
    const r = await fetch(base + pth); ok(r.ok, `GET ${pth.replace(t1, ':token')}`, String(r.status));
  }
  const csp = (await fetch(base + '/admin/')).headers.get('content-security-policy');
  ok(/script-src 'self'/.test(csp) && !/unsafe-eval/.test(csp), 'CSP sem script inline/eval');

  console.log('\n[recusa e cancelamento]');
  const c2 = await mk('Para recusar', [{ name: 'Pedro Alves' }]);
  const tk = (await api(`/api/documents/${c2.data.id}`)).data.signers[0].link.split('/').pop();
  const rf = await api(`/api/s/${tk}/refuse`, { method: 'POST', json: { reason: 'Não concordo' }, auth: false });
  ok(rf.status === 200 && (await api(`/api/documents/${c2.data.id}`)).data.status === 'cancelled', 'recusa cancela o documento');
  ok((await api(`/api/s/${tk}/sign`, { method: 'POST', json: body(), auth: false })).status === 403, 'link recusado não assina mais');
  const c3 = await mk('Para cancelar', [{ name: 'Ana Souza' }]);
  const tc = (await api(`/api/documents/${c3.data.id}`)).data.signers[0].link.split('/').pop();
  await api(`/api/documents/${c3.data.id}/cancel`, { method: 'POST', json: {} });
  ok((await api(`/api/s/${tc}`, { auth: false })).data.blocked, 'documento cancelado bloqueia o link');

  console.log('\n[vários documentos + posição das assinaturas]');
  const mkPdf = async (pages, rotate = {}) => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= pages; i++) { const pg = d.addPage([595, 842]); pg.drawText(`Documento teste - pagina ${i}`, { x: 60, y: 760, size: 14, font: f }); if (rotate[i]) pg.setRotation({ type: 'degrees', angle: rotate[i] }); }
    return Buffer.from(await d.save({ useObjectStreams: false })); };
  const pdfA = await mkPdf(2), pdfB = await mkPdf(3, { 2: 90 }), pdfC = await mkPdf(1, { 1: 180 });
  const multi = async (files, fields) => { const f = new FormData(); for (const [i, b] of files.entries()) f.append('file', new Blob([b], { type: 'application/pdf' }), `arq${i + 1}.pdf`);
    for (const [k, v] of Object.entries(fields)) f.append(k, typeof v === 'string' ? v : JSON.stringify(v)); return api('/api/documents', { method: 'POST', form: f }); };
  const sgs = [{ name: 'Cliente Teste', requireCpf: false }, { name: 'Advogado Teste', requireCpf: false }];
  const pls = [
    { signer: 0, file: 0, page: 2, x: 0.1, y: 0.7, w: 0.35, h: 0.1 },
    { signer: 1, file: 0, page: 2, x: 0.55, y: 0.7, w: 0.35, h: 0.1 },
    { signer: 0, file: 1, page: 2, x: 0.1, y: 0.2, w: 0.35, h: 0.1 },
    { signer: 0, file: 1, page: 3, x: 0.1, y: 0.7, w: 0.35, h: 0.1 },
  ];
  ok((await multi([pdfA, pdfB], { title: 'Pacote', signers: sgs, mode: 'together', placements: [{ signer: 0, file: 0, page: 3, x: 0.1, y: 0.1, w: 0.3, h: 0.1 }] })).status === 400, 'posição em página que não existe = 400');
  ok((await multi([pdfA, pdfB], { title: 'Pacote', signers: sgs, mode: 'together', placements: [{ signer: 5, file: 0, page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.1 }] })).status === 400, 'posição de signatário que não existe = 400');
  const tog = await multi([pdfA, pdfB, pdfC], { title: 'Pacote junto', signers: sgs, mode: 'together', placements: [...pls, { signer: 0, file: 2, page: 1, x: 0.1, y: 0.1, w: 0.35, h: 0.1 }] });
  ok(tog.status === 201 && tog.data.documents.length === 1, 'tudo junto cria 1 documento', JSON.stringify(tog.data));
  const dT = (await api(`/api/documents/${tog.data.id}`)).data;
  for (const sgn of dT.signers) await api(`/api/s/${sgn.link.split('/').pop()}/sign`, { method: 'POST', json: body({ cpf: undefined }), auth: false });
  const dT2 = (await api(`/api/documents/${tog.data.id}`)).data;
  ok(dT2.status === 'signed', 'documento junto finalizado', JSON.stringify({ s: dT2.status, e: dT2.error }));
  const finT = await api(`/api/documents/${tog.data.id}/final`, { raw: true });
  fs.writeFileSync(path.join(tmp, 'junto.pdf'), finT.buf);
  const pt = await PDFDocument.load(finT.buf);
  ok(pt.getPageCount() >= 6 + 2, `páginas = 2+3+1 do original + termo + evidências (${pt.getPageCount()})`);
  const imgs = (i) => { const r = pt.getPage(i).node.Resources(); const xo = r && r.lookup(pt.context.obj('XObject')); return xo ? xo.keys().length : 0; };
  ok(imgs(0) === 0, 'página sem posição não recebe carimbo');
  ok(imgs(1) >= 1 && imgs(3) >= 1 && imgs(4) >= 1 && imgs(5) >= 1, 'carimbos nas páginas escolhidas (arquivo 1 p2, arquivo 2 p2 e p3, arquivo 3 p1)', JSON.stringify([0, 1, 2, 3, 4, 5].map(imgs)));
  const sep = await multi([pdfA, pdfB], { signers: sgs, mode: 'separate', titles: ['Procuração', 'Carta de preposição'], placements: [{ signer: 0, file: 1, page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.1 }] });
  ok(sep.status === 201 && sep.data.documents.length === 2, 'em separado cria 1 documento para cada arquivo', JSON.stringify(sep.data));
  const [sa, sb] = await Promise.all(sep.data.documents.map(async (d) => (await api(`/api/documents/${d.id}`)).data));
  ok(sa.title === 'Procuração' && sb.title === 'Carta de preposição', 'títulos individuais');
  ok(sa.signers[0].link !== sb.signers[0].link, 'cada documento tem o próprio link');
  const one = await multi([pdfA, pdfB], { title: 'Sem posições', signers: sgs, mode: 'together' });
  ok(one.status === 201, 'sem posições continua funcionando (assinatura só no termo)');
  console.log('  (PDF de conferência visual:', path.join(tmp, 'junto.pdf'), ')');
} catch (e) {
  fail++; console.log('ERRO NO TESTE:', e.stack || e); console.log('--- log do servidor ---\n' + srvLog);
} finally {
  stop(); smtp.close();
  console.log(`\n${pass} ok, ${fail} falhas  (arquivos em ${tmp})`);
  process.exit(fail ? 1 : 0);
}
