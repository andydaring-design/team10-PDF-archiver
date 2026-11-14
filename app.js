import * as pdfjsLib from './lib/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');
const DOC_OPTS = {
  cMapUrl: chrome.runtime.getURL('lib/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: chrome.runtime.getURL('lib/standard_fonts/'),
  isEvalSupported: false // extension pages do not allow eval
};
const { OPS, ImageKind } = pdfjsLib;

// Chrome's canvas limits: no side above 32767 px, no more than ~268 million pixels.
const MAX_SIDE = 16384, MAX_AREA = 16384 * 16384;
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

const $ = id => document.getElementById(id);
const sources = [];          // { name, size, pages, w, h, load(): Promise<Uint8Array> }
window.__t10 = { get sources() { return sources; } }; // for checking from the developer tools
let dirHandle = null;        // folder chosen by the user (File System Access API)
let cancelled = false, busy = false;
const HAS_PICKER = typeof window.showDirectoryPicker === 'function';

/* ------------------------------------------------------------------ small helpers */
const fmtBytes = b => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const showErr = m => { $('err').textContent = m || ''; };
const baseName = n => n.replace(/\.pdf$/i, '');
// Safe for Windows / macOS / Linux file names
const clean = s => (s || '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || 'pdf';
function log(line) { const l = $('log'); l.hidden = false; l.textContent += line + '\n'; l.scrollTop = l.scrollHeight; }

/* ------------------------------------------------------------------ options (remembered between uses) */
const OPT_IDS = ['mode', 'pages', 'format', 'quality', 'sizeMode', 'sizeVal', 'bg', 'minSize', 'prefix', 'pad', 'subfolder', 'exists', 'dlFolder', 'alsoPdf'];
function readOpts() {
  const o = {};
  for (const id of OPT_IDS) o[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  o.dest = document.querySelector('input[name=dest]:checked').value;
  return o;
}
function saveOpts() { chrome.storage.local.set({ opts: readOpts() }); }
async function loadOpts() {
  const { opts } = await chrome.storage.local.get('opts');
  if (!opts) return;
  for (const id of OPT_IDS) if (id in opts) { if ($(id).type === 'checkbox') $(id).checked = opts[id]; else $(id).value = opts[id]; }
  const r = document.querySelector(`input[name=dest][value="${opts.dest}"]`); if (r) r.checked = true;
}

const DEFAULT_SIZE = { dpi: 150, width: 1920, height: 1080, longest: 2000 };
let lastSizeMode = null;
function syncUi() {
  const o = readOpts(), embedded = o.mode === 'embedded';
  // "Original size" only makes sense for pictures; DPI only for pages
  $('sizeMode').querySelector('[value=dpi]').hidden = embedded;
  $('sizeMode').querySelector('[value=original]').hidden = !embedded;
  if (embedded && o.sizeMode === 'dpi') $('sizeMode').value = 'original';
  if (!embedded && o.sizeMode === 'original') $('sizeMode').value = 'dpi';
  const sm = $('sizeMode').value;
  if (lastSizeMode && sm !== lastSizeMode && DEFAULT_SIZE[sm]) $('sizeVal').value = DEFAULT_SIZE[sm];
  lastSizeMode = sm;
  $('sizeValBox').hidden = sm === 'original';
  $('sizeValLabel').textContent = { dpi: 'DPI (150 = screen, 300 = print quality)', width: 'Width (px)', height: 'Height (px)', longest: 'Longest side (px)' }[sm] || '';
  $('sizeVal').setAttribute('list', sm === 'dpi' ? 'dpiList' : '');
  $('qualityBox').hidden = o.format === 'png';
  $('qualityOut').textContent = $('quality').value;
  $('bgBox').hidden = embedded;
  $('bg').querySelector('[value=transparent]').disabled = o.format === 'jpeg';
  if (o.format === 'jpeg') $('bg').value = 'white';
  $('minBox').hidden = !embedded;
  $('pad').parentElement.lastChild.textContent = embedded
    ? ' Pad page numbers (p007 instead of p7) so files sort in order'
    : ' Pad page numbers (page-007 instead of page-7) so files sort in order';
  $('destFolder').hidden = o.dest !== 'folder';
  $('destDownloads').hidden = o.dest !== 'downloads';
  updateSizeHint();
  updateStart();
}
function updateStart() {
  const o = readOpts();
  $('start').disabled = busy || !sources.length || (o.dest === 'folder' && !dirHandle);
  $('start').textContent = !sources.length ? 'Add a PDF first'
    : o.dest === 'folder' && !dirHandle ? 'Choose a folder first'
    : `Convert ${sources.length === 1 ? 'the PDF' : sources.length + ' PDFs'}`;
}

/* ------------------------------------------------------------------ sizes */
// Scale factor (1 = 72 DPI) that turns a page of w x h points into the size asked for.
function pageScale(o, w, h) {
  const v = Math.max(1, Number(o.sizeVal) || 0);
  switch (o.sizeMode) {
    case 'width': return v / w;
    case 'height': return v / h;
    case 'longest': return v / Math.max(w, h);
    default: return v / 72; // dpi
  }
}
// Keeps the image inside what Chrome can draw. Returns { scale, limited }.
function clampScale(scale, w, h) {
  let s = scale;
  if (w * s > MAX_SIDE) s = MAX_SIDE / w;
  if (h * s > MAX_SIDE) s = MAX_SIDE / h;
  if (w * s * h * s > MAX_AREA) s = Math.sqrt(MAX_AREA / (w * h));
  return { scale: s, limited: s < scale - 1e-9 };
}
function updateSizeHint() {
  const o = readOpts(), first = sources[0];
  if (first && first.kind === 'shots') { $('sizeHint').textContent = `"${first.name}": ${first.perPage ? 'pages are' : 'the image is'} ${first.w} × ${first.h} pixels. "Resolution (DPI)" keeps that size; a width in pixels resizes it.`; return; }
  if (!first || o.mode !== 'pages') { $('sizeHint').textContent = o.mode === 'embedded' ? 'Pictures are re-saved in the format you choose; vector drawings and text are not pictures, so use "Each page as an image" for those.' : ''; return; }
  const { scale, limited } = clampScale(pageScale(o, first.w, first.h), first.w, first.h);
  $('sizeHint').textContent = `Page 1 of "${first.name}" will be ${Math.round(first.w * scale)} × ${Math.round(first.h * scale)} pixels`
    + ` (${Math.round(scale * 72)} DPI).` + (limited ? ' That is the largest size Chrome can draw, so it has been reduced.' : '');
}

/* ------------------------------------------------------------------ page ranges */
// "1-3, 5, 8-" -> [1,2,3,5,8,...,n]. Empty -> all pages.
function parseRange(text, n) {
  const t = (text || '').trim();
  if (!t || /^all$/i.test(t)) return Array.from({ length: n }, (_, i) => i + 1);
  const set = new Set();
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/) || part.match(/^(\d+)$/);
    if (!m) throw new Error(`"${part}" is not a page number or range. Use e.g. 1-3, 5, 8-`);
    let a, b;
    if (m.length === 2) a = b = +m[1];
    else { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : n; }
    if (a > b) [a, b] = [b, a];
    for (let p = Math.max(1, a); p <= Math.min(n, b); p++) set.add(p);
  }
  return [...set].sort((x, y) => x - y);
}

/* ------------------------------------------------------------------ opening PDFs */
async function openPdf(data, name) {
  const task = pdfjsLib.getDocument({ ...DOC_OPTS, data });
  task.onPassword = (update, reason) => {
    const p = prompt(`"${name}" is password protected.${reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? '\nThat password was not right.' : ''}\nEnter the password:`);
    if (p === null) task.destroy(); else update(p);
  };
  return task.promise;
}

// Adds a PDF (its bytes) to the list. Throws if it is not a readable PDF.
async function addSource(name, data, url) {
  if (String.fromCharCode(...data.subarray(0, 1024)).indexOf('%PDF') < 0) throw new Error('it is not a PDF');
  let doc;
  try { doc = await openPdf(data.slice(), name); } // pdf.js takes the buffer over, so give it a copy
  catch (e) { throw new Error(e && e.name === 'PasswordException' ? 'no password given' : (e.message || String(e))); }
  const vp = (await doc.getPage(1)).getViewport({ scale: 1 }), pages = doc.numPages;
  await doc.destroy();
  sources.push({ name, url, size: data.length, pages, w: vp.width, h: vp.height, load: async () => data.slice() });
  renderFiles();
}

function renderFiles() {
  const ul = $('files'); ul.textContent = '';
  sources.forEach((s, i) => {
    const li = document.createElement('li');
    const nm = Object.assign(document.createElement('span'), { className: 'nm', textContent: s.name, title: s.url || '' });
    const info = Object.assign(document.createElement('small'), { textContent: s.kind === 'shots' ? (s.perPage ? `${s.pages} page${s.pages === 1 ? '' : 's'} · screen capture` : `${s.pages === 1 ? 'one long image' : s.pages + ' long images'} · ${s.w} px wide`) : `${s.pages} page${s.pages === 1 ? '' : 's'} · ${fmtBytes(s.size)}` });
    const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: 'Remove' });
    x.addEventListener('click', () => { if (busy) return; sources.splice(i, 1); renderFiles(); listOpenPdfs(); });
    const pdfBtn = Object.assign(document.createElement('button'), { className: 'alt small', textContent: 'Save PDF',
      title: s.kind === 'shots' ? 'Save this screen capture as a PDF file' : 'Save this PDF file as it is' });
    pdfBtn.addEventListener('click', () => savePdfNow(s, pdfBtn));
    li.append(nm, info, pdfBtn, x); ul.append(li);
  });
  $('noPdf').hidden = sources.length > 0;
  updateSizeHint(); updateStart(); updateCurTab().catch(() => {});
}

