'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PANEL_LONG  = 1200;
const PANEL_SHORT = 600;
const PANEL_AREA  = PANEL_LONG * PANEL_SHORT;
const MIN_CUT_WARN = 150;

const SCREW_INSET = 25;     // mm from each panel edge
const SCREW_MID_THRESHOLD = 800; // long-axis length needed before mid screws are added

const els = {
  polygon:  document.getElementById('polygon'),
  polygonStatus: document.getElementById('polygon-status'),
  waste:    document.getElementById('waste'),
  panelPrice:     document.getElementById('panel-price'),
  screwPackPrice: document.getElementById('screw-pack-price'),
  showDims: document.getElementById('show-dims'),
  showLab:  document.getElementById('show-labels'),
  showCuts: document.getElementById('show-cuts'),
  showScrews: document.getElementById('show-screws'),
  svg:      document.getElementById('drawing'),
  summary:  document.getElementById('summary'),
  cutList:  document.getElementById('cut-list'),
  exportBtn:document.getElementById('export'),
};

// -------- Polygon helpers --------

function parsePolygon(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const poly = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[(\[]?\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*[\])]?$/);
    if (!m) { errors.push(`Line ${i + 1}: cannot parse "${lines[i]}"`); continue; }
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    if (!isFinite(x) || !isFinite(y) || x < -1 || y < -1 || x > 30000 || y > 30000) {
      errors.push(`Line ${i + 1}: out of range`);
      continue;
    }
    poly.push({ x, y });
  }
  if (poly.length < 3) errors.push('Need at least 3 vertices.');
  return { poly, errors };
}

function polygonBBox(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function polygonCentroid(poly) {
  let cx = 0, cy = 0, signed = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cross = p.x * q.y - q.x * p.y;
    signed += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  signed *= 0.5;
  if (signed === 0) {
    const bb = polygonBBox(poly);
    return { x: bb.x0 + bb.w / 2, y: bb.y0 + bb.h / 2 };
  }
  return { x: cx / (6 * signed), y: cy / (6 * signed) };
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > pt.y) !== (yj > pt.y))
        && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// Sutherland-Hodgman: clip an arbitrary polygon against an axis-aligned rect.
// The clip region is the rect (convex), so this works for non-convex subjects.
function clipPolygonByRect(subject, x0, y0, x1, y1) {
  let out = subject;
  out = clipHalfPlane(out, p => p.x >= x0, (a, b) => intersectV(a, b, x0));
  if (out.length === 0) return out;
  out = clipHalfPlane(out, p => p.x <= x1, (a, b) => intersectV(a, b, x1));
  if (out.length === 0) return out;
  out = clipHalfPlane(out, p => p.y >= y0, (a, b) => intersectH(a, b, y0));
  if (out.length === 0) return out;
  out = clipHalfPlane(out, p => p.y <= y1, (a, b) => intersectH(a, b, y1));
  return out;
}
function clipHalfPlane(poly, isInside, intersect) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const aIn = isInside(a), bIn = isInside(b);
    if (aIn && bIn) out.push(b);
    else if (aIn && !bIn) out.push(intersect(a, b));
    else if (!aIn && bIn) { out.push(intersect(a, b)); out.push(b); }
  }
  return out;
}
function intersectV(a, b, x) {
  const dx = b.x - a.x;
  const t = dx === 0 ? 0 : (x - a.x) / dx;
  return { x, y: a.y + t * (b.y - a.y) };
}
function intersectH(a, b, y) {
  const dy = b.y - a.y;
  const t = dy === 0 ? 0 : (y - a.y) / dy;
  return { x: a.x + t * (b.x - a.x), y };
}

// -------- Geometry --------

