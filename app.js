/* ===========================================================
   「극저온의 세계」 — 앱 로직
   - 학생 기록: localStorage 자동 저장
   - 사진: IndexedDB 저장 (새로고침해도 남아 있음)
   - 버니어 Go Direct 센서: Web Bluetooth (godirect.js)
   - 보고서: 브라우저 인쇄 기능으로 PDF 저장 (한글 안 깨짐)
   =========================================================== */
(function () {
'use strict';

/* -----------------------------------------------------------
   0. 작은 도구들
----------------------------------------------------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
/** **굵게** 만 지원하는 아주 간단한 서식 변환 */
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

let toastTimer = null;
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2200);
}

/* -----------------------------------------------------------
   1. 저장소 — 글은 localStorage, 사진은 IndexedDB
----------------------------------------------------------- */
const LS_KEY = 'cryoCamp.v1';

const store = {
  data: { profile: {}, answers: {}, dataset: null, agreed: false },

  load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) { console.warn('저장된 내용을 불러오지 못했습니다.', e); }
  },
  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.data));
      flashSaved();
    } catch (e) {
      console.warn(e);
      toast('저장 공간이 부족합니다. 사진을 조금 지워 주세요.');
    }
  },
  answer(id, val) { this.data.answers[id] = val; this.save(); },
  get(id) { return this.data.answers[id] || ''; },
  clearAll() {
    localStorage.removeItem(LS_KEY);
    localStorage.removeItem('cryoCamp.step');
    this.data = { profile: {}, answers: {}, dataset: null, agreed: false };
  }
};

let savedTimer = null;
function flashSaved() {
  const n = $('#save-state');
  if (!n) return;
  n.textContent = '저장하는 중…';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { n.textContent = '자동 저장됨 ✓'; }, 350);
}

