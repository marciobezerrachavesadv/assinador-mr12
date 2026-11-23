const code = location.pathname.split('/').filter(Boolean).pop();
const root = document.getElementById('app');
const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Rio_Branco', dateStyle: 'short', timeStyle: 'short' });
const dt = (i) => (i ? fmt.format(new Date(i)) : '—');
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else el.setAttribute(k, v); }
  for (const kid of kids.flat()) { if (kid == null || kid === false) continue; el.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); }
  return el;
}
const ST = { signed: ['Documento assinado por todos', 'okmsg'], pending: ['Ainda aguardando assinaturas', 'warnmsg'], cancelled: ['Documento cancelado', 'err'], finalizing: ['Em finalização', 'warnmsg'], error: ['Pendente de finalização', 'warnmsg'] };

async function main() {
  const res = await fetch(`/api/verificar/${encodeURIComponent(code)}`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { root.replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Documento não encontrado'), h('div', { class: 'err' }, d.error || 'Código inválido.'))); return; }
  const [label, cls] = ST[d.status] || [d.status, ''];
  root.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'muted small' }, `${d.org} · verificação pública`),
    h('h1', {}, d.title), h('div', { class: cls }, label),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Código'), h('dd', { class: 'mono' }, d.code),
      h('dt', {}, 'Criado em'), h('dd', {}, dt(d.createdAt)),
      d.completedAt ? [h('dt', {}, 'Concluído em'), h('dd', {}, dt(d.completedAt))] : null,
      h('dt', {}, 'SHA-256 do original'), h('dd', { class: 'mono' }, d.originalSha256),
      d.finalSha256 ? [h('dt', {}, 'SHA-256 do assinado'), h('dd', { class: 'mono' }, d.finalSha256)] : null,
      h('dt', {}, 'Selo digital'), h('dd', {}, d.sealed ? `Sim — ${d.sealSubject}` : 'Não')),
    h('h2', {}, 'Signatários'),
    h('table', {}, h('tbody', {}, d.signers.map((s) => h('tr', {}, h('td', {}, s.name), h('td', {}, s.status === 'signed' ? `Assinou em ${dt(s.signedAt)}` : s.status === 'refused' ? 'Recusou' : 'Pendente'))))),
    h('p', { class: 'muted small' }, 'Para conferir um arquivo, calcule o SHA-256 dele e compare com o valor acima. O selo digital pode ser conferido no Validar do ITI (validar.iti.gov.br).')));
}
main().catch(() => root.replaceChildren(h('div', { class: 'err' }, 'Não foi possível consultar agora.')));
