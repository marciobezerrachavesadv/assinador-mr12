// Ponte com outros sistemas (ex.: SST MR12) via MCP (Model Context Protocol), transporte HTTP "streamable", sem estado.
// Ativada so quando MCP_TOKEN estiver configurado. O endereco do conector fica: PUBLIC_URL/mcp/<MCP_TOKEN>
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { config } from './config.js';
import { db, logEvent } from './db.js';
import { rateLimit } from './auth.js';

const PROTO = '2025-06-18';

const TOOLS = [
  {
    name: 'enviar_para_assinatura',
    title: 'Enviar PDF para assinatura',
    description: 'Cria um documento no AssinadorMR12 a partir de um PDF (base64) e devolve o link individual de assinatura de cada signatário e o código de verificação.',
    inputSchema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Título do documento (2 a 200 caracteres)' },
        pdf_base64: { type: 'string', description: 'Conteúdo do PDF em base64' },
        signatarios: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object',
            properties: {
              nome: { type: 'string' }, email: { type: 'string' }, whatsapp: { type: 'string', description: 'DDD + número' },
              cpf: { type: 'string' }, exigir_selfie: { type: 'boolean' },
            },
            required: ['nome'],
          },
        },
        prazo: { type: 'string', description: 'Data limite AAAA-MM-DD (opcional)' },
        em_ordem: { type: 'boolean', description: 'Assinar na ordem da lista' },
        referencia: { type: 'string', description: 'Identificação no sistema de origem (ex.: contrato 0012/2026)' },
        pdf_parte: {
          type: 'object', description: 'Envio do PDF em partes (para PDFs grandes): mande cada parte em uma chamada; a última cria o documento.',
          properties: { upload_id: { type: 'string' }, indice: { type: 'number' }, total: { type: 'number' }, dados: { type: 'string', description: 'Trecho do base64' } },
        },
      },
      required: ['titulo', 'signatarios'],
    },
  },
  {
    name: 'consultar_assinatura',
    title: 'Consultar situação do documento',
    description: 'Situação de um documento do AssinadorMR12: quem já assinou, links, código de verificação e se o PDF final está pronto.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'Id devolvido por enviar_para_assinatura' } }, required: ['id'] },
  },
  {
    name: 'baixar_documento_assinado',
    title: 'Baixar o PDF assinado',
    description: 'Devolve o PDF final assinado (com selo, se configurado) em base64. Só funciona depois que todos assinaram.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, parte: { type: 'number', description: 'Parte do arquivo (0, 1, 2…), para baixar PDFs grandes em pedaços' } }, required: ['id'] },
  },
  {
    name: 'cancelar_assinatura',
    title: 'Cancelar documento',
    description: 'Cancela um documento que ainda aguarda assinaturas.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
];

const ST = { pending: 'aguardando assinaturas', finalizing: 'finalizando', signed: 'assinado por todos', cancelled: 'cancelado', error: 'erro na finalização', refused: 'recusado' };
const SST = { new: 'não abriu', viewed: 'abriu o link', signed: 'assinou', refused: 'recusou' };

function resumo(d) {
  return {
    id: d.id, codigo: d.code, titulo: d.title, situacao: d.status, situacao_texto: ST[d.status] || d.status,
    criado_em: d.createdAt, concluido_em: d.completedAt, verificar_url: d.verifyUrl, pdf_final_pronto: d.status === 'signed' && !!d.finalSha256,
    erro: d.error || null,
    signatarios: d.signers.map((s) => ({ nome: s.name, email: s.email, whatsapp: s.phone, situacao: s.status, situacao_texto: SST[s.status] || s.status, assinou_em: s.signedAt, link: s.link })),
  };
}

const PARTE = 30000; // caracteres de base64 por parte no download
const uploads = new Map(); // upload_id -> { partes: [], total, em, bytes }
function limparUploads() { const lim = Date.now() - 30 * 60_000; for (const [k, v] of uploads) if (v.em < lim) uploads.delete(k); }