/* --- IndexedDB (사진) --- */
const photoDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('cryoCampPhotos', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('photos')) {
          const os = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
          os.createIndex('stepId', 'stepId', { unique: false });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
      req.onerror = () => reject(req.error);
    });
  },
  tx(mode) { return this.db.transaction('photos', mode).objectStore('photos'); },
  async add(stepId, dataUrl) {
    await this.open();
    return new Promise((res, rej) => {
      const r = this.tx('readwrite').add({ stepId, dataUrl, ts: Date.now() });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async byStep(stepId) {
    await this.open();
    return new Promise((res, rej) => {
      const out = [];
      const r = this.tx('readonly').index('stepId').openCursor(IDBKeyRange.only(stepId));
      r.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push(c.value); c.continue(); } else res(out);
      };
      r.onerror = () => rej(r.error);
    });
  },
  async all() {
    await this.open();
    return new Promise((res, rej) => {
      const r = this.tx('readonly').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  },
  async remove(id) {
    await this.open();
    return new Promise((res, rej) => {
      const r = this.tx('readwrite').delete(id);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  },
  async clear() {
    await this.open();
    return new Promise((res, rej) => {
      const r = this.tx('readwrite').clear();
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }
};

/** 큰 사진은 줄여서 저장 (저장 공간 절약 + 보고서 인쇄 속도) */
function shrinkImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* -----------------------------------------------------------
   2. 블록 렌더링
----------------------------------------------------------- */
function renderBlock(b) {
  switch (b.type) {
    case 'h':
      return el('h2', 'sec', esc(b.text));

    case 'p':
      return el('p', 'body', md(b.text));

    case 'list': {
      const ul = el('ul', 'bullets');
      b.items.forEach(t => ul.appendChild(el('li', null, md(t))));
      return ul;
    }

    case 'steps': {
      const ol = el('ol', 'steps');
      b.items.forEach(t => ol.appendChild(el('li', null, md(t))));
      return ol;
    }

    case 'fact':
      return el('div', 'fact',
        `<div class="big">${esc(b.big)}</div>
         <div class="label">${esc(b.label)}</div>
         ${b.sub ? `<div class="sub">${md(b.sub)}</div>` : ''}`);

    case 'why': {
      const d = el('details', 'why');
      d.innerHTML = `<summary>${esc(b.q)}</summary>
        <div class="ans">${md(b.a)}${b.youtube ? videoEmbedHTML(b) : ''}</div>`;
      /* 설명 안에 사진도 함께 넣을 수 있습니다 (files / file) */
      if (b.files || b.file) $('.ans', d).appendChild(buildPhotoRow(b));
      /* 상자를 펼칠 때 비로소 영상을 불러옵니다 (안 열면 유튜브에 접속하지 않음) */
      if (b.youtube) d.addEventListener('toggle', () => { if (d.open) loadVideos(d); });
      return d;
    }

    case 'video': {
      const box = el('div', 'card');
      box.innerHTML = videoEmbedHTML(b);
      loadVideos(box);
      return box;
    }

    case 'compare': {
      const wrap = el('div', 'compare');
      [b.left, b.right].forEach(col => {
        const c = el('div', 'col');
        c.innerHTML = `<h4>${esc(col.title)}</h4><ul>${col.items.map(i => `<li>${md(i)}</li>`).join('')}</ul>`;
        wrap.appendChild(c);
      });
      return wrap;
    }

    case 'cards': {
      const g = el('div', 'cardgrid');
      b.items.forEach(it => {
        g.appendChild(el('div', 'minicard',
          `<div class="ic">${it.icon}</div><h4>${esc(it.title)}</h4><p>${md(it.text)}</p>`));
      });
      return g;
    }

    case 'danger': {
      const d = el('div', 'danger');
      d.innerHTML = `<h4>⚠️ 안전 수칙 — 꼭 지켜요</h4><ul>${b.items.map(i => `<li>${md(i)}</li>`).join('')}</ul>`;
      return d;
    }

    case 'photo':
      return buildPhotoRow(b);

    case 'sensorLab':
      return buildSensorLab();

    default:
      return el('div');
  }
}

/* -----------------------------------------------------------
   1-9. 넓은 화면에서의 2단 배치
   소제목(h)과 넓은 요소(강조상자·안전수칙·비교표·카드·실험실)를 경계로
   구역을 나누고, 각 구역 안에서
       왼쪽 = 설명 글 / 오른쪽 = 「왜 그럴까?」·사진·영상
   으로 자리를 "고정"합니다.

   CSS 다단(columns)을 쓰지 않는 이유: 다단은 내용의 높이가 바뀌면 글을
   자동으로 재분배해서, 상자를 펼치는 순간 위에 있던 박스가 옆 단으로
   튀어 버립니다. 자리를 고정해 두면 펼쳐도 그 칸만 길어집니다.
----------------------------------------------------------- */
const SIDE_TYPES = ['why', 'photo', 'video'];              // 오른쪽 칸
const FULL_TYPES = ['fact', 'danger', 'compare', 'cards', 'sensorLab']; // 전체 폭

function buildBlocks(step) {
  const wrap = el('div', 'blocks');
  let sec = null;

  const newSection = () => {
    sec = el('div', 'secgrid');
    sec.appendChild(el('div', 'col-main'));
    sec.appendChild(el('div', 'col-side'));
    wrap.appendChild(sec);
  };
  newSection();

  step.blocks.forEach(b => {
    if (b.type === 'h' || FULL_TYPES.includes(b.type)) {
      wrap.appendChild(renderBlock(b));   // 전체 폭으로 두고 구역을 새로 연다
      newSection();
      return;
    }
    const col = SIDE_TYPES.includes(b.type) ? '.col-side' : '.col-main';
    $(col, sec).appendChild(renderBlock(b));
  });

  /* 빈 구역·빈 칸 정리 */
  $$('.secgrid', wrap).forEach(g => {
    const m = $('.col-main', g).children.length;
    const s = $('.col-side', g).children.length;
    if (!m && !s) { g.remove(); return; }
    if (!s) g.classList.add('noside');
    if (!m) g.classList.add('nomain');
  });
  return wrap;
}

/* -----------------------------------------------------------
   2-0. 사진 넣기
   images/ 폴더에 정해진 이름으로 사진을 넣어 두면 자동으로 그 사진이 보입니다.
   파일이 없으면 "어떤 사진이 필요한지" 설명이 담긴 빈 자리가 보입니다.
     사진 한 장:  { file: '이름.jpg', desc: '설명' }
     여러 장   :  { files: [{ file:'a.png', caption:'설명' }, ...] }
----------------------------------------------------------- */
function buildPhotoRow(b) {
  const items = (b.files && b.files.length)
    ? b.files
    : [{ file: b.file, caption: b.desc }];

  const row = el('div', items.length > 1 ? 'photorow' : 'photoone');
  items.forEach(it => {
    const cap = it.caption || b.desc || '';
    const slot = el('div', 'photoslot',
      `<div class="tag">📷 사진 자리 — images/${esc(it.file || '')}</div>
       <p class="desc">${esc(cap.replace(/\*\*/g, ''))}</p>`);
    if (it.file) {
      const img = new Image();
      img.alt = cap.replace(/\*\*/g, '');
      img.addEventListener('click', () => openLightbox(img.src));
      img.onload = () => {
        slot.innerHTML = '';
        slot.classList.add('filled');
        slot.appendChild(img);
        if (cap) slot.appendChild(el('p', 'caption', md(cap)));
      };
      img.src = 'images/' + it.file;
    }
    row.appendChild(slot);
  });
  return row;
}

/* -----------------------------------------------------------
   2-1. 유튜브 영상 넣기
   b.youtube  영상 ID (주소의 youtu.be/ 뒤 또는 watch?v= 뒤 부분)
   b.vcaption 영상 아래 설명 (없어도 됨)
----------------------------------------------------------- */
function videoEmbedHTML(b) {
  const id = String(b.youtube).trim();
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0&modestbranding=1`;
  return `<div class="video-embed">
      <div class="video-frame">
        <iframe data-src="${src}" title="${esc(b.vcaption || '설명 영상')}"
          allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="strict-origin-when-cross-origin" allowfullscreen loading="lazy"></iframe>
      </div>
      ${b.vcaption ? `<p class="video-caption">${md(b.vcaption)}</p>` : ''}
      <p class="video-fallback">영상이 안 보이나요? 인터넷 연결이 필요합니다.
        <a href="https://youtu.be/${encodeURIComponent(id)}" target="_blank" rel="noopener">유튜브에서 바로 보기 ↗</a></p>
    </div>`;
}

/** data-src 를 실제 src 로 바꿔 그때 영상을 불러옵니다 */
function loadVideos(root) {
  $$('iframe[data-src]', root).forEach(f => {
    f.src = f.dataset.src;
    f.removeAttribute('data-src');
  });
}

/* -----------------------------------------------------------
   3. 사진 업로드 영역
----------------------------------------------------------- */
function buildPhotoZone(stepId) {
  const wrap = el('div', 'photo-upload');
  wrap.innerHTML = `
    <div class="photo-actions">
      <button class="pbtn solid" data-act="camera">📸 사진 찍기</button>
      <button class="pbtn" data-act="file">🖼️ 사진 불러오기</button>
    </div>
    <p class="empty-note">아직 사진이 없어요. 실험 장면을 찍어서 남겨 봅시다!</p>
    <div class="thumbs"></div>
    <input type="file" accept="image/*" capture="environment" hidden data-input="camera">
    <input type="file" accept="image/*" multiple hidden data-input="file">
  `;
  const thumbs = $('.thumbs', wrap);
  const note = $('.empty-note', wrap);

  async function refresh() {
    const rows = await photoDB.byStep(stepId);
    thumbs.innerHTML = '';
    note.style.display = rows.length ? 'none' : '';
    rows.forEach(r => {
      const t = el('div', 'thumb');
      t.innerHTML = `<img src="${r.dataUrl}" alt="실험 사진"><button class="del" title="삭제">✕</button>`;
      $('img', t).addEventListener('click', () => openLightbox(r.dataUrl));
      $('.del', t).addEventListener('click', async () => {
        if (!confirm('이 사진을 지울까요?')) return;
        await photoDB.remove(r.id);
        refresh(); renderNav();
      });
      thumbs.appendChild(t);
    });
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    toast('사진을 저장하는 중…', 1200);
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const url = await shrinkImage(f, 1400, 0.82);
        await photoDB.add(stepId, url);
      } catch (e) { console.warn(e); toast('사진을 저장하지 못했습니다.'); }
    }
    await refresh();
    renderNav();
    toast('사진이 저장되었어요 ✓');
  }

  $$('[data-act]', wrap).forEach(btn => {
    btn.addEventListener('click', () => $(`[data-input="${btn.dataset.act}"]`, wrap).click());
  });
  $$('[data-input]', wrap).forEach(inp => {
    inp.addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
  });

  refresh();
  return wrap;
}

/* -----------------------------------------------------------
   4. 기록(서술형) 영역
----------------------------------------------------------- */
function buildRecordZone(step) {
  const zone = el('div', 'record-zone');
  zone.appendChild(el('h3', null, '✏️ 관찰한 것을 기록해요'));

  const card = el('div', 'card');
  step.records.forEach(r => {
    const q = el('div', 'qbox');
    q.innerHTML = `<label for="${r.id}">${esc(r.label)}</label>
                   <textarea id="${r.id}" placeholder="${esc(r.ph || '')}"></textarea>`;
    const ta = $('textarea', q);
    ta.value = store.get(r.id);
    let t = null;
    ta.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { store.answer(r.id, ta.value); renderNav(); }, 350);
    });
    card.appendChild(q);
  });
  zone.appendChild(card);

  if (step.photos) {
    zone.appendChild(el('h3', null, '📷 실험 사진 남기기'));
    const pc = el('div', 'card');
    pc.appendChild(buildPhotoZone(step.id));
    zone.appendChild(pc);
  }
  return zone;
}

/* -----------------------------------------------------------
   5. 그래프 그리기 (외부 라이브러리 없이 캔버스로 직접)
----------------------------------------------------------- */
function drawChart(canvas, points, opts) {
  opts = opts || {};
  const forPrint = !!opts.forPrint;
  const dpr = forPrint ? 2 : (window.devicePixelRatio || 1);
  const cssW = opts.width || canvas.clientWidth || 700;
  const cssH = opts.height || canvas.clientHeight || 320;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const css = getComputedStyle(document.documentElement);
  const cInk = forPrint ? '#10243a' : css.getPropertyValue('--ink').trim() || '#10243a';
  const cSoft = forPrint ? '#6b829a' : css.getPropertyValue('--ink-soft').trim() || '#6b829a';
  const cLine = forPrint ? '#dbe7f2' : css.getPropertyValue('--line').trim() || '#dbe7f2';
  const cBrand = '#0a7cc4';

  const pad = { l: 58, r: 16, t: 16, b: 40 };
  const W = cssW - pad.l - pad.r;
  const H = cssH - pad.t - pad.b;

  if (forPrint) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cssW, cssH); }

  if (!points.length) {
    ctx.fillStyle = cSoft;
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('측정을 시작하면 여기에 그래프가 그려집니다', cssW / 2, cssH / 2);
    return;
  }

  const xs = points.map(p => p.t), ys = points.map(p => p.v);
  let xMin = 0, xMax = Math.max(10, Math.max.apply(null, xs));
  let yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
  if (yMax - yMin < 5) { const m = (yMax + yMin) / 2; yMin = m - 3; yMax = m + 3; }
  const padY = (yMax - yMin) * 0.12;
  yMin -= padY; yMax += padY;

  const X = (t) => pad.l + (t - xMin) / (xMax - xMin || 1) * W;
  const Y = (v) => pad.t + H - (v - yMin) / (yMax - yMin || 1) * H;

  /* 눈금과 격자 */
  ctx.font = '12px system-ui, sans-serif';
  ctx.strokeStyle = cLine;
  ctx.lineWidth = 1;
  ctx.fillStyle = cSoft;

  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 5; i++) {
    const v = yMin + (yMax - yMin) * i / 5;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + W, y); ctx.stroke();
    ctx.fillText(v.toFixed(0) + '℃', pad.l - 8, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i <= 5; i++) {
    const t = xMin + (xMax - xMin) * i / 5;
    const x = X(t);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + H); ctx.stroke();
    ctx.fillText(t.toFixed(0), x, pad.t + H + 8);
  }
  ctx.fillText('시간 (초)', pad.l + W / 2, pad.t + H + 24);

  /* 0℃ 기준선 — 물이 어는 온도 */
  if (yMin < 0 && yMax > 0) {
    ctx.save();
    ctx.strokeStyle = '#e5484d'; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(pad.l, Y(0)); ctx.lineTo(pad.l + W, Y(0)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e5484d'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('0℃ (물이 어는 온도)', pad.l + 6, Y(0) - 4);
    ctx.restore();
  }

  /* 데이터 선 */
  ctx.strokeStyle = cBrand; ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  points.forEach((p, i) => { const x = X(p.t), y = Y(p.v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();

  /* 마지막 점 강조 */
  const last = points[points.length - 1];
  ctx.fillStyle = cBrand;
  ctx.beginPath(); ctx.arc(X(last.t), Y(last.v), 4.5, 0, Math.PI * 2); ctx.fill();

  /* 점 개수가 적으면 각 점 표시 (수동 입력 모드) */
  if (points.length <= 40) {
    points.forEach(p => { ctx.beginPath(); ctx.arc(X(p.t), Y(p.v), 3, 0, Math.PI * 2); ctx.fill(); });
  }

  ctx.fillStyle = cInk;
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('물의 냉각곡선', pad.l + 4, pad.t + 2);
}

/* -----------------------------------------------------------
   6. 센서 실험실 (버니어 Go Direct / 수동 입력)
----------------------------------------------------------- */
const lab = {
  device: null, sensor: null,
  points: [], recording: false, t0: 0,
  mode: 'sensor',
  manualRows: [['0', '']],
  node: null
};

function buildSensorLab() {
  const box = el('div', 'lab');
  box.innerHTML = `
    <h4>🌡️ 온도 측정 실험실</h4>
    <div class="tabs">
      <button class="tab active" data-mode="sensor">무선 센서로 측정</button>
      <button class="tab" data-mode="manual">직접 입력하기</button>
    </div>

    <div data-pane="sensor">
      <div class="lab-status">
        <span class="dot" id="lab-dot"></span>
        <span id="lab-msg">센서가 아직 연결되지 않았어요</span>
        <span class="live-temp" id="lab-live">—</span>
      </div>
      <div class="lab-buttons">
        <button class="pbtn solid" id="btn-connect">🔗 센서 연결하기</button>
        <button class="pbtn" id="btn-record" disabled>⏺ 측정 시작</button>
        <button class="pbtn" id="btn-clear">🗑 데이터 지우기</button>
      </div>
      <p class="hint" id="lab-hint"></p>
    </div>

    <div data-pane="manual" hidden>
      <p class="hint">센서가 없거나 연결이 안 될 때 사용해요. 시간(초)과 온도(℃)를 적으면 그래프가 바로 그려집니다.</p>
      <div class="lab-buttons">
        <button class="pbtn" id="btn-addrow">+ 줄 추가</button>
        <button class="pbtn" id="btn-usemanual">📊 이 값으로 그래프 그리기</button>
      </div>
      <div id="manual-wrap"></div>
    </div>

    <div id="chart-wrap"><canvas class="chart" id="chart"></canvas></div>
    <div class="lab-buttons" style="margin-top:12px">
      <button class="pbtn solid" id="btn-savedata">💾 이 데이터를 보고서에 담기</button>
      <span class="hint" id="save-info" style="align-self:center"></span>
    </div>
  `;
  lab.node = box;

  /* 저장해 둔 데이터가 있으면 되살리기 */
  if (store.data.dataset && store.data.dataset.points) lab.points = store.data.dataset.points.slice();

  setTimeout(() => {
    redrawLab();
    renderManualTable();
    updateSaveInfo();
    showBluetoothHint();
  }, 0);

  /* 탭 전환 */
  $$('.tab', box).forEach(t => t.addEventListener('click', () => {
    $$('.tab', box).forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    lab.mode = t.dataset.mode;
    $('[data-pane="sensor"]', box).hidden = lab.mode !== 'sensor';
    $('[data-pane="manual"]', box).hidden = lab.mode !== 'manual';
  }));

  $('#btn-connect', box).addEventListener('click', connectSensor);
  $('#btn-record', box).addEventListener('click', toggleRecording);
  $('#btn-clear', box).addEventListener('click', () => {
    if (!confirm('측정한 데이터를 모두 지울까요?')) return;
    lab.points = []; redrawLab();
  });
  $('#btn-addrow', box).addEventListener('click', () => {
    const lastT = parseFloat(lab.manualRows[lab.manualRows.length - 1][0]);
    lab.manualRows.push([isNaN(lastT) ? '' : String(lastT + 10), '']);
    renderManualTable();
  });
  $('#btn-usemanual', box).addEventListener('click', () => {
    const pts = lab.manualRows
      .map(r => ({ t: parseFloat(r[0]), v: parseFloat(r[1]) }))
      .filter(p => !isNaN(p.t) && !isNaN(p.v))
      .sort((a, b) => a.t - b.t);
    if (pts.length < 2) { toast('숫자를 2줄 이상 채워 주세요.'); return; }
    lab.points = pts; redrawLab();
    toast('그래프를 그렸어요 ✓');
  });
  $('#btn-savedata', box).addEventListener('click', () => {
    if (!lab.points.length) { toast('저장할 데이터가 없어요.'); return; }
    store.data.dataset = { points: lab.points.slice(), savedAt: Date.now(), source: lab.mode };
    store.save();
    updateSaveInfo();
    toast('보고서에 데이터를 담았어요 ✓');
    renderNav();
  });

  return box;
}

function showBluetoothHint() {
  const h = lab.node && $('#lab-hint', lab.node);
  if (!h) return;
  if (!navigator.bluetooth) {
    h.innerHTML = '⚠️ 이 브라우저에서는 무선 센서 연결이 안 됩니다. <b>크롬(Chrome)</b> 또는 <b>엣지(Edge)</b>로 열어 주세요. ' +
      '(아이패드 사파리는 지원하지 않습니다) 그동안에는 <b>「직접 입력하기」</b> 탭을 사용하세요.';
  } else if (typeof window.godirect === 'undefined') {
    h.innerHTML = '⚠️ 센서 라이브러리(godirect.js)를 찾지 못했습니다. 파일이 같은 폴더에 있는지 확인해 주세요.';
  } else if (!window.isSecureContext) {
    h.innerHTML = '⚠️ 파일을 직접 열면 블루투스를 쓸 수 없습니다. <b>시작.bat</b> 으로 실행해 주세요.';
  } else {
    h.innerHTML = '센서 전원을 켜고 [센서 연결하기]를 누른 뒤, 목록에서 <b>GDX-</b>로 시작하는 기기를 선택하세요.';
  }
}

function labStatus(msg, state) {
  if (!lab.node) return;
  $('#lab-msg', lab.node).textContent = msg;
  const dot = $('#lab-dot', lab.node);
  dot.className = 'dot' + (state ? ' ' + state : '');
}

async function connectSensor() {
  if (!navigator.bluetooth) { toast('이 브라우저는 블루투스를 지원하지 않아요.'); showBluetoothHint(); return; }
  if (typeof window.godirect === 'undefined') { toast('godirect.js 파일이 없습니다.'); return; }

  labStatus('센서를 찾는 중…', 'busy');
  try {
    const device = await window.godirect.selectDevice(true);
    lab.device = device;

    /* 온도 센서 고르기 — 단위가 ℃ 인 것 우선 */
    const sensors = device.sensors || [];
    let s = sensors.find(x => x.enabled && /C$/i.test((x.unit || '').trim()))
         || sensors.find(x => /온도|temp/i.test(x.name || ''))
         || sensors.find(x => x.enabled)
         || sensors[0];
    if (!s) throw new Error('사용할 수 있는 센서를 찾지 못했습니다.');
    lab.sensor = s;
    if (!s.enabled) s.setEnabled(true);

    try { device.start(1000); } catch (e) { console.warn('측정 주기 설정 실패', e); }

    s.on('value-changed', (sensor) => {
      const v = sensor.value;
      if (typeof v !== 'number' || isNaN(v)) return;
      const live = lab.node && $('#lab-live', lab.node);
      if (live) live.textContent = v.toFixed(1) + ' ℃';
      if (lab.recording) {
        lab.points.push({ t: (Date.now() - lab.t0) / 1000, v });
        redrawLab();
      }
    });

    device.on('device-closed', () => {
      labStatus('센서 연결이 끊어졌어요', '');
      lab.recording = false;
      if (lab.node) {
        $('#btn-record', lab.node).disabled = true;
        $('#btn-record', lab.node).textContent = '⏺ 측정 시작';
      }
    });

    labStatus(`${device.name || '센서'} 연결됨 (${s.name} · ${s.unit})`, 'on');
    $('#btn-record', lab.node).disabled = false;
    toast('센서가 연결되었어요 ✓');
  } catch (e) {
    console.warn(e);
    labStatus('연결하지 못했어요. 다시 시도해 주세요.', '');
    if (e && /cancel|User cancelled/i.test(e.message || '')) return;
    toast('연결 실패: 센서 전원과 블루투스를 확인해 주세요.');
  }
}

function toggleRecording() {
  const btn = $('#btn-record', lab.node);
  if (!lab.recording) {
    lab.recording = true;
    lab.t0 = Date.now();
    lab.points = [];
    btn.textContent = '⏹ 측정 끝내기';
    btn.classList.add('solid');
    labStatus('측정 중…  물을 액화질소에 담가 보세요!', 'busy');
    toast('측정을 시작했어요!');
  } else {
    lab.recording = false;
    btn.textContent = '⏺ 측정 시작';
    btn.classList.remove('solid');
    labStatus(`측정 끝 (${lab.points.length}개 기록됨)`, 'on');
    toast('측정을 마쳤어요. [보고서에 담기]를 눌러 저장하세요!');
  }
  redrawLab();
}

function redrawLab() {
  if (!lab.node) return;
  const c = $('#chart', lab.node);
  if (c) drawChart(c, lab.points);
}

function renderManualTable() {
  if (!lab.node) return;
  const wrap = $('#manual-wrap', lab.node);
  if (!wrap) return;
  const t = el('table', 'manual-table');
  t.innerHTML = '<thead><tr><th style="width:44px">#</th><th>시간 (초)</th><th>온도 (℃)</th></tr></thead>';
  const tb = el('tbody');
  lab.manualRows.forEach((row, i) => {
    const tr = el('tr');
    tr.innerHTML = `<td>${i + 1}</td>
      <td><input type="number" step="any" value="${esc(row[0])}" data-i="${i}" data-c="0"></td>
      <td><input type="number" step="any" value="${esc(row[1])}" data-i="${i}" data-c="1"></td>`;
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  wrap.innerHTML = '';
  wrap.appendChild(t);
  $$('input', t).forEach(inp => {
    inp.addEventListener('input', () => {
      lab.manualRows[+inp.dataset.i][+inp.dataset.c] = inp.value;
    });
  });
}

function updateSaveInfo() {
  if (!lab.node) return;
  const n = $('#save-info', lab.node);
  const d = store.data.dataset;
  n.textContent = d ? `보고서에 ${d.points.length}개 값이 담겨 있어요 ✓` : '아직 보고서에 담지 않았어요';
}

/* -----------------------------------------------------------
   7. 화면들 — 시작 / 쉬는 시간 / 보고서
----------------------------------------------------------- */
function renderIntro(main) {
  const p = store.data.profile;
  const head = el('div', 'step-head');
  head.innerHTML = `
    <span class="eyebrow">❄️ 여름방학 과학탐구 캠프</span>
    <h1>극저온의 세계</h1>
    <p class="sub">−196℃, 우리가 한 번도 가보지 못한 아주 차가운 세상으로 떠나 봅시다.</p>`;
  main.appendChild(head);

  const c1 = el('div', 'card');
  c1.innerHTML = `
    <h3 style="margin-top:0">먼저 내 정보를 적어 주세요</h3>
    <div class="field-grid">
      <div class="field"><label for="p-name">이름</label><input type="text" id="p-name" placeholder="예) 김과학"></div>
      <div class="field"><label for="p-school">학교</label><input type="text" id="p-school" placeholder="예) ○○중학교"></div>
      <div class="field"><label for="p-grade">학년 / 반</label><input type="text" id="p-grade" placeholder="예) 2학년 3반"></div>
      <div class="field"><label for="p-team">모둠</label><input type="text" id="p-team" placeholder="예) 3모둠"></div>
    </div>
    <label class="agree">
      <input type="checkbox" id="p-agree">
      <span><b>안전 약속</b><br>선생님의 안내를 잘 듣고, 장난치지 않고, 안전하게 실험하겠습니다.
      액화질소는 아주 차갑고 위험할 수 있다는 것을 이해했습니다.</span>
    </label>`;
  main.appendChild(c1);

  const map = { 'p-name': 'name', 'p-school': 'school', 'p-grade': 'grade', 'p-team': 'team' };
  Object.keys(map).forEach(id => {
    const inp = $('#' + id, c1);
    inp.value = p[map[id]] || '';
    inp.addEventListener('input', () => { p[map[id]] = inp.value; store.save(); renderNav(); });
  });
  const ag = $('#p-agree', c1);
  ag.checked = !!store.data.agreed;
  ag.addEventListener('change', () => { store.data.agreed = ag.checked; store.save(); });

  const c2 = el('div', 'card');
  const rows = STEPS.filter(s => s.id !== 'intro').map(s =>
    `<tr><td>${s.icon}</td><td>${esc(s.title)}</td><td>${s.minutes}분</td></tr>`).join('');
  c2.innerHTML = `<h3 style="margin-top:0">오늘의 흐름 (총 ${totalTimeText()})</h3>
    <table class="timetable"><tbody>${rows}</tbody></table>`;
  main.appendChild(c2);

  const c3 = el('div', 'danger');
  c3.innerHTML = `<h4>⚠️ 시작하기 전에 꼭 기억해요</h4>
    <ul>
      <li>액화질소는 <b>−196℃</b>로 아주 차갑습니다. 절대 장난치지 않습니다.</li>
      <li>모든 실험은 <b>선생님의 안내</b>에 따라서만 합니다.</li>
      <li>보안경을 쓰고, 반지·시계·팔찌는 미리 뺍니다.</li>
      <li>액화질소가 몸이나 옷에 고이면 즉시 털어내고 선생님께 알립니다.</li>
    </ul>`;
  main.appendChild(c3);
}

function renderBreak(main, step) {
  const mins = step.minutes || 10;
  const next = STEPS[STEPS.indexOf(step) + 1];

  const head = el('div', 'step-head');
  head.innerHTML = `<span class="eyebrow">☕ 잠깐 쉬어요 · ${mins}분</span>
    <h1>${esc(step.title)}</h1>
    <p class="sub">화장실 다녀오고, 물 마시고, 손을 따뜻하게 녹여 주세요.</p>`;
  main.appendChild(head);

  const mm = String(mins).padStart(2, '0');
  const w = el('div', 'card');
  w.innerHTML = `<div class="breakwrap">
      <div class="bigtimer" id="bt">${mm}:00</div>
      <div class="lab-buttons" style="justify-content:center">
        <button class="pbtn solid" id="bt-start">▶ 시작</button>
        <button class="pbtn" id="bt-reset">↺ ${mins}분으로</button>
      </div>
      ${next ? `<p class="hint" style="margin-top:18px">쉬는 시간이 끝나면
        <b>${esc(next.title)}</b>가 이어집니다 ${next.icon}</p>` : ''}
    </div>`;
  main.appendChild(w);

  const disp = $('#bt', w);
  let left = mins * 60, id = null;
  const paint = () => {
    const m = String(Math.floor(Math.abs(left) / 60)).padStart(2, '0');
    const s = String(Math.abs(left) % 60).padStart(2, '0');
    disp.textContent = (left < 0 ? '-' : '') + m + ':' + s;
    disp.classList.toggle('done', left <= 0);
  };
  $('#bt-start', w).addEventListener('click', (e) => {
    if (id) { clearInterval(id); id = null; e.target.textContent = '▶ 계속'; return; }
    e.target.textContent = '⏸ 멈춤';
    id = setInterval(() => { left--; paint(); if (left === 0) toast('쉬는 시간이 끝났어요!', 4000); }, 1000);
  });
  $('#bt-reset', w).addEventListener('click', () => {
    clearInterval(id); id = null; left = mins * 60; paint();
    $('#bt-start', w).textContent = '▶ 시작';
  });
  paint();
  breakCleanup = () => clearInterval(id);
}
let breakCleanup = null;

/* -----------------------------------------------------------
   8. 보고서
----------------------------------------------------------- */
async function renderReport(main) {
  const head = el('div', 'step-head no-print');
  head.innerHTML = `<span class="eyebrow">📄 마지막 단계</span>
    <h1>나의 탐구 보고서</h1>
    <p class="sub">오늘 쓴 기록과 찍은 사진이 자동으로 정리되었어요. PDF로 저장해서 메일로 보내 봅시다.</p>`;
  main.appendChild(head);

  /* 조작 버튼 */
  const ctrl = el('div', 'card no-print');
  ctrl.innerHTML = `
    <h3 style="margin-top:0">1) 보고서를 PDF로 저장하기</h3>
    <p class="hint" style="margin-top:0">아래 버튼을 누르면 인쇄 창이 열립니다.
      프린터 선택에서 <b>「PDF로 저장」</b>을 고른 뒤 저장하세요.</p>
    <div class="lab-buttons">
      <button class="pbtn solid" id="btn-print">🖨️ PDF로 저장하기</button>
    </div>

    <h3>2) 저장한 PDF를 메일로 보내기</h3>
    <p class="hint" style="margin-top:0">받을 메일 주소를 적고 버튼을 누르면 메일 앱이 열립니다.
      열린 메일에 <b>방금 저장한 PDF 파일을 첨부</b>한 뒤 보내면 끝!</p>
    <div class="email-row">
      <div class="field" style="margin:0">
        <label for="mailto">받는 사람 메일 주소</label>
        <input type="email" id="mailto" placeholder="예) mine@example.com">
      </div>
      <button class="pbtn solid" id="btn-mail">✉️ 메일 앱 열기</button>
      <button class="pbtn" id="btn-copy">📋 내용 복사</button>
    </div>

    <h3>3) 다 끝냈다면</h3>
    <p class="hint" style="margin-top:0">여러 학생이 같은 기기를 쓴다면, 다음 학생을 위해 기록을 지워 주세요.
      <b>PDF를 먼저 저장했는지 꼭 확인하세요!</b></p>
    <div class="lab-buttons">
      <button class="pbtn" id="btn-reset-all" style="border-color:#e5484d;color:#e5484d">🧹 모두 지우고 새로 시작</button>
    </div>`;
  main.appendChild(ctrl);

  const paper = el('div', 'report-paper');
  paper.id = 'report-paper';
  main.appendChild(paper);
  await buildReportPaper(paper);

  const mailInput = $('#mailto', ctrl);
  mailInput.value = store.data.profile.email || '';
  mailInput.addEventListener('input', () => {
    store.data.profile.email = mailInput.value; store.save();
  });

  $('#btn-print', ctrl).addEventListener('click', () => window.print());

  $('#btn-mail', ctrl).addEventListener('click', () => {
    const to = mailInput.value.trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { toast('메일 주소를 바르게 적어 주세요.'); return; }
    const p = store.data.profile;
    const subject = `[극저온의 세계] ${p.name || '학생'}의 탐구 보고서`;
    const body = reportAsText() +
      '\n\n────────────────\n※ 저장한 PDF 파일을 이 메일에 첨부해서 보내 주세요.\n';
    window.location.href =
      `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    toast('메일 앱을 열었어요. PDF 파일을 첨부해 주세요!', 4000);
  });

  $('#btn-copy', ctrl).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(reportAsText()); toast('보고서 내용을 복사했어요 ✓'); }
    catch (e) { toast('복사하지 못했어요.'); }
  });

  $('#btn-reset-all', ctrl).addEventListener('click', async () => {
    if (!confirm('정말 모두 지울까요?\n\n적은 내용과 사진이 전부 사라집니다.\nPDF를 먼저 저장했는지 확인하세요!')) return;
    if (!confirm('한 번 더 확인합니다. 정말 지울까요?')) return;
    store.clearAll();
    await photoDB.clear();
    state.current = 0;
    render();
    toast('모두 지웠어요. 새로 시작할 수 있습니다.');
  });
}

