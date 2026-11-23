const token = location.pathname.split('/').filter(Boolean).pop();
const API = `/api/s/${encodeURIComponent(token)}`;
const root = document.getElementById('app');

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

async function call(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* sem corpo */ }
  if (!res.ok) throw new Error(body?.error || `Erro ${res.status}`);
  return body;
}

const state = { info: null, sigKind: 'desenho', selfie: null, geo: null, stream: null, email: '' };

function message(title, text, cls = '') {
  root.replaceChildren(h('div', { class: 'card' }, h('h1', {}, title), h('div', { class: cls }, text)));
}

// ----- assinatura: desenho -----
function makePad() {
  const canvas = h('canvas', { class: 'pad', width: 800, height: 260, 'aria-label': 'Área para desenhar a assinatura' });
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
  let drawing = false, dirty = false, last = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; };
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); drawing = true; last = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(last.x + 0.1, last.y + 0.1); ctx.stroke(); dirty = true; });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; e.preventDefault(); const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; });
  const end = () => { drawing = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  return {
    canvas,
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
    isEmpty: () => !dirty,
    toDataUrl: () => canvas.toDataURL('image/png'),
  };
}

// ----- assinatura: digitada -----
function typedToPng(text) {
  const c = document.createElement('canvas'); c.width = 800; c.height = 260;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  let size = 110;
  const font = (s) => `italic ${s}px "Segoe Script","Brush Script MT","Apple Chancery","Lucida Handwriting",cursive`;
  ctx.font = font(size);
  while (ctx.measureText(text).width > 740 && size > 28) { size -= 4; ctx.font = font(size); }
  ctx.fillText(text, 400, 130);
  return c.toDataURL('image/png');
}

// ----- selfie -----
function stopStream() { state.stream?.getTracks().forEach((t) => t.stop()); state.stream = null; }
function resizeToJpeg(source, w, h0) {
  const max = 720; const k = Math.min(1, max / Math.max(w, h0));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
function selfieBlock(onChange) {
  const host = h('div');
  const render = () => {
    host.replaceChildren();
    if (state.selfie) {
      host.append(h('img', { class: 'shot', src: state.selfie, alt: 'Sua selfie' }),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: () => { state.selfie = null; onChange(); render(); } }, 'Tirar outra')));
      return;
    }
    const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'user', style: 'display:none', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const bmp = await createImageBitmap(f);
        state.selfie = resizeToJpeg(bmp, bmp.width, bmp.height); onChange(); render();
      } catch { host.append(h('div', { class: 'err' }, 'Não foi possível ler a foto. Tente outra.')); }
    } });
    const err = h('div');
    host.append(h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'primary', onclick: async () => {
        err.replaceChildren();
        if (!navigator.mediaDevices?.getUserMedia) { fileInput.click(); return; }
        try {
          state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        } catch { err.append(h('div', { class: 'warnmsg' }, 'Não consegui abrir a câmera. Libere a permissão no navegador ou envie uma foto.')); return; }
        const video = h('video', { class: 'cam', autoplay: true, playsinline: true, muted: true });
        video.srcObject = state.stream;
        host.replaceChildren(video, h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'primary', onclick: () => {
            if (!video.videoWidth) return;
            state.selfie = resizeToJpeg(video, video.videoWidth, video.videoHeight); stopStream(); onChange(); render();
          } }, 'Tirar foto'),
          h('button', { type: 'button', onclick: () => { stopStream(); render(); } }, 'Cancelar')));
      } }, 'Abrir câmera'),
      h('button', { type: 'button', onclick: () => fileInput.click() }, 'Enviar uma foto'), fileInput), err);
  };
  render();
  return host;
}

// ----- localização: pedida automaticamente ao abrir; prova de onde a assinatura foi feita -----
function askGeo(ui) {
  const set = (cls, msg, retry) => { ui.note.className = `small ${cls}`; ui.note.textContent = msg; ui.btn.hidden = !retry; ui.btn.disabled = false; ui.onchange?.(); };
  if (!navigator.geolocation) { state.geo = null; set('warnmsg', 'Este aparelho ou navegador não oferece localização. Abra o link em outro aparelho (celular) para assinar.', false); return; }
  ui.btn.disabled = true; ui.note.className = 'muted small'; ui.note.textContent = 'Aguardando você permitir a localização no aviso do navegador…';
  const ok = (p) => { state.geo = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }; set('okmsg', `✔ Localização registrada${p.coords.accuracy ? ` (precisão de cerca de ${Math.round(p.coords.accuracy)} m)` : ''}.`, false); };
  const fail = (e) => {
    state.geo = null;
    const denied = e && e.code === 1;
    set(ui.required ? 'warnmsg' : 'muted', denied
      ? 'A localização está bloqueada. Toque no cadeado (ou no ícone ao lado do endereço do site), escolha Permissões ou Configurações do site, permita a Localização e toque em “Tentar de novo”.'
      : 'Não consegui obter a localização. Verifique se o GPS/localização do aparelho está ligado e toque em “Tentar de novo”.', true);
  };
  navigator.geolocation.getCurrentPosition(ok, (e) => {
    if (e && e.code === 3) navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: false, timeout: 12000, maximumAge: 120000 }); // GPS demorou: aceita posição aproximada
    else fail(e);
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
}