async function addFiles(files) {
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { showErr(`"${f.name}" is not a PDF file.`); continue; }
    try { await addSource(f.name, new Uint8Array(await f.arrayBuffer())); }
    catch (e) { showErr(`Could not open "${f.name}": ${e.message}`); }
  }
}

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => { showErr(''); await addFiles([...$('file').files]); $('file').value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) drop.classList.remove('over'); }));
document.addEventListener('drop', e => { showErr(''); addFiles([...(e.dataTransfer && e.dataTransfer.files || [])]); });

/* ------------------------------------------------------------------ PDFs open in the browser */
// The address of the PDF a tab is showing. Chrome's own viewer keeps the PDF's address in the tab;
// pdf.js-style web viewers (…/viewer.html?file=…) carry it in the address.
function pdfUrlOf(raw) {
  try {
    const u = new URL(raw);
    const f = u.searchParams.get('file');
    if (f && /\.pdf\b/i.test(f)) return new URL(f, u).href.split('#')[0];
    if (/^(https?|file):$/.test(u.protocol)) return u.href.split('#')[0];
  } catch { /* not an address */ }
  return null;
}
const looksLikePdf = url => { try { return /\.pdf$/i.test(new URL(url).pathname) || /[?&]file=[^&]*\.pdf/i.test(url); } catch { return false; } };