async function buildReportPaper(paper) {
  const p = store.data.profile;
  const today = new Date();
  const dateStr = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;

  let html = `
    <div class="rp-title">
      <h1>❄️ 극저온의 세계</h1>
      <p>여름방학 과학탐구 캠프 · 탐구 보고서</p>
    </div>
    <div class="rp-meta">
      <div><b>이름</b>${esc(p.name) || '&nbsp;'}</div>
      <div><b>학교</b>${esc(p.school) || '&nbsp;'}</div>
      <div><b>학년 / 반</b>${esc(p.grade) || '&nbsp;'}</div>
      <div><b>모둠</b>${esc(p.team) || '&nbsp;'}</div>
      <div><b>날짜</b>${dateStr}</div>
    </div>`;

  const allPhotos = await photoDB.all();

  for (const step of STEPS) {
    if (!step.records || !step.records.length) continue;
    const answers = step.records.map(r => ({ q: r.label, a: store.get(r.id) }));
    const photos = allPhotos.filter(x => x.stepId === step.id);
    const hasAny = answers.some(a => a.a.trim()) || photos.length;

    html += `<div class="rp-sec">
      <h2>${step.icon} ${esc(step.title)}</h2>`;
    answers.forEach(a => {
      html += `<div class="rp-q">
        <div class="q">${esc(a.q)}</div>
        <div class="a${a.a.trim() ? '' : ' blank'}">${a.a.trim() ? esc(a.a) : '(적지 않음)'}</div>
      </div>`;
    });

    /* 냉각곡선 그래프는 실험 단계에 붙임 */
    if (step.id === 's5' && store.data.dataset && store.data.dataset.points.length) {
      const pts = store.data.dataset.points;
      const c = document.createElement('canvas');
      drawChart(c, pts, { forPrint: true, width: 640, height: 300 });
      html += `<div style="margin-top:10px"><img src="${c.toDataURL('image/png')}" style="width:100%;border:1px solid #d6e6f5;border-radius:8px" alt="냉각곡선 그래프"></div>`;

      /* 데이터 표 — 너무 길면 골라서 20개만 */
      const stepN = Math.max(1, Math.ceil(pts.length / 20));
      const picked = pts.filter((_, i) => i % stepN === 0).slice(0, 20);
      html += `<table class="rp-datatable"><tr><th>시간(초)</th>${picked.map(x => `<td>${x.t.toFixed(0)}</td>`).join('')}</tr>
               <tr><th>온도(℃)</th>${picked.map(x => `<td>${x.v.toFixed(1)}</td>`).join('')}</tr></table>`;
    }

    if (photos.length) {
      html += `<div class="rp-photos">${photos.map(x => `<img src="${x.dataUrl}" alt="실험 사진">`).join('')}</div>`;
    }
    if (!hasAny) html += `<div class="rp-q"><div class="a blank">이 단계는 기록이 없습니다.</div></div>`;
    html += `</div>`;
  }

  paper.innerHTML = html;
}