// Tile the room polygon with 600×1200 panels in halv forbandt, centered
// on the polygon's bounding box (falling back to centroid if the bbox
// center isn't inside the polygon). Each panel rect is clipped against
// the room polygon, so cut pieces can be non-rectangular.
function generatePanels(roomPoly) {
  const bbox = polygonBBox(roomPoly);
  const W = bbox.w, L = bbox.h;
  const longAxisX = W >= L;
  const pw = longAxisX ? PANEL_LONG  : PANEL_SHORT;
  const ph = longAxisX ? PANEL_SHORT : PANEL_LONG;

  let cx = bbox.x0 + W / 2;
  let cy = bbox.y0 + L / 2;
  if (!pointInPolygon({ x: cx, y: cy }, roomPoly)) {
    const c = polygonCentroid(roomPoly);
    cx = c.x; cy = c.y;
  }

  const shortSize = longAxisX ? L : W;
  const longSize  = longAxisX ? W : L;
  const rMax = Math.ceil(shortSize / (2 * PANEL_SHORT)) + 1;
  const cMax = Math.ceil(longSize  / (2 * PANEL_LONG))  + 2;

  const out = [];

  for (let r = -rMax; r <= rMax; r++) {
    const rowOffset = (Math.abs(r) % 2 === 1) ? PANEL_LONG / 2 : 0;
    for (let c = -cMax; c <= cMax; c++) {
      let x, y;
      if (longAxisX) {
        x = cx - pw / 2 + c * PANEL_LONG + rowOffset;
        y = cy - ph / 2 + r * PANEL_SHORT;
      } else {
        x = cx - pw / 2 + r * PANEL_SHORT;
        y = cy - ph / 2 + c * PANEL_LONG + rowOffset;
      }

      const clipped = clipPolygonByRect(roomPoly, x, y, x + pw, y + ph);
      if (clipped.length < 3) continue;
      const area = polygonArea(clipped);
      if (area < 100) continue; // < 1 cm² — slivers from corner-touching rooms

      const fullArea = pw * ph;
      const isFull   = Math.abs(area - fullArea) < 1;
      const cbbox    = polygonBBox(clipped);
      const w = Math.round(cbbox.w);
      const h = Math.round(cbbox.h);
      const isRect = Math.abs(cbbox.w * cbbox.h - area) < 10;

      const clipLeft   = cbbox.x0 > x      + 0.5;
      const clipTop    = cbbox.y0 > y      + 0.5;
      const clipRight  = cbbox.x1 < x + pw - 0.5;
      const clipBottom = cbbox.y1 < y + ph - 0.5;
      const xClip = clipLeft || clipRight;
      const yClip = clipTop  || clipBottom;

      let type;
      if (isFull)        type = 'full';
      else if (!isRect)  type = 'shaped';
      else if (xClip && yClip) type = 'corner';
      else                     type = 'edge';

      out.push({
        polygon: clipped,
        bbox: cbbox,
        x: cbbox.x0, y: cbbox.y0, w, h,
        area, isFull, isRectangular: isRect,
        type,
        tooSmall: !isFull && (w < MIN_CUT_WARN || h < MIN_CUT_WARN),
        srcX: x, srcY: y, fullW: pw, fullH: ph,
      });
    }
  }

  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out;
}

// -------- Cut grouping --------

function groupPanels(panels) {
  const fullCount = panels.filter(p => p.isFull).length;
  const cuts = panels.filter(p => !p.isFull);
  const groups = new Map();
  for (const p of cuts) {
    const a = Math.min(p.w, p.h);
    const b = Math.max(p.w, p.h);
    const key = `${a}x${b}`;
    let g = groups.get(key);
    if (!g) {
      g = { w: a, h: b, count: 0, types: new Set(), tooSmall: p.tooSmall };
      groups.set(key, g);
    }
    g.count++;
    g.types.add(p.type);
    g.tooSmall = g.tooSmall || p.tooSmall;
  }
  const cutGroups = [...groups.values()].map(g => ({
    ...g,
    type: g.types.has('shaped') ? 'shaped'
        : g.types.has('corner') ? 'corner'
        : 'edge',
    canPair: (g.w + g.w <= PANEL_LONG) || (g.h + g.h <= PANEL_LONG)
            || (g.w * 2 <= PANEL_SHORT) || (g.h * 2 <= PANEL_SHORT),
    piecesPerPanel: piecesPerPanel(g.w, g.h),
  })).sort((a, b) => b.count - a.count);

  return { fullCount, cutGroups, totalPieces: panels.length, cutCount: cuts.length };
}

// How many cut pieces of (w×h) fit in a single 600×1200 panel.
function piecesPerPanel(w, h) {
  const a = Math.min(w, h), b = Math.max(w, h);
  const n1 = Math.floor(PANEL_SHORT / a) * Math.floor(PANEL_LONG / b);
  const n2 = (b <= PANEL_SHORT) ? Math.floor(PANEL_LONG / a) * Math.floor(PANEL_SHORT / b) : 0;
  return Math.max(1, n1, n2);
}