function nameFor(url, res, title) {
  const cd = res && res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*\s*=\s*[^']*''([^;]+)/i) || cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  let n = '';
  try { n = m ? decodeURIComponent(m[1].trim()) : decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { n = m ? m[1] : ''; }
  if (!/\.pdf$/i.test(n)) n = (title && !/^https?:|^file:/i.test(title) ? title.replace(/\.pdf$/i, '') : n || 'document') + '.pdf';
  return n.replace(/[\u0000-\u001f]/g, '');
}

/* ---- "Catch it while it opens": watch the tab with Chrome's debugger while the user opens the PDF again ----
   The PDF's bytes are taken as they arrive (from every frame and worker of the page), so no second download is needed. */
let capture = null;
function showCapture(tabId, title) {
  $('capture').hidden = false; $('capture').dataset.tab = tabId; $('capture').dataset.title = title || '';
  $('capMsg').textContent = '';
}
$('capStart').addEventListener('click', () => startCapture(Number($('capture').dataset.tab), $('capture').dataset.title));
$('capStop').addEventListener('click', () => { shotCancel = true; stopCapture('Stopped.'); });

async function startCapture(tabId, title) {
  if (capture) return;
  $('shotBtn').disabled = true;
  showErr('');
  const target = { tabId };
  try { await chrome.debugger.attach(target, '1.3'); }
  catch (e) { $('capMsg').textContent = 'Could not watch that tab: ' + (e.message || e) + ' (close the browser\'s developer tools on that tab and try again).'; return; }
  const me = await chrome.tabs.getCurrent();
  const reqs = new Map(), done = new Set();
  const send = (sessionId, method, params = {}) => chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : target, method, params);
  const hdr = (h, n) => { for (const k in h || {}) if (k.toLowerCase() === n) return h[k]; return ''; };
  const looksPdf = r => /\bpdf\b/i.test(r.mime || '') || /\.pdf\b/i.test(r.cd || '') || /\.pdf([?#&]|$)|inputFormat=pdf/i.test(r.url || '');
  async function grab(sid, requestId, r) {
    const key = r.url.split('#')[0];
    if (done.has(key)) return;
    let data = null;
    if (r.status === 200) {
      try {
        const b = await send(sid, 'Network.getResponseBody', { requestId });
        const bytes = b.base64Encoded ? fromB64(b.body) : new TextEncoder().encode(b.body);
        if (isPdfBytes(bytes)) data = bytes;
      } catch { /* body no longer available */ }
    }
    if (!data) { // e.g. the viewer loaded it in pieces (206): read it once more, with the same sign-in headers
      const headers = Object.entries(r.headers || {}).filter(([k]) => !SKIP_REFETCH.test(k)).map(([name, value]) => ({ name, value }));
      try { data = (await fetchPdf(r.url, headers)).data; } catch { /* try the next one */ }
    }
    if (!data || done.has(key)) return;
    done.add(key);
    const name = nameFor('', null, ((r.cd && nameFor(r.url, { headers: new Headers({ 'content-disposition': r.cd }) }, '')) || ((title || '').match(/[^|\-–—]*\.pdf/i) || [''])[0].trim() || (title || 'document').split('|')[0].trim()).replace(/\.pdf$/i, ''));
    try {
      await addSource(name, data, key);
      setTabMsg(`Caught "${name}" while it opened and loaded it.`, 'ok'); showDiag('');
      $('capture').hidden = true;
      stopCapture('');
      if (me) { chrome.tabs.update(me.id, { active: true }); chrome.windows.update(me.windowId, { focused: true }); }
    } catch (e) { $('capMsg').textContent = `Found a PDF but could not open it: ${e.message}`; done.delete(key); }
  }
  const onEvent = (src, method, p) => {
    if (src.tabId !== tabId) return;
    const sid = src.sessionId, k = (sid || '') + '|' + (p && p.requestId);
    if (method === 'Target.attachedToTarget') {
      const s2 = p.sessionId;
      send(s2, 'Network.enable', { maxResourceBufferSize: 200e6, maxTotalBufferSize: 400e6 }).catch(() => {});
      send(s2, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      send(s2, 'Runtime.runIfWaitingForDebugger').catch(() => {});
    } else if (method === 'Network.requestWillBeSent') {
      reqs.set(k, { url: p.request.url, headers: p.request.headers });
    } else if (method === 'Network.responseReceived') {
      const r = reqs.get(k) || { url: p.response.url };
      Object.assign(r, { url: p.response.url, status: p.response.status, mime: p.response.mimeType, cd: hdr(p.response.headers, 'content-disposition') });
      reqs.set(k, r);
    } else if (method === 'Network.loadingFinished') {
      const r = reqs.get(k);
      if (r && r.status < 400 && looksPdf(r)) grab(sid, p.requestId, r);
      reqs.delete(k);
    } else if (method === 'Network.loadingFailed') reqs.delete(k);
  };
  const onDetach = src => { if (src.tabId === tabId) stopCapture('Stopped watching (the bar was closed).', true); };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  capture = { tabId, onEvent, onDetach, timer: setTimeout(() => stopCapture('Stopped after 3 minutes without seeing a PDF. Press Start to try again.'), 180000) };
  try {
    await send(undefined, 'Network.enable', { maxResourceBufferSize: 200e6, maxTotalBufferSize: 400e6 });
    await send(undefined, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  } catch (e) { stopCapture('Could not watch that tab: ' + (e.message || e)); return; }
  $('capStart').hidden = true; $('capStop').hidden = false;
  $('capMsg').textContent = 'Watching… now close the PDF in that tab and open it again.';
  chrome.tabs.update(tabId, { active: true }).catch(() => {});
}
const SKIP_REFETCH = /^(cookie|host|content-length|range|if-range|if-none-match|if-modified-since|origin|referer|user-agent|accept-encoding|connection|sec-.*|proxy-.*|upgrade-insecure-requests|priority|:.*)$/i;

function stopCapture(msg, alreadyDetached) {
  if (!capture || capture.shot) return;
  const c = capture; capture = null;
  clearTimeout(c.timer);
  chrome.debugger.onEvent.removeListener(c.onEvent);
  chrome.debugger.onDetach.removeListener(c.onDetach);
  if (!alreadyDetached) chrome.debugger.detach({ tabId: c.tabId }).catch(() => {});
  $('capStart').hidden = false; $('capStop').hidden = true; $('shotBtn').disabled = false;
  $('capMsg').textContent = msg || '';
}
window.addEventListener('pagehide', () => stopCapture(''));

/* ---- "Capture from the screen": scroll the viewer and stitch screenshots into one long image ----
   Works with any viewer, because it only takes pictures of what Chrome shows. The pictures are as sharp as the screen:
   zoom the viewer in first for sharper images. */
// Runs in each frame: finds (cmd 'find') or scrolls (cmd 'scroll') the main scrolling area that is visible on screen,
// and reports where the PDF's pages are inside it (in "content" positions, which do not change while scrolling).
function t10Scroller(cmd, y) {
  const vw = document.documentElement.clientWidth || innerWidth, vh = document.documentElement.clientHeight || innerHeight;
  const isDoc = el => el === document.scrollingElement || el === document.documentElement || el === document.body;
  const geo = el => {
    if (isDoc(el)) { const se = document.scrollingElement || document.documentElement; return { l: 0, t: 0, w: vw, h: vh, top: se.scrollTop, scrollH: se.scrollHeight }; }
    const r = el.getBoundingClientRect();
    return { l: r.left + el.clientLeft, t: r.top + el.clientTop, w: el.clientWidth, h: el.clientHeight, top: el.scrollTop, scrollH: el.scrollHeight };
  };
  // Pages: same-width boxes shaped like pages, stacked one under another. The largest such set wins.
  const pagesIn = (el, g) => {
    const root = isDoc(el) ? document.body : el, groups = new Map();
    for (const e of root.querySelectorAll('canvas, img, div, section, article')) {
      const w = e.offsetWidth, h = e.offsetHeight;
      if (w < g.w * 0.25 || h < 120 || h / w < 0.45 || h / w > 2.3) continue;
      const r = e.getBoundingClientRect();
      const p = { top: Math.round(r.top - g.t + g.top), left: Math.round(r.left - g.l), w: Math.round(r.width), h: Math.round(r.height) };
      const k = Math.round(r.width / 3);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    let best = [], bestH = 0;
    for (const list of groups.values()) {
      list.sort((a, b) => a.top - b.top || b.h - a.h);
      const out = [];
      for (const p of list) { const last = out[out.length - 1]; if (!last || p.top >= last.top + last.h - 3) out.push(p); } // drops nested copies
      const total = out.reduce((n, p) => n + p.h, 0);
      if (out.length > best.length || (out.length === best.length && total > bestH)) { best = out; bestH = total; }
    }
    // a lone box is only a page if it is a good part of the document
    if (best.length === 1 && best[0].h < g.scrollH * 0.5) return [];
    return best;
  };
  if (cmd === 'scroll') {
    const el = document.querySelector('[data-t10-scroll]') || document.scrollingElement;
    if (y != null) el.scrollTop = y;
    const g = geo(el); g.pages = pagesIn(el, g); return g;
  }
  let best = null, bestScore = 0;
  const consider = el => {
    const g = geo(el);
    const w = Math.min(g.l + g.w, vw) - Math.max(g.l, 0), h = Math.min(g.t + g.h, vh) - Math.max(g.t, 0);
    if (w < 150 || h < 150 || g.scrollH < g.h * 1.1) return;
    const top = document.elementFromPoint(Math.max(g.l, 0) + w / 2, Math.max(g.t, 0) + h / 2);
    if (top && !isDoc(el) && !el.contains(top)) return; // hidden behind something (e.g. the file list behind a viewer)
    const score = w * h * Math.min(g.scrollH / g.h, 20);
    if (score > bestScore) { best = el; bestScore = score; }
  };
  if (document.scrollingElement) consider(document.scrollingElement);
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 150) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') consider(el);
    }
  }
  document.querySelectorAll('[data-t10-scroll]').forEach(e => e.removeAttribute('data-t10-scroll'));
  const iframes = [...document.querySelectorAll('iframe')].map(f => { const r = f.getBoundingClientRect(); return { src: f.src, l: r.left + f.clientLeft, t: r.top + f.clientTop }; });
  if (!best) return { frame: location.href, vw, vh, iframes, score: 0 };
  if (!isDoc(best)) best.setAttribute('data-t10-scroll', '1');
  const g = geo(best);
  return { frame: location.href, vw, vh, iframes, score: bestScore, ...g, pages: pagesIn(best, g) };
}

let shotCancel = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEG = 16000; // tallest long image, in pixels (WebP cannot be taller than 16383)

// One output image being pieced together: a page (from its position in the viewer), or a part of the long image.
class Piece {
  constructor(top, left, w, h, ratio) { Object.assign(this, { top, left, w, h, filled: top }); this.c = document.createElement('canvas'); this.c.width = Math.max(1, Math.round(w * ratio)); this.c.height = Math.max(1, Math.round(h * ratio)); }
  // copies the part of a screenshot strip (content from..to, shown at screen x0 / y0) that belongs to this piece
  draw(strip, ratio) {
    const from = Math.max(this.top, strip.from), to = Math.min(this.top + this.h, strip.to);
    if (to <= from) return;
    const left = Math.max(this.left, strip.visL - strip.contentL), right = Math.min(this.left + this.w, strip.visR - strip.contentL);
    if (right <= left) return;
    const sx = (strip.contentL + left + strip.offX) * ratio, sy = (strip.y0 + (from - strip.from)) * ratio;
    this.c.getContext('2d').drawImage(strip.bmp, sx, sy, (right - left) * ratio, (to - from) * ratio, (left - this.left) * ratio, (from - this.top) * ratio, (right - left) * ratio, (to - from) * ratio);
    if (from <= this.filled + 1) this.filled = Math.max(this.filled, to);
  }
  get done() { return this.filled >= this.top + this.h - 1; }
  async finish() { const b = await canvasToBlob(this.c, 'image/png'); this.c.width = this.c.height = 0; return b; }
}

async function captureScreen(tabId, title) {
  shotCancel = false;
  showErr('');
  const say = t => { $('capMsg').textContent = t; };
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { say('That tab has been closed.'); return; }
  if (!IN_PANEL) await chrome.tabs.update(tabId, { active: true }); // it must be on screen
  await sleep(400);
  let found;
  try { found = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: t10Scroller, args: ['find'] }); }
  catch (e) { say('Could not look at that page: ' + (e.message || e)); return; }
  const top = found.find(f => f.frameId === 0) || found[0];
  const pick = found.filter(f => f.result && f.result.score > 0).sort((a, b) => b.result.score - a.result.score)[0];
  let offX = 0, offY = 0;
  if (pick && pick.frameId !== 0) { // where that frame sits on the screen
    const want = (() => { try { const u = new URL(pick.result.frame); return u.origin + u.pathname; } catch { return ''; } })();
    const fr = (top.result.iframes || []).find(f => { try { const u = new URL(f.src); return u.origin + u.pathname === want; } catch { return false; } });
    if (!fr) { say('The PDF is in a part of the page the extension cannot measure. Open it on its own (e.g. "Open in browser") and try again.'); return; }
    offX = fr.l; offY = fr.t;
  }
  const frameId = pick ? pick.frameId : 0, frameVh = pick ? pick.result.vh : top.result.vh;
  const scroll = async y => (await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: t10Scroller, args: ['scroll', y == null ? null : y] }))[0].result;
  let lastShot = 0;
  const shoot = async () => {
    const wait = 600 - (Date.now() - lastShot); if (wait > 0) await sleep(wait); // Chrome allows about 2 screenshots a second
    lastShot = Date.now();
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return createImageBitmap(await (await fetch(url)).blob());
  };
  $('shotBtn').disabled = true; $('capStart').disabled = true; $('capStop').hidden = false; $('curShot').disabled = true;
  if (!capture) capture = { shot: true };
  const pages = new Map();      // page top -> Piece   (pages found in the viewer)
  const recent = [];            // the last few strips, to fill in pages the viewer only adds when they come into view
  const done = [];              // [{ top, blob }]
  let ratio = 0, longPiece = null, startTop = 0, g = null, anyPages = false;
  const addPages = list => {
    for (const p of list || []) {
      if ([...pages.keys(), ...done.map(d => d.top)].some(t => Math.abs(t - p.top) < 4)) continue;
      const piece = new Piece(p.top, p.left, p.w, p.h, ratio);
      pages.set(p.top, piece); anyPages = true;
      for (const st of recent) piece.draw(st, ratio);
    }
  };
  try {
    g = pick ? pick.result : { l: 0, t: 0, w: top.result.vw, h: top.result.vh, top: 0, scrollH: top.result.vh, pages: [] };
    startTop = g.top;
    if (pick) { g = await scroll(0); await sleep(1000); g = await scroll(); }
    for (let step = 0; step < 3000; step++) {
      if (shotCancel) throw new Error('Stopped.');
      const bmp = await shoot();
      if (!ratio) ratio = bmp.width / top.result.vw;
      const visT = Math.max(g.t, 0), visB = Math.min(g.t + g.h, frameVh), visL = Math.max(g.l, 0), visR = Math.min(g.l + g.w, pick ? pick.result.vw : top.result.vw);
      const strip = { bmp, from: g.top + (visT - g.t), to: g.top + (visB - g.t), y0: offY + visT, visL, visR, contentL: g.l, offX };
      addPages(g.pages);
      if (!anyPages) { // no pages found (yet): piece a long image together instead
        if (!longPiece || longPiece.done) {
          if (longPiece) done.push({ top: longPiece.top, blob: await longPiece.finish() });
          const t0 = longPiece ? longPiece.top + longPiece.h : 0;
          longPiece = new Piece(t0, 0, g.w, Math.min(SEG / ratio, Math.max(g.scrollH - t0, 1)), ratio);
        }
        longPiece.draw(strip, ratio);
      }
      for (const [k, p] of pages) { p.draw(strip, ratio); if (p.done) { done.push({ top: p.top, blob: await p.finish() }); pages.delete(k); } }
      recent.push(strip); while (recent.length > 3) recent.shift().bmp.close();
      say(`Capturing from the screen… ${Math.min(99, Math.round(100 * strip.to / g.scrollH))}%${anyPages ? ` · ${done.length} page${done.length === 1 ? '' : 's'} so far` : ''} - keep that tab visible and do not scroll.`);
      if (!pick || strip.to >= g.scrollH - 1) break;
      const prevTop = g.top;
      g = await scroll(g.top + (visB - visT));
      if (g.top <= prevTop + 0.5) break;                 // cannot scroll any further
      await sleep(1000);                                 // give the viewer time to draw the newly shown pages
      g = await scroll();                                // read the page positions again once drawn
    }
    for (const p of pages.values()) if (p.filled > p.top + 20) done.push({ top: p.top, blob: await p.finish() }); // partly captured pages
    if (!anyPages && longPiece && longPiece.filled > longPiece.top) { longPiece.h = longPiece.filled - longPiece.top; const c = longPiece.c, h = Math.round(longPiece.h * ratio); const t = document.createElement('canvas'); t.width = c.width; t.height = Math.min(h, c.height); t.getContext('2d').drawImage(c, 0, 0); longPiece.c = t; done.push({ top: longPiece.top, blob: await longPiece.finish() }); c.width = c.height = 0; }
  } catch (e) {
    say(e.message === 'Stopped.' ? 'Stopped.' : 'The screen capture failed: ' + (e.message || e));
    done.length = 0;
  } finally {
    recent.forEach(s => s.bmp.close());
    if (pick) scroll(startTop).catch(() => {});        // put the page back where it was
    $('shotBtn').disabled = false; $('capStart').disabled = false; $('curShot').disabled = false;
    if (capture && capture.shot) { capture = null; $('capStop').hidden = true; }
  }
  if (!done.length) return;
  done.sort((a, b) => a.top - b.top);
  const parts = done.map(d => d.blob);
  const base = (((title || '').match(/[^|\-–—]*\.pdf/i) || [''])[0].trim() || (title || 'screen capture').split('|')[0].trim()).replace(/\.pdf$/i, '');
  const first = await createImageBitmap(parts[0]); const w = first.width, h = first.height; first.close();
  sources.push({ kind: 'shots', perPage: anyPages, name: base + ' (screen capture)', tabUrl: pdfUrlOf(tab.url), url: 'shots:' + tab.url + ':' + Date.now(),
    size: parts.reduce((n, b) => n + b.size, 0), pages: parts.length, w, h, parts });
  renderFiles();
  say('');
  setTabMsg(anyPages
    ? `Captured "${base}" from the screen: ${parts.length} page${parts.length === 1 ? '' : 's'}, ${w} × ${h} pixels each.`
    : `Captured "${base}" from the screen as ${parts.length === 1 ? 'one long image' : parts.length + ' long images'} (the pages could not be told apart): ${w} pixels wide.`, 'ok');
  $('capture').hidden = true;
}
$('shotBtn').addEventListener('click', () => captureScreen(Number($('capture').dataset.tab), $('capture').dataset.title));