function reportAsText() {
  const p = store.data.profile;
  let out = `[극저온의 세계] 탐구 보고서\n`;
  out += `이름: ${p.name || ''} / 학교: ${p.school || ''} / 학년반: ${p.grade || ''} / 모둠: ${p.team || ''}\n`;
  out += `\n`;
  STEPS.forEach(step => {
    if (!step.records) return;
    const filled = step.records.filter(r => store.get(r.id).trim());
    if (!filled.length) return;
    out += `■ ${step.title}\n`;
    filled.forEach(r => { out += `Q. ${r.label}\nA. ${store.get(r.id).trim()}\n\n`; });
  });
  const d = store.data.dataset;
  if (d && d.points.length) {
    out += `■ 물의 냉각곡선 측정 데이터 (${d.points.length}개)\n`;
    const stepN = Math.max(1, Math.ceil(d.points.length / 20));
    d.points.filter((_, i) => i % stepN === 0).slice(0, 20)
      .forEach(x => { out += `${x.t.toFixed(0)}초 : ${x.v.toFixed(1)}℃\n`; });
  }
  return out;
}

/* -----------------------------------------------------------
   9. 전체 렌더링 & 이동
----------------------------------------------------------- */
const state = { current: 0 };

/** 쉬는 시간·시작·보고서를 뺀 「몇 번째 배우는 단계인지」 (순서를 바꿔도 번호가 맞습니다) */
function lessonNumber(step) {
  return STEPS.filter(s => s.blocks).indexOf(step) + 1;
}

