import { createPlacer } from '/admin/posicao.js';
const TZ = 'America/Rio_Branco';
const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const dt = (iso) => (iso ? fmt.format(new Date(iso)) : '—');
const STATUS = {
  pending: ['Aguardando assinaturas', 'warn'], finalizing: ['Finalizando', 'info'], signed: ['Assinado', 'ok'],
  cancelled: ['Cancelado', ''], error: ['Erro ao finalizar', 'bad'],
};
const SIGNER = { new: ['Não abriu', ''], viewed: ['Abriu o link', 'info'], signed: ['Assinou', 'ok'], refused: ['Recusou', 'bad'] };
const EVENT = {
  created: 'Documento criado', viewed: 'Abriu o link', signed: 'Assinou', refused: 'Recusou assinar', cancelled: 'Documento cancelado',
  completed: 'Documento finalizado', finalize_error: 'Falha ao finalizar', mail_sent: 'Cópia enviada por e-mail', mail_failed: 'Falha ao enviar e-mail',
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const pill = ([text, cls]) => h('span', { class: `pill ${cls}` }, text);

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  let body = null;
  try { body = await res.json(); } catch { /* sem corpo */ }
  if (res.status === 401 && path !== '/api/login') { state.user = null; render(); throw new Error('Sessão expirada. Faça login.'); }
  if (!res.ok) throw new Error(body?.error || `Erro ${res.status}`);
  return body;
}
const postJson = (path, data) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) });

const state = { user: null, org: '', seal: null, publicUrl: '', mail: false };
const root = document.getElementById('app');

function copy(text, btn) {
  navigator.clipboard?.writeText(text).then(() => { const o = btn.textContent; btn.textContent = 'Copiado!'; setTimeout(() => (btn.textContent = o), 1500); })
    .catch(() => window.prompt('Copie o link:', text));
}
const showErr = (host, e) => { host.replaceChildren(h('div', { class: 'err' }, e.message || String(e))); };

// ---------- login ----------
function viewLogin() {
  const msg = h('div');
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try { await postJson('/api/login', { email: email.value, password: pass.value }); await boot(); } catch (err) { showErr(msg, err); }
  } }, h('h1', {}, 'AssinadorMR12'), h('label', {}, 'E-mail'), email, h('label', {}, 'Senha'), pass, msg,
  h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Entrar')));
  return h('div', { class: 'wrap narrow' }, form);
}

// ---------- layout ----------
function sealBanner() {
  const s = state.seal;
  if (!s) return null;
  if (s.error) return h('div', { class: 'banner warnmsg' }, `Selo ICP indisponível: ${s.error} Os documentos ficarão com erro na finalização até corrigir.`);
  if (s.enabled) {
    const i = s.info;
    return h('div', { class: 'banner okmsg' }, `Selo ICP ativo: ${i.subject} · vence em ${i.daysLeft} dias${i.signaturePolicy ? '' : ' · sem política AD-RB (confira no Validar do ITI)'}`);
  }
  return h('div', { class: 'banner', style: 'background:var(--surface2)' }, 'Selo ICP desativado: os documentos saem com termo e evidências, sem selo digital.');
}
function layout(route, content) {
  const link = (href, text, key) => h('a', { href, class: route === key ? 'on' : '' }, text);
  return h('div', {},
    h('header', { class: 'top' }, h('div', { class: 'wrap' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: '/logo.png', alt: 'Grupo MR12', class: 'brandlogo' }), 'AssinadorMR12'),
      h('nav', {}, link('#/', 'Documentos', 'list'), link('#/novo', 'Novo documento', 'novo'), link('#/validar', 'Validar PDF', 'validar'), link('#/equipe', 'Equipe', 'equipe')),
      h('span', { class: 'muted small' }, `${state.user.name} · ${state.org}`),
      h('button', { class: 'small', onclick: async () => { await api('/api/logout', { method: 'POST' }); state.user = null; render(); } }, 'Sair'))),
    sealBanner(),
    h('main', { class: 'wrap' }, content));
}