function setTabMsg(text, kind) { const m = $('tabMsg'); m.hidden = !text; m.textContent = text || ''; m.className = 'tabmsg ' + (kind || ''); }

const isPdfBytes = d => String.fromCharCode(...d.subarray(0, 1024)).indexOf('%PDF') >= 0;

// Downloads url (normally straight from Chrome's cache). Returns { data, res } if it is a PDF, null if it is something else.
// Stops early when the first bytes show it is not a PDF, so large non-PDF files are not downloaded in full.
async function fetchPdf(url, headers) {
  const init = { credentials: 'include' };
  if (headers && headers.length) init.headers = Object.fromEntries(headers.map(h => [h.name, h.value]));
  let res;
  try { res = await fetch(url, { ...init, cache: 'force-cache' }); }
  catch { res = await fetch(url, init); }
  if (!res.ok) { const e = new Error(`the site answered "${res.status} ${res.statusText}"`); e.status = res.status; throw e; }
  const reader = res.body.getReader(), parts = [];
  let len = 0, checked = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); len += value.length;
    if (!checked && len >= 1024) {
      checked = true;
      if (!isPdfBytes(concat(parts, len))) { reader.cancel().catch(() => {}); return { res, data: null, got: res.headers.get('content-type') || '' }; }
    }
  }
  const data = concat(parts, len);
  return { res, data: isPdfBytes(data) ? data : null, got: res.headers.get('content-type') || '' };
}
function concat(parts, len) { const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

/* ---- looking inside a page (Teams, SharePoint, OneDrive, Outlook, web PDF viewers…) ----
   These sites show a PDF inside their own page, often in a frame from another site, so the tab's address is not the PDF.
   This runs in every frame of the tab and lists what could be the PDF: a PDF frame / <embed> / <object>, and the files
   the frame has loaded (from the browser's own record of loaded files) that look like a PDF download. */
function findPdfsInFrame() {
  const items = [], add = (url, how, score) => { if (url && !/^(data|javascript|about|chrome):/i.test(url)) items.push({ url, how, score }); };
  try { if (document.contentType === 'application/pdf') add(location.href, 'PDF frame', 100); } catch { /* ignore */ }
  for (const el of document.querySelectorAll('embed, object, iframe')) {
    const src = el.getAttribute('src') ? el.src : el.getAttribute('data') ? el.data : '';
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type.includes('pdf') || /\.pdf([?#]|$)/i.test(src) || (/^blob:/i.test(src) && el.tagName !== 'IFRAME')) add(src, el.tagName.toLowerCase(), 90);
  }
  const PDFISH = /\.pdf([?#&]|$)|download\.aspx|[?&]tempauth=|\/content([?#]|$)|\/\$value|format=pdf|application%2fpdf|[/=]pdf([/?&#]|$)/i;
  const NOT = /\.(m?js|css|json|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|webm|mp3|html?)([?#]|$)/i;
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (NOT.test(new URL(e.name).pathname)) continue;
      if (PDFISH.test(e.name)) add(e.name, 'loaded by the page', 60);
      else if (['fetch', 'xmlhttprequest', 'other', 'embed', 'object'].includes(e.initiatorType) && (e.encodedBodySize > 30000 || e.transferSize === 0 && e.encodedBodySize === 0)) add(e.name, 'loaded by the page', e.encodedBodySize > 30000 ? 15 : 5);
    }
  } catch { /* ignore */ }
  for (const a of document.querySelectorAll('a[href]')) if (/\.pdf([?#]|$)/i.test(a.href)) add(a.href, 'link', 10);
  const pdfTitle = (document.title.match(/[^|\-–—]*\.pdf/i) || [''])[0].trim();
  return { frame: location.href, title: pdfTitle, items: items.slice(-80) };
}

// Fetches a file from inside the page's frame (needed for blob: addresses, and for sites that only accept the page itself).
async function fetchInFrame(url) {
  let r, firstErr = '';
  for (const credentials of ['include', 'same-origin', 'omit']) {
    try { r = await fetch(url, { credentials }); break; } catch (e) { firstErr = firstErr || (e.message || String(e)); r = null; }
  }
  if (!r) return { error: firstErr };
  try {
    if (!r.ok) return { error: `${r.status} ${r.statusText}` };
    const b = new Uint8Array(await r.arrayBuffer());
    if (String.fromCharCode(...b.subarray(0, 1024)).indexOf('%PDF') < 0) return { notPdf: true, got: r.headers.get('content-type') || '' };
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return { b64: btoa(s), cd: r.headers.get('content-disposition') || '' };
  } catch (e) { return { error: e.message || String(e) }; }
}
// SharePoint / OneDrive / Teams files: the page address names the file, so ask SharePoint for it directly
// (its normal download link, which uses your SharePoint login). This gets the original file.
function sharePointCandidates(pageUrls) {
  const out = [];
  for (const raw of pageUrls) {
    let u; try { u = new URL(raw); } catch { continue; }
    if (!/(\.sharepoint\.com|\.sharepoint-df\.com)$/i.test(u.hostname)) continue;
    const id = u.searchParams.get('id') || u.searchParams.get('SourceUrl') || u.searchParams.get('sourceurl') || '';
    const uniq = (u.searchParams.get('sourcedoc') || u.searchParams.get('UniqueId') || '').replace(/[{}]/g, '');
    const site = ((id || u.pathname).match(/^\/(sites|teams|personal)\/[^/]+/i) || [''])[0];
    const base = u.origin + site + '/_layouts/15/download.aspx';
    if (/\.pdf$/i.test(id)) {
      out.push({ url: `${base}?SourceUrl=${encodeURIComponent(id)}`, how: 'SharePoint download', score: 99, name: id.split('/').pop() });
      out.push({ url: u.origin + id.split('/').map(encodeURIComponent).join('/'), how: 'SharePoint file', score: 98, name: id.split('/').pop() });
    }
    const file = u.searchParams.get('file') || '';
    if (/^[0-9a-f-]{36}$/i.test(uniq) && (!file || /\.pdf$/i.test(file))) out.push({ url: `${base}?UniqueId=${uniq}`, how: 'SharePoint download', score: 97, name: file });
  }
  return out;
}
// Hides sign-in tokens in addresses before they are shown in the details box.
const redact = url => url.replace(/([?&](?:tempauth|access_token|token|sig|signature|key|code|auth)=)[^&]+/gi, '$1…');
const fromB64 = s => { const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

let lastDiag = '';
function showDiag(text) {
  lastDiag = text;
  $('diag').hidden = !text;
  $('diagText').textContent = text;
}
$('copyDiag').addEventListener('click', async () => { await navigator.clipboard.writeText(lastDiag); $('copyDiag').textContent = 'Copied'; setTimeout(() => { $('copyDiag').textContent = 'Copy details'; }, 1500); });

async function findInPage(tabId, title) {
  let frames;
  try { frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: findPdfsInFrame }); }
  catch (e) { return { found: false, diag: `Could not look inside the page: ${e.message || e}` }; }
  const seen = new Map();
  for (const f of frames) for (const it of (f.result && f.result.items) || []) {
    const key = it.url.split('#')[0];
    if (!seen.has(key) || seen.get(key).score < it.score) seen.set(key, { ...it, url: key, frameId: f.frameId, frameTitle: f.result.title });
  }
  const pdfTitle = frames.map(f => f.result && f.result.title).find(Boolean) || '';
  const frameUrls = frames.map(f => f.result && f.result.frame).filter(Boolean);
  let tabUrl = ''; try { tabUrl = (await chrome.tabs.get(tabId)).url; } catch { /* closed */ }
  for (const c of sharePointCandidates([tabUrl, ...frameUrls])) if (!seen.has(c.url)) seen.set(c.url, { ...c, frameId: 0, frameTitle: c.name || '' });
  // PDFs Chrome saw arriving in this tab (also from workers / with sign-in headers)
  const origins = new Set(frameUrls.map(x => { try { return new URL(x).origin; } catch { return ''; } }));
  const { captured = [] } = await chrome.storage.session.get('captured').catch(() => ({}));
  for (const c of captured) {
    if (Date.now() - c.time > 3600e3) continue;
    if (c.tabId !== tabId && !(c.tabId === -1 && origins.has(c.initiator))) continue;
    const key = c.url.split('#')[0];
    const prev = seen.get(key);
    seen.set(key, { ...(prev || {}), url: key, how: 'seen arriving in the tab', score: Math.max(95, prev ? prev.score : 0), frameId: c.frameId >= 0 && c.tabId === tabId ? c.frameId : 0, headers: c.headers, cd: c.cd, frameTitle: (prev && prev.frameTitle) || '' });
  }
  const cands = [...seen.values()].sort((x, y) => y.score - x.score).slice(0, 15);
  const tried = [];
  for (const c of cands) {
    if (sources.some(s => s.url === c.url)) return { found: true, already: sources.find(s => s.url === c.url).name };
    setTabMsg(`Looking for the PDF inside the page${title ? ' "' + title + '"' : ''}… (${tried.length + 1} of ${cands.length})`);
    let data = null, res = null, cd = '', why = '';
    if (!/^blob:/i.test(c.url)) {
      try { let got; ({ data, res, got } = await fetchPdf(c.url, c.headers)); if (!data) why = `extension: not a PDF (${(got || '?').split(';')[0]})`; } catch (e) { why = 'extension: ' + e.message; }
    }
    // A web page instead of the PDF usually means "not logged in" from the extension: ask from inside the page instead
    // (it is logged in). Only skip that for ordinary files that are clearly something else.
    if (!data && !(/not a PDF/.test(why) && c.score < 60)) {
      // let the page's own frame fetch it (blob: addresses, or files only the page may read)
      try {
        let [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [c.frameId || 0] }, world: 'MAIN', func: fetchInFrame, args: [c.url] }).catch(() => [null]);
        if (!r || !r.result || r.result.error) [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [c.frameId || 0] }, func: fetchInFrame, args: [c.url] });
        const v = r && r.result;
        if (v && v.b64) { data = fromB64(v.b64); cd = v.cd; why = ''; } else if (v) why = [why, 'page: ' + (v.notPdf ? `not a PDF (${(v.got || '?').split(';')[0]})` : v.error)].filter(Boolean).join('; ');
      } catch (e) { why = [why, 'page: ' + e.message].filter(Boolean).join('; '); }
    }
    tried.push(`${data ? 'PDF ' : '-   '} [${c.how}, ${c.score}] ${redact(c.url).slice(0, 400)}${why ? '  -> ' + why : ''}`);
    if (data) {
      // name: the one the site sends, else a ".pdf" name in the viewer's / tab's title, else the address
      const hdr = cd || (res && res.headers.get('content-disposition')) || c.cd || '';
      const fromTitle = c.frameTitle || c.name || pdfTitle || ((title || '').match(/[^|\-–—]*\.pdf/i) || [''])[0].trim();
      let urlFile = ''; try { if (!/^blob:/i.test(c.url)) urlFile = decodeURIComponent(new URL(c.url).pathname.split('/').pop()); } catch { /* none */ }
      const generic = n => !n || /^(content|download|document|file|\$value|[0-9a-f-]{20,})(\.pdf)?$/i.test(n) || /\.aspx$/i.test(n);
      let name = hdr ? nameFor(c.url, { headers: new Headers({ 'content-disposition': hdr }) }, '') : '';
      if (generic(name.replace(/\.pdf$/i, ''))) name = fromTitle || (/\.pdf$/i.test(urlFile) && !generic(urlFile.replace(/\.pdf$/i, '')) ? urlFile : '') || nameFor('', null, (title || 'document').split('|')[0].trim());
      name = nameFor('', null, name.replace(/\.pdf$/i, ''));
      await addSource(name, data, c.url);
      return { found: true, name };
    }
  }
  return {
    found: false,
    diag: `Version ${chrome.runtime.getManifest().version}\nPage: ${title || ''}\nFrames looked in: ${frames.length}\n${frames.map(f => '  frame ' + f.frameId + ': ' + redact((f.result && f.result.frame) || '?').slice(0, 300)).join('\n')}\nPDFs seen arriving in this tab: ${captured.filter(c => c.tabId === tabId).length}\nPossible files tried: ${tried.length}\n${tried.join('\n')}`
  };
}


// Reads the PDF a tab is showing: either the tab is the PDF itself (Chrome's PDF viewer), or the PDF is shown inside
// the page (Teams, SharePoint…), in which case the page is searched for it.
const loading = new Set();
async function loadFromTab(rawUrl, title, opts = {}) {
  const key = (rawUrl || '') + '|' + (opts.tabId || '');
  if (loading.has(key)) return false;
  loading.add(key);
  const before = sources.length;
  try {
    const ok = await loadFromTabNow(rawUrl, title, opts);
    if (ok && sources.length > before) sources[sources.length - 1].tabUrl = pdfUrlOf(rawUrl); // remember which tab it came from
    return ok;
  } finally { loading.delete(key); updateCurTab(); }
}
async function loadFromTabNow(rawUrl, title, { tabId } = {}) {
  showDiag(''); $('capture').hidden = true; stopCapture('');
  const url = pdfUrlOf(rawUrl);
  if (!url) { setTabMsg('That tab is not showing a PDF.', 'warn'); return false; }
  const had = sources.find(s => s.url === url || s.tabUrl === url);
  if (had) { setTabMsg(`"${had.name}" is already in the list.`); return true; }
  if (url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) { setTabMsg(''); $('fileAccess').hidden = false; return false; }
  setTabMsg(`Reading the PDF from your tab${title ? ': ' + title : ''}…`);
  try {
    // 1. the tab itself is the PDF
    let direct = null, directErr = null;
    if (looksLikePdf(rawUrl) || !tabId) { try { direct = await fetchPdf(url); } catch (e) { directErr = e; } }
    if (direct && direct.data) {
      const name = nameFor(url, direct.res, title);
      await addSource(name, direct.data, url);
      setTabMsg(`Loaded "${name}" from your tab.`, 'ok'); return true;
    }
    // 2. the PDF is shown inside the page
    if (tabId) {
      const r = await findInPage(tabId, title);
      if (r.found) { setTabMsg(r.already ? `"${r.already}" is already in the list.` : `Found "${r.name}" in the page and loaded it.`, 'ok'); return true; }
      // last try: maybe the tab is a PDF after all (an address without ".pdf")
      if (!looksLikePdf(rawUrl)) { try { direct = await fetchPdf(url); } catch (e) { directErr = e; } }
      if (direct && direct.data) {
        const name = nameFor(url, direct.res, title);
        await addSource(name, direct.data, url);
        setTabMsg(`Loaded "${name}" from your tab.`, 'ok'); return true;
      }
      setTabMsg('No PDF could be found in that tab.\n'
        + 'If the PDF is shown inside a site (Teams, SharePoint, Outlook…): open it so it is showing on screen, then click the icon again. '
        + 'Or use "Catch it while it opens" below. Or use the site\'s Download button and drop the file below.', 'warn');
      showDiag(r.diag);
      showCapture(tabId, title);
      return false;
    }
    if (directErr) throw directErr;
    throw new Error('it is not a PDF');
  } catch (e) {
    setTabMsg(url.startsWith('file:')
      ? `Could not read that file from your computer (${e.message || e}). It may have been moved or renamed - drop it in below instead.`
      : `Could not read the PDF from that tab: ${e.message || e}.\nIf the site made the PDF just for you (e.g. after pressing a button), use the viewer's download button, then drop the file below.`, 'warn');
    return false;
  } finally { listOpenPdfs(); }
}

// Lists the other tabs that are showing PDFs, so they can be added with one click.
async function listOpenPdfs() {
  const tabs = await chrome.tabs.query({});
  const box = $('tabList'); box.textContent = '';
  const seen = new Set(sources.map(s => s.url));
  for (const t of tabs) {
    const url = t.url && pdfUrlOf(t.url);
    if (!url || !looksLikePdf(t.url) || seen.has(url)) continue;
    seen.add(url);
    const row = document.createElement('div'); row.className = 'tabpdf';
    let file = ''; try { file = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { /* keep the title */ }
    const label = /\.pdf$/i.test(file) ? file : (t.title || url);
    const nm = Object.assign(document.createElement('span'), { className: 'nm', textContent: label, title: (t.title && t.title !== label ? t.title + '\n' : '') + url });
    const add = Object.assign(document.createElement('button'), { className: 'alt small', textContent: 'Add' });
    add.addEventListener('click', async () => { add.disabled = true; showErr(''); await loadFromTab(t.url, t.title, { tabId: t.id }); });
    row.append(nm, add); box.append(row);
  }
  $('otherTabs').hidden = !box.children.length;
  $('addAllTabs').hidden = box.children.length < 2;
}
$('addAllTabs').addEventListener('click', async () => {
  for (const b of [...$('tabList').querySelectorAll('button')]) b.click();
});
$('openExt').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }));
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete' || info.url) listOpenPdfs(); });
chrome.tabs.onRemoved.addListener(() => listOpenPdfs());

// The toolbar icon was clicked again on another PDF while this page is open: add that PDF here.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== 't10pdf-add') return;
  chrome.tabs.getCurrent(t => reply(t ? { tabId: t.id, windowId: t.windowId } : { panel: true }));
  if (msg.url) { chrome.storage.session.remove('pendingLink'); showErr(''); $('fileAccess').hidden = true; loadFromTab(msg.url, msg.title, { tabId: msg.tabId }); }
  return true;
});