/** 전체 수업 시간을 "2시간 35분" 처럼 표시 */
function totalTimeText() {
  const t = STEPS.reduce((a, s) => a + (s.minutes || 0), 0);
  const h = Math.floor(t / 60), m = t % 60;
  return (h ? h + '시간 ' : '') + (m ? m + '분' : '').trim() || t + '분';
}

function stepDone(step) {
  if (step.id === 'intro') return !!(store.data.profile.name && store.data.agreed);
  if (!step.records) return false;
  return step.records.some(r => store.get(r.id).trim().length > 0);
}

function renderNav() {
  const nav = $('#stepnav');
  nav.innerHTML = '';
  STEPS.forEach((s, i) => {
    const rest = s.type === 'break';
    const cls = 'snav'
      + (i === state.current ? ' active' : '')
      + (stepDone(s) ? ' done' : '')
      + (rest ? ' rest' : '');
    const b = el('button', cls);
    b.innerHTML = `<span class="snum"><span>${rest ? s.icon : (s.blocks ? lessonNumber(s) : s.icon)}</span></span>
      <span class="stitle">${esc(s.title)}</span>
      <span class="smin">${s.minutes}분</span>`;
    b.addEventListener('click', () => { go(i); closeDrawer(); });
    nav.appendChild(b);
  });
  renderProgress();
  /* 현재 단계 버튼을 가운데로 — 단계 바만 가로로 움직이고 페이지는 건드리지 않음
     (scrollIntoView 를 쓰면 페이지가 세로로 함께 끌려 내려갑니다) */
  /* 현재 단계가 사이드바 밖으로 밀려 있으면 보이는 곳으로 */
  const active = $('.snav.active', nav);
  const side = $('#sidebar');
  if (active && side) {
    const a = active.getBoundingClientRect(), s = side.getBoundingClientRect();
    if (a.top < s.top + 8 || a.bottom > s.bottom - 8) {
      side.scrollTop += a.top - s.top - side.clientHeight / 2;
    }
  }
}