// ---------- lista ----------
async function viewList() {
  const host = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
  api('/api/documents').then((rows) => {
    if (!rows.length) { host.replaceChildren(h('div', { class: 'card' }, 'Nenhum documento ainda. ', h('a', { href: '#/novo' }, 'Criar o primeiro'), '.')); return; }
    host.replaceChildren(h('div', { class: 'card', style: 'padding:4px 8px;overflow:auto' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Documento', 'Situação', 'Assinaturas', 'Criado em'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((r) => h('tr', { class: 'click', onclick: () => { location.hash = `#/doc/${r.id}`; } },
        h('td', {}, h('strong', {}, r.title), h('div', { class: 'muted small mono' }, r.code)),
        h('td', {}, pill(STATUS[r.status] || [r.status, ''])),
        h('td', {}, `${r.signed}/${r.signers}`),
        h('td', {}, dt(r.created_at))))))));
  }).catch((e) => showErr(host, e));
  return h('div', {}, h('h1', {}, 'Documentos'), host);
}

// ---------- novo ----------
function viewNovo() {
  const msg = h('div');
  const title = h('input', { type: 'text', maxlength: 200, required: true });
  const titleBox = h('div', {}, h('label', {}, 'Título do documento'), title);
  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf', required: true, multiple: true });
  const deadline = h('input', { type: 'date' });
  const ordered = h('input', { type: 'checkbox' });
  const list = h('div');
  // vários arquivos: assinar tudo junto (um PDF só) ou em separado (um documento para cada)
  const mTogether = h('input', { type: 'radio', name: 'modo', value: 'together', checked: true });
  const mSeparate = h('input', { type: 'radio', name: 'modo', value: 'separate' });
  const titlesBox = h('div');
  const modeBox = h('div', { class: 'card', hidden: true },
    h('strong', {}, 'Você escolheu mais de um arquivo. Como o cliente vai assinar?'),
    h('label', { class: 'check' }, mTogether, h('span', {}, 'Tudo junto: os arquivos viram um PDF só, o cliente assina uma vez e recebe um único documento assinado.')),
    h('label', { class: 'check' }, mSeparate, h('span', {}, 'Em separado: cada arquivo vira um documento, com o próprio link, a própria assinatura e o próprio PDF final.')),
    titlesBox);
  const mode = () => (file.files.length > 1 && mSeparate.checked ? 'separate' : 'together');
  const names = () => [...list.children].map((b) => b._f.name.value);
  const placer = createPlacer({ getNames: names, getMode: mode });
  const syncMode = () => {
    const many = file.files.length > 1, sep = many && mSeparate.checked;
    modeBox.hidden = !many; titleBox.hidden = sep; title.required = !sep;
    titlesBox.replaceChildren(...(sep ? [h('label', {}, 'Nome de cada documento'), ...[...file.files].map((f, i) => { const t = h('input', { type: 'text', maxlength: 200, required: true, value: f.name.replace(/\.pdf$/i, ''), 'data-i': i }); return t; })] : []));
  };
  file.addEventListener('change', () => { syncMode(); placer.setFiles([...file.files]); });
  mTogether.addEventListener('change', syncMode); mSeparate.addEventListener('change', syncMode);
  const addSigner = () => {
    const f = {
      name: h('input', { type: 'text', placeholder: 'Nome completo', required: true }),
      cpf: h('input', { type: 'text', placeholder: 'CPF (opcional)', inputmode: 'numeric' }),
      phone: h('input', { type: 'tel', placeholder: 'WhatsApp com DDD' }),
      email: h('input', { type: 'email', placeholder: 'E-mail (opcional)' }),
      selfie: h('input', { type: 'checkbox' }),
      reqCpf: h('input', { type: 'checkbox', checked: true }),
      reqGeo: h('input', { type: 'checkbox', checked: true }),
    };
    f.reqCpf.checked = true; f.reqGeo.checked = true;
    const box = h('div', { class: 'signer-form' },
      h('div', { class: 'row' }, f.name, f.cpf), h('div', { class: 'row' }, f.phone, f.email),
      h('label', { class: 'check' }, f.reqCpf, 'Pedir o CPF ao assinar'),
      h('label', { class: 'check' }, f.selfie, 'Exigir selfie'),
      h('label', { class: 'check' }, f.reqGeo, 'Exigir localização automática (prova de onde assinou; recomendado)'),
      h('button', { class: 'small danger', type: 'button', onclick: () => { if (list.children.length > 1) { const i = [...list.children].indexOf(box); box.remove(); placer.signerRemoved(i); } } }, 'Remover'));
    box._f = f;
    f.name.addEventListener('input', () => placer.refresh());
    list.append(box);
    placer.refresh();
  };
  addSigner();
  // Preenchimento vindo de outros sistemas (ex.: SST MR12, Toga): #/novo?titulo=..&nome=..&tel=..&email=..&cpf=..
  try {
    const q = new URLSearchParams((location.hash.split('?')[1] || ''));
    if (q.get('titulo')) title.value = q.get('titulo').slice(0, 200);
    const f0 = list.children[0] && list.children[0]._f;
    if (f0) {
      if (q.get('nome')) f0.name.value = q.get('nome').slice(0, 120);
      if (q.get('tel')) f0.phone.value = q.get('tel').slice(0, 30);
      if (q.get('email')) f0.email.value = q.get('email').slice(0, 120);
      if (q.get('cpf')) f0.cpf.value = q.get('cpf').slice(0, 20);
    }
    placer.refresh();
  } catch { /* ignora */ }
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    msg.replaceChildren();
    const fd = new FormData();
    const sep = mode() === 'separate';
    fd.append('title', sep ? 'lote' : title.value);
    for (const f of file.files) fd.append('file', f);
    fd.append('mode', mode());
    if (sep) fd.append('titles', JSON.stringify([...titlesBox.querySelectorAll('input')].map((i) => i.value)));
    if (deadline.value) fd.append('deadline', deadline.value);
    fd.append('ordered', ordered.checked ? '1' : '0');
    fd.append('signers', JSON.stringify([...list.children].map((b) => ({
      name: b._f.name.value, cpf: b._f.cpf.value, phone: b._f.phone.value, email: b._f.email.value,
      requireSelfie: b._f.selfie.checked, requireCpf: b._f.reqCpf.checked, requireGeo: b._f.reqGeo.checked,
    }))));
    const pls = placer.getPlacements();
    if (pls.length) fd.append('placements', JSON.stringify(pls));
    const btn = form.querySelector('button.primary');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await api('/api/documents', { method: 'POST', body: fd });
      location.hash = r.documents && r.documents.length > 1 ? `#/lote/${r.documents.map((d) => d.id).join(',')}` : `#/doc/${r.id}`;
    } catch (err) { showErr(msg, err); btn.disabled = false; btn.textContent = 'Criar e gerar links'; }
  } },
  titleBox,
  h('label', {}, 'Arquivo(s) PDF (até 10 MB cada, sem assinatura digital). Dá para escolher vários de uma vez.'), file,
  modeBox,
  placer.el,
  h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Prazo para assinar (opcional)'), deadline)),
  h('label', { class: 'check' }, ordered, 'Assinatura em ordem (cada um só assina depois do anterior)'),
  h('h2', {}, 'Signatários'), list,
  h('button', { type: 'button', onclick: addSigner }, '+ Adicionar signatário'),
  msg, h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Criar e gerar links')));
  return h('div', {}, h('h1', {}, 'Novo documento'), form);
}