// ----- telas -----
function fmtCpf(v) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}

function viewSign(info) {
  const pad = makePad();
  const typed = h('input', { type: 'text', maxlength: 60, placeholder: 'Digite seu nome', autocomplete: 'off' });
  const typedPreview = h('div', { class: 'muted small' });
  const padBox = h('div', {}, pad.canvas, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'small', onclick: () => pad.clear() }, 'Limpar')));
  const typedBox = h('div', { style: 'display:none' }, typed, typedPreview);
  const tabD = h('button', { type: 'button', class: 'on', onclick: () => setKind('desenho') }, 'Desenhar');
  const tabT = h('button', { type: 'button', onclick: () => setKind('digitado') }, 'Digitar');
  function setKind(k) {
    state.sigKind = k;
    tabD.className = k === 'desenho' ? 'on' : ''; tabT.className = k === 'digitado' ? 'on' : '';
    padBox.style.display = k === 'desenho' ? '' : 'none'; typedBox.style.display = k === 'digitado' ? '' : 'none';
  }

  const email = h('input', { type: 'email', inputmode: 'email', autocomplete: 'email', placeholder: 'seuemail@exemplo.com', maxlength: 120, value: info.signer.emailPreset || '' });
  const cpf = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '000.000.000-00', maxlength: 14, oninput: (e) => { e.target.value = fmtCpf(e.target.value); } });
  const consent = h('input', { type: 'checkbox' });
  const err = h('div');
  const geoNote = h('div', { class: 'muted small' });
  const geoUi = { note: geoNote, btn: null, required: !!info.signer.requireGeo, onchange: null };
  const geoBtn = h('button', { type: 'button', class: 'small', hidden: true, onclick: () => askGeo(geoUi) }, 'Tentar de novo');
  geoUi.btn = geoBtn;
  const submit = h('button', { class: 'primary', type: 'button', disabled: true }, 'Assinar documento');
  const refuse = h('button', { type: 'button', class: 'danger small', onclick: () => viewRefuse() }, 'Recusar assinar');

  const refresh = () => { submit.disabled = !consent.checked || (info.signer.requireSelfie && !state.selfie) || (info.signer.requireGeo && !state.geo); };
  geoUi.onchange = () => refresh();
  consent.addEventListener('change', refresh);

  submit.addEventListener('click', async () => {
    err.replaceChildren();
    let png;
    if (state.sigKind === 'desenho') {
      if (pad.isEmpty()) { err.append(h('div', { class: 'err' }, 'Desenhe sua assinatura no quadro.')); return; }
      png = pad.toDataUrl();
    } else {
      const t = typed.value.trim();
      if (t.length < 3) { err.append(h('div', { class: 'err' }, 'Digite seu nome para assinar.')); return; }
      png = typedToPng(t);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) { err.append(h('div', { class: 'err' }, 'Informe um e-mail válido para receber a sua via do documento assinado.')); email.focus(); return; }
    state.email = email.value.trim();
    submit.disabled = true; submit.textContent = 'Assinando…';
    try {
      const r = await call(`${API}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        signaturePng: png, signatureKind: state.sigKind, selfieJpeg: state.selfie, cpf: cpf.value, email: email.value.trim(), consent: consent.checked, geo: state.geo,
      }) });
      stopStream();
      viewDone(info, r);
    } catch (e) {
      err.replaceChildren(h('div', { class: 'err' }, e.message)); submit.textContent = 'Assinar documento'; refresh();
    }
  });

  root.replaceChildren(
    h('div', { class: 'card' },
      h('div', { class: 'muted small' }, `${info.org} enviou para você assinar`),
      h('h1', { style: 'margin-bottom:.4rem' }, info.doc.title),
      h('div', { class: 'muted small' }, `Signatário: ${info.signer.name}`)),
    h('div', { class: 'card step' },
      h('h2', {}, 'Leia o documento'),
      h('iframe', { class: 'sign-doc', src: `${API}/pdf#view=FitH`, title: 'Documento para assinar' }),
      h('div', { class: 'actions' }, h('a', { class: 'btn small', href: `${API}/pdf`, target: '_blank', rel: 'noopener' }, 'Abrir em tela cheia / baixar'))),
    info.signer.requireCpf ? h('div', { class: 'card step' }, h('h2', {}, 'Confirme seu CPF'), cpf) : null,
    h('div', { class: 'card step' }, h('h2', {}, 'Seu e-mail'),
      h('p', { class: 'muted small' }, 'É para este e-mail que enviaremos a sua via do documento assinado.'), email),
    info.signer.requireSelfie ? h('div', { class: 'card step' }, h('h2', {}, 'Tire uma selfie'),
      h('p', { class: 'muted small' }, 'A foto fica guardada junto das provas da assinatura. Escolha um lugar com boa luz.'), selfieBlock(refresh)) : null,
    h('div', { class: 'card step' },
      h('h2', {}, 'Sua assinatura'),
      h('div', { class: 'tabs' }, tabD, tabT), padBox, typedBox,
      ),
    h('div', { class: 'card step' }, h('h2', {}, 'Localização'),
      h('p', { class: 'muted small' }, info.signer.requireGeo ? 'Para comprovar que foi você quem assinou, registramos o local da assinatura. Quando o navegador perguntar, toque em Permitir.' : 'Registrar o local da assinatura ajuda a comprovar que foi você quem assinou. Quando o navegador perguntar, toque em Permitir (opcional).'),
      geoNote, h('div', { class: 'actions' }, geoBtn)),
    h('div', { class: 'card step' },
      h('h2', {}, 'Confirmar'),
      h('label', { class: 'check' }, consent, info.consent), err,
      h('div', { class: 'actions sticky-foot' }, submit, refuse)));
  askGeo(geoUi);
  typed.addEventListener('input', () => { typedPreview.textContent = typed.value ? 'Sua assinatura será escrita com letra cursiva.' : ''; });
  refresh();
}

function viewRefuse() {
  const reason = h('textarea', { rows: 3, maxlength: 300, placeholder: 'Motivo (opcional)' });
  const err = h('div');
  root.replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Recusar assinatura'),
    h('p', {}, 'Ao recusar, o documento é cancelado para todos os signatários.'), reason, err,
    h('div', { class: 'actions' },
      h('button', { class: 'danger', type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        try { await call(`${API}/refuse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: reason.value }) }); message('Recusa registrada', 'Você recusou assinar este documento. O remetente foi informado.'); }
        catch (x) { err.replaceChildren(h('div', { class: 'err' }, x.message)); e.target.disabled = false; }
      } }, 'Confirmar recusa'),
      h('button', { type: 'button', onclick: () => viewSign(state.info) }, 'Voltar'))));
}

function viewDone(info, r) {
  const parts = [h('h1', {}, 'Assinatura registrada ✔'),
    h('div', { class: 'okmsg' }, 'Obrigado, ' + info.signer.name.split(' ')[0] + '. Sua assinatura foi registrada com data e hora.')];
  if (state.email) parts.push(h('p', {}, r?.finalReady ? `Enviamos a sua via do documento assinado para ${state.email}. Confira também a caixa de spam.` : `Quando todos assinarem, você receberá a sua via do documento assinado em ${state.email}.`));
  if (r?.finalReady) parts.push(h('p', {}, 'Todos já assinaram. Baixe a cópia final:'), h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: `${API}/final` }, 'Baixar documento assinado')));
  else if (r?.docStatus === 'error') parts.push(h('div', { class: 'warnmsg' }, 'Sua assinatura foi guardada, mas houve um problema ao gerar o arquivo final. O remetente já pode tentar de novo.'));
  else parts.push(h('p', { class: 'muted' }, 'Ainda faltam outros signatários. Quando todos assinarem, o remetente receberá o arquivo final.'));
  parts.push(h('p', { class: 'muted small' }, `Código do documento: ${info.doc.code}`));
  root.replaceChildren(h('div', { class: 'card' }, parts));
}

async function main() {
  try {
    const info = await call(API);
    state.info = info;
    if (info.done) return viewDone(info, { finalReady: info.finalReady });
    if (info.blocked) return message(info.doc.title, info.blocked, 'warnmsg');
    viewSign(info);
  } catch (e) { message('Link indisponível', e.message, 'err'); }
}
main();
