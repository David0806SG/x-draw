/* =========================================================================
   x-draw — a lightweight Excalidraw-style whiteboard
   Features: hand-drawn shapes (rough.js), arrows, freehand, text notes,
   images, multi-scene sidebar with search, autosave to localStorage,
   undo/redo, zoom/pan, PNG export, .xdraw save/open.
   ========================================================================= */

'use strict';

// ---------- constants ----------
const FONT_FAMILY = '"Excalifont", "Patrick Hand", "Segoe Print", "Comic Sans MS", cursive';
const LINE_HEIGHT = 1.25;
const STROKE_COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00'];
const BG_COLORS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99'];
const MIN_ZOOM = 0.1, MAX_ZOOM = 5;
const LS_INDEX = 'xdraw.scenes';
const LS_SCENE = 'xdraw.scene.';
const LS_THUMB = 'xdraw.thumb.';
const LS_LAST = 'xdraw.lastScene';

// ---------- state ----------
const state = {
  tool: 'select',
  elements: [],
  selection: new Set(),
  scroll: { x: 0, y: 0 },
  zoom: 1,
  sceneId: null,
  scenes: [],           // [{id, name, updatedAt}]
  editingId: null,      // element id currently in the textarea editor
  spaceDown: false,
  props: {
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    edges: 'round',
    fontSize: 20,
    opacity: 100,
  },
};

let history = [];
let redoStack = [];
const HISTORY_MAX = 100;

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvas-wrap');
const gen = rough.generator();
const rc = rough.canvas(canvas);
const drawableCache = new Map();   // id -> {v, drawables:[]}
const imageCache = new Map();      // id -> HTMLImageElement

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const seed = () => Math.floor(Math.random() * 2 ** 31);

function toScene(sx, sy) {
  return { x: (sx - state.scroll.x) / state.zoom, y: (sy - state.scroll.y) / state.zoom };
}
function toScreen(x, y) {
  return { x: x * state.zoom + state.scroll.x, y: y * state.zoom + state.scroll.y };
}
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function touch(el) { el.v = (el.v || 0) + 1; }

function getBounds(el) {
  if (el.points && el.points.length) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [px, py] of el.points) {
      x1 = Math.min(x1, px); y1 = Math.min(y1, py);
      x2 = Math.max(x2, px); y2 = Math.max(y2, py);
    }
    return { x1: el.x + x1, y1: el.y + y1, x2: el.x + x2, y2: el.y + y2 };
  }
  return { x1: el.x, y1: el.y, x2: el.x + el.w, y2: el.y + el.h };
}

function boundsOf(els) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const el of els) {
    const b = getAABB(el);
    x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1);
    x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
  }
  return { x1, y1, x2, y2 };
}

function rotatePoint(px, py, cx, cy, ang) {
  const dx = px - cx, dy = py - cy;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

// axis-aligned bounding box including rotation (for export, marquee, zoom-to-fit)
function getAABB(el) {
  const b = getBounds(el);
  if (!el.angle) return b;
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  const pts = [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]]
    .map(([x, y]) => rotatePoint(x, y, cx, cy, el.angle));
  return {
    x1: Math.min(...pts.map(p => p.x)), y1: Math.min(...pts.map(p => p.y)),
    x2: Math.max(...pts.map(p => p.x)), y2: Math.max(...pts.map(p => p.y)),
  };
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitTest(el, pt, threshold) {
  if (el.angle) {
    const bb = getBounds(el);
    pt = rotatePoint(pt.x, pt.y, (bb.x1 + bb.x2) / 2, (bb.y1 + bb.y2) / 2, -el.angle);
  }
  const b = getBounds(el);
  const th = threshold;
  if (pt.x < b.x1 - th || pt.x > b.x2 + th || pt.y < b.y1 - th || pt.y > b.y2 + th) return false;
  if (el.points && el.points.length > 1) {
    const tol = Math.max(th, el.strokeWidth + 4);
    for (let i = 0; i < el.points.length - 1; i++) {
      const a = { x: el.x + el.points[i][0], y: el.y + el.points[i][1] };
      const c = { x: el.x + el.points[i + 1][0], y: el.y + el.points[i + 1][1] };
      if (distToSegment(pt, a, c) <= tol) return true;
    }
    return false;
  }
  return true;
}

function topElementAt(pt) {
  const th = 6 / state.zoom;
  for (let i = state.elements.length - 1; i >= 0; i--) {
    if (hitTest(state.elements[i], pt, th)) return state.elements[i];
  }
  return null;
}

function selectedEls() {
  return state.elements.filter(el => state.selection.has(el.id));
}

// ---------- arrow-to-shape binding ----------
const BINDABLE = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'image']);
let bindHighlight = null; // id of the shape highlighted as a bind target

function byId(id) { return state.elements.find(e => e.id === id); }

function bindableAt(pt, excludeId) {
  const th = 10 / state.zoom;
  for (let i = state.elements.length - 1; i >= 0; i--) {
    const el = state.elements[i];
    if (el.id === excludeId || !BINDABLE.has(el.type) || el.containerId) continue;
    const b = getBounds(el);
    if (pt.x >= b.x1 - th && pt.x <= b.x2 + th && pt.y >= b.y1 - th && pt.y <= b.y2 + th) return el;
  }
  return null;
}