/** 사이드바의 진도 막대 — 기록을 남긴 단계 비율 */
function renderProgress() {
  const lessons = STEPS.filter(s => s.records && s.records.length);
  const done = lessons.filter(stepDone).length;
  const pct = lessons.length ? Math.round(done / lessons.length * 100) : 0;

  const p = $('#sp-percent'), f = $('#sp-fill'), sub = $('#sp-sub'), tot = $('#sp-total');
  if (p) p.textContent = pct + '%';
  if (f) f.style.width = pct + '%';
  if (sub) {
    sub.textContent = pct === 0 ? '아직 시작 전이에요'
      : pct === 100 ? '모든 기록을 마쳤어요! 🎉'
      : `${lessons.length}개 중 ${done}개 단계를 기록했어요`;
  }
  if (tot) tot.textContent = totalTimeText();
}

/* --- 휴대폰용 서랍 --- */
function openDrawer() {
  document.body.classList.add('nav-open');
  $('#scrim').hidden = false;
  $('#btn-menu').setAttribute('aria-expanded', 'true');
}
function closeDrawer() {
  if (!document.body.classList.contains('nav-open')) return;
  document.body.classList.remove('nav-open');
  $('#scrim').hidden = true;
  $('#btn-menu').setAttribute('aria-expanded', 'false');
}