function estimatePurchase(fullCount, cutGroups, wastePct) {
  let cutPanels = 0;
  for (const g of cutGroups) {
    cutPanels += Math.ceil(g.count / g.piecesPerPanel);
  }
  const layoutPanels = fullCount + cutPanels;
  const withWaste = Math.ceil(layoutPanels * (1 + wastePct / 100));
  return { layoutPanels, withWaste };
}

// -------- Screw placement --------

// Standard 6-screw pattern on a full 600×1200 panel: 4 corners + 2 middle
// on the long edges at the long-axis midpoint, all 25mm inset.
// For cut panels we use the same rule applied to the cut's own bounding
// box, omitting the middle pair when the long side is too short to need it.
function placeScrews(panel) {
  const { x, y, w, h } = panel;
  if (w < 60 || h < 60) return [];

  const candidates = [
    { x: x + SCREW_INSET,     y: y + SCREW_INSET     },
    { x: x + w - SCREW_INSET, y: y + SCREW_INSET     },
    { x: x + SCREW_INSET,     y: y + h - SCREW_INSET },
    { x: x + w - SCREW_INSET, y: y + h - SCREW_INSET },
  ];
  if (Math.max(w, h) >= SCREW_MID_THRESHOLD) {
    if (h >= w) {
      candidates.push({ x: x + SCREW_INSET,     y: y + h / 2 });
      candidates.push({ x: x + w - SCREW_INSET, y: y + h / 2 });
    } else {
      candidates.push({ x: x + w / 2, y: y + SCREW_INSET     });
      candidates.push({ x: x + w / 2, y: y + h - SCREW_INSET });
    }
  }
  // For shaped (non-rectangular) cuts, drop screws that fall outside
  // the actual cut polygon (e.g. on the wrong side of a diagonal wall).
  if (panel.isRectangular) return candidates;
  return candidates.filter(c => pointInPolygon(c, panel.polygon));
}

function totalScrewCount(panels) {
  return panels.reduce((n, p) => n + placeScrews(p).length, 0);
}

// -------- SVG renderer --------

// SVG presentation attributes applied directly so svg2pdf reads them
// reliably (it doesn't always resolve external-stylesheet fills/strokes).
const SVG_STYLE = {
  roomFill:   { fill: '#ffffff' },
  roomBorder: { fill: 'none', stroke: '#1a1a1a', 'stroke-width': 5 },
  panelFull:  { fill: '#fcfcfa', stroke: '#999',    'stroke-width': 1.5 },
  panelCut:   { fill: '#fef3c7', stroke: '#b08a3a', 'stroke-width': 1.5 },
  panelWarn:  { fill: '#fecaca', stroke: '#b91c1c', 'stroke-width': 2 },
  centerline: { stroke: '#c4b87a', 'stroke-width': 1.5, 'stroke-dasharray': '18 10', fill: 'none', opacity: 0.55 },
  dimLine:    { stroke: '#1a1a1a', 'stroke-width': 1.5, fill: 'none' },
  dimExt:     { stroke: '#999',    'stroke-width': 1,   fill: 'none' },
  dimTick:    { stroke: '#1a1a1a', 'stroke-width': 2,   fill: 'none' },
  dimLabel:   { 'font-family': 'sans-serif', 'font-size': 60, 'font-weight': 600, fill: '#1a1a1a', 'text-anchor': 'middle' },
  panelLabel: { 'font-family': 'sans-serif', 'font-size': 38, fill: '#999',    'text-anchor': 'middle' },
  cutLabel:   { 'font-family': 'sans-serif', 'font-weight': 600, fill: '#92400e', 'text-anchor': 'middle' },
  screw:      { fill: '#333', stroke: '#fff', 'stroke-width': 1.5 },
  offsetDim:  { stroke: '#1a1a1a', 'stroke-width': 1.5, fill: 'none' },
  offsetTick: { stroke: '#1a1a1a', 'stroke-width': 1.5, fill: 'none' },
  offsetLabel:{ 'font-family': 'sans-serif', 'font-size': 38, 'font-weight': 500, fill: '#1a1a1a' },
};
const SCREW_R = 14; // mm radius for drawing