function shapeCenter(el) {
  const b = getBounds(el);
  return { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
}

// point on the border of `el` (padded by gap) along the ray center -> toward
function borderPoint(el, toward, gap = 5) {
  const c = shapeCenter(el);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const b = getBounds(el);
  const hw = (b.x2 - b.x1) / 2 + gap, hh = (b.y2 - b.y1) / 2 + gap;
  let t;
  if (el.type === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else if (el.type === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

function recomputeBoundArrow(arrow) {
  if (arrow.type !== 'arrow' || !arrow.points || arrow.points.length < 2) return;
  const sEl = arrow.startBinding && byId(arrow.startBinding.elementId);
  const eEl = arrow.endBinding && byId(arrow.endBinding.elementId);
  if (arrow.startBinding && !sEl) delete arrow.startBinding;
  if (arrow.endBinding && !eEl) delete arrow.endBinding;
  if (!sEl && !eEl) return;
  const last = arrow.points.length - 1;
  const a = { x: arrow.x + arrow.points[0][0], y: arrow.y + arrow.points[0][1] };
  const b = { x: arrow.x + arrow.points[last][0], y: arrow.y + arrow.points[last][1] };
  const na = sEl ? borderPoint(sEl, eEl ? shapeCenter(eEl) : b) : a;
  const nb = eEl ? borderPoint(eEl, sEl ? shapeCenter(sEl) : na) : b;
  // keep intermediate points visually in place while re-anchoring the origin
  const shiftX = arrow.x - na.x, shiftY = arrow.y - na.y;
  for (let i = 1; i < last; i++) {
    arrow.points[i] = [arrow.points[i][0] + shiftX, arrow.points[i][1] + shiftY];
  }
  arrow.x = na.x; arrow.y = na.y;
  arrow.points[0] = [0, 0];
  arrow.points[last] = [nb.x - na.x, nb.y - na.y];
  touch(arrow);
}

function updateArrowsBoundTo(ids) {
  for (const el of state.elements) {
    if (el.type !== 'arrow') continue;
    if ((el.startBinding && ids.has(el.startBinding.elementId)) ||
        (el.endBinding && ids.has(el.endBinding.elementId))) {
      recomputeBoundArrow(el);
    }
  }
}

function clearBindingsTo(ids) {
  for (const el of state.elements) {
    if (el.type !== 'arrow') continue;
    if (el.startBinding && ids.has(el.startBinding.elementId)) { delete el.startBinding; touch(el); }
    if (el.endBinding && ids.has(el.endBinding.elementId)) { delete el.endBinding; touch(el); }
  }
}

// ---------- shape labels (container text) ----------
const CONTAINERABLE = new Set(['rectangle', 'diamond', 'ellipse']);

// usable text width inside a container (ellipse/diamond get their inscribed width)
function labelMaxWidth(c) {
  const w = c.type === 'ellipse' ? c.w * 0.7 : c.type === 'diamond' ? c.w * 0.55 : c.w - 16;
  return Math.max(24, w);
}

// word-wrap text to maxW, breaking overlong words by character
function wrapText(text, fontSize, maxW) {
  ctx.save();
  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  const out = [];
  for (const line of String(text).split('\n')) {
    if (ctx.measureText(line).width <= maxW) { out.push(line); continue; }
    let cur = '';
    for (const word of line.split(' ')) {
      const trial = cur ? cur + ' ' + word : word;
      if (ctx.measureText(trial).width <= maxW) { cur = trial; continue; }
      if (cur) out.push(cur);
      if (ctx.measureText(word).width > maxW) {
        let chunk = '';
        for (const chr of word) {
          if (chunk && ctx.measureText(chunk + chr).width > maxW) { out.push(chunk); chunk = chr; }
          else chunk += chr;
        }
        cur = chunk;
      } else {
        cur = word;
      }
    }
    out.push(cur);
  }
  ctx.restore();
  return out.join('\n');
}

// keep a container's label wrapped to its width, centered, and matching its rotation.
// labels keep the user's original text in rawText; text holds the wrapped version.
function syncLabel(container) {
  if (!container.labelId) return;
  const t = byId(container.labelId);
  if (!t) { delete container.labelId; return; }
  const raw = t.rawText !== undefined ? t.rawText : t.text;
  t.rawText = raw;
  t.text = wrapText(raw, t.fontSize, labelMaxWidth(container));
  remeasure(t);
  t.x = container.x + (container.w - t.w) / 2;
  t.y = container.y + (container.h - t.h) / 2;
  t.angle = container.angle || 0;
  touch(t);
}

// expand a set of ids with the label ids of any containers in it
function withLabels(ids) {
  const out = new Set(ids);
  for (const id of ids) {
    const el = byId(id);
    if (el && el.labelId) out.add(el.labelId);
  }
  return out;
}

// ---------- text measurement ----------
function measureText(text, fontSize) {
  ctx.save();
  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  const lines = String(text).split('\n');
  let w = 10;
  for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
  ctx.restore();
  return { w: Math.ceil(w) + 4, h: Math.ceil(lines.length * fontSize * LINE_HEIGHT) };
}
function remeasure(el) {
  const m = measureText(el.text, el.fontSize);
  el.w = m.w; el.h = m.h;
}

// ---------- element factory ----------
function newElement(type, x, y) {
  const p = state.props;
  return {
    id: uid(), type, x, y, w: 0, h: 0, angle: 0,
    strokeColor: p.strokeColor, backgroundColor: p.backgroundColor,
    fillStyle: p.fillStyle, strokeWidth: p.strokeWidth, strokeStyle: p.strokeStyle,
    edges: p.edges, opacity: p.opacity, seed: seed(), v: 0,
  };
}

// ---------- rough drawables ----------
function roughOpts(el) {
  const o = {
    seed: el.seed, roughness: 1.2, bowing: 1,
    stroke: el.strokeColor, strokeWidth: el.strokeWidth,
    preserveVertices: true,
    disableMultiStroke: el.strokeStyle !== 'solid',
  };
  const fillable = el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse';
  if (fillable && el.backgroundColor && el.backgroundColor !== 'transparent') {
    o.fill = el.backgroundColor;
    o.fillStyle = el.fillStyle;
    o.fillWeight = el.strokeWidth / 2;
    o.hachureGap = 4 + el.strokeWidth * 2;
  }
  if (el.strokeStyle === 'dashed') o.strokeLineDash = [8, 9];
  if (el.strokeStyle === 'dotted') o.strokeLineDash = [1.5, 7];
  return o;
}

function roundedRectPath(w, h, r) {
  return `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} ` +
         `L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
}

function buildDrawables(el) {
  const o = roughOpts(el);
  const w = Math.max(el.w, 1), h = Math.max(el.h, 1);
  switch (el.type) {
    case 'rectangle': {
      if (el.edges === 'round') {
        const r = Math.min(32, Math.min(w, h) * 0.25);
        return [gen.path(roundedRectPath(w, h, r), o)];
      }
      return [gen.rectangle(0, 0, w, h, o)];
    }
    case 'diamond':
      return [gen.polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], o)];
    case 'ellipse':
      return [gen.ellipse(w / 2, h / 2, w, h, o)];
    case 'line':
      return [el.points.length > 2 && el.edges !== 'sharp'
        ? gen.curve(el.points, o) : gen.linearPath(el.points, o)];
    case 'draw': {
      if (el.points.length < 3) return [gen.linearPath(el.points, o)];
      return [gen.curve(el.points, { ...o, roughness: 0.6, bowing: 0 })];
    }
    case 'arrow': {
      const pts = el.points;
      const ds = [pts.length > 2 && el.edges !== 'sharp'
        ? gen.curve(pts, o) : gen.linearPath(pts, o)];
      if (pts.length >= 2) {
        const [x2, y2] = pts[pts.length - 1];
        let i = pts.length - 2;
        while (i > 0 && Math.hypot(x2 - pts[i][0], y2 - pts[i][1]) < 4) i--;
        const [x1, y1] = pts[i];
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.min(24, Math.max(12, Math.hypot(x2 - x1, y2 - y1) * 0.25));
        const a1 = ang + Math.PI + 0.44, a2 = ang + Math.PI - 0.44;
        const ho = { ...o, strokeLineDash: undefined, disableMultiStroke: true };
        ds.push(gen.line(x2, y2, x2 + len * Math.cos(a1), y2 + len * Math.sin(a1), ho));
        ds.push(gen.line(x2, y2, x2 + len * Math.cos(a2), y2 + len * Math.sin(a2), ho));
      }
      return ds;
    }
  }
  return [];
}

function getDrawables(el) {
  const c = drawableCache.get(el.id);
  if (c && c.v === el.v) return c.drawables;
  const drawables = buildDrawables(el);
  drawableCache.set(el.id, { v: el.v, drawables });
  return drawables;
}

// ---------- rendering ----------
function renderElement(context, roughCanvas, el) {
  context.save();
  context.globalAlpha = (el.opacity ?? 100) / 100;
  if (el.angle) {
    const b = getBounds(el);
    const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    context.translate(cx, cy);
    context.rotate(el.angle);
    context.translate(-cx, -cy);
  }
  context.translate(el.x, el.y);
  if (el.type === 'text') {
    context.font = `${el.fontSize}px ${FONT_FAMILY}`;
    context.fillStyle = el.strokeColor;
    context.textBaseline = 'alphabetic';
    const lh = el.fontSize * LINE_HEIGHT;
    const lines = String(el.text).split('\n');
    const center = !!el.containerId; // labels are center-aligned per line
    lines.forEach((line, i) => {
      const ox = center ? Math.max(0, (el.w - context.measureText(line).width) / 2) : 0;
      context.fillText(line, ox, i * lh + el.fontSize * 0.9);
    });
  } else if (el.type === 'image') {
    const img = imageCache.get(el.id);
    if (img && img.complete && img.naturalWidth) {
      context.drawImage(img, 0, 0, el.w, el.h);
    } else {
      context.strokeStyle = '#ccc';
      context.strokeRect(0, 0, el.w, el.h);
      if (!img) {
        const im = new Image();
        im.onload = () => requestRender();
        im.src = el.dataURL;
        imageCache.set(el.id, im);
      }
    }
  } else {
    for (const d of getDrawables(el)) roughCanvas.draw(d);
  }
  context.restore();
}

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

let marquee = null; // {x1,y1,x2,y2} in scene coords

function render() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // solid light background: dark mode inverts the whole canvas via a CSS filter,
  // so content is always painted in light-mode colors
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  ctx.save();
  ctx.translate(state.scroll.x, state.scroll.y);
  ctx.scale(state.zoom, state.zoom);
  for (const el of state.elements) {
    if (el.id === state.editingId) continue;
    renderElement(ctx, rc, el);
  }
  ctx.restore();
  drawSelectionUI();
  updateHistButtons();
}

function drawSelectionUI() {
  const sel = selectedEls();
  ctx.save();

  if (bindHighlight) {
    const bEl = byId(bindHighlight);
    if (bEl) {
      const b = getBounds(bEl);
      const p1 = toScreen(b.x1, b.y1), p2 = toScreen(b.x2, b.y2);
      ctx.strokeStyle = 'rgba(105,101,219,0.4)';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.roundRect(p1.x - 6, p1.y - 6, p2.x - p1.x + 12, p2.y - p1.y + 12, 6);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = '#6965db';
  ctx.lineWidth = 1;
  for (const el of sel) {
    const b = getBounds(el);
    const cs = toScreen((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
    const w = (b.x2 - b.x1) * state.zoom, h = (b.y2 - b.y1) * state.zoom;
    ctx.save();
    ctx.translate(cs.x, cs.y);
    ctx.rotate(el.angle || 0);
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8);
    ctx.restore();
  }
  if (sel.length === 1 && isTwoPointLinear(sel[0])) {
    ctx.setLineDash([]);
    for (const h of endpointHandles(sel[0])) {
      if (h.mid) {
        ctx.fillStyle = 'rgba(105,101,219,0.25)';
        ctx.beginPath();
        ctx.arc(h.x, h.y, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(h.x, h.y, 4, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      } else {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(h.x, h.y, 5.5, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
  } else if (sel.length === 1 && sel[0].type !== 'draw') {
    ctx.setLineDash([]);
    for (const h of handlePositions(sel[0])) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      if (h.d === 'rot') ctx.arc(h.x, h.y, 5.5, 0, Math.PI * 2);
      else ctx.rect(h.x - 4.5, h.y - 4.5, 9, 9);
      ctx.fill(); ctx.stroke();
    }
  }
  if (marquee) {
    const p1 = toScreen(marquee.x1, marquee.y1), p2 = toScreen(marquee.x2, marquee.y2);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(105,101,219,0.08)';
    ctx.strokeStyle = 'rgba(105,101,219,0.5)';
    ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
    ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
  }
  ctx.restore();
}

const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
function handlePositions(el) {
  const b = getBounds(el);
  const p1 = toScreen(b.x1, b.y1), p2 = toScreen(b.x2, b.y2);
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const M = 4;
  const hs = [
    { d: 'nw', x: p1.x - M, y: p1.y - M }, { d: 'n', x: mx, y: p1.y - M },
    { d: 'ne', x: p2.x + M, y: p1.y - M }, { d: 'e', x: p2.x + M, y: my },
    { d: 'se', x: p2.x + M, y: p2.y + M }, { d: 's', x: mx, y: p2.y + M },
    { d: 'sw', x: p1.x - M, y: p2.y + M }, { d: 'w', x: p1.x - M, y: my },
    { d: 'rot', x: mx, y: p1.y - M - 22 },
  ];
  if (el.angle) {
    for (const h of hs) {
      const r = rotatePoint(h.x, h.y, mx, my, el.angle);
      h.x = r.x; h.y = r.y;
    }
  }
  return hs;
}
function isTwoPointLinear(el) {
  return (el.type === 'arrow' || el.type === 'line') && !!el.points;
}

// a handle on every point, plus an insert-handle in the middle of every segment
function endpointHandles(el) {
  const abs = el.points.map(([px, py]) => toScreen(el.x + px, el.y + py));
  const hs = abs.map((p, i) => ({ d: 'pt:' + i, x: p.x, y: p.y }));
  for (let i = 0; i < abs.length - 1; i++) {
    hs.push({ d: 'seg:' + i, x: (abs[i].x + abs[i + 1].x) / 2, y: (abs[i].y + abs[i + 1].y) / 2, mid: true });
  }
  return hs;
}

function handleAt(screenPt) {
  const sel = selectedEls();
  if (sel.length !== 1 || sel[0].type === 'draw') return null;
  if (isTwoPointLinear(sel[0])) {
    for (const h of endpointHandles(sel[0])) {
      if (Math.hypot(screenPt.x - h.x, screenPt.y - h.y) <= 9) return h.d;
    }
    return null;
  }
  for (const h of handlePositions(sel[0])) {
    if (Math.abs(screenPt.x - h.x) <= 7 && Math.abs(screenPt.y - h.y) <= 7) return h.d;
  }
  return null;
}

// ---------- history ----------
function pushHistory() {
  history.push(JSON.stringify(state.elements));
  if (history.length > HISTORY_MAX) history.shift();
  redoStack = [];
}
function undo() {
  if (!history.length) return;
  redoStack.push(JSON.stringify(state.elements));
  state.elements = JSON.parse(history.pop());
  state.selection.clear();
  scheduleSave(); requestRender();
}
function redo() {
  if (!redoStack.length) return;
  history.push(JSON.stringify(state.elements));
  state.elements = JSON.parse(redoStack.pop());
  state.selection.clear();
  scheduleSave(); requestRender();
}
function updateHistButtons() {
  document.getElementById('btn-undo').disabled = !history.length;
  document.getElementById('btn-redo').disabled = !redoStack.length;
}

// ---------- scenes / persistence ----------
function loadIndex() {
  try { state.scenes = JSON.parse(localStorage.getItem(LS_INDEX)) || []; }
  catch { state.scenes = []; }
}
function saveIndex() {
  localStorage.setItem(LS_INDEX, JSON.stringify(state.scenes));
}

let saveTimer = null, thumbTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentScene, 400);
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(saveThumbnail, 1600);
}

function saveCurrentScene() {
  if (!state.sceneId) return;
  try {
    localStorage.setItem(LS_SCENE + state.sceneId, JSON.stringify(state.elements));
  } catch (err) {
    console.warn('localStorage quota exceeded; scene not saved', err);
  }
  const meta = state.scenes.find(s => s.id === state.sceneId);
  if (meta) { meta.updatedAt = Date.now(); saveIndex(); }
  renderSceneList();
}

function saveThumbnail() {
  if (!state.sceneId) return;
  const tc = document.createElement('canvas');
  tc.width = 176; tc.height = 136;
  const tctx = tc.getContext('2d');
  tctx.fillStyle = '#fff';
  tctx.fillRect(0, 0, tc.width, tc.height);
  if (state.elements.length) {
    const b = boundsOf(state.elements);
    const pad = 12;
    const sc = Math.min((tc.width - pad) / Math.max(b.x2 - b.x1, 1),
                        (tc.height - pad) / Math.max(b.y2 - b.y1, 1), 1);
    tctx.translate(tc.width / 2 - (b.x1 + b.x2) / 2 * sc, tc.height / 2 - (b.y1 + b.y2) / 2 * sc);
    tctx.scale(sc, sc);
    const trc = rough.canvas(tc);
    for (const el of state.elements) renderElement(tctx, trc, el);
  }
  try { localStorage.setItem(LS_THUMB + state.sceneId, tc.toDataURL('image/png')); } catch {}
  renderSceneList();
}

function createScene(name) {
  const scene = { id: uid(), name: name || 'Untitled scene', updatedAt: Date.now() };
  state.scenes.unshift(scene);
  saveIndex();
  return scene;
}

function openScene(id) {
  // commit pending save of the old scene
  clearTimeout(saveTimer);
  if (state.sceneId) saveCurrentScene();
  state.sceneId = id;
  localStorage.setItem(LS_LAST, id);
  try { state.elements = JSON.parse(localStorage.getItem(LS_SCENE + id)) || []; }
  catch { state.elements = []; }
  state.selection.clear();
  history = []; redoStack = [];
  drawableCache.clear();
  const meta = state.scenes.find(s => s.id === id);
  document.getElementById('scene-title').value = meta ? meta.name : '';
  zoomToContent();
  renderSceneList();
  requestRender();
}

function deleteScene(id) {
  const meta = state.scenes.find(s => s.id === id);
  if (!confirm(`Delete scene "${meta ? meta.name : ''}"? This cannot be undone.`)) return;
  state.scenes = state.scenes.filter(s => s.id !== id);
  localStorage.removeItem(LS_SCENE + id);
  localStorage.removeItem(LS_THUMB + id);
  saveIndex();
  if (state.sceneId === id) {
    if (!state.scenes.length) createScene();
    openScene(state.scenes[0].id);
  }
  renderSceneList();
}

function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 15) return 'a few seconds ago';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? 'a minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? 'an hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return d === 1 ? 'a day ago' : `${d} days ago`;
  const mo = Math.floor(d / 30);
  return mo === 1 ? 'a month ago' : `${mo} months ago`;
}

function renderSceneList() {
  const list = document.getElementById('scene-list');
  const q = document.getElementById('scene-search').value.trim().toLowerCase();
  list.innerHTML = '';
  const scenes = [...state.scenes].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of scenes) {
    if (q && !s.name.toLowerCase().includes(q)) continue;
    const item = document.createElement('div');
    item.className = 'scene-item' + (s.id === state.sceneId ? ' active' : '');
    const thumb = document.createElement('div');
    thumb.className = 'scene-thumb';
    const t = localStorage.getItem(LS_THUMB + s.id);
    if (t) thumb.style.backgroundImage = `url(${t})`;
    const meta = document.createElement('div');
    meta.className = 'scene-meta';
    meta.innerHTML = `<div class="scene-name"></div><div class="scene-time">${relTime(s.updatedAt)}</div>`;
    meta.querySelector('.scene-name').textContent = s.name;
    const del = document.createElement('button');
    del.className = 'scene-del'; del.textContent = '✕'; del.title = 'Delete scene';
    del.addEventListener('click', ev => { ev.stopPropagation(); deleteScene(s.id); });
    item.append(thumb, meta, del);
    item.addEventListener('click', () => { if (s.id !== state.sceneId) openScene(s.id); });
    list.appendChild(item);
  }
}

// ---------- viewport ----------
function setZoom(z, center) {
  z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  const c = center || { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 };
  const before = toScene(c.x, c.y);
  state.zoom = z;
  state.scroll.x = c.x - before.x * z;
  state.scroll.y = c.y - before.y * z;
  document.getElementById('zoom-reset').textContent = Math.round(z * 100) + '%';
  requestRender();
}

function zoomToContent() {
  if (!state.elements.length) {
    state.zoom = 1;
    state.scroll = { x: wrap.clientWidth * 0.15, y: wrap.clientHeight * 0.15 };
  } else {
    const b = boundsOf(state.elements);
    const w = Math.max(b.x2 - b.x1, 100), h = Math.max(b.y2 - b.y1, 100);
    const z = Math.min((wrap.clientWidth - 120) / w, (wrap.clientHeight - 160) / h, 1);
    state.zoom = Math.max(MIN_ZOOM, z);
    state.scroll.x = wrap.clientWidth / 2 - (b.x1 + b.x2) / 2 * state.zoom;
    state.scroll.y = wrap.clientHeight / 2 - (b.y1 + b.y2) / 2 * state.zoom;
  }
  document.getElementById('zoom-reset').textContent = Math.round(state.zoom * 100) + '%';
}

// ---------- text editor overlay ----------
let editorEl = null; // the <textarea>

function openTextEditor(el, isNew) {
  if (editorEl) commitTextEditor();
  state.editingId = el.id;
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = (el.rawText !== undefined ? el.rawText : el.text) || '';
  ta.spellcheck = false;
  editorEl = ta;
  ta.dataset.isNew = isNew ? '1' : '';
  positionEditor(el, ta);
  wrap.appendChild(ta);
  // focus after the triggering pointer event fully settles, so the browser's
  // default focus handling can't immediately blur (and close) the editor
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 0);

  const resize = () => {
    const cont = el.containerId && byId(el.containerId);
    if (cont) {
      // labels edit inside a fixed-width, wrapping, centered textarea
      const maxW = labelMaxWidth(cont);
      const m = measureText(wrapText(ta.value || ' ', el.fontSize, maxW), el.fontSize);
      ta.style.whiteSpace = 'pre-wrap';
      ta.style.wordBreak = 'break-word';
      ta.style.textAlign = 'center';
      ta.style.width = (maxW + 6) * state.zoom + 'px';
      ta.style.height = (m.h + 8) * state.zoom + 'px';
      const p = toScreen(cont.x + cont.w / 2 - maxW / 2, cont.y + cont.h / 2 - m.h / 2);
      ta.style.left = p.x - 2 + 'px';
      ta.style.top = p.y - 2 + 'px';
      return;
    }
    const m = measureText(ta.value || ' ', el.fontSize);
    ta.style.width = (m.w + 12) * state.zoom + 'px';
    ta.style.height = (m.h + 6) * state.zoom + 'px';
  };
  resize();
  ta.addEventListener('input', resize);
  ta.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); commitTextEditor(); }
  });
  ta.addEventListener('blur', () => commitTextEditor());
  requestRender();
}

function positionEditor(el, ta) {
  const p = toScreen(el.x, el.y);
  ta.style.left = p.x - 2 + 'px';
  ta.style.top = p.y - 2 + 'px';
  ta.style.fontSize = el.fontSize * state.zoom + 'px';
  ta.style.color = el.strokeColor;
}

function commitTextEditor() {
  if (!editorEl) return;
  const ta = editorEl;
  editorEl = null;
  const id = state.editingId;
  state.editingId = null;
  const isNew = ta.dataset.isNew === '1';
  const text = ta.value.replace(/\s+$/, '');
  ta.remove();

  const el = state.elements.find(e => e.id === id) || (isNew ? pendingText : null);
  if (!el) { requestRender(); return; }

  if (!text.trim()) {
    // empty -> remove if it exists in the scene
    const idx = state.elements.findIndex(e => e.id === id);
    if (idx >= 0) { pushHistory(); state.elements.splice(idx, 1); scheduleSave(); }
    if (el.containerId) {
      const cont = byId(el.containerId);
      if (cont && cont.labelId === id) { delete cont.labelId; touch(cont); }
    }
    pendingText = null;
    requestRender();
    return;
  }
  pushHistory();
  el.text = text;
  if (el.containerId) el.rawText = text; // syncLabel re-wraps from rawText
  remeasure(el);
  touch(el);
  updateArrowsBoundTo(new Set([el.id]));
  if (isNew && !state.elements.includes(el)) state.elements.push(el);
  if (el.containerId) {
    const cont = byId(el.containerId);
    if (cont) { cont.labelId = el.id; touch(cont); syncLabel(cont); }
    else delete el.containerId;
  }
  pendingText = null;
  state.selection = new Set([el.containerId || el.id]);
  scheduleSave();
  requestRender();
  syncPanel();
}

let pendingText = null;

function startTextAt(scenePt) {
  const el = newElement('text', scenePt.x, scenePt.y - state.props.fontSize * 0.7);
  el.text = '';
  el.fontSize = state.props.fontSize;
  pendingText = el;
  openTextEditor(el, true);
  setTool('select');
}

function editTextElement(el) {
  state.selection = new Set([el.containerId || el.id]);
  openTextEditor(el, false);
}

function openLabelEditor(container) {
  const existing = container.labelId && byId(container.labelId);
  if (existing) {
    state.selection = new Set([container.id]);
    openTextEditor(existing, false);
    return;
  }
  const label = newElement('text', container.x + container.w / 2,
                           container.y + container.h / 2 - state.props.fontSize * 0.625);
  label.text = '';
  label.fontSize = state.props.fontSize;
  label.containerId = container.id;
  pendingText = label;
  openTextEditor(label, true);
}

// ---------- pointer interaction ----------
let action = null;
let multiPoint = null; // {el} — arrow/line being placed point-by-point; last point follows the cursor

function finishMultiPoint() {
  if (!multiPoint) return;
  const el = multiPoint.el;
  multiPoint = null;
  bindHighlight = null;
  el.points.pop(); // drop the pending cursor-following point
  // dedupe consecutive near-identical points (double-click leaves duplicates)
  const pts = [];
  for (const p of el.points) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 2) pts.push(p);
  }
  el.points = pts;
  if (el.points.length < 2) {
    state.elements = state.elements.filter(x => x.id !== el.id);
    history.pop(); // remove the creation snapshot
    requestRender();
    return;
  }
  // re-normalize so the first point is the origin
  const abs = el.points.map(([px, py]) => [el.x + px, el.y + py]);
  el.x = abs[0][0]; el.y = abs[0][1];
  el.points = abs.map(([px, py]) => [px - el.x, py - el.y]);
  if (el.type === 'arrow') {
    const last = el.points.length - 1;
    const aPt = { x: el.x + el.points[0][0], y: el.y + el.points[0][1] };
    const bPt = { x: el.x + el.points[last][0], y: el.y + el.points[last][1] };
    const sShape = bindableAt(aPt, el.id);
    const eShape = bindableAt(bPt, el.id);
    if (!(sShape && eShape && sShape.id === eShape.id)) {
      if (sShape) el.startBinding = { elementId: sShape.id };
      if (eShape) el.endBinding = { elementId: eShape.id };
      recomputeBoundArrow(el);
    }
  }
  touch(el);
  state.selection = new Set([el.id]);
  scheduleSave();
  requestRender();
  syncPanel();
}
/* action shapes:
   {type:'pan', startScroll, startPt}
   {type:'create', el}                            — shapes/lines/arrows
   {type:'draw', el}
   {type:'move', startPts:Map(id->{x,y}), start, moved, didHistory}
   {type:'marquee', start}
   {type:'resize', el, dir, startBounds, snapshot}
   {type:'erase'}
*/

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('dblclick', onDblClick);

function onPointerDown(e) {
  if (editorEl) { commitTextEditor(); return; }
  canvas.setPointerCapture(e.pointerId);
  const sp = canvasPoint(e);
  const pt = toScene(sp.x, sp.y);

  if (e.button === 1 || state.tool === 'hand' || state.spaceDown) {
    action = { type: 'pan', startScroll: { ...state.scroll }, startPt: sp };
    setCursor('grabbing');
    return;
  }
  if (e.button !== 0) return;

  switch (state.tool) {
    case 'select': {
      const dir = handleAt(sp);
      if (dir === 'rot') {
        const el = selectedEls()[0];
        const b = getBounds(el);
        const c = { x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
        action = {
          type: 'rotate', el, center: c, startAngle: el.angle || 0,
          startPtAngle: Math.atan2(pt.y - c.y, pt.x - c.x), didHistory: false,
        };
        return;
      }
      if (dir) {
        const el = selectedEls()[0];
        action = { type: 'resize', el, dir, startBounds: getBounds(el), snapshot: JSON.parse(JSON.stringify(el)), didHistory: false };
        return;
      }
      let hit = topElementAt(pt);
      if (hit && hit.containerId) {
        const cont = byId(hit.containerId);
        if (cont) hit = cont; // clicking a label selects its container
      }
      if (hit) {
        if (e.shiftKey) {
          if (state.selection.has(hit.id)) state.selection.delete(hit.id);
          else state.selection.add(hit.id);
        } else if (!state.selection.has(hit.id)) {
          state.selection = new Set([hit.id]);
        }
        if (e.altKey) duplicateSelection(0, 0);
        const startPts = new Map();
        for (const el of selectedEls()) startPts.set(el.id, { x: el.x, y: el.y });
        action = { type: 'move', startPts, start: pt, moved: false, didHistory: false };
      } else {
        if (!e.shiftKey) state.selection.clear();
        action = { type: 'marquee', start: pt };
        marquee = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      }
      requestRender();
      syncPanel();
      return;
    }
    case 'rectangle': case 'diamond': case 'ellipse': {
      const el = newElement(state.tool, pt.x, pt.y);
      action = { type: 'create', el, start: pt };
      pushHistory();
      state.elements.push(el);
      return;
    }
    case 'arrow': case 'line': {
      if (multiPoint) {
        // commit the pending point where clicked, start following the cursor again
        const el = multiPoint.el;
        el.points[el.points.length - 1] = [pt.x - el.x, pt.y - el.y];
        el.points.push([pt.x - el.x, pt.y - el.y]);
        touch(el);
        requestRender();
        return;
      }
      const el = newElement(state.tool, pt.x, pt.y);
      el.points = [[0, 0], [0, 0]];
      action = { type: 'create', el, start: pt };
      pushHistory();
      state.elements.push(el);
      return;
    }
    case 'draw': {
      const el = newElement('draw', pt.x, pt.y);
      el.points = [[0, 0]];
      action = { type: 'draw', el };
      pushHistory();
      state.elements.push(el);
      return;
    }
    case 'text': {
      e.preventDefault(); // keep the click from re-focusing the canvas and blurring the editor
      const hit = topElementAt(pt);
      if (hit && hit.type === 'text') { editTextElement(hit); setTool('select'); return; }
      if (hit && CONTAINERABLE.has(hit.type)) { openLabelEditor(hit); setTool('select'); return; }
      startTextAt(pt);
      return;
    }
    case 'eraser': {
      action = { type: 'erase', didHistory: false };
      eraseAt(pt, action);
      return;
    }
  }
}

function onPointerMove(e) {
  const sp = canvasPoint(e);
  const pt = toScene(sp.x, sp.y);

  if (!action) {
    if (multiPoint) {
      // pending point follows the cursor
      const el = multiPoint.el;
      let dx = pt.x - el.x, dy = pt.y - el.y;
      if (e.shiftKey && el.points.length >= 2) {
        const [qx, qy] = el.points[el.points.length - 2];
        const ang = Math.round(Math.atan2(dy - qy, dx - qx) / (Math.PI / 12)) * (Math.PI / 12);
        const len = Math.hypot(dx - qx, dy - qy);
        dx = qx + len * Math.cos(ang); dy = qy + len * Math.sin(ang);
      }
      el.points[el.points.length - 1] = [dx, dy];
      if (el.type === 'arrow') {
        const t = bindableAt(pt, el.id);
        bindHighlight = t ? t.id : null;
      }
      touch(el);
      requestRender();
      return;
    }
    // hover cursor feedback
    if (state.tool === 'select') {
      const dir = handleAt(sp);
      if (dir) canvas.style.cursor = dir === 'rot' ? 'grab' : dir.includes(':') ? 'pointer' : dir + '-resize';
      else if (topElementAt(pt)) { canvas.style.cursor = 'move'; }
      else canvas.style.cursor = '';
    }
    return;
  }

  switch (action.type) {
    case 'pan': {
      state.scroll.x = action.startScroll.x + (sp.x - action.startPt.x);
      state.scroll.y = action.startScroll.y + (sp.y - action.startPt.y);
      requestRender();
      break;
    }
    case 'create': {
      const el = action.el, s = action.start;
      if (el.points) {
        let dx = pt.x - s.x, dy = pt.y - s.y;
        if (e.shiftKey) { // snap to 15° angles
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
          const len = Math.hypot(dx, dy);
          dx = len * Math.cos(ang); dy = len * Math.sin(ang);
        }
        el.points[el.points.length - 1] = [dx, dy];
      } else {
        let w = pt.x - s.x, h = pt.y - s.y;
        if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
        el.x = Math.min(s.x, s.x + w); el.y = Math.min(s.y, s.y + h);
        el.w = Math.abs(w); el.h = Math.abs(h);
      }
      if (el.type === 'arrow') {
        const t = bindableAt(pt, el.id);
        bindHighlight = t ? t.id : null;
      }
      touch(el);
      requestRender();
      break;
    }
    case 'draw': {
      const el = action.el;
      const last = el.points[el.points.length - 1];
      const nx = pt.x - el.x, ny = pt.y - el.y;
      if (Math.hypot(nx - last[0], ny - last[1]) > 1.5 / state.zoom) {
        el.points.push([nx, ny]);
        touch(el);
        requestRender();
      }
      break;
    }
    case 'move': {
      const dx = pt.x - action.start.x, dy = pt.y - action.start.y;
      if (!action.moved && Math.hypot(dx, dy) * state.zoom < 2) break;
      if (!action.didHistory) { pushHistory(); action.didHistory = true; }
      if (!action.moved) {
        // dragging an arrow without its bound shape detaches it
        for (const el of selectedEls()) {
          if (el.type !== 'arrow') continue;
          if (el.startBinding && !state.selection.has(el.startBinding.elementId)) { delete el.startBinding; touch(el); }
          if (el.endBinding && !state.selection.has(el.endBinding.elementId)) { delete el.endBinding; touch(el); }
        }
      }
      action.moved = true;
      for (const el of selectedEls()) {
        const s0 = action.startPts.get(el.id);
        if (s0) { el.x = s0.x + dx; el.y = s0.y + dy; }
        if (el.labelId) syncLabel(el);
      }
      updateArrowsBoundTo(state.selection);
      requestRender();
      break;
    }
    case 'marquee': {
      marquee = {
        x1: Math.min(action.start.x, pt.x), y1: Math.min(action.start.y, pt.y),
        x2: Math.max(action.start.x, pt.x), y2: Math.max(action.start.y, pt.y),
      };
      state.selection = new Set(
        state.elements.filter(el => {
          if (el.containerId) return false; // labels follow their container
          const b = getAABB(el);
          return b.x1 >= marquee.x1 && b.x2 <= marquee.x2 && b.y1 >= marquee.y1 && b.y2 <= marquee.y2;
        }).map(el => el.id)
      );
      requestRender();
      break;
    }
    case 'resize': {
      if (!action.didHistory) {
        pushHistory();
        // history snapshot must hold pre-resize geometry
        history[history.length - 1] = JSON.stringify(
          state.elements.map(el => el.id === action.el.id ? action.snapshot : el)
        );
        action.didHistory = true;
      }
      applyResize(action, pt, e.shiftKey);
      if (action.el.labelId) syncLabel(action.el);
      if (BINDABLE.has(action.el.type)) updateArrowsBoundTo(new Set([action.el.id]));
      requestRender();
      break;
    }
    case 'rotate': {
      if (!action.didHistory) { pushHistory(); action.didHistory = true; }
      let a = action.startAngle + Math.atan2(pt.y - action.center.y, pt.x - action.center.x) - action.startPtAngle;
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      action.el.angle = a;
      if (action.el.labelId) syncLabel(action.el);
      touch(action.el);
      requestRender();
      break;
    }
    case 'erase': {
      eraseAt(pt, action);
      break;
    }
  }
}

function applyResize(act, pt, uniform) {
  const el = act.el, b0 = act.startBounds;
  let dir = act.dir;
  if (dir.startsWith('seg:')) {
    // dragging a segment midpoint inserts a new point there, then behaves like a point drag
    const i = Number(dir.slice(4));
    el.points.splice(i + 1, 0, [pt.x - el.x, pt.y - el.y]);
    dir = act.dir = 'pt:' + (i + 1);
  }
  if (dir.startsWith('pt:')) {
    const i = Number(dir.slice(3));
    const abs = el.points.map(([px, py]) => [el.x + px, el.y + py]);
    abs[i] = [pt.x, pt.y];
    el.x = abs[0][0]; el.y = abs[0][1];
    el.points = abs.map(([px, py]) => [px - el.x, py - el.y]);
    act.lastPt = pt;
    act.ptIndex = i;
    if (el.type === 'arrow' && (i === 0 || i === el.points.length - 1)) {
      const t = bindableAt(pt, el.id);
      bindHighlight = t ? t.id : null;
    }
    touch(el);
    return;
  }
  const ang = el.angle || 0;
  const C0 = { x: (b0.x1 + b0.x2) / 2, y: (b0.y1 + b0.y2) / 2 };
  const lp = ang ? rotatePoint(pt.x, pt.y, C0.x, C0.y, -ang) : pt;
  let x1 = b0.x1, y1 = b0.y1, x2 = b0.x2, y2 = b0.y2;
  if (dir.includes('w')) x1 = Math.min(lp.x, x2 - 4);
  if (dir.includes('e')) x2 = Math.max(lp.x, x1 + 4);
  if (dir.includes('n')) y1 = Math.min(lp.y, y2 - 4);
  if (dir.includes('s')) y2 = Math.max(lp.y, y1 + 4);

  const w0 = b0.x2 - b0.x1 || 1, h0 = b0.y2 - b0.y1 || 1;
  let sx = (x2 - x1) / w0, sy = (y2 - y1) / h0;
  if (uniform || el.type === 'image') {
    const s = Math.max(sx, sy);
    sx = sy = s;
    if (dir.includes('w')) x1 = x2 - w0 * s; else x2 = x1 + w0 * s;
    if (dir.includes('n')) y1 = y2 - h0 * s; else y2 = y1 + h0 * s;
  }
  const snap = act.snapshot;

  if (el.type === 'text') {
    el.fontSize = Math.max(8, snap.fontSize * ((dir === 'n' || dir === 's') ? sy : sx));
    remeasure(el);
    el.x = dir.includes('w') ? x2 - el.w : x1;
    el.y = dir.includes('n') ? y2 - el.h : y1;
  } else if (el.points) {
    el.points = snap.points.map(([px, py]) => [px * sx, py * sy]);
    // re-anchor: snapshot origin relative to old bounds
    el.x = x1 + (snap.x - b0.x1) * sx;
    el.y = y1 + (snap.y - b0.y1) * sy;
  } else {
    el.x = x1; el.y = y1;
    el.w = Math.max(4, x2 - x1); el.h = Math.max(4, y2 - y1);
  }
  if (ang) {
    // keep the anchor (the corner/edge opposite the grabbed handle) fixed in world space
    const A = {
      x: dir.includes('w') ? b0.x2 : dir.includes('e') ? b0.x1 : C0.x,
      y: dir.includes('n') ? b0.y2 : dir.includes('s') ? b0.y1 : C0.y,
    };
    const C1l = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    const Ag = rotatePoint(A.x, A.y, C0.x, C0.y, ang);
    const C1 = rotatePoint(Ag.x + (C1l.x - A.x), Ag.y + (C1l.y - A.y), Ag.x, Ag.y, ang);
    el.x += C1.x - C1l.x;
    el.y += C1.y - C1l.y;
  }
  touch(el);
}

function eraseAt(pt, act) {
  let hit = topElementAt(pt);
  if (hit && hit.containerId) hit = byId(hit.containerId) || hit;
  if (hit) {
    if (!act.didHistory) { pushHistory(); act.didHistory = true; }
    const ids = withLabels(new Set([hit.id]));
    state.elements = state.elements.filter(el => !ids.has(el.id));
    clearBindingsTo(ids);
    for (const id of ids) state.selection.delete(id);
    scheduleSave();
    requestRender();
  }
}

function onPointerUp(e) {
  if (!action) return;
  const act = action;
  action = null;

  switch (act.type) {
    case 'pan':
      setCursor(state.tool === 'hand' || state.spaceDown ? 'grab' : '');
      break;
    case 'create': {
      const el = act.el;
      const b = getBounds(el);
      if (Math.max(b.x2 - b.x1, b.y2 - b.y1) < 3) {
        if (el.type === 'arrow' || el.type === 'line') {
          // click (not drag) with arrow/line: place points one click at a time
          multiPoint = { el };
          requestRender();
          break;
        }
        // discard click-only shapes (history entry already pushed; pop it)
        state.elements.pop();
        history.pop();
      } else {
        if (el.type === 'arrow') {
          const last = el.points.length - 1;
          const aPt = { x: el.x + el.points[0][0], y: el.y + el.points[0][1] };
          const bPt = { x: el.x + el.points[last][0], y: el.y + el.points[last][1] };
          const sShape = bindableAt(aPt, el.id);
          const eShape = bindableAt(bPt, el.id);
          if (!(sShape && eShape && sShape.id === eShape.id)) {
            if (sShape) el.startBinding = { elementId: sShape.id };
            if (eShape) el.endBinding = { elementId: eShape.id };
            recomputeBoundArrow(el);
          }
        }
        state.selection = new Set([el.id]);
        setTool('select');
      }
      bindHighlight = null;
      scheduleSave();
      break;
    }
    case 'draw': {
      const el = act.el;
      if (el.points.length < 2) { state.elements.pop(); history.pop(); }
      scheduleSave();
      break;
    }
    case 'move':
      if (act.moved) scheduleSave();
      break;
    case 'marquee':
      marquee = null;
      break;
    case 'resize': {
      const el = act.el;
      if (act.dir && act.dir.startsWith('pt:') && el.points) {
        const i = act.ptIndex ?? Number(act.dir.slice(3));
        const last = el.points.length - 1;
        if (i > 0 && i < last) {
          // interior point dropped on the line between its neighbours -> remove it
          const P = j => ({ x: el.x + el.points[j][0], y: el.y + el.points[j][1] });
          if (distToSegment(P(i), P(i - 1), P(i + 1)) < 6 / state.zoom + 2) {
            el.points.splice(i, 1);
            touch(el);
          }
        } else if (el.type === 'arrow' && act.lastPt) {
          const key = i === 0 ? 'startBinding' : 'endBinding';
          const otherKey = i === 0 ? 'endBinding' : 'startBinding';
          const shape = bindableAt(act.lastPt, el.id);
          if (shape && !(el[otherKey] && el[otherKey].elementId === shape.id)) {
            el[key] = { elementId: shape.id };
          } else {
            delete el[key];
          }
          recomputeBoundArrow(el);
        }
      }
      bindHighlight = null;
      scheduleSave();
      break;
    }
    case 'rotate':
      scheduleSave();
      break;
  }
  requestRender();
  syncPanel();
}

function onDblClick(e) {
  if (multiPoint) { finishMultiPoint(); setTool('select'); return; }
  const sp = canvasPoint(e);
  const pt = toScene(sp.x, sp.y);
  const hit = topElementAt(pt);
  if (hit && hit.type === 'text') { editTextElement(hit); return; }
  if (hit && CONTAINERABLE.has(hit.type)) { openLabelEditor(hit); return; }
  if (!hit) startTextAt(pt);
}

// wheel: pan / ctrl+wheel: zoom
wrap.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const sp = canvasPoint(e);
    setZoom(state.zoom * Math.exp(-e.deltaY * 0.012), sp);
  } else {
    state.scroll.x -= e.deltaX;
    state.scroll.y -= e.deltaY;
    requestRender();
  }
}, { passive: false });

// ---------- images ----------
function placeImage(dataURL) {
  const img = new Image();
  img.onload = () => {
    const maxSide = 480;
    const sc = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
    const c = toScene(wrap.clientWidth / 2, wrap.clientHeight / 2);
    pushHistory();
    const el = newElement('image', c.x - w / 2, c.y - h / 2);
    el.w = w; el.h = h; el.dataURL = dataURL;
    state.elements.push(el);
    imageCache.set(el.id, img);
    state.selection = new Set([el.id]);
    setTool('select');
    scheduleSave();
    requestRender();
  };
  img.src = dataURL;
}

document.getElementById('file-image').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => placeImage(r.result);
  r.readAsDataURL(f);
  e.target.value = '';
});

window.addEventListener('paste', e => {
  if (editorEl || document.activeElement.tagName === 'INPUT') return;
  for (const item of e.clipboardData.items) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile();
      const r = new FileReader();
      r.onload = () => placeImage(r.result);
      r.readAsDataURL(f);
      e.preventDefault();
      return;
    }
  }
  const text = e.clipboardData.getData('text/plain');
  if (text) {
    const c = toScene(wrap.clientWidth / 2, wrap.clientHeight / 2);
    pushHistory();
    const el = newElement('text', c.x, c.y);
    el.text = text; el.fontSize = state.props.fontSize;
    remeasure(el);
    state.elements.push(el);
    state.selection = new Set([el.id]);
    scheduleSave(); requestRender();
  }
});

// ---------- selection ops ----------
function deleteSelection() {
  if (!state.selection.size) return;
  pushHistory();
  const ids = withLabels(state.selection);
  state.elements = state.elements.filter(el => !ids.has(el.id));
  clearBindingsTo(ids);
  state.selection.clear();
  scheduleSave(); requestRender(); syncPanel();
}

function duplicateSelection(dx = 14, dy = 14) {
  const selIds = withLabels(state.selection);
  const sel = state.elements.filter(el => selIds.has(el.id));
  if (!sel.length) return;
  pushHistory();
  const idMap = new Map();
  const clones = sel.map(el => {
    const c = JSON.parse(JSON.stringify(el));
    c.id = uid(); c.seed = seed(); c.v = 0;
    c.x += dx; c.y += dy;
    idMap.set(el.id, c.id);
    if (el.type === 'image' && imageCache.has(el.id)) imageCache.set(c.id, imageCache.get(el.id));
    return c;
  });
  // bindings & labels follow the clones when both ends were duplicated, otherwise drop
  for (const c of clones) {
    for (const k of ['startBinding', 'endBinding']) {
      if (c[k]) {
        const nid = idMap.get(c[k].elementId);
        if (nid) c[k].elementId = nid; else delete c[k];
      }
    }
    if (c.containerId) {
      const nid = idMap.get(c.containerId);
      if (nid) c.containerId = nid; else delete c.containerId;
    }
    if (c.labelId) {
      const nid = idMap.get(c.labelId);
      if (nid) c.labelId = nid; else delete c.labelId;
    }
  }
  state.elements.push(...clones);
  state.selection = new Set(clones.filter(c => !c.containerId).map(c => c.id));
  scheduleSave(); requestRender();
}

function reorderSelection(toFront) {
  if (!state.selection.size) return;
  pushHistory();
  const ids = withLabels(state.selection);
  const sel = state.elements.filter(el => ids.has(el.id));
  const rest = state.elements.filter(el => !ids.has(el.id));
  state.elements = toFront ? [...rest, ...sel] : [...sel, ...rest];
  scheduleSave(); requestRender();
}

// ---------- property panel ----------
function buildSwatches(containerId, colors, key) {
  const c = document.getElementById(containerId);
  colors.forEach(color => {
    const b = document.createElement('button');
    b.className = 'swatch' + (color === 'transparent' ? ' transparent' : '');
    if (color !== 'transparent') b.style.background = color;
    b.title = color;
    b.dataset.v = color;
    b.addEventListener('click', () => applyProp(key, color));
    c.appendChild(b);
  });
}

function applyProp(key, value) {
  state.props[key] = value;
  const sel = selectedEls();
  if (sel.length) {
    pushHistory();
    for (const el of sel) {
      el[key] = value;
      if (el.type === 'text' && key === 'fontSize') remeasure(el);
      if (key === 'fontSize' && el.labelId) {
        const lb = byId(el.labelId);
        if (lb) { lb.fontSize = value; remeasure(lb); touch(lb); syncLabel(el); }
      }
      touch(el);
    }
    if (key === 'fontSize') updateArrowsBoundTo(new Set(sel.map(e => e.id)));
    scheduleSave();
    requestRender();
  }
  syncPanel();
}

function syncPanel() {
  const panel = document.getElementById('panel');
  const sel = selectedEls();
  const drawingTool = ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'draw', 'text'].includes(state.tool);
  const show = drawingTool || sel.length > 0;
  panel.classList.toggle('visible', show);
  if (!show) return;

  // pull props from a single selected element so the panel reflects it
  const src = sel.length === 1 ? sel[0] : state.props;
  const val = k => src[k] !== undefined ? src[k] : state.props[k];

  const mark = (containerSel, v) => {
    document.querySelectorAll(containerSel).forEach(b =>
      b.classList.toggle('active', String(b.dataset.v) === String(v)));
  };
  mark('#stroke-swatches .swatch', val('strokeColor'));
  mark('#bg-swatches .swatch', val('backgroundColor'));
  mark('#fill-btns button', val('fillStyle'));
  mark('#width-btns button', val('strokeWidth'));
  mark('#style-btns button', val('strokeStyle'));
  mark('#edge-btns button', val('edges'));
  mark('#font-btns button', Math.round(val('fontSize')));
  document.getElementById('opacity-range').value = val('opacity');

  // section visibility
  const selTypes = sel.length ? new Set(sel.map(e => e.type)) : new Set([state.tool]);
  const has = (...ts) => ts.some(t => selTypes.has(t));
  const sec = p => document.querySelector(`.p-section[data-p="${p}"]`);
  sec('background').style.display = has('rectangle', 'diamond', 'ellipse') ? '' : 'none';
  sec('fillStyle').style.display = has('rectangle', 'diamond', 'ellipse') && val('backgroundColor') !== 'transparent' ? '' : 'none';
  sec('edges').style.display = has('rectangle', 'arrow', 'line') ? '' : 'none';
  sec('fontSize').style.display = has('text') || sel.some(e => e.labelId) ? '' : 'none';
  sec('strokeWidth').style.display = has('rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'draw') ? '' : 'none';
  sec('strokeStyle').style.display = has('rectangle', 'diamond', 'ellipse', 'arrow', 'line') ? '' : 'none';
  sec('stroke').style.display = has('image') && selTypes.size === 1 ? 'none' : '';
  document.getElementById('sel-actions').style.display = sel.length ? '' : 'none';
}

// panel events
document.getElementById('fill-btns').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) applyProp('fillStyle', b.dataset.v);
});
document.getElementById('width-btns').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) applyProp('strokeWidth', Number(b.dataset.v));
});
document.getElementById('style-btns').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) applyProp('strokeStyle', b.dataset.v);
});
document.getElementById('edge-btns').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) applyProp('edges', b.dataset.v);
});
document.getElementById('font-btns').addEventListener('click', e => {
  const b = e.target.closest('button'); if (b) applyProp('fontSize', Number(b.dataset.v));
});
document.getElementById('opacity-range').addEventListener('input', e => {
  applyProp('opacity', Number(e.target.value));
});
document.getElementById('act-del').addEventListener('click', deleteSelection);
document.getElementById('act-dup').addEventListener('click', () => duplicateSelection());
document.getElementById('act-front').addEventListener('click', () => reorderSelection(true));
document.getElementById('act-back').addEventListener('click', () => reorderSelection(false));

// ---------- toolbar ----------
function setTool(tool) {
  if (multiPoint) finishMultiPoint();
  if (tool === 'image') {
    document.getElementById('file-image').click();
    return;
  }
  state.tool = tool;
  document.querySelectorAll('#toolbar .tool').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  const cur = {
    hand: 'grab', rectangle: 'crosshair', diamond: 'crosshair', ellipse: 'crosshair',
    arrow: 'crosshair', line: 'crosshair', draw: 'crosshair', text: 'text', eraser: 'eraser',
  }[tool] || '';
  setCursor(cur);
  if (tool !== 'select') { state.selection.clear(); requestRender(); }
  syncPanel();
}

function setCursor(kind) {
  canvas.className = kind ? 'cur-' + kind : '';
  canvas.style.cursor = '';
}

document.querySelectorAll('#toolbar .tool').forEach(b =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));

// ---------- keyboard ----------
const TOOL_KEYS = {
  '1': 'select', '2': 'rectangle', '3': 'diamond', '4': 'ellipse', '5': 'arrow',
  '6': 'line', '7': 'draw', '8': 'text', '9': 'image', '0': 'eraser',
  v: 'select', h: 'hand', r: 'rectangle', d: 'diamond', o: 'ellipse',
  a: 'arrow', l: 'line', p: 'draw', t: 'text', e: 'eraser',
};

window.addEventListener('keydown', e => {
  const inField = editorEl || ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.code === 'Space' && !inField) {
    if (!state.spaceDown) { state.spaceDown = true; if (!action) setCursor('grab'); }
    e.preventDefault();
    return;
  }
  if (inField) return;

  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();

  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 'a') { e.preventDefault(); state.selection = new Set(state.elements.filter(el => !el.containerId).map(el => el.id)); requestRender(); syncPanel(); return; }
  if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
  if (mod) return;

  if (k === 'delete' || k === 'backspace') { deleteSelection(); return; }
  if (k === 'escape') {
    if (multiPoint) { finishMultiPoint(); setTool('select'); return; }
    state.selection.clear(); requestRender(); syncPanel(); return;
  }
  if (k === 'enter' && multiPoint) { finishMultiPoint(); setTool('select'); return; }

  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k) && state.selection.size) {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 2) / state.zoom;
    const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
    const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
    pushHistory();
    for (const el of selectedEls()) {
      el.x += dx; el.y += dy;
      if (el.labelId) syncLabel(el);
    }
    updateArrowsBoundTo(state.selection);
    scheduleSave(); requestRender();
    return;
  }

  if (TOOL_KEYS[k] && !e.repeat) setTool(TOOL_KEYS[k]);
});

window.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    state.spaceDown = false;
    if (!action) setCursor(state.tool === 'hand' ? 'grab' : '');
  }
});

// ---------- theme ----------
const LS_THEME = 'xdraw.theme';

function setTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  localStorage.setItem(LS_THEME, t);
  const btn = document.getElementById('btn-theme');
  btn.querySelector('.ic-moon').style.display = t === 'dark' ? 'none' : '';
  btn.querySelector('.ic-sun').style.display = t === 'dark' ? '' : 'none';
  btn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

document.getElementById('btn-theme').addEventListener('click', () =>
  setTheme(document.body.classList.contains('dark') ? 'light' : 'dark'));

// ---------- zoom / undo UI ----------
document.getElementById('zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.2));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.2));
document.getElementById('zoom-reset').addEventListener('click', () => setZoom(1));
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);

// ---------- export / save / open ----------
function download(filename, href) {
  const a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

document.getElementById('btn-export').addEventListener('click', () => {
  if (!state.elements.length) { alert('Canvas is empty — nothing to export.'); return; }
  const b = boundsOf(state.elements);
  const pad = 40, scale = 2;
  const w = (b.x2 - b.x1 + pad * 2), h = (b.y2 - b.y1 + pad * 2);
  const ec = document.createElement('canvas');
  ec.width = Math.ceil(w * scale); ec.height = Math.ceil(h * scale);
  const ectx = ec.getContext('2d');
  ectx.fillStyle = '#ffffff';
  ectx.fillRect(0, 0, ec.width, ec.height);
  ectx.scale(scale, scale);
  ectx.translate(pad - b.x1, pad - b.y1);
  const erc = rough.canvas(ec);
  for (const el of state.elements) renderElement(ectx, erc, el);
  const meta = state.scenes.find(s => s.id === state.sceneId);
  download(`${(meta ? meta.name : 'x-draw').replace(/[^\w\- ]+/g, '')}.png`, ec.toDataURL('image/png'));
});

document.getElementById('btn-save').addEventListener('click', () => {
  const meta = state.scenes.find(s => s.id === state.sceneId);
  const data = {
    type: 'x-draw', version: 1,
    name: meta ? meta.name : 'Untitled scene',
    elements: state.elements,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  download(`${(meta ? meta.name : 'scene').replace(/[^\w\- ]+/g, '')}.xdraw`, URL.createObjectURL(blob));
});

document.getElementById('btn-open').addEventListener('click', () =>
  document.getElementById('file-open').click());

document.getElementById('file-open').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      const els = Array.isArray(data.elements) ? data.elements : Array.isArray(data) ? data : null;
      if (!els) throw new Error('no elements array');
      const scene = createScene((data.name || f.name.replace(/\.[^.]+$/, '')) + '');
      localStorage.setItem(LS_SCENE + scene.id, JSON.stringify(els));
      openScene(scene.id);
      saveThumbnail();
    } catch (err) {
      alert('Could not open file: ' + err.message);
    }
  };
  r.readAsText(f);
  e.target.value = '';
});

// ---------- sidebar ----------
document.getElementById('btn-new-scene').addEventListener('click', () => {
  const scene = createScene();
  openScene(scene.id);
  document.getElementById('scene-title').focus();
  document.getElementById('scene-title').select();
});

document.getElementById('scene-search').addEventListener('input', renderSceneList);

document.getElementById('scene-title').addEventListener('change', e => {
  const meta = state.scenes.find(s => s.id === state.sceneId);
  if (meta) {
    meta.name = e.target.value.trim() || 'Untitled scene';
    e.target.value = meta.name;
    saveIndex();
    renderSceneList();
  }
});
document.getElementById('scene-title').addEventListener('keydown', e => {
  if (e.key === 'Enter') e.target.blur();
});

const sidebar = document.getElementById('sidebar');
document.getElementById('btn-collapse').addEventListener('click', () => {
  sidebar.classList.add('collapsed');
  document.getElementById('btn-expand').style.display = '';
  setTimeout(resizeCanvas, 200);
});
document.getElementById('btn-expand').addEventListener('click', () => {
  sidebar.classList.remove('collapsed');
  document.getElementById('btn-expand').style.display = 'none';
  setTimeout(resizeCanvas, 200);
});

// ---------- canvas sizing ----------
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  requestRender();
}
window.addEventListener('resize', resizeCanvas);

// periodic sidebar timestamp refresh
setInterval(renderSceneList, 60000);

// flush pending save when leaving
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  saveCurrentScene();
});

// ---------- init ----------
function init() {
  buildSwatches('stroke-swatches', STROKE_COLORS, 'strokeColor');
  buildSwatches('bg-swatches', BG_COLORS, 'backgroundColor');
  setTheme(localStorage.getItem(LS_THEME) ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  loadIndex();
  if (!state.scenes.length) createScene('Welcome');
  const last = localStorage.getItem(LS_LAST);
  const target = state.scenes.find(s => s.id === last) || state.scenes[0];
  resizeCanvas();
  openScene(target.id);
  setTool('select');
  // re-render once the handwriting font is ready so text measures correctly
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      for (const el of state.elements) if (el.type === 'text') { remeasure(el); touch(el); }
      requestRender();
    });
  }
}
init();

// exposed for debugging / testing
window.__xdraw = { state, toScreen, toScene };