/* ------------------------------------------------------------------ choosing the folder (remembered in IndexedDB) */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('t10pdf', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kv(op, key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const st = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
    const r = op === 'get' ? st.get(key) : st.put(val, key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function setDir(h) { dirHandle = h; $('dirName').textContent = h ? `📁 ${h.name}` : 'No folder chosen'; updateStart(); }

$('chooseDir').addEventListener('click', async () => {
  showErr('');
  try {
    const h = await window.showDirectoryPicker({ id: 't10pdf', mode: 'readwrite', startIn: dirHandle || 'pictures' });
    setDir(h); kv('put', 'dir', h).catch(() => {});
  } catch (e) {
    if (e.name !== 'AbortError') showErr('That folder cannot be used: ' + (e.message || e) + '\nChrome does not allow system folders (like the whole Downloads or Documents folder on some systems) - choose or create a folder inside it.');
  }
});

async function ensureDirPermission() {
  const opts = { mode: 'readwrite' };
  if ((await dirHandle.queryPermission(opts)) === 'granted') return true;
  return (await dirHandle.requestPermission(opts)) === 'granted';
}

/* ------------------------------------------------------------------ where the images go */
class FolderSink {
  constructor(root, exists) { this.root = root; this.exists = exists; }
  async dir(sub) { return sub ? this.root.getDirectoryHandle(sub, { create: true }) : this.root; }
  async write(dir, name, blob) {
    let target = name;
    const has = async n => { try { await dir.getFileHandle(n); return true; } catch { return false; } };
    if (await has(target)) {
      if (this.exists === 'skip') return null;
      if (this.exists === 'rename') {
        const dot = name.lastIndexOf('.'), stem = name.slice(0, dot), ext = name.slice(dot);
        for (let i = 2; await has(target); i++) target = `${stem} (${i})${ext}`;
      }
    }
    const fh = await dir.getFileHandle(target, { create: true });
    const w = await fh.createWritable();
    await w.write(blob); await w.close();
    return target;
  }
}
class DownloadsSink {
  constructor(folder, exists) { this.folder = folder; this.exists = exists; this.pending = new Map(); }
  async dir(sub) { return [this.folder, sub].filter(Boolean).join('/'); }
  async write(dir, name, blob) {
    const url = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({
      url, filename: (dir ? dir + '/' : '') + name, saveAs: false,
      // the Downloads API cannot skip, so "skip" keeps both
      conflictAction: this.exists === 'replace' ? 'overwrite' : 'uniquify'
    });
    this.pending.set(id, url);
    return name;
  }
  listen() {
    this.onChanged = d => {
      if (d.state && d.state.current !== 'in_progress' && this.pending.has(d.id)) { URL.revokeObjectURL(this.pending.get(d.id)); this.pending.delete(d.id); }
    };
    chrome.downloads.onChanged.addListener(this.onChanged);
  }
}

/* ------------------------------------------------------------------ encoding */
const canvasToBlob = (c, type, q) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('the image could not be encoded (it may be too large)')), type, q));

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC_TABLE[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// Writes the DPI into the file so it prints at the PDF's real size.
async function withDpi(blob, format, dpi) {
  if (!dpi || format === 'webp') return blob;
  const b = new Uint8Array(await blob.arrayBuffer());
  if (format === 'jpeg') {
    // JFIF header: FF D8 FF E0 len 'JFIF\0' ver(2) units(1) xdens(2) ydens(2)
    if (b[2] === 0xff && b[3] === 0xe0 && String.fromCharCode(...b.subarray(6, 10)) === 'JFIF') {
      const d = Math.min(65535, Math.round(dpi));
      b[13] = 1; b[14] = d >> 8; b[15] = d & 255; b[16] = d >> 8; b[17] = d & 255;
    }
    return new Blob([b], { type: blob.type });
  }
  // PNG: insert a pHYs chunk right after IHDR (8-byte signature + 25-byte IHDR chunk)
  const ppm = Math.round(dpi / 0.0254), chunk = new Uint8Array(21), dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  return new Blob([b.subarray(0, 33), chunk, b.subarray(33)], { type: blob.type });
}

// Turns one of pdf.js's decoded images into a canvas.
function imageToCanvas(img) {
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  if (img.bitmap) { c.width = img.bitmap.width; c.height = img.bitmap.height; ctx.drawImage(img.bitmap, 0, 0); return c; }
  const { width: w, height: h, kind, data } = img;
  if (!w || !h || !data) return null;
  c.width = w; c.height = h;
  const out = ctx.createImageData(w, h), d = out.data;
  if (kind === ImageKind.RGBA_32BPP) d.set(data.subarray(0, d.length));
  else if (kind === ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) { d[i * 4] = data[j]; d[i * 4 + 1] = data[j + 1]; d[i * 4 + 2] = data[j + 2]; d[i * 4 + 3] = 255; }
  } else if (kind === ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const on = data[y * rowBytes + (x >> 3)] & (128 >> (x & 7)), v = on ? 255 : 0, i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  } else return null;
  ctx.putImageData(out, 0, 0);
  return c;
}