// ---------- varios documentos criados de uma vez (em separado) ----------
async function viewLote(ids) {
  const host = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
  const docs = await Promise.all(ids.map((id) => api(`/api/documents/${id}`)));
  const n = docs[0].signers.length;
  const msgFor = (i) => {
    const s = docs[0].signers[i], first = s.name.split(' ')[0];
    return `Olá, ${first}! Seguem os documentos para você assinar:\n\n${docs.map((d, k) => `${k + 1}. ${d.title}: ${d.signers[i].link}`).join('\n')}`;
  };
  host.replaceChildren(
    h('p', {}, h('a', { href: '#/' }, '← Documentos')),
    h('h1', {}, `${docs.length} documentos criados`),
    h('p', { class: 'muted' }, 'Cada documento tem o próprio link de assinatura. Abaixo, uma mensagem única para cada pessoa com todos os links.'),
    ...docs[0].signers.map((s, i) => h('div', { class: 'card' },
      h('strong', {}, s.name), h('pre', { class: 'mono', style: 'white-space:pre-wrap;margin:8px 0;font-size:.85rem' }, msgFor(i)),
      h('div', { class: 'actions', style: 'margin:0' },
        h('button', { class: 'small', onclick: (e) => copy(msgFor(i), e.target) }, 'Copiar mensagem'),
        s.phone ? h('a', { class: 'btn small', href: `https://wa.me/${s.phone}?text=${encodeURIComponent(msgFor(i))}`, target: '_blank', rel: 'noopener' }, 'WhatsApp') : null))),
    h('h2', {}, 'Documentos'),
    h('div', { class: 'card', style: 'padding:4px 8px' }, h('table', {}, h('tbody', {}, docs.map((d) => h('tr', { class: 'click', onclick: () => { location.hash = `#/doc/${d.id}`; } },
      h('td', {}, h('strong', {}, d.title), h('div', { class: 'muted small mono' }, d.code)), h('td', {}, pill(STATUS[d.status] || [d.status, ''])))))))
  );
  void n;
  return host;
}