export function mountMcp(app, { criarDocumentos, docDetail, abs }) {
  const token = String(process.env.MCP_TOKEN ?? '').trim();
  if (!token) return;
  if (token.length < 32) { console.warn('MCP_TOKEN curto demais (mínimo 32 caracteres): ponte MCP desativada.'); return; }
  const tokBuf = Buffer.from(token);
  const ok = (t) => { const b = Buffer.from(String(t || '')); return b.length === tokBuf.length && crypto.timingSafeEqual(b, tokBuf); };
  const limit = rateLimit({ windowMs: 60_000, max: 120 });
  const body = express.json({ limit: '20mb' });
  const userId = () => db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id ?? null;

  const result = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
  const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

  async function callTool(name, a = {}, req) {
    if (name === 'enviar_para_assinatura') {
      let b64 = String(a.pdf_base64 || '').replace(/^data:application\/pdf;base64,/, '');
      if (!b64 && a.pdf_parte) {
        limparUploads();
        const pp = a.pdf_parte, total = Number(pp.total), idx = Number(pp.indice);
        if (!Number.isInteger(total) || total < 1 || total > 2000 || !Number.isInteger(idx) || idx < 0 || idx >= total) return fail('Parte do PDF inválida.');
        let uid = String(pp.upload_id || '');
        if (!uid) { if (uploads.size > 50) return fail('Muitos envios em andamento; tente de novo em alguns minutos.'); uid = crypto.randomBytes(12).toString('hex'); uploads.set(uid, { partes: [], total, em: Date.now(), bytes: 0 }); }
        const up = uploads.get(uid);
        if (!up || up.total !== total) return fail('Envio em partes não encontrado ou expirado; recomece.');
        const dados = String(pp.dados || '');
        up.bytes += dados.length - (up.partes[idx]?.length || 0);
        if (up.bytes > config.limits.pdfBytes * 1.4) { uploads.delete(uid); return fail('PDF grande demais (máximo 10 MB).'); }
        up.partes[idx] = dados; up.em = Date.now();
        const recebidas = up.partes.filter((x) => typeof x === 'string').length;
        if (recebidas < total) return result({ upload_id: uid, recebidas, total, completo: false });
        b64 = up.partes.join(''); uploads.delete(uid);
      }
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return fail('Envie o PDF em base64.');
      if (buf.length > config.limits.pdfBytes) return fail('PDF grande demais (máximo 10 MB).');
      const lista = Array.isArray(a.signatarios) ? a.signatarios : [];
      const signers = lista.map((s) => ({ name: s?.nome, email: s?.email || '', phone: s?.whatsapp || '', cpf: s?.cpf || '', requireSelfie: !!s?.exigir_selfie }));
      const out = await criarDocumentos({
        files: [{ buffer: buf, originalname: 'documento.pdf' }], title: a.titulo, signers: JSON.stringify(signers),
        deadline: a.prazo || '', ordered: a.em_ordem ? '1' : '0', userId: userId(), ip: req.ip, ua: 'ponte MCP', via: String(a.referencia || 'ponte MCP').slice(0, 120),
      });
      return result(resumo(docDetail(out.id)));
    }
    const id = Number(a.id);
    if (!Number.isInteger(id) || id < 1) return fail('Informe o id do documento.');
    const d = docDetail(id);
    if (!d) return fail('Documento não encontrado.');
    if (name === 'consultar_assinatura') return result(resumo(d));
    if (name === 'baixar_documento_assinado') {
      const row = db.prepare('SELECT final_file, title FROM documents WHERE id = ?').get(id);
      if (d.status !== 'signed' || !row?.final_file) return fail('O PDF final ainda não está pronto: faltam assinaturas ou a finalização não terminou.');
      const p = abs('finals', row.final_file);
      if (!fs.existsSync(p)) return fail('Arquivo final não encontrado no servidor.');
      const tudo = fs.readFileSync(p).toString('base64'), total = Math.max(1, Math.ceil(tudo.length / PARTE));
      const parte = a.parte === undefined || a.parte === null ? null : Number(a.parte);
      if (parte === null && tudo.length <= PARTE) return result({ id, codigo: d.code, nome_arquivo: `${row.title}_assinado.pdf`, pdf_base64: tudo, parte: 0, total_partes: 1 });
      const i = parte ?? 0;
      if (!Number.isInteger(i) || i < 0 || i >= total) return fail('Parte inválida.');
      return result({ id, codigo: d.code, nome_arquivo: `${row.title}_assinado.pdf`, parte: i, total_partes: total, dados: tudo.slice(i * PARTE, (i + 1) * PARTE) });
    }
    if (name === 'cancelar_assinatura') {
      const r = db.prepare("UPDATE documents SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
      if (!r.changes) return fail('Só é possível cancelar documentos que ainda aguardam assinaturas.');
      logEvent(id, null, 'cancelled', { ip: req.ip, via: 'ponte MCP' });
      return result(resumo(docDetail(id)));
    }
    return fail(`Ferramenta desconhecida: ${name}`);
  }

  async function handle(msg, req) {
    const { id, method, params } = msg || {};
    const reply = (r) => ({ jsonrpc: '2.0', id, result: r });
    const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return err(-32600, 'Requisição inválida');
    if (id === undefined) return null; // notificacao
    switch (method) {
      case 'initialize':
        return reply({ protocolVersion: params?.protocolVersion || PROTO, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'AssinadorMR12', version: '1.0.0' }, instructions: 'Envia PDFs para assinatura eletrônica no AssinadorMR12 e acompanha a situação.' });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        try { return reply(await callTool(params?.name, params?.arguments || {}, req)); }
        catch (e) { return reply(fail(e?.status && e.status < 500 ? e.message : 'Erro interno no AssinadorMR12.')); }
      }
      default: return err(-32601, 'Método não suportado');
    }
  }

  app.all('/mcp/:token', limit, (req, res, next) => {
    if (!ok(req.params.token)) return res.status(404).json({ error: 'Rota não encontrada.' });
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET') return res.status(405).set('Allow', 'POST').end();
    if (req.method === 'DELETE') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    next();
  }, body, async (req, res) => {
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    const out = (await Promise.all(msgs.map((m) => handle(m, req)))).filter(Boolean);
    if (!out.length) return res.status(202).end();
    res.json(Array.isArray(req.body) ? out : out[0]);
  });
  console.log('Ponte MCP ativa em /mcp/<MCP_TOKEN>.');
}