function resized(c, o) {
  if (o.sizeMode === 'original') return c;
  const s = clampScale(pageScale(o, c.width, c.height), c.width, c.height).scale;
  const w = Math.max(1, Math.round(c.width * s)), h = Math.max(1, Math.round(c.height * s));
  if (w === c.width && h === c.height) return c;
  const r = document.createElement('canvas'); r.width = w; r.height = h;
  const ctx = r.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(c, 0, 0, w, h);
  return r;
}
// JPEG has no transparency: put the picture on white so transparent parts do not turn black.
function flatten(c) {
  const r = document.createElement('canvas'); r.width = c.width; r.height = c.height;
  const ctx = r.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.width, r.height); ctx.drawImage(c, 0, 0);
  return r;
}

function getObj(page, id) {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise(res => {
    const t = setTimeout(() => res(null), 15000);
    try { store.get(id, v => { clearTimeout(t); res(v); }); } catch { clearTimeout(t); res(null); }
  });
}

/* ------------------------------------------------------------------ saving the PDF itself */
// A minimal PDF: one JPEG picture per page, filling the page.
function buildPdf(images) { // [{ jpeg: Uint8Array, w, h }]
  const enc = new TextEncoder(), chunks = [], offs = [];
  let pos = 0;
  const push = x => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); pos += b.length; };
  const obj = (id, ...body) => { offs[id] = pos; push(`${id} 0 obj\n`); body.forEach(push); push('\nendobj\n'); };
  push('%PDF-1.4\n%âãÏÓ\n');
  const n = images.length, kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  images.forEach((im, i) => {
    const W = im.w > im.h ? 841.89 : 595.28, H = +(W * im.h / im.w).toFixed(2); // A4 width; height keeps the picture's shape
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(3 + i * 3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${5 + i * 3} 0 R >> >> /Contents ${4 + i * 3} 0 R >>`);
    obj(4 + i * 3, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    obj(5 + i * 3, `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`, im.jpeg, '\nendstream');
  });
  const xref = pos, size = 3 + n * 3;
  push(`xref\n0 ${size}\n0000000000 65535 f \n` + offs.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join(''));
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

// The PDF of a list entry: a real PDF exactly as it was received, or a screen capture made into one.
async function pdfOf(s) {
  if (s.kind !== 'shots') return new Blob([await s.load()], { type: 'application/pdf' });
  const images = [];
  for (const blob of s.parts) {
    const bm = await createImageBitmap(blob);
    // a long image (pages not told apart) is cut into A4-shaped pages
    const sliceH = s.perPage ? bm.height : Math.round(bm.width * Math.SQRT2);
    for (let y = 0; y < bm.height; y += sliceH) {
      const h = Math.min(sliceH, bm.height - y);
      const c = document.createElement('canvas'); c.width = bm.width; c.height = h;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, h); ctx.drawImage(bm, 0, y, bm.width, h, 0, 0, bm.width, h);
      images.push({ jpeg: new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', 0.92)).arrayBuffer()), w: c.width, h });
      c.width = c.height = 0;
    }
    bm.close();
  }
  return buildPdf(images);
}
const pdfFileName = s => clean(s.name.replace(/\.pdf$/i, '')) + '.pdf';

// [Save PDF] on a list entry: saves it straight away to the place chosen in step 2 (not into the images' subfolder).
async function savePdfNow(s, btn) {
  showErr('');
  const o = readOpts();
  if (o.dest === 'folder') {
    if (!dirHandle) { showErr('Choose a folder in step 2 first (or pick "My Downloads folder").'); $('chooseDir').focus(); return; }
    try { if (!(await ensureDirPermission())) { showErr('Chrome was not allowed to save into that folder. Press Save PDF again and choose "Allow".'); return; } }
    catch (e) { showErr('The folder could not be opened (' + (e.message || e) + '). Choose it again.'); setDir(null); return; }
  }
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Saving…';
  const sink = o.dest === 'folder' ? new FolderSink(dirHandle, o.exists) : new DownloadsSink(clean(o.dlFolder || 'PDF images'), o.exists);
  if (sink.listen) { sink.listen(); setTimeout(() => chrome.downloads.onChanged.removeListener(sink.onChanged), 120000); }
  try {
    const name = await sink.write(await sink.dir(''), pdfFileName(s), await pdfOf(s));
    const where = o.dest === 'folder' ? dirHandle.name : 'Downloads/' + await sink.dir('');
    setTabMsg(name ? `Saved "${name}" in ${where}.` : `"${pdfFileName(s)}" is already in ${where} - skipped (see "If a file with the same name is already there").`, name ? 'ok' : '');
  } catch (e) {
    showErr('Could not save the PDF: ' + (e.message || e));
  } finally { btn.disabled = false; btn.textContent = label; }
}

/* ------------------------------------------------------------------ converting */
async function convert() {
  showErr('');
  const o = readOpts();
  saveOpts();
  if (o.dest === 'folder') {
    // asked first, while Chrome still counts this as a click (it may show "allow this site to edit files?")
    try { if (!(await ensureDirPermission())) { showErr('Chrome was not allowed to save into that folder. Press Convert again and choose "Allow", or choose another folder.'); return; } }
    catch (e) { showErr('The folder could not be opened (' + (e.message || e) + '). Choose it again.'); setDir(null); return; }
  }
  const plans = [];
  try { for (const s of sources) plans.push({ s, pages: s.kind === 'shots' && !s.perPage ? s.parts.map((_, i) => i + 1) : parseRange(o.pages, s.pages) }); }
  catch (e) { showErr(e.message); $('pages').focus(); return; }
  const total = plans.reduce((n, p) => n + p.pages.length, 0);
  if (!total) { showErr('None of the pages you listed are in the PDF' + (sources.length > 1 ? 's.' : '.')); return; }

  const sink = o.dest === 'folder' ? new FolderSink(dirHandle, o.exists) : new DownloadsSink(clean(o.dlFolder || 'PDF images'), o.exists);
  if (sink.listen) sink.listen();
  const type = 'image/' + o.format, q = o.format === 'png' ? undefined : Number(o.quality) / 100, ext = EXT[o.format];
  const embedded = o.mode === 'embedded';

  busy = true; cancelled = false; updateStart();
  $('cancel').hidden = false; $('progressBox').hidden = false; $('log').textContent = ''; $('log').hidden = true;
  document.querySelectorAll('section input, section select, section button').forEach(e => { e.dataset.was = e.disabled; e.disabled = true; });
  let done = 0, saved = 0, skipped = 0, failed = 0, small = 0, limitedPages = 0;
  const t0 = performance.now();
  const progress = text => { $('barFill').style.width = (100 * done / total).toFixed(1) + '%'; $('status').textContent = text; };

  try {
    for (const [fi, { s, pages }] of plans.entries()) {
      if (cancelled) break;
      const stem = clean(o.prefix.trim() || baseName(s.name));
      const dir = await sink.dir(o.subfolder ? clean(baseName(s.name)) : '');
      const where = o.dest === 'folder' ? `${dirHandle.name}${o.subfolder ? '/' + clean(baseName(s.name)) : ''}` : `Downloads/${await sink.dir(o.subfolder ? clean(baseName(s.name)) : '')}`;
      log(`${s.name}: ${pages.length} page${pages.length === 1 ? '' : 's'} → ${where}`);
      if (o.alsoPdf) {
        try { const n = await sink.write(dir, pdfFileName(s), await pdfOf(s)); log(n ? `  saved the PDF as "${n}"` : '  the PDF is already there - skipped'); }
        catch (e) { log(`  could not save the PDF: ${e.message || e}`); }
      }
      const width = Math.max(o.pad ? String(s.pages).length : 0, o.pad ? 3 : 0);
      const num = n => String(n).padStart(width, '0');
      if (s.kind === 'shots') {
        for (const i of pages.map(p => p - 1)) {
          const blob = s.parts[i];
          if (cancelled) break;
          progress(`${s.name} · image ${i + 1} of ${s.parts.length}`);
          try {
            const bm = await createImageBitmap(blob);
            let c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; c.getContext('2d').drawImage(bm, 0, 0); bm.close();
            if (o.sizeMode !== 'dpi' && o.sizeMode !== 'original') c = resized(c, o);
            if (o.format === 'jpeg') c = flatten(c);
            if (o.format === 'webp' && c.height > 16383) throw new Error('too tall for WebP - choose PNG or JPEG');
            const name = await sink.write(dir, s.perPage ? `${stem}-page-${num(i + 1)}.${ext}` : `${stem}${s.parts.length > 1 ? '-part-' + (i + 1) : ''}.${ext}`, await canvasToBlob(c, type, q));
            if (name) saved++; else skipped++;
          } catch (e) { failed++; log(`  image ${i + 1}: failed - ${e.message || e}`); }
          done++;
        }
        continue;
      }
      const doc = await openPdf(await s.load(), s.name);
      const seen = new Set();
      try {
        for (const pn of pages) {
          if (cancelled) break;
          const prefix = sources.length > 1 ? `PDF ${fi + 1} of ${sources.length} · ` : '';
          progress(`${prefix}${s.name} · page ${pn} (${done + 1} of ${total})`);
          const page = await doc.getPage(pn);
          try {
            if (!embedded) {
              const vp1 = page.getViewport({ scale: 1 });
              const { scale, limited } = clampScale(pageScale(o, vp1.width, vp1.height), vp1.width, vp1.height);
              if (limited) limitedPages++;
              const vp = page.getViewport({ scale });
              const c = document.createElement('canvas');
              c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
              const bg = o.bg === 'transparent' && o.format !== 'jpeg' ? 'rgba(0,0,0,0)' : '#ffffff';
              await page.render({ canvasContext: c.getContext('2d', { alpha: true }), viewport: vp, background: bg }).promise;
              const blob = await withDpi(await canvasToBlob(c, type, q), o.format, scale * 72);
              c.width = c.height = 0; // free the memory straight away
              const name = await sink.write(dir, `${stem}-page-${num(pn)}.${ext}`, blob);
              if (name) { saved++; } else { skipped++; }
            } else {
              const ops = await page.getOperatorList();
              let k = 0;
              for (let i = 0; i < ops.fnArray.length; i++) {
                const fn = ops.fnArray[i], args = ops.argsArray[i];
                let img = null, id = null;
                if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
                  id = args[0];
                  if (seen.has(id)) continue; // the same picture used again (logos etc.)
                  seen.add(id);
                  img = await getObj(page, id);
                } else if (fn === OPS.paintInlineImageXObject) img = args[0];
                else continue;
                if (!img) { failed++; continue; }
                let c = imageToCanvas(img);
                if (!c) { failed++; log(`  page ${pn}: one picture uses an image type that cannot be saved - skipped`); continue; }
                if (Math.min(c.width, c.height) < Number(o.minSize || 0)) { small++; continue; }
                c = resized(c, o);
                if (o.format === 'jpeg') c = flatten(c);
                const blob = await canvasToBlob(c, type, q);
                const name = await sink.write(dir, `${stem}-p${num(pn)}-img${++k}.${ext}`, blob);
                if (name) saved++; else skipped++;
              }
            }
          } catch (e) {
            failed++; log(`  page ${pn}: failed - ${e.message || e}`);
          } finally { page.cleanup(); }
          done++;
        }
      } finally { await doc.destroy(); }
    }
  } catch (e) {
    showErr('Stopped: ' + (e.message || e));
    if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') { setDir(null); showErr('Stopped: the folder is no longer available or Chrome lost permission to it. Choose the folder again.'); }
  } finally {
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    progress('');
    const parts = [`${saved} image${saved === 1 ? '' : 's'} saved in ${secs}s`];
    if (skipped) parts.push(`${skipped} skipped (already there)`);
    if (small) parts.push(`${small} small picture${small === 1 ? '' : 's'} left out`);
    if (failed) parts.push(`${failed} failed`);
    if (limitedPages) parts.push(`${limitedPages} page${limitedPages === 1 ? ' was' : 's were'} made smaller to fit Chrome's maximum image size`);
    if (embedded && !saved && !failed && !cancelled) parts.push('no pictures found - the PDF may be text and drawings only (try "Each page as an image")');
    $('status').textContent = (cancelled ? 'Cancelled. ' : 'Done. ') + parts.join(' · ') + '.';
    log($('status').textContent);
    if (sink.listen) setTimeout(() => chrome.downloads.onChanged.removeListener(sink.onChanged), 120000);
    busy = false; $('cancel').hidden = true;
    document.querySelectorAll('section input, section select, section button').forEach(e => { e.disabled = e.dataset.was === 'true'; });
    syncUi();
  }
}

$('start').addEventListener('click', () => { if (!busy) convert(); });
$('cancel').addEventListener('click', () => { cancelled = true; $('status').textContent = 'Cancelling after this page…'; });
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

/* ------------------------------------------------------------------ side panel: follows the tab you are on */
const IN_PANEL = !(await chrome.tabs.getCurrent());
const PANEL_WIN = IN_PANEL ? (await chrome.windows.getCurrent()).id : null;
async function activeTab() { const [t] = await chrome.tabs.query({ active: true, windowId: PANEL_WIN }); return t; }
async function updateCurTab() {
  if (!IN_PANEL) return;
  const t = await activeTab(), ok = t && /^(https?|file):/i.test(t.url || '');
  $('curTab').hidden = !ok;
  if (!ok) return;
  $('curTitle').textContent = t.title || t.url;
  const url = pdfUrlOf(t.url), have = sources.some(s => s.url === url || s.tabUrl === url);
  $('curAdd').disabled = have || loading.size > 0;
  $('curAdd').textContent = have ? 'Added' : loading.size ? 'Looking…' : "Add this tab's PDF";
  $('curAdd').onclick = () => { showErr(''); $('fileAccess').hidden = true; loadFromTab(t.url, t.title || '', { tabId: t.id }); };
  $('curShot').onclick = () => { showCapture(t.id, t.title || ''); captureScreen(t.id, t.title || ''); };
}
if (IN_PANEL) {
  chrome.tabs.onActivated.addListener(i => { if (i.windowId === PANEL_WIN) updateCurTab(); });
  chrome.tabs.onUpdated.addListener((id, info, t) => { if (t.active && t.windowId === PANEL_WIN && (info.status === 'complete' || info.title)) updateCurTab(); });
}
$('fullTab').addEventListener('click', async e => {
  e.preventDefault();
  const t = IN_PANEL && await activeTab();
  let url = chrome.runtime.getURL('app.html');
  if (t && /^(https?|file):/i.test(t.url || '')) url += '?src=' + encodeURIComponent(t.url) + '&title=' + encodeURIComponent(t.title || '') + '&tab=' + t.id;
  chrome.tabs.create({ url });
});

/* ------------------------------------------------------------------ start up */
(async () => {
  await loadOpts();
  if (!HAS_PICKER) {
    // e.g. Brave turns the folder picker off: fall back to the Downloads folder
    const f = document.querySelector('input[name=dest][value=folder]');
    f.disabled = true; f.parentElement.title = 'This browser does not let extensions pick a folder';
    document.querySelector('input[name=dest][value=downloads]').checked = true;
    $('chooseDir').disabled = true;
  } else {
    try { const h = await kv('get', 'dir'); if (h) setDir(h); } catch { /* no remembered folder */ }
  }
  lastSizeMode = $('sizeMode').value;
  const q = new URLSearchParams(location.search);
  if (IN_PANEL) {
    document.body.classList.add('panel');
    const { pendingLink } = await chrome.storage.session.get('pendingLink').catch(() => ({}));
    if (pendingLink && Date.now() - pendingLink.time < 15000) { chrome.storage.session.remove('pendingLink'); loadFromTab(pendingLink.url, ''); }
    else {
      const t = await activeTab();
      if (t && /^(https?|file):/i.test(t.url || '')) loadFromTab(t.url, t.title || '', { tabId: t.id });
      else setTabMsg('Open a PDF (or a page showing one, like Teams or SharePoint) and press "Add this tab\'s PDF".');
    }
  } else if (q.get('src')) loadFromTab(q.get('src'), q.get('title') || '', { tabId: Number(q.get('tab')) || undefined });
  else setTabMsg('Open a PDF in Chrome and click the extension icon, or add one below.');
  updateCurTab();
  listOpenPdfs();
  OPT_IDS.forEach(id => $(id).addEventListener(id === 'quality' || id === 'sizeVal' ? 'input' : 'change', () => { syncUi(); saveOpts(); }));
  document.querySelectorAll('input[name=dest]').forEach(r => r.addEventListener('change', () => { syncUi(); saveOpts(); }));
  syncUi();
})();