// ---------- detalhe ----------
async function viewDoc(id) {
  const host = h('div', {}, h('p', { class: 'muted' }, 'Carregando…'));
  const load = async () => {
    const d = await api(`/api/documents/${id}`);
    const act = (label, fn, cls = '') => h('button', { class: `small ${cls}`, onclick: async (e) => { e.target.disabled = true; try { await fn(); await load(); } catch (err) { alert(err.message); e.target.disabled = false; } } }, label);
    const waLink = (s) => {
      const first = s.name.split(' ')[0];
      const text = `Olá, ${first}! Segue o documento "${d.title}" para você assinar: ${s.link}`;
      return `https://wa.me/${s.phone}?text=${encodeURIComponent(text)}`;
    };
    host.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'align-items:center' }, h('h1', { style: 'margin:0' }, d.title), pill(STATUS[d.status] || [d.status, ''])),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Código'), h('dd', { class: 'mono' }, d.code),
          h('dt', {}, 'Criado em'), h('dd', {}, dt(d.createdAt)),
          d.deadline ? [h('dt', {}, 'Prazo'), h('dd', {}, d.deadline.split('-').reverse().join('/'))] : null,
          h('dt', {}, 'Ordem'), h('dd', {}, d.ordered ? 'Em sequência' : 'Qualquer ordem'),
          h('dt', {}, 'Hash do original'), h('dd', { class: 'mono' }, d.originalSha256),
          d.finalSha256 ? [h('dt', {}, 'Hash do final'), h('dd', { class: 'mono' }, d.finalSha256)] : null,
          d.sealed ? [h('dt', {}, 'Selo digital'), h('dd', {}, `${d.seal.subject} (emitido por ${d.seal.issuer})`)] : null,
          h('dt', {}, 'Verificação pública'), h('dd', {}, h('a', { href: d.verifyUrl, target: '_blank', rel: 'noopener' }, d.verifyUrl))),
        d.error ? h('div', { class: 'err' }, `Erro: ${d.error}`) : null,
        h('div', { class: 'actions' },
          h('a', { class: 'btn small', href: `/api/documents/${id}/original` }, 'Baixar original'),
          d.finalSha256 ? h('a', { class: 'btn small primary', href: `/api/documents/${id}/final` }, 'Baixar assinado') : null,
          d.status === 'pending' ? act('Cancelar documento', async () => { if (!confirm('Cancelar este documento? Os links deixam de funcionar.')) throw new Error('Cancelamento desfeito.'); await postJson(`/api/documents/${id}/cancel`); }, 'danger') : null,
          d.status === 'error' ? act('Tentar finalizar de novo', () => postJson(`/api/documents/${id}/finalize`)) : null,
          d.status === 'signed' && state.mail ? act('Reenviar cópias por e-mail', async () => { const r = await postJson(`/api/documents/${id}/send-copies`); alert(`Enviado para ${r.sent} destinatário(s)${r.failed ? `; falhou para ${r.failed}` : ''}.`); }) : null,
          h('button', { class: 'small', onclick: load }, 'Atualizar'))),
      h('h2', {}, 'Signatários'),
      h('div', { class: 'card', style: 'padding:4px 8px;overflow:auto' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Nome', 'Situação', 'Link de assinatura'].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.signers.map((s) => h('tr', {},
          h('td', {}, h('strong', {}, (d.ordered ? `${s.order}. ` : '') + s.name),
            h('div', { class: 'muted small' }, [s.cpf ? 'CPF informado' : null, s.phone ? `+${s.phone}` : null, s.email, s.requireSelfie ? 'selfie' : null, s.requireGeo ? 'localização' : null].filter(Boolean).join(' · ')),
            s.geo ? h('div', { class: 'small' }, h('a', { href: `https://www.google.com/maps?q=${s.geo.lat},${s.geo.lng}`, target: '_blank', rel: 'noopener' }, `Local da assinatura no mapa${s.geo.acc ? ` (precisão ~${Math.round(s.geo.acc)} m)` : ''}`)) : null),
          h('td', {}, pill(SIGNER[s.status] || [s.status, '']), s.signedAt ? h('div', { class: 'muted small' }, dt(s.signedAt)) : null),
          h('td', {}, d.status === 'pending' || s.status === 'signed' ? h('div', { class: 'actions', style: 'margin:0' },
            h('button', { class: 'small', onclick: (e) => copy(s.link, e.target) }, 'Copiar link'),
            s.phone && s.status !== 'signed' ? h('a', { class: 'btn small', href: waLink(s), target: '_blank', rel: 'noopener' }, 'WhatsApp') : null) : h('span', { class: 'muted' }, '—'))))))),
      h('h2', {}, 'Histórico'),
      h('div', { class: 'card' }, h('table', {}, h('tbody', {}, d.events.filter((e) => e.type !== 'viewed' || true).map((e) => h('tr', {},
        h('td', { class: 'small', style: 'white-space:nowrap' }, dt(e.at)),
        h('td', {}, `${EVENT[e.type] || e.type}${e.signer ? ` — ${e.signer}` : ''}`, e.detail?.message ? ` (${e.detail.message})` : ''),
        h('td', { class: 'muted small' }, e.ip || '')))))));
  };
  load().catch((e) => showErr(host, e));
  return h('div', {}, h('p', {}, h('a', { href: '#/' }, '← Documentos')), host);
}

