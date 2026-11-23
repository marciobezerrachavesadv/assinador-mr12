// Teste da ponte MCP: sobe o servidor com MCP_TOKEN, envia PDF, assina pelo link e baixa o PDF final pela ponte.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr12-mcp-'));
const port = 3800 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;
const TOKEN = 'a'.repeat(16) + 'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';
let pass = 0, fail = 0;
const ok = (c, n, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${x}`); } };

const env = { ...process.env, PORT: String(port), PUBLIC_URL: base, DATA_DIR: path.join(tmp, 'data'), STORAGE_DIR: path.join(tmp, 'storage'),
  ADMIN_EMAIL: 'adv@teste.com', ADMIN_PASSWORD: 'senha-bem-grande-123', ORG_NAME: 'GRUPO MR12', MCP_TOKEN: TOKEN, SMTP_HOST: '', ICP_P12_PATH: '' };
const srv = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
process.on('exit', () => srv.kill());
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/me`)).status === 401) break; } catch { } await new Promise((r) => setTimeout(r, 250)); }

let n = 0;
const rpc = async (method, params, tok = TOKEN) => {
  const r = await fetch(`${base}/mcp/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  let data = null; try { data = await r.json(); } catch { } return { status: r.status, data };
};
const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).data?.result;

try {
  ok((await rpc('initialize', {}, 'errado')).status === 404, 'token errado = 404');
  const ini = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  ok(ini.data?.result?.serverInfo?.name === 'AssinadorMR12', 'initialize');
  const notif = await fetch(`${base}/mcp/${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  ok(notif.status === 202, 'notificação = 202');
  const tl = await rpc('tools/list', {});
  ok(tl.data?.result?.tools?.length === 4, 'tools/list com 4 ferramentas');

  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText('Contrato de teste pela ponte', { x: 60, y: 760, size: 14, font: f });
  const pdf = Buffer.from(await d.save({ useObjectStreams: false })).toString('base64');

  const bad = await tool('enviar_para_assinatura', { titulo: 'X', pdf_base64: pdf, signatarios: [{ nome: 'Ana' }] });
  ok(bad?.isError, 'título curto gera erro de ferramenta', JSON.stringify(bad));
  const env1 = await tool('enviar_para_assinatura', { titulo: 'Contrato nº 0001/2026 – Teste', pdf_base64: pdf, signatarios: [{ nome: 'Maria da Silva', email: 'maria@cliente.com', whatsapp: '(68) 99999-0000' }], referencia: 'contrato 0001/2026' });
  const doc = env1?.structuredContent;
  ok(!env1?.isError && doc?.id && /^[A-Z2-9]{4}-/.test(doc.codigo), 'documento criado pela ponte', JSON.stringify(env1).slice(0, 300));
  ok(doc?.signatarios?.[0]?.link?.startsWith(base + '/s/'), 'link do signatário devolvido');
  ok(doc?.signatarios?.[0]?.whatsapp === '5568999990000', 'whatsapp normalizado');

  const naoPronto = await tool('baixar_documento_assinado', { id: doc.id });
  ok(naoPronto?.isError, 'baixar antes de assinar = erro');

  const token = doc.signatarios[0].link.split('/').pop();
  const png = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'test/fixtures/assinatura.png')).toString('base64');
  const s = await fetch(`${base}/api/s/${token}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signaturePng: png, signatureKind: 'desenho', consent: true, cpf: '52998224725', email: 'maria@cliente.com', geo: { lat: -9.97, lng: -67.81, acc: 20 } }) });
  ok(s.status === 200, 'assinou pelo link', String(s.status));

  let st;
  for (let i = 0; i < 20; i++) { st = (await tool('consultar_assinatura', { id: doc.id }))?.structuredContent; if (st?.pdf_final_pronto) break; await new Promise((r) => setTimeout(r, 300)); }
  ok(st?.situacao === 'signed' && st.signatarios[0].situacao === 'signed', 'consulta mostra assinado', JSON.stringify(st).slice(0, 300));
  const fin = (await tool('baixar_documento_assinado', { id: doc.id }))?.structuredContent;
  ok(fin && Buffer.from(fin.pdf_base64, 'base64').subarray(0, 5).toString() === '%PDF-', 'PDF final baixado pela ponte');

  const fp = (await tool('baixar_documento_assinado', { id: doc.id, parte: 0 }))?.structuredContent;
  let junto = ''; for (let i = 0; i < (fp?.total_partes || 0); i++) junto += (await tool('baixar_documento_assinado', { id: doc.id, parte: i })).structuredContent.dados;
  ok(fp?.total_partes >= 1 && junto === fin.pdf_base64, 'download em partes = arquivo inteiro', `${fp?.total_partes}`);

  const TAM = 500, partes = []; for (let i = 0; i < pdf.length; i += TAM) partes.push(pdf.slice(i, i + TAM));
  let uid = '', ult;
  for (let i = 0; i < partes.length; i++) { ult = (await tool('enviar_para_assinatura', { titulo: 'Contrato em partes', signatarios: [{ nome: 'Carla Lima' }], pdf_parte: { upload_id: uid, indice: i, total: partes.length, dados: partes[i] } }))?.structuredContent; uid = ult?.upload_id || uid; }
  ok(partes.length > 1 && ult?.id && ult?.codigo, 'envio em partes cria o documento', `${partes.length} ${JSON.stringify(ult).slice(0, 200)}`);

  const env2 = (await tool('enviar_para_assinatura', { titulo: 'Para cancelar', pdf_base64: pdf, signatarios: [{ nome: 'José Souza' }] }))?.structuredContent;
  const can = (await tool('cancelar_assinatura', { id: env2.id }))?.structuredContent;
  ok(can?.situacao === 'cancelled', 'cancelamento pela ponte');
} catch (e) { fail++; console.error(e, log); }
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