function render() {
  if (breakCleanup) { breakCleanup(); breakCleanup = null; }
  lab.node = null;

  const main = $('#app');
  main.innerHTML = '';
  const step = STEPS[state.current];

  if (step.type === 'intro') renderIntro(main);
  else if (step.type === 'break') renderBreak(main, step);
  else if (step.type === 'report') renderReport(main);
  else {
    const head = el('div', 'step-head');
    head.innerHTML = `<span class="eyebrow">${step.icon} ${lessonNumber(step)}단계 · ${step.minutes}분</span>
      <h1>${esc(step.title)}</h1>
      ${step.subtitle ? `<p class="sub">${esc(step.subtitle)}</p>` : ''}`;
    main.appendChild(head);
    main.appendChild(buildBlocks(step));
    if (step.records && step.records.length) main.appendChild(buildRecordZone(step));
  }

  $('#btn-prev').disabled = state.current === 0;
  $('#btn-next').disabled = state.current === STEPS.length - 1;
  $('#btn-next').textContent = state.current === STEPS.length - 2 ? '보고서 만들기 ›' : '다음 ›';
  renderNav();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function go(i) {
  state.current = Math.max(0, Math.min(STEPS.length - 1, i));
  try { localStorage.setItem('cryoCamp.step', String(state.current)); } catch (e) { /* 무시 */ }
  render();
}

/* -----------------------------------------------------------
   10. 상단 타이머 · 테마 · 확대보기
----------------------------------------------------------- */
function initTheme() {
  const btns = $$('.js-theme');
  const paint = (t) => btns.forEach(b => {
    b.textContent = b.classList.contains('sbtn')
      ? (t === 'dark' ? '☀️ 화면' : '🌙 화면')
      : (t === 'dark' ? '☀️' : '🌙');
  });

  const saved = localStorage.getItem('cryoCamp.theme') || 'light';
  document.documentElement.dataset.theme = saved;
  paint(saved);

  btns.forEach(b => b.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('cryoCamp.theme', next);
    paint(next);
    redrawLab();
  }));
}

function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').hidden = false;
}
function initLightbox() {
  const lb = $('#lightbox');
  lb.addEventListener('click', () => { lb.hidden = true; });
}

/* -----------------------------------------------------------
   11. 시작!
----------------------------------------------------------- */
function init() {
  store.load();
  initTheme();
  initLightbox();

  $('#btn-prev').addEventListener('click', () => go(state.current - 1));
  $('#btn-next').addEventListener('click', () => go(state.current + 1));
  $('#btn-menu').addEventListener('click', () => {
    document.body.classList.contains('nav-open') ? closeDrawer() : openDrawer();
  });
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowRight') go(state.current + 1);
    if (e.key === 'ArrowLeft') go(state.current - 1);
  });
  window.addEventListener('resize', () => { redrawLab(); if (innerWidth >= 1024) closeDrawer(); });

  photoDB.open().catch(e => console.warn('사진 저장소를 열지 못했습니다.', e));

  /* 새로고침해도 보던 단계로 돌아오게 */
  const saved = parseInt(localStorage.getItem('cryoCamp.step'), 10);
  if (!isNaN(saved) && saved >= 0 && saved < STEPS.length) state.current = saved;
  render();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