// ---------- validar ----------
const VERDICT = { integra_cadeia_confiavel: 'ok', integra_cadeia_nao_confiavel: 'warn', integra_alterado_depois: 'warn', invalida: 'bad', ilegivel: 'bad' };
function viewValidar() {
  const out = h('div');
  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf' });
  const go = h('button', { class: 'primary', onclick: async () => {
    if (!file.files[0]) return;
    out.replaceChildren(h('p', { class: 'muted' }, 'Conferindo…'));
    const fd = new FormData(); fd.append('file', file.files[0]);
    try { renderValidation(out, await api('/api/validar', { method: 'POST', body: fd })); } catch (e) { showErr(out, e); }
  } }, 'Conferir assinaturas');
  return h('div', {}, h('h1', {}, 'Validar PDF'),
    h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Confere a integridade e a cadeia das assinaturas digitais (ICP-Brasil ou outras) de um PDF.'), file, h('div', { class: 'actions' }, go)), out);
}
function renderValidation(host, r) {
  const yes = (b) => (b ? '✔ sim' : '✘ não');
  const parts = [h('div', { class: 'card' }, h('dl', { class: 'kv' }, h('dt', {}, 'SHA-256 do arquivo'), h('dd', { class: 'mono' }, r.sha256), h('dt', {}, 'Assinaturas'), h('dd', {}, String(r.signatures.length))))];
  if (!r.hasSignatures) parts.push(h('div', { class: 'warnmsg' }, 'Este PDF não contém assinaturas digitais.'));
  for (const s of r.signatures) {
    const sg = s.signer;
    parts.push(h('div', { class: 'card' },
      h('div', { class: 'row', style: 'align-items:center' }, h('h3', { style: 'margin:0' }, `Assinatura ${s.index}`), h('span', { class: `pill ${VERDICT[s.verdict] || ''}` }, s.verdictLabel)),
      sg ? h('dl', { class: 'kv' },
        h('dt', {}, 'Signatário'), h('dd', {}, sg.commonName || '—'),
        sg.cnpj ? [h('dt', {}, 'CNPJ (certificado)'), h('dd', {}, sg.cnpj)] : null,
        sg.cpf ? [h('dt', {}, 'CPF (certificado)'), h('dd', {}, sg.cpf)] : null,
        sg.responsavelNome ? [h('dt', {}, 'Responsável'), h('dd', {}, sg.responsavelNome)] : null,
        h('dt', {}, 'Emissor'), h('dd', {}, sg.issuer),
        h('dt', {}, 'Tipo (OID ICP)'), h('dd', {}, sg.icpCertificateType ? `Certificado ${sg.icpCertificateType} ICP-Brasil` : 'Não identificado como ICP-Brasil pelos OIDs'),
        h('dt', {}, 'Validade do certificado'), h('dd', {}, `${dt(sg.notBefore)} a ${dt(sg.notAfter)}`),
        h('dt', {}, 'Assinado em'), h('dd', {}, dt(s.signingTime) + ' (data declarada na própria assinatura)'),
        h('dt', {}, 'Formato'), h('dd', {}, s.subFilter || '—'),
        h('dt', {}, 'Integridade (hash)'), h('dd', {}, yes(s.integrity.digestMatches)),
        h('dt', {}, 'Assinatura confere'), h('dd', {}, yes(s.integrity.signatureValid)),
        h('dt', {}, 'Cobre o arquivo todo'), h('dd', {}, yes(s.integrity.coversWholeFile)),
        h('dt', {}, 'Cadeia'), h('dd', {}, s.chain.status === 'trusted' ? `Confiável (raiz: ${s.chain.root})` : s.chain.status === 'unchecked' ? 'Não verificada (sem raízes)' : 'Não confirmada', s.chain.notes?.length ? h('div', { class: 'muted small' }, s.chain.notes.join(' ')) : null),
        h('dt', {}, 'Atributos CAdES'), h('dd', {}, `Certificado do signatário: ${s.cades.signingCertificateAttr ? 'sim' : 'não'} · Política de assinatura: ${s.cades.signaturePolicyOid || 'nenhuma'}`),
        h('dt', {}, 'Revogação'), h('dd', {}, 'Não consultada')) : null,
      s.messages?.length ? h('div', { class: 'err' }, s.messages.join(' ')) : null));
  }
  parts.push(h('div', { class: 'warnmsg' }, r.note, ' ', h('a', { href: 'https://validar.iti.gov.br', target: '_blank', rel: 'noopener' }, 'Abrir o Validar do ITI')));
  host.replaceChildren(...parts);
}

// ---------- equipe ----------
function viewEquipe() {
  const host = h('div');
  const msg = h('div');
  const load = () => api('/api/users').then((us) => host.replaceChildren(h('div', { class: 'card' }, h('table', {}, h('tbody', {}, us.map((u) => h('tr', {}, h('td', {}, u.name), h('td', { class: 'muted' }, u.email))))))));
  load();
  const name = h('input', { type: 'text', required: true }), email = h('input', { type: 'email', required: true }), pw = h('input', { type: 'password', minlength: 10, required: true, autocomplete: 'new-password' });
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); msg.replaceChildren();
    try { await postJson('/api/users', { name: name.value, email: email.value, password: pw.value }); form.reset(); msg.replaceChildren(h('div', { class: 'okmsg' }, 'Usuário criado.')); load(); } catch (err) { showErr(msg, err); }
  } }, h('h3', {}, 'Adicionar usuário'), h('label', {}, 'Nome'), name, h('label', {}, 'E-mail'), email, h('label', {}, 'Senha (mínimo 10 caracteres)'), pw, msg, h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Criar usuário')));
  return h('div', {}, h('h1', {}, 'Equipe'), host, form);
}

// ---------- roteador ----------
async function render() {
  if (!state.user) { root.replaceChildren(viewLogin()); return; }
  const hash = location.hash || '#/';
  let route = 'list', view;
  const m = /^#\/doc\/(\d+)$/.exec(hash), ml = /^#\/lote\/([\d,]+)$/.exec(hash);
  if (m) view = await viewDoc(Number(m[1]));
  else if (ml) view = await viewLote(ml[1].split(',').map(Number).slice(0, 20));
  else if (hash === '#/novo' || hash.startsWith('#/novo?')) { route = 'novo'; view = viewNovo(); }
  else if (hash === '#/validar') { route = 'validar'; view = viewValidar(); }
  else if (hash === '#/equipe') { route = 'equipe'; view = viewEquipe(); }
  else view = await viewList();
  root.replaceChildren(layout(route, view));
}
async function boot() {
  try { const me = await api('/api/me'); state.user = me.user; state.org = me.org; state.seal = me.seal; state.mail = !!me.mail; state.publicUrl = me.publicUrl; } catch { state.user = null; }
  render();
}
window.addEventListener('hashchange', render);
boot();
