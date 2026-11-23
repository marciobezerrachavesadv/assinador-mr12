// Escolher onde cada pessoa assina: mostra as paginas dos PDFs e deixa arrastar uma caixa por signatario.
// Posicoes em fracao (0 a 1) da pagina como aparece na tela; o servidor carimba a assinatura nesse lugar.
const COLORS = ['#1f3a8a', '#1b7a4b', '#b4560a', '#8a1f6a', '#0f6f8a', '#b0261c', '#5b4bb5', '#6b6b00'];
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const BOX_W = 0.34, BOX_H = 0.085, VIEW_PX = 620;

let pdfjsP = null;
function loadPdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('/vendor/pdfjs/pdf.min.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'; return m; });
  }
  return pdfjsP;
}

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) { if (kid == null || kid === false) continue; el.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); }
  return el;
}

export function createPlacer({ getNames, getMode }) {
  const state = { files: [], boxes: [], armed: null, seq: 0 };
  const chips = h('div', { class: 'pl-chips' });
  const info = h('div', { class: 'muted small' });
  const pagesHost = h('div', { class: 'pl-pages' });
  const sug = h('button', { type: 'button', class: 'small', onclick: () => suggest() }, 'Sugerir: no fim do documento');
  const clr = h('button', { type: 'button', class: 'small', onclick: () => { state.boxes.splice(0).forEach((b) => b.el.remove()); refresh(); } }, 'Limpar tudo');
  const el = h('div', { class: 'card pl', hidden: true },
    h('h2', { style: 'margin-top:0' }, 'Onde cada pessoa assina'),
    h('p', { class: 'muted small' }, 'Opcional. Clique no nome de quem vai assinar e depois clique na página, no lugar onde a assinatura deve aparecer. Arraste a caixa para ajustar, puxe o canto para mudar o tamanho. Sem nenhuma posição, a assinatura aparece só na página do termo, no fim.'),
    chips, h('div', { class: 'row', style: 'gap:8px;margin:8px 0' }, sug, clr), info, pagesHost);

  const nameOf = (i) => (getNames()[i] || '').trim() || `Signatário ${i + 1}`;
  const colorOf = (i) => COLORS[i % COLORS.length];

  function paintBox(b) {
    const s = b.el.style;
    s.left = `${b.x * 100}%`; s.top = `${b.y * 100}%`; s.width = `${b.w * 100}%`; s.height = `${b.h * 100}%`;
    s.borderColor = colorOf(b.signer); s.background = `${colorOf(b.signer)}22`;
    b.label.textContent = nameOf(b.signer); b.label.style.color = colorOf(b.signer);
  }

  function drag(ev, b, mode) {
    ev.preventDefault(); ev.stopPropagation();
    const r = b.el.parentElement.getBoundingClientRect();
    const sx = ev.clientX, sy = ev.clientY, o = { x: b.x, y: b.y, w: b.w, h: b.h };
    const move = (e) => {
      const dx = (e.clientX - sx) / r.width, dy = (e.clientY - sy) / r.height;
      if (mode === 'move') { b.x = clamp(o.x + dx, 0, 1 - b.w); b.y = clamp(o.y + dy, 0, 1 - b.h); }
      else { b.w = clamp(o.w + dx, 0.06, 1 - b.x); b.h = clamp(o.h + dy, 0.03, 1 - b.y); }
      paintBox(b);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  function addBox(signer, file, page, x, y, w = BOX_W, h2 = BOX_H) {
    const ov = state.files[file]?.pages[page - 1]?.ov;
    if (!ov) return null;
    const b = { id: ++state.seq, signer, file, page, w, h: h2, x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h2) };
    b.label = h('span', { class: 'pl-label' });
    const del = h('button', { type: 'button', class: 'pl-del', title: 'Remover', onpointerdown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); state.boxes = state.boxes.filter((z) => z !== b); b.el.remove(); refresh(); } }, '×');
    const grip = h('span', { class: 'pl-grip', onpointerdown: (e) => drag(e, b, 'resize') });
    b.el = h('div', { class: 'pl-box', onpointerdown: (e) => drag(e, b, 'move') }, b.label, del, grip);
    ov.append(b.el); state.boxes.push(b); paintBox(b); refresh();
    return b;
  }

  function refresh() {
    const names = getNames();
    chips.replaceChildren(...names.map((_, i) => {
      const n = state.boxes.filter((b) => b.signer === i).length;
      return h('button', { type: 'button', class: `pl-chip${state.armed === i ? ' on' : ''}`, style: `--c:${colorOf(i)}`, onclick: () => { state.armed = state.armed === i ? null : i; pagesHost.classList.toggle('armed', state.armed !== null); refresh(); } },
        h('span', { class: 'dot' }), `${state.armed === i ? '▶ ' : '+ '}${nameOf(i)}`, n ? h('span', { class: 'pl-n' }, `${n}`) : null);
    }));
    state.boxes.forEach(paintBox);
    info.textContent = state.armed !== null ? `Agora clique na página onde ${nameOf(state.armed)} vai assinar.` : (state.boxes.length ? `${state.boxes.length} posição(ões) definida(s).` : 'Nenhuma posição definida ainda.');
    sug.disabled = !state.files.length || !names.length;
  }

  function suggest() {
    const perFile = getMode() === 'separate';
    const n = getNames().length;
    const targets = perFile ? state.files.map((_, i) => i) : [state.files.length - 1];
    for (const f of targets) {
      const file = state.files[f]; if (!file) continue;
      const last = file.pages.length;
      const missing = [...Array(n).keys()].filter((s) => !state.boxes.some((b) => b.signer === s && (perFile ? b.file === f : true)));
      const rows = Math.ceil(missing.length / 2);
      missing.forEach((s, k) => {
        const col = k % 2, row = Math.floor(k / 2);
        const x = missing.length === 1 ? 0.33 : 0.07 + col * 0.46;
        addBox(s, f, last, x, 0.8 - (rows - 1 - row) * 0.11);
      });
    }
    pagesHost.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  async function setFiles(fileList) {
    state.boxes = []; state.files = []; state.armed = null; pagesHost.replaceChildren(); pagesHost.classList.remove('armed');
    if (!fileList.length) { el.hidden = true; return; }
    el.hidden = false;
    info.textContent = 'Carregando as páginas…';
    let pdfjs;
    try { pdfjs = await loadPdfjs(); } catch { info.textContent = 'Não consegui carregar a visualização das páginas. Você ainda pode criar o documento sem escolher posições.'; return; }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); e.target._render?.(); } }), { rootMargin: '700px' });
    for (let fi = 0; fi < fileList.length; fi++) {
      const f = fileList[fi];
      const entry = { name: f.name, pages: [] };
      state.files.push(entry);
      if (fileList.length > 1) pagesHost.append(h('h3', { class: 'pl-file' }, `${fi + 1}. ${f.name}`));
      try {
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()), isEvalSupported: false, standardFontDataUrl: '/vendor/pdfjs-fonts/' }).promise;
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const base = page.getViewport({ scale: 1 });
          const canvas = h('canvas');
          const ov = h('div', { class: 'pl-ov', onclick: (ev) => {
            if (state.armed === null || ev.target !== ov) return;
            const r = ov.getBoundingClientRect();
            addBox(state.armed, fi, p, (ev.clientX - r.left) / r.width - BOX_W / 2, (ev.clientY - r.top) / r.height - BOX_H / 2);
            state.armed = null; pagesHost.classList.remove('armed'); refresh();
          } });
          const wrap = h('div', { class: 'pl-pg', style: `aspect-ratio:${base.width}/${base.height}` }, canvas, ov, h('span', { class: 'pl-pn' }, `pág. ${p}${pdf.numPages > 1 ? ` de ${pdf.numPages}` : ''}`));
          wrap._render = async () => {
            const sc = (VIEW_PX / base.width) * Math.min(window.devicePixelRatio || 1, 2);
            const vp = page.getViewport({ scale: sc });
            canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
            try { await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise; } catch { /* pagina com problema: mostra em branco */ }
          };
          entry.pages.push({ ov, wrap });
          pagesHost.append(wrap); io.observe(wrap);
        }
      } catch {
        pagesHost.append(h('div', { class: 'err' }, `Não consegui mostrar as páginas de ${f.name}. O servidor ainda vai conferir o arquivo ao criar o documento.`));
      }
    }
    refresh();
  }

  function signerRemoved(idx) {
    state.boxes = state.boxes.filter((b) => { if (b.signer === idx) { b.el.remove(); return false; } if (b.signer > idx) b.signer -= 1; return true; });
    if (state.armed === idx) state.armed = null; else if (state.armed > idx) state.armed -= 1;
    refresh();
  }

  const getPlacements = () => state.boxes.map(({ signer, file, page, x, y, w, h: hh }) => ({ signer, file, page, x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +hh.toFixed(4) }));
  return { el, setFiles, refresh, signerRemoved, getPlacements };
}