function el(parent, tag, attrs, text) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function polygonPointsAttr(poly) {
  return poly.map(p => `${p.x},${p.y}`).join(' ');
}

function renderSVG(roomPoly, panels) {
  const svg = els.svg;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const bbox = polygonBBox(roomPoly);
  const W = bbox.w, L = bbox.h;
  const pad = 900;
  svg.setAttribute('viewBox', `${bbox.x0 - pad} ${bbox.y0 - pad} ${W + 2 * pad} ${L + 2 * pad}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Clip path so panel grid never leaks past polygon walls visually
  const defs = el(svg, 'defs', {});
  const clip = el(defs, 'clipPath', { id: 'room-clip' });
  el(clip, 'polygon', { points: polygonPointsAttr(roomPoly) });

  const roomPts = polygonPointsAttr(roomPoly);
  el(svg, 'polygon', { points: roomPts, ...SVG_STYLE.roomFill });

  // Centerlines through the bounding-box center
  const cxBB = bbox.x0 + W / 2, cyBB = bbox.y0 + L / 2;
  el(svg, 'line', { x1: cxBB, y1: bbox.y0, x2: cxBB, y2: bbox.y1, ...SVG_STYLE.centerline });
  el(svg, 'line', { x1: bbox.x0, y1: cyBB, x2: bbox.x1, y2: cyBB, ...SVG_STYLE.centerline });

  const gGrid = el(svg, 'g', {});
  for (const p of panels) {
    const style = p.isFull ? SVG_STYLE.panelFull : (p.tooSmall ? SVG_STYLE.panelWarn : SVG_STYLE.panelCut);
    if (p.isRectangular) {
      el(gGrid, 'rect', { x: p.bbox.x0, y: p.bbox.y0, width: p.bbox.w, height: p.bbox.h, ...style });
    } else {
      el(gGrid, 'polygon', { points: polygonPointsAttr(p.polygon), ...style });
    }
  }

  const gLabels = el(svg, 'g', { class: 'layer-labels' });
  let seq = 0;
  for (const p of panels) {
    if (!p.isFull) continue;
    seq++;
    const cx = p.bbox.x0 + p.bbox.w / 2, cy = p.bbox.y0 + p.bbox.h / 2;
    el(gLabels, 'text', { x: cx, y: cy + 14, ...SVG_STYLE.panelLabel }, String(seq));
  }

  const gCuts = el(svg, 'g', { class: 'layer-cuts' });
  for (const p of panels) {
    if (p.isFull) continue;
    if (p.w < 90 || p.h < 60) continue;
    const c = polygonCentroid(p.polygon);
    const label = p.isRectangular ? `${p.w}×${p.h}` : `~${p.w}×${p.h}`;
    const minDim = Math.min(p.w, p.h);
    const size = minDim < 220 ? 28 : 42;
    el(gCuts, 'text', {
      x: c.x, y: c.y + size / 3,
      ...SVG_STYLE.cutLabel,
      'font-size': size,
    }, label);
  }

  const gDims = el(svg, 'g', { class: 'layer-dims' });
  drawHorizontalDim(gDims, bbox.x0, bbox.x1, bbox.y0 - 350, `${Math.round(W)} mm`);
  drawVerticalDim  (gDims, bbox.y0, bbox.y1, bbox.x0 - 350, `${Math.round(L)} mm`);

  // Anchor offsets are bbox-relative; meaningful for rectangular rooms,
  // approximate for polygons (drawn vs bounding box, not actual walls).
  const longAxisX = W >= L;
  const pw = longAxisX ? PANEL_LONG  : PANEL_SHORT;
  const ph = longAxisX ? PANEL_SHORT : PANEL_LONG;
  const ax  = cxBB - pw / 2;
  const ay  = cyBB - ph / 2;
  const ax2 = ax + pw;
  const ay2 = ay + ph;
  drawOffsetV(gDims, cxBB, bbox.y0, ay,        `${Math.round(ay - bbox.y0)} mm`);
  drawOffsetV(gDims, cxBB, ay2,     bbox.y1,   `${Math.round(bbox.y1 - ay2)} mm`);
  drawOffsetH(gDims, cyBB, bbox.x0, ax,        `${Math.round(ax - bbox.x0)} mm`);
  drawOffsetH(gDims, cyBB, ax2,     bbox.x1,   `${Math.round(bbox.x1 - ax2)} mm`);

  const gScrews = el(svg, 'g', { class: 'layer-screws' });
  for (const p of panels) {
    for (const s of placeScrews(p)) {
      el(gScrews, 'circle', { cx: s.x, cy: s.y, r: SCREW_R, ...SVG_STYLE.screw });
    }
  }

  // Room border (polygon, on top so cut edges don't bleed past it)
  el(svg, 'polygon', { points: roomPts, ...SVG_STYLE.roomBorder });
}

function drawHorizontalDim(g, x0, x1, yLine, label) {
  el(g, 'line', { x1: x0, y1: yLine, x2: x1, y2: yLine, ...SVG_STYLE.dimLine });
  el(g, 'line', { x1: x0, y1: 0, x2: x0, y2: yLine - 30, ...SVG_STYLE.dimExt });
  el(g, 'line', { x1: x1, y1: 0, x2: x1, y2: yLine - 30, ...SVG_STYLE.dimExt });
  const t = 70;
  el(g, 'line', { x1: x0 - t/2, y1: yLine + t/2, x2: x0 + t/2, y2: yLine - t/2, ...SVG_STYLE.dimTick });
  el(g, 'line', { x1: x1 - t/2, y1: yLine + t/2, x2: x1 + t/2, y2: yLine - t/2, ...SVG_STYLE.dimTick });
  el(g, 'text', { x: (x0 + x1) / 2, y: yLine - 35, ...SVG_STYLE.dimLabel }, label);
}

// Interior dim: vertical line at x from y0..y1, with perpendicular ticks
// and a label placed to the right of the line. Used for anchor offsets.
function drawOffsetV(g, x, y0, y1, label) {
  if (y1 - y0 < 80) return;
  el(g, 'line', { x1: x, y1: y0, x2: x, y2: y1, ...SVG_STYLE.offsetDim });
  const t = 50;
  el(g, 'line', { x1: x - t / 2, y1: y0, x2: x + t / 2, y2: y0, ...SVG_STYLE.offsetTick });
  el(g, 'line', { x1: x - t / 2, y1: y1, x2: x + t / 2, y2: y1, ...SVG_STYLE.offsetTick });
  el(g, 'text', {
    x: x + 45, y: (y0 + y1) / 2 + 14,
    ...SVG_STYLE.offsetLabel,
    'text-anchor': 'start',
  }, label);
}

function drawOffsetH(g, y, x0, x1, label) {
  if (x1 - x0 < 80) return;
  el(g, 'line', { x1: x0, y1: y, x2: x1, y2: y, ...SVG_STYLE.offsetDim });
  const t = 50;
  el(g, 'line', { x1: x0, y1: y - t / 2, x2: x0, y2: y + t / 2, ...SVG_STYLE.offsetTick });
  el(g, 'line', { x1: x1, y1: y - t / 2, x2: x1, y2: y + t / 2, ...SVG_STYLE.offsetTick });
  el(g, 'text', {
    x: (x0 + x1) / 2, y: y - 20,
    ...SVG_STYLE.offsetLabel,
    'text-anchor': 'middle',
  }, label);
}

function drawVerticalDim(g, y0, y1, xLine, label) {
  el(g, 'line', { x1: xLine, y1: y0, x2: xLine, y2: y1, ...SVG_STYLE.dimLine });
  el(g, 'line', { x1: 0, y1: y0, x2: xLine + 30, y2: y0, ...SVG_STYLE.dimExt });
  el(g, 'line', { x1: 0, y1: y1, x2: xLine + 30, y2: y1, ...SVG_STYLE.dimExt });
  const t = 70;
  el(g, 'line', { x1: xLine - t/2, y1: y0 + t/2, x2: xLine + t/2, y2: y0 - t/2, ...SVG_STYLE.dimTick });
  el(g, 'line', { x1: xLine - t/2, y1: y1 + t/2, x2: xLine + t/2, y2: y1 - t/2, ...SVG_STYLE.dimTick });
  const mid = (y0 + y1) / 2;
  el(g, 'text', {
    x: xLine - 35, y: mid,
    ...SVG_STYLE.dimLabel,
    transform: `rotate(-90 ${xLine - 35} ${mid})`,
  }, label);
}

// -------- UI: summary, cut list, layer toggles --------

function renderSummary(roomPoly, group, purchase, wastePct, screwCount, costs, panelPrice, screwPackPrice) {
  const bb = polygonBBox(roomPoly);
  const m2 = polygonArea(roomPoly) / 1e6;
  els.summary.innerHTML = `
    <h3>Summary</h3>
    <div class="stat"><span>Bounding box</span><strong>${Math.round(bb.w)} × ${Math.round(bb.h)} mm</strong></div>
    <div class="stat"><span>Ceiling area</span><strong>${m2.toFixed(2)} m²</strong></div>
    <div class="stat"><span>Pieces in layout</span><strong>${group.totalPieces}</strong></div>
    <div class="stat"><span>Full panels (uncut)</span><strong>${group.fullCount}</strong></div>
    <div class="stat"><span>Cut pieces</span><strong>${group.cutCount}</strong></div>
    <div class="stat total"><span>Panels to purchase</span><strong>${purchase.withWaste}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>incl. ${wastePct}% waste</span><span>(${purchase.layoutPanels} before waste)</span></div>
    <div class="stat total"><span>Screws needed</span><strong>${screwCount}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>screw packs of 100</span><span>${costs.screwPacks}</span></div>
    <div class="stat total"><span>Panel cost</span><strong>${fmtMoney(costs.panelCost)}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>${purchase.withWaste} × ${fmtMoney(panelPrice)}</span></div>
    <div class="stat"><span>Screw cost</span><strong>${fmtMoney(costs.screwCost)}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>${costs.screwPacks} × ${fmtMoney(screwPackPrice)}</span></div>
    <div class="stat total"><span><strong>Total</strong></span><strong>${fmtMoney(costs.totalCost)}</strong></div>
  `;
}

function renderCutList(group) {
  const { fullCount, cutGroups } = group;
  let rows = '';
  rows += `<tr>
    <td class="num">${fullCount}</td>
    <td class="num">600 × 1200</td>
    <td><span class="badge full">full</span></td>
    <td>—</td>
  </tr>`;
  for (const g of cutGroups) {
    const pairNote = g.piecesPerPanel >= 2
      ? `${g.piecesPerPanel} per source panel`
      : '1 per source panel';
    rows += `<tr class="${g.tooSmall ? 'warn' : ''}">
      <td class="num">${g.count}</td>
      <td class="num">${g.w} × ${g.h}</td>
      <td><span class="badge ${g.type}">${g.type}</span></td>
      <td>${pairNote}${g.tooSmall ? ` · <strong>cut &lt; 150 mm</strong>` : ''}</td>
    </tr>`;
  }
  let html = `
    <h2>Cut List</h2>
    <table>
      <thead><tr><th>Qty</th><th>Size (mm)</th><th>Type</th><th>Notes</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  const hasTiny = cutGroups.some(g => g.tooSmall);
  if (hasTiny) {
    html += `<div class="warn-banner">
      One or more cuts are smaller than 150 mm. These are awkward to install — consider shifting the anchor by 300 mm (e.g. nudge the room dimensions slightly) or rotating panel orientation to improve the layout.
    </div>`;
  }
  els.cutList.innerHTML = html;
}

function updateLayerClasses() {
  els.svg.classList.toggle('no-dims',   !els.showDims.checked);
  els.svg.classList.toggle('no-labels', !els.showLab.checked);
  els.svg.classList.toggle('no-cuts',   !els.showCuts.checked);
  els.svg.classList.toggle('no-screws', !els.showScrews.checked);
}

// -------- Main update --------

function readInputs() {
  const { poly, errors } = parsePolygon(els.polygon.value);
  const waste = clamp(parseFloat(els.waste.value), 0, 50);
  const panelPrice     = clamp(parseFloat(els.panelPrice.value),     0, 1e6);
  const screwPackPrice = clamp(parseFloat(els.screwPackPrice.value), 0, 1e6);
  return {
    polygon: poly,
    polygonErrors: errors,
    waste:          isFinite(waste)          ? waste          : 0,
    panelPrice:     isFinite(panelPrice)     ? panelPrice     : 0,
    screwPackPrice: isFinite(screwPackPrice) ? screwPackPrice : 0,
  };
}
function clamp(v, lo, hi) { if (!isFinite(v)) return NaN; return Math.max(lo, Math.min(hi, v)); }

const moneyFmt = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtMoney(n) { return moneyFmt.format(n) + ' kr.'; }

function computeCosts(purchase, screwCount, panelPrice, screwPackPrice) {
  const screwPacks = Math.ceil(screwCount / 100);
  const panelCost  = purchase.withWaste * panelPrice;
  const screwCost  = screwPacks * screwPackPrice;
  return { screwPacks, panelCost, screwCost, totalCost: panelCost + screwCost };
}

let lastState = null;
function update() {
  const { polygon: roomPoly, polygonErrors, waste, panelPrice, screwPackPrice } = readInputs();

  // Status line under the polygon textarea
  if (polygonErrors.length || roomPoly.length < 3) {
    els.polygonStatus.className = 'polygon-status error';
    els.polygonStatus.textContent = polygonErrors[0] || 'Polygon needs ≥ 3 vertices';
    return; // keep the last good drawing
  }
  const bb = polygonBBox(roomPoly);
  const m2 = polygonArea(roomPoly) / 1e6;
  els.polygonStatus.className = 'polygon-status ok';
  els.polygonStatus.textContent =
    `${roomPoly.length} vertices · bbox ${Math.round(bb.w)}×${Math.round(bb.h)} mm · ${m2.toFixed(2)} m²`;

  const panels = generatePanels(roomPoly);
  const group  = groupPanels(panels);
  const purchase = estimatePurchase(group.fullCount, group.cutGroups, waste);
  const screwCount = totalScrewCount(panels);
  const costs = computeCosts(purchase, screwCount, panelPrice, screwPackPrice);
  renderSVG(roomPoly, panels);
  renderSummary(roomPoly, group, purchase, waste, screwCount, costs, panelPrice, screwPackPrice);
  renderCutList(group);
  updateLayerClasses();
  lastState = { roomPoly, waste, panels, group, purchase, screwCount, costs, panelPrice, screwPackPrice };
}

[els.polygon, els.waste, els.panelPrice, els.screwPackPrice].forEach(i => i.addEventListener('input', update));
[els.showDims, els.showLab, els.showCuts, els.showScrews].forEach(c => c.addEventListener('change', updateLayerClasses));
els.exportBtn.addEventListener('click', exportPDF);

update();

// -------- PDF export --------

async function exportPDF() {
  const btn = els.exportBtn;
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const { roomPoly, waste, group, purchase, screwCount, costs, panelPrice, screwPackPrice } = lastState;
    const bb = polygonBBox(roomPoly);
    const W = Math.round(bb.w), L = Math.round(bb.h);

    const clone = els.svg.cloneNode(true);
    clone.classList.remove('no-dims', 'no-labels', 'no-cuts', 'no-screws');

    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:1600px;';
    stage.appendChild(clone);
    document.body.appendChild(stage);

    const pageW = 210, pageH = 297;
    const margin = 12;
    const usableW = pageW - 2 * margin;
    const usableH = pageH - 50;

    const pad = 900;
    const drawW_mm_real = W + 2 * pad;
    const drawH_mm_real = L + 2 * pad;
    const factor = Math.min(usableW / drawW_mm_real, usableH / drawH_mm_real);
    const drawW = drawW_mm_real * factor;
    const drawH = drawH_mm_real * factor;
    const scaleDenom = Math.round(1 / factor);

    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14);
    pdf.text('Troldtekt Panel Calculator', margin, 16);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
    pdf.text(`Rum (bbox): ${W} × ${L} mm`, margin, 23);
    pdf.text(`Skala 1:${scaleDenom}`, pageW - margin, 23, { align: 'right' });
    pdf.text(`Halv forbandt · centered`, margin, 28);
    pdf.text(new Date().toLocaleDateString(), pageW - margin, 28, { align: 'right' });

    const drawX = margin + (usableW - drawW) / 2;
    const drawY = 34;
    await pdf.svg(clone, { x: drawX, y: drawY, width: drawW, height: drawH });

    stage.remove();

    pdf.addPage();
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14);
    pdf.text('Materials & Cut List', margin, 16);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
    pdf.text(`Rum (bbox): ${W} × ${L} mm`, margin, 23);

    let y = 34;
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('Summary', margin, y); y += 6;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
    const m2 = polygonArea(roomPoly) / 1e6;
    const lines = [
      `Ceiling area: ${m2.toFixed(2)} m²`,
      `Pieces in layout: ${group.totalPieces}`,
      `Full panels (uncut): ${group.fullCount}`,
      `Cut pieces: ${group.cutCount}`,
      `Panels to purchase (incl. ${waste}% waste): ${purchase.withWaste}`,
      `   – before waste: ${purchase.layoutPanels}`,
      `Screws needed: ${screwCount}  (${costs.screwPacks} pack${costs.screwPacks === 1 ? '' : 's'} of 100)`,
    ];
    for (const line of lines) { pdf.text(line, margin, y); y += 5.2; }
    y += 6;

    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('Cost', margin, y); y += 6;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
    const costLines = [
      [`Panels  (${purchase.withWaste} × ${fmtMoney(panelPrice)})`,          fmtMoney(costs.panelCost)],
      [`Screws  (${costs.screwPacks} × ${fmtMoney(screwPackPrice)})`,        fmtMoney(costs.screwCost)],
    ];
    for (const [lbl, val] of costLines) {
      pdf.text(lbl, margin, y);
      pdf.text(val, pageW - margin, y, { align: 'right' });
      y += 5.2;
    }
    pdf.setLineWidth(0.2);
    pdf.setDrawColor(180);
    pdf.line(margin, y - 1, pageW - margin, y - 1);
    y += 1;
    pdf.setFont('helvetica', 'bold');
    pdf.text('Total', margin, y);
    pdf.text(fmtMoney(costs.totalCost), pageW - margin, y, { align: 'right' });
    pdf.setFont('helvetica', 'normal');
    y += 8;

    // Reset stroke/line state — svg2pdf leaves setLineWidth at the
    // SVG's last stroke-width (~5mm) which would render any subsequent
    // pdf.line() as a thick grey band.
    pdf.setLineWidth(0.2);
    pdf.setDrawColor(0);

    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('Cut list', margin, y); y += 4;

    const colX = { qty: margin + 2, size: margin + 24, type: margin + 62, notes: margin + 92 };
    const rowH = 5.5;
    const tableW = pageW - 2 * margin;

    // Header bar (matches the grey #f4f4ee bar in the HTML cut list)
    pdf.setFillColor(244, 244, 238);
    pdf.rect(margin, y, tableW, rowH, 'F');
    pdf.setTextColor(85, 85, 85);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8);
    const headerBaseline = y + rowH - 1.8;
    pdf.text('QTY',       colX.qty,   headerBaseline);
    pdf.text('SIZE (MM)', colX.size,  headerBaseline);
    pdf.text('TYPE',      colX.type,  headerBaseline);
    pdf.text('NOTES',     colX.notes, headerBaseline);
    y += rowH;

    // Table outline + header underline
    pdf.setDrawColor(212, 212, 204);
    pdf.line(margin, y, margin + tableW, y);

    pdf.setTextColor(26, 26, 26);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);

    const drawRow = (cells, opts = {}) => {
      if (y + rowH > pageH - 15) { pdf.addPage(); y = 20; }
      if (opts.warn) pdf.setTextColor(153, 27, 27);
      const baseline = y + rowH - 1.6;
      pdf.text(cells[0], colX.qty,   baseline);
      pdf.text(cells[1], colX.size,  baseline);
      pdf.text(cells[2], colX.type,  baseline);
      pdf.text(cells[3], colX.notes, baseline);
      y += rowH;
      pdf.setDrawColor(234, 234, 227);
      pdf.line(margin, y, margin + tableW, y);
      if (opts.warn) pdf.setTextColor(26, 26, 26);
    };

    drawRow([String(group.fullCount), '600 × 1200', 'full', '—']);
    for (const g of group.cutGroups) {
      const note = `${g.piecesPerPanel} per source panel` + (g.tooSmall ? '  (< 150 mm)' : '');
      drawRow([String(g.count), `${g.w} × ${g.h}`, g.type, note], { warn: g.tooSmall });
    }

    pdf.save(`troldtekt-${W}x${L}.pdf`);
  } catch (err) {
    console.error(err);
    alert('PDF export failed: ' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

window.__troldtekt = { generatePanels, groupPanels, estimatePurchase };
