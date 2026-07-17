'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PANEL_LONG  = 1200;
const PANEL_SHORT = 600;
const PANEL_AREA  = PANEL_LONG * PANEL_SHORT;
const MIN_CUT_WARN = 150;

const SCREW_INSET = 25;     // mm from each panel edge
const SCREW_MID_THRESHOLD = 800; // long-axis length needed before mid screws are added

// True in the browser; false when loaded by Node for `node test.js`.
// All DOM wiring below is skipped in Node so the pure geometry
// functions can be required and unit-tested.
const isBrowser = typeof document !== 'undefined';

const els = !isBrowser ? null : {
  polygon:  document.getElementById('polygon'),
  polygonStatus: document.getElementById('polygon-status'),
  waste:    document.getElementById('waste'),
  panelPrice:     document.getElementById('panel-price'),
  screwPackPrice: document.getElementById('screw-pack-price'),
  battenPrice:    document.getElementById('batten-price'),
  battenWidth:    document.getElementById('batten-width'),
  showDims: document.getElementById('show-dims'),
  showLab:  document.getElementById('show-labels'),
  showCuts: document.getElementById('show-cuts'),
  showScrews: document.getElementById('show-screws'),
  showBattens: document.getElementById('show-battens'),
  showHandles: document.getElementById('show-handles'),
  copyLink: document.getElementById('copy-link'),
  svg:      document.getElementById('drawing'),
  summary:  document.getElementById('summary'),
  cutList:  document.getElementById('cut-list'),
  exportBtn:document.getElementById('export'),
  themeToggle: document.getElementById('theme-toggle'),
  rotateBtn: document.getElementById('rotate-panels'),
  optimizeBtn: document.getElementById('optimize'),
  recenterBtn: document.getElementById('recenter'),
  anchorStatus: document.getElementById('anchor-status'),
};

// Manual override for panel orientation. `false` means "use the natural
// long-axis-along-the-longer-bbox-side"; toggling the rotate button
// flips it. Persisted across reloads.
let panelRotated = isBrowser && localStorage.getItem('troldtekt-rotated') === 'true';

// Anchor offset applied to the panel grid, set by the layout optimizer
// (or reset to centered). Not persisted: it is tuned to one polygon and
// orientation, so editing the polygon or rotating panels resets it.
let anchorOffset = { dx: 0, dy: 0 };

// -------- Polygon helpers --------

function parsePolygon(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const raw = [];
  const errors = [];
  const notes = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[(\[]?\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*[\])]?$/);
    if (!m) { errors.push(`Line ${i + 1}: cannot parse "${lines[i]}"`); continue; }
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    if (!isFinite(x) || !isFinite(y) || x < -1 || y < -1 || x > 30000 || y > 30000) {
      errors.push(`Line ${i + 1}: out of range`);
      continue;
    }
    raw.push({ x, y });
  }

  // Drop consecutive duplicate vertices, and a repeated closing vertex
  // (people often re-enter the first point to "close" the polygon).
  const poly = [];
  for (const p of raw) {
    const prev = poly[poly.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.5) continue;
    poly.push(p);
  }
  if (poly.length >= 2) {
    const a = poly[0], b = poly[poly.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.5) poly.pop();
  }
  if (poly.length !== raw.length) notes.push('duplicate vertices dropped');

  if (poly.length < 3) {
    errors.push('Need at least 3 vertices.');
    return { poly, errors, notes };
  }

  const signed = polygonSignedArea(poly);
  if (Math.abs(signed) < 1) {
    errors.push('Polygon has zero area.');
    return { poly, errors, notes };
  }
  // Normalize to clockwise (positive signed area with y pointing down)
  // so downstream geometry always sees one winding.
  if (signed < 0) {
    poly.reverse();
    notes.push('reversed to clockwise');
  }

  const cross = findSelfIntersection(poly);
  if (cross) {
    errors.push(`Polygon self-intersects: wall ${cross[0] + 1} crosses wall ${cross[1] + 1}.`);
  }
  return { poly, errors, notes };
}

// Proper segment intersection test including collinear touching.
function segmentsIntersect(p1, p2, p3, p4) {
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const onSeg = (a, b, c) =>
    Math.min(a.x, b.x) - 1e-9 <= c.x && c.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= c.y && c.y <= Math.max(a.y, b.y) + 1e-9;
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(p3, p4, p1)) return true;
  if (d2 === 0 && onSeg(p3, p4, p2)) return true;
  if (d3 === 0 && onSeg(p1, p2, p3)) return true;
  if (d4 === 0 && onSeg(p1, p2, p4)) return true;
  return false;
}

// Returns [i, j] (0-based wall indices) of the first pair of
// non-adjacent walls that cross, or null if the polygon is simple.
// O(n²) — fine for hand-entered room outlines.
function findSelfIntersection(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // share a vertex
      if (segmentsIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) {
        return [i, j];
      }
    }
  }
  return null;
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

// Shoelace. Positive = clockwise when y points down (screen coords).
function polygonSignedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function polygonArea(poly) {
  return Math.abs(polygonSignedArea(poly));
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

// Clip a horizontal/vertical line to a polygon. Returns the inside
// intervals (sorted, paired). Works for non-convex polygons via the
// even-odd rule. Used to compute batten extents.
function clipHorizontalToPolygon(yLine, poly) {
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a.y < yLine && b.y >= yLine) || (a.y >= yLine && b.y < yLine)) {
      const t = (yLine - a.y) / (b.y - a.y);
      xs.push(a.x + t * (b.x - a.x));
    }
  }
  xs.sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
  return out;
}
function clipVerticalToPolygon(xLine, poly) {
  const ys = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a.x < xLine && b.x >= xLine) || (a.x >= xLine && b.x < xLine)) {
      const t = (xLine - a.x) / (b.x - a.x);
      ys.push(a.y + t * (b.y - a.y));
    }
  }
  ys.sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i + 1 < ys.length; i += 2) out.push([ys[i], ys[i + 1]]);
  return out;
}

// -------- Geometry --------

// Tile the room polygon with 600×1200 panels in halv forbandt, centered
// on the polygon's bounding box (falling back to centroid if the bbox
// center isn't inside the polygon). Each panel rect is clipped against
// the room polygon, so cut pieces can be non-rectangular.
// `offset` ({dx, dy} in mm, optional) shifts the whole grid off the
// centered anchor — used by the layout optimizer. The pattern repeats
// every 1200 mm along the long axis and 600 mm across, so canonical
// offsets stay within ±600 / ±300.
function generatePanels(roomPoly, longAxisX, offset) {
  const bbox = polygonBBox(roomPoly);
  const W = bbox.w, L = bbox.h;
  if (longAxisX === undefined) longAxisX = W >= L;
  const pw = longAxisX ? PANEL_LONG  : PANEL_SHORT;
  const ph = longAxisX ? PANEL_SHORT : PANEL_LONG;

  let cx = bbox.x0 + W / 2;
  let cy = bbox.y0 + L / 2;
  if (!pointInPolygon({ x: cx, y: cy }, roomPoly)) {
    const c = polygonCentroid(roomPoly);
    cx = c.x; cy = c.y;
  }
  if (offset) { cx += offset.dx || 0; cy += offset.dy || 0; }

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

// Battens (lægter) come in two roles, both running parallel to the
// panel's long axis (same direction as the Troldtekt panels):
//   1. Perimeter battens — one along each polygon side that is parallel
//      to the panel long axis. They sit flush against the wall on the
//      room interior. Walls perpendicular to the long axis don't get a
//      perimeter batten (you nail into the joists/walls there instead).
//   2. Interior battens — at the panel grid's row boundaries, 600 mm
//      apart. If a grid line coincides with one of the perimeter walls
//      it's skipped (the perimeter batten already covers it — otherwise
//      a width/2 strip would poke outside the room).
// Perimeter battens are rotated rectangles (polygons); interior battens
// are axis-aligned rectangles centred on the grid line.
const BATTEN_SPACING = PANEL_SHORT; // 600 mm
const PARALLEL_TOL = 0.1; // dot-product slop for "wall follows long axis"

function generateBattens(roomPoly, battenWidth, longAxisX, offset) {
  const bbox = polygonBBox(roomPoly);
  const W = bbox.w, L = bbox.h;
  if (longAxisX === undefined) longAxisX = W >= L;

  let cx = bbox.x0 + W / 2;
  let cy = bbox.y0 + L / 2;
  if (!pointInPolygon({ x: cx, y: cy }, roomPoly)) {
    const c = polygonCentroid(roomPoly);
    cx = c.x; cy = c.y;
  }
  // Interior battens sit on the panel grid's row boundaries, so they
  // must follow the same anchor offset as generatePanels.
  if (offset) { cx += offset.dx || 0; cy += offset.dy || 0; }

  const out = [];
  // Perpendicular coordinates of the perimeter walls — used to skip any
  // interior grid line that would collide with one of them.
  const perimeterCoords = [];

  // Perimeter battens: only on walls that follow the panel's long axis.
  for (let i = 0; i < roomPoly.length; i++) {
    const a = roomPoly[i];
    const b = roomPoly[(i + 1) % roomPoly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    const followsLongAxis = longAxisX
      ? Math.abs(dy) / length < PARALLEL_TOL  // horizontal-ish wall
      : Math.abs(dx) / length < PARALLEL_TOL; // vertical-ish wall
    if (!followsLongAxis) continue;

    const px = -dy / length, py = dx / length;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const inwardSign = pointInPolygon({ x: mx + px, y: my + py }, roomPoly) ? 1 : -1;
    const nx = px * inwardSign, ny = py * inwardSign;
    const corners = [
      { x: a.x,                      y: a.y                      },
      { x: b.x,                      y: b.y                      },
      { x: b.x + nx * battenWidth,   y: b.y + ny * battenWidth   },
      { x: a.x + nx * battenWidth,   y: a.y + ny * battenWidth   },
    ];
    out.push({ perimeter: true, corners, length });
    perimeterCoords.push(longAxisX ? my : mx);
  }

  // Interior battens at panel-grid row boundaries (skipping any that
  // would land on a perimeter wall).
  const coincides = v => perimeterCoords.some(c => Math.abs(c - v) < 1);
  if (longAxisX) {
    const anchorY = cy - PANEL_SHORT / 2;
    const rMin = Math.floor((bbox.y0 - anchorY) / BATTEN_SPACING);
    const rMax = Math.ceil ((bbox.y1 - anchorY) / BATTEN_SPACING);
    for (let r = rMin; r <= rMax; r++) {
      const y = anchorY + r * BATTEN_SPACING;
      if (y < bbox.y0 - 0.5 || y > bbox.y1 + 0.5) continue;
      if (coincides(y)) continue;
      for (const [x0, x1] of clipHorizontalToPolygon(y, roomPoly)) {
        if (x1 - x0 < 1) continue;
        out.push({ horizontal: true, y, x0, x1, length: x1 - x0 });
      }
    }
  } else {
    const anchorX = cx - PANEL_SHORT / 2;
    const cMin = Math.floor((bbox.x0 - anchorX) / BATTEN_SPACING);
    const cMax = Math.ceil ((bbox.x1 - anchorX) / BATTEN_SPACING);
    for (let c = cMin; c <= cMax; c++) {
      const x = anchorX + c * BATTEN_SPACING;
      if (x < bbox.x0 - 0.5 || x > bbox.x1 + 0.5) continue;
      if (coincides(x)) continue;
      for (const [y0, y1] of clipVerticalToPolygon(x, roomPoly)) {
        if (y1 - y0 < 1) continue;
        out.push({ horizontal: false, x, y0, y1, length: y1 - y0 });
      }
    }
  }
  return out;
}

function totalBattenLength(battens) {
  return battens.reduce((sum, b) => sum + b.length, 0); // mm
}

// -------- Setting-out measurements --------

// The numbers an installer chalks on the ceiling before anything goes
// up, measured from the bounding-box walls (exact for rectangular
// rooms, approximate for polygons — same caveat as the anchor dims):
//  - crossFirst: distance from the cross-axis min wall (top wall when
//    battens run horizontally, left wall when vertical) to the first
//    interior batten centerline; battens repeat at 600 mm c/c.
//  - longFirst: distance from the long-axis min wall to the first
//    panel end joint on even rows; joints repeat at 1200 mm, odd rows
//    are shifted 600 mm (halv forbandt).
// Either is null when the room is too small to have such a line.
function computeSettingOut(roomPoly, longAxisX, offset) {
  const bbox = polygonBBox(roomPoly);
  if (longAxisX === undefined) longAxisX = bbox.w >= bbox.h;
  let cx = bbox.x0 + bbox.w / 2;
  let cy = bbox.y0 + bbox.h / 2;
  if (!pointInPolygon({ x: cx, y: cy }, roomPoly)) {
    const c = polygonCentroid(roomPoly);
    cx = c.x; cy = c.y;
  }
  if (offset) { cx += offset.dx || 0; cy += offset.dy || 0; }

  const crossMin  = longAxisX ? bbox.y0 : bbox.x0;
  const crossSize = longAxisX ? bbox.h : bbox.w;
  const longMin   = longAxisX ? bbox.x0 : bbox.y0;
  const longSize  = longAxisX ? bbox.w : bbox.h;
  const crossC    = longAxisX ? cy : cx;
  const longC     = longAxisX ? cx : cy;

  // First grid line strictly inside the room (a line on the wall itself
  // is the wall, not a chalk line).
  const firstInside = (anchor, spacing, min) =>
    anchor + Math.ceil((min + 1 - anchor) / spacing) * spacing - min;

  let crossFirst = Math.round(firstInside(crossC - PANEL_SHORT / 2, BATTEN_SPACING, crossMin));
  let longFirst  = Math.round(firstInside(longC - PANEL_LONG / 2, PANEL_LONG, longMin));
  if (crossFirst >= crossSize - 1) crossFirst = null;
  if (longFirst  >= longSize - 1)  longFirst  = null;

  return {
    crossFirst, crossWall: longAxisX ? 'top' : 'left',
    longFirst,  longWall:  longAxisX ? 'left' : 'top',
  };
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

// Pack the cut pieces into virtual 600×1200 source panels so that
// complementary cuts share a panel (e.g. a 600×340 and a 600×860 both
// come out of one 600×1200). Two-level guillotine, first-fit-decreasing:
// a panel is divided into full-width strips along its 1200 mm length;
// each strip holds pieces side by side across the 600 mm width. Pieces
// may rotate 90°. Shaped cuts are packed by their bounding box
// (conservative). Saw kerf is ignored — the most common pairing (two
// pieces summing to exactly 1200 mm) is a single cut.
function packCutPieces(pieces) {
  const sorted = pieces
    .map(p => ({ a: Math.min(p.w, p.h), b: Math.max(p.w, p.h) }))
    .sort((p, q) => q.b - p.b || q.a - p.a);

  const panels = []; // { freeLen, strips: [{ len, freeWidth }] }
  for (const piece of sorted) {
    if (packIntoStrip(panels, piece)) continue;
    if (packIntoNewStrip(panels, piece)) continue;
    const panel = { freeLen: PANEL_LONG, strips: [] };
    panels.push(panel);
    packIntoNewStrip([panel], piece); // always fits: len ≤ 1200
  }
  return panels;
}

function packIntoStrip(panels, piece) {
  for (const panel of panels) {
    for (const s of panel.strips) {
      // Prefer the orientation whose long side runs along the strip,
      // so the piece eats as little strip width as possible.
      if (piece.b <= s.len && piece.a <= s.freeWidth) { s.freeWidth -= piece.a; return true; }
      if (piece.a <= s.len && piece.b <= s.freeWidth) { s.freeWidth -= piece.b; return true; }
    }
  }
  return false;
}

function packIntoNewStrip(panels, piece) {
  // Orient the piece so the new strip is as short as possible: long
  // side across the 600 mm width when it fits, else along the length.
  const len   = piece.b <= PANEL_SHORT ? piece.a : piece.b;
  const width = piece.b <= PANEL_SHORT ? piece.b : piece.a;
  for (const panel of panels) {
    if (len <= panel.freeLen) {
      panel.freeLen -= len;
      panel.strips.push({ len, freeWidth: PANEL_SHORT - width });
      return true;
    }
  }
  return false;
}

function estimatePurchase(fullCount, cutGroups, wastePct) {
  const pieces = [];
  for (const g of cutGroups) {
    for (let i = 0; i < g.count; i++) pieces.push({ w: g.w, h: g.h });
  }
  const cutPanels = packCutPieces(pieces).length;
  const layoutPanels = fullCount + cutPanels;
  const withWaste = Math.ceil(layoutPanels * (1 + wastePct / 100));
  return { layoutPanels, withWaste, cutPanels };
}

// -------- Layout optimizer --------

// Grid-search anchor offsets (both panel orientations) for the layout
// that minimizes, in order: cuts narrower than 150 mm, panels to
// purchase (via the packing estimate), number of cut pieces, and
// finally distance from the centered anchor (ties prefer the natural
// orientation). The tiling repeats every 1200 mm along the long axis
// and 600 mm across — and a 600 mm cross shift equals a 600 mm long
// shift — so dLong ∈ (−600, 600], dCross ∈ (−300, 300] covers every
// distinct layout.
const OPTIMIZE_STEP = 50; // mm search grid

function scoreLayout(roomPoly, longAxisX, offset) {
  const panels = generatePanels(roomPoly, longAxisX, offset);
  const group = groupPanels(panels);
  const purchase = estimatePurchase(group.fullCount, group.cutGroups, 0);
  return {
    tiny: panels.filter(p => p.tooSmall).length,
    panelsNeeded: purchase.layoutPanels,
    cutCount: group.cutCount,
  };
}

function betterLayout(a, b) {
  if (a.tiny !== b.tiny) return a.tiny < b.tiny;
  if (a.panelsNeeded !== b.panelsNeeded) return a.panelsNeeded < b.panelsNeeded;
  if (a.cutCount !== b.cutCount) return a.cutCount < b.cutCount;
  return a.offsetMag < b.offsetMag;
}

function layoutOffsetMag(dLong, dCross, isNaturalOrientation) {
  return Math.abs(dLong) + Math.abs(dCross) + (isNaturalOrientation ? 0 : 1);
}

function optimizeLayout(roomPoly, naturalLongAxisX, step = OPTIMIZE_STEP) {
  let best = null;
  for (const longAxisX of [naturalLongAxisX, !naturalLongAxisX]) {
    for (let dLong = -PANEL_LONG / 2 + step; dLong <= PANEL_LONG / 2; dLong += step) {
      for (let dCross = -PANEL_SHORT / 2 + step; dCross <= PANEL_SHORT / 2; dCross += step) {
        const offset = longAxisX ? { dx: dLong, dy: dCross } : { dx: dCross, dy: dLong };
        const s = scoreLayout(roomPoly, longAxisX, offset);
        s.longAxisX = longAxisX;
        s.offset = offset;
        s.offsetMag = layoutOffsetMag(dLong, dCross, longAxisX === naturalLongAxisX);
        if (!best || betterLayout(s, best)) best = s;
      }
    }
  }
  return best;
}

// -------- Screw placement --------

// Standard 6-screw pattern on a full 600×1200 panel: 4 corners + 2 middle
// on the long edges at the long-axis midpoint, all 25mm inset.
// For cut panels we use the same rule applied to the cut's own bounding
// box, omitting the middle pair when the long side is too short to need it.
//
// When `battens` is passed, every screw is checked against the batten
// layout — a screw only holds if it goes into wood. Screws with no batten
// beneath them are moved along the cross axis (perpendicular to the
// batten direction) to the nearest batten that is still inside the cut
// polygon; if none is reachable within SCREW_SNAP_MAX the screw keeps
// its position and is flagged `offBatten` so the UI can warn about it.
function placeScrews(panel, battens, battenWidth, longAxisX) {
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
  const screws = panel.isRectangular
    ? candidates
    : candidates.filter(c => pointInPolygon(c, panel.polygon));

  if (!battens) return screws;
  return snapScrewsToBattens(screws, panel, battens, battenWidth, longAxisX);
}

const SCREW_SNAP_MAX = 300;      // max mm a screw may move to reach a batten
const SCREW_BATTEN_MARGIN = 2;   // keep snapped screws off the batten's edge

function screwOnBatten(s, battens, battenWidth) {
  for (const b of battens) {
    if (b.perimeter) {
      if (pointInPolygon(s, b.corners)) return true;
    } else if (b.horizontal) {
      if (Math.abs(s.y - b.y) <= battenWidth / 2 &&
          s.x >= b.x0 - 1e-6 && s.x <= b.x1 + 1e-6) return true;
    } else {
      if (Math.abs(s.x - b.x) <= battenWidth / 2 &&
          s.y >= b.y0 - 1e-6 && s.y <= b.y1 + 1e-6) return true;
    }
  }
  return false;
}

function snapScrewsToBattens(screws, panel, battens, battenWidth, longAxisX) {
  const out = [];
  for (const s of screws) {
    if (screwOnBatten(s, battens, battenWidth)) { out.push(s); continue; }
    out.push(snapToNearestBatten(s, panel, battens, battenWidth, longAxisX)
             || { ...s, offBatten: true });
  }
  // Snapping can pull two screws onto the same spot (e.g. both corners
  // of a shallow sliver land on one batten) — keep only the first.
  return out.filter((s, i) =>
    out.findIndex(t => Math.hypot(t.x - s.x, t.y - s.y) < 10) === i);
}

function snapToNearestBatten(s, panel, battens, battenWidth, longAxisX) {
  const cross = longAxisX ? s.y : s.x;
  let best = null, bestDist = Infinity;
  for (const b of battens) {
    let lo, hi;
    if (b.perimeter) {
      const cs = longAxisX ? b.corners.map(c => c.y) : b.corners.map(c => c.x);
      lo = Math.min(...cs); hi = Math.max(...cs);
    } else if (b.horizontal) {
      lo = b.y - battenWidth / 2; hi = b.y + battenWidth / 2;
    } else {
      lo = b.x - battenWidth / 2; hi = b.x + battenWidth / 2;
    }
    const target = Math.max(lo + SCREW_BATTEN_MARGIN,
                   Math.min(hi - SCREW_BATTEN_MARGIN, cross));
    const dist = Math.abs(target - cross);
    if (dist >= bestDist || dist > SCREW_SNAP_MAX) continue;
    const cand = longAxisX ? { x: s.x, y: target } : { x: target, y: s.y };
    // Must actually land on this batten (slanted perimeter battens have
    // a wider bbox than their real footprint) and stay inside the cut.
    if (!screwOnBatten(cand, [b], battenWidth)) continue;
    if (!pointInPolygon(cand, panel.polygon)) continue;
    best = { ...cand, snapped: true };
    bestDist = dist;
  }
  return best;
}

function totalScrewCount(panels) {
  return panels.reduce((n, p) => n + (p.screws || placeScrews(p)).length, 0);
}

function offBattenScrewCount(panels) {
  return panels.reduce((n, p) =>
    n + (p.screws ? p.screws.filter(s => s.offBatten).length : 0), 0);
}

// -------- State persistence & share URLs --------

// The full app state (room, prices, toggles, layout tweaks) is saved
// to localStorage on every update and mirrored into the URL hash via
// history.replaceState, so the current layout is always bookmarkable
// and shareable. Values are plain numbers and , ; . - separators, all
// legal in a URL fragment, so the hash stays readable.
//   #p=0,0;3600,0;3600,4800;0,4800&w=10&pp=129&sp=170&bp=10&bw=95
//    &rot=1&ox=150&oy=-100&hide=cs
const STATE_KEY = 'troldtekt-state';

// letter used in the `hide=` hash field → els key of the checkbox
const LAYER_KEYS = [
  ['d', 'showDims'], ['l', 'showLab'], ['c', 'showCuts'],
  ['s', 'showScrews'], ['b', 'showBattens'], ['h', 'showHandles'],
];

function encodeStateHash(s) {
  const { poly, errors } = parsePolygon(s.polygonText || '');
  if (errors.length) return '';
  const parts = [`p=${poly.map(pt => `${pt.x},${pt.y}`).join(';')}`];
  const num = (key, v) => {
    const n = parseFloat(v);
    if (isFinite(n)) parts.push(`${key}=${n}`);
  };
  num('w',  s.waste);
  num('pp', s.panelPrice);
  num('sp', s.screwPackPrice);
  num('bp', s.battenPrice);
  num('bw', s.battenWidth);
  if (s.rotated) parts.push('rot=1');
  if (s.offset && (s.offset.dx || s.offset.dy)) {
    parts.push(`ox=${s.offset.dx || 0}`, `oy=${s.offset.dy || 0}`);
  }
  if (s.hide) parts.push(`hide=${s.hide}`);
  return parts.join('&');
}

function decodeStateHash(hash) {
  const raw = (hash || '').replace(/^#/, '');
  if (!raw.includes('p=')) return null;
  const s = {};
  let ox, oy;
  for (const part of raw.split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i), v = part.slice(i + 1);
    if      (k === 'p')    s.polygonText = v.split(';').map(pair => pair.replace(',', ', ')).join('\n');
    else if (k === 'w')    s.waste = parseFloat(v);
    else if (k === 'pp')   s.panelPrice = parseFloat(v);
    else if (k === 'sp')   s.screwPackPrice = parseFloat(v);
    else if (k === 'bp')   s.battenPrice = parseFloat(v);
    else if (k === 'bw')   s.battenWidth = parseFloat(v);
    else if (k === 'rot')  s.rotated = v === '1';
    else if (k === 'ox')   ox = parseFloat(v);
    else if (k === 'oy')   oy = parseFloat(v);
    else if (k === 'hide') s.hide = v;
  }
  if (!s.polygonText) return null;
  if (isFinite(ox) || isFinite(oy)) s.offset = { dx: ox || 0, dy: oy || 0 };
  // encodeStateHash omits default values, so absence means default —
  // fill them in so a shared link renders the same for every recipient
  // regardless of their previous rotation/toggle state.
  if (s.rotated === undefined) s.rotated = false;
  if (s.hide === undefined) s.hide = '';
  return s;
}

// -------- Interactive polygon editing (pure part) --------

const VERTEX_SNAP_GRID = 10; // mm — dragged positions round to this
const VERTEX_SNAP_AXIS = 60; // mm — snap to a neighbour's x/y so walls stay straight

function snapVertex(poly, index, x, y) {
  x = Math.round(x / VERTEX_SNAP_GRID) * VERTEX_SNAP_GRID;
  y = Math.round(y / VERTEX_SNAP_GRID) * VERTEX_SNAP_GRID;
  const n = poly.length;
  for (const q of [poly[(index + n - 1) % n], poly[(index + 1) % n]]) {
    if (Math.abs(x - q.x) <= VERTEX_SNAP_AXIS) x = q.x;
    if (Math.abs(y - q.y) <= VERTEX_SNAP_AXIS) y = q.y;
  }
  return {
    x: Math.max(0, Math.min(30000, x)),
    y: Math.max(0, Math.min(30000, y)),
  };
}

// -------- SVG renderer --------

// SVG presentation attributes are applied directly (not via stylesheet)
// so svg2pdf can read them reliably during export. Two palettes, picked
// by `theme` below; the dark palette leans on dark-grey surfaces and
// orange accents to mirror the page chrome.
const THEMES = {
  light: {
    roomFill:    { fill: '#ffffff' },
    roomBorder:  { fill: 'none', stroke: '#1a1a1a', 'stroke-width': 5 },
    panelFull:   { fill: '#fcfcfa', stroke: '#999',    'stroke-width': 1.5 },
    panelCut:    { fill: '#fef3c7', stroke: '#b08a3a', 'stroke-width': 1.5 },
    panelWarn:   { fill: '#fecaca', stroke: '#b91c1c', 'stroke-width': 2 },
    centerline:  { stroke: '#c4b87a', 'stroke-width': 1.5, 'stroke-dasharray': '18 10', fill: 'none', opacity: 0.55 },
    panelLabel:  { 'font-family': 'sans-serif', 'font-size': 38, fill: '#999',    'text-anchor': 'middle' },
    cutLabel:    { 'font-family': 'sans-serif', 'font-weight': 600, fill: '#92400e', 'text-anchor': 'middle' },
    screw:       { fill: '#333', stroke: '#fff', 'stroke-width': 1.5 },
    screwWarn:   { fill: '#b91c1c', stroke: '#fff', 'stroke-width': 1.5 },
    offsetDim:   { stroke: '#1a1a1a', 'stroke-width': 1.5, fill: 'none' },
    offsetTick:  { stroke: '#1a1a1a', 'stroke-width': 1.5, fill: 'none' },
    offsetLabel: { 'font-family': 'sans-serif', 'font-size': 38, 'font-weight': 500, fill: '#1a1a1a' },
    batten:      { fill: '#c69f6c', 'fill-opacity': 0.45, stroke: '#8a5a2b', 'stroke-width': 1, 'stroke-opacity': 0.85 },
    handle:      { fill: '#ffffff', stroke: '#1a1a1a', 'stroke-width': 3 },
    handleMid:   { fill: '#ffffff', stroke: '#999', 'stroke-width': 2, opacity: 0.85 },
    roomEdgeLabel: '#1a1a1a',
    cutEdgeLabel:  '#92400e',
    battenLabel:   '#8a5a2b',
  },
  dark: {
    roomFill:    { fill: '#1f1f1f' },
    roomBorder:  { fill: 'none', stroke: '#fb923c', 'stroke-width': 5 },
    panelFull:   { fill: '#2a2a2a', stroke: '#666',    'stroke-width': 1.5 },
    panelCut:    { fill: '#3a2410', stroke: '#f97316', 'stroke-width': 1.5 },
    panelWarn:   { fill: '#4a1414', stroke: '#ef4444', 'stroke-width': 2 },
    centerline:  { stroke: '#7c4a18', 'stroke-width': 1.5, 'stroke-dasharray': '18 10', fill: 'none', opacity: 0.7 },
    panelLabel:  { 'font-family': 'sans-serif', 'font-size': 38, fill: '#888',    'text-anchor': 'middle' },
    cutLabel:    { 'font-family': 'sans-serif', 'font-weight': 600, fill: '#fdba74', 'text-anchor': 'middle' },
    screw:       { fill: '#fb923c', stroke: '#1a1a1a', 'stroke-width': 1.5 },
    screwWarn:   { fill: '#ef4444', stroke: '#1a1a1a', 'stroke-width': 1.5 },
    offsetDim:   { stroke: '#d4d4d4', 'stroke-width': 1.5, fill: 'none' },
    offsetTick:  { stroke: '#d4d4d4', 'stroke-width': 1.5, fill: 'none' },
    offsetLabel: { 'font-family': 'sans-serif', 'font-size': 38, 'font-weight': 500, fill: '#e6e6e6' },
    batten:      { fill: '#7a4a18', 'fill-opacity': 0.55, stroke: '#fb923c', 'stroke-width': 1, 'stroke-opacity': 0.9 },
    handle:      { fill: '#1f1f1f', stroke: '#fb923c', 'stroke-width': 3 },
    handleMid:   { fill: '#1f1f1f', stroke: '#7c4a18', 'stroke-width': 2, opacity: 0.9 },
    roomEdgeLabel: '#f5f5f5',
    cutEdgeLabel:  '#fdba74',
    battenLabel:   '#fb923c',
  },
};
let theme = THEMES.light;
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

function renderSVG(roomPoly, panels, battens, battenWidth, longAxisX, offset) {
  const svg = els.svg;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const bbox = polygonBBox(roomPoly);
  const W = bbox.w, L = bbox.h;
  if (longAxisX === undefined) longAxisX = W >= L;
  const pad = 900;
  svg.setAttribute('viewBox', `${bbox.x0 - pad} ${bbox.y0 - pad} ${W + 2 * pad} ${L + 2 * pad}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Clip path so panel grid never leaks past polygon walls visually
  const defs = el(svg, 'defs', {});
  const clip = el(defs, 'clipPath', { id: 'room-clip' });
  el(clip, 'polygon', { points: polygonPointsAttr(roomPoly) });

  const roomPts = polygonPointsAttr(roomPoly);
  el(svg, 'polygon', { points: roomPts, ...theme.roomFill });

  // Centerlines through the bounding-box center
  const cxBB = bbox.x0 + W / 2, cyBB = bbox.y0 + L / 2;
  el(svg, 'line', { x1: cxBB, y1: bbox.y0, x2: cxBB, y2: bbox.y1, ...theme.centerline });
  el(svg, 'line', { x1: bbox.x0, y1: cyBB, x2: bbox.x1, y2: cyBB, ...theme.centerline });

  const gGrid = el(svg, 'g', {});
  for (const p of panels) {
    const style = p.isFull ? theme.panelFull : (p.tooSmall ? theme.panelWarn : theme.panelCut);
    if (p.isRectangular) {
      el(gGrid, 'rect', { x: p.bbox.x0, y: p.bbox.y0, width: p.bbox.w, height: p.bbox.h, ...style });
    } else {
      el(gGrid, 'polygon', { points: polygonPointsAttr(p.polygon), ...style });
    }
  }

  const gBattens = el(svg, 'g', { class: 'layer-battens' });
  for (const b of battens) {
    if (b.perimeter) {
      el(gBattens, 'polygon', {
        points: polygonPointsAttr(b.corners),
        ...theme.batten,
      });
    } else if (b.horizontal) {
      el(gBattens, 'rect', {
        x: b.x0, y: b.y - battenWidth / 2,
        width: b.x1 - b.x0, height: battenWidth,
        ...theme.batten,
      });
    } else {
      el(gBattens, 'rect', {
        x: b.x - battenWidth / 2, y: b.y0,
        width: battenWidth, height: b.y1 - b.y0,
        ...theme.batten,
      });
    }
  }
  drawBattenGapLabels(gBattens, battens, bbox, longAxisX, battenWidth);

  const gLabels = el(svg, 'g', { class: 'layer-labels' });
  let seq = 0;
  for (const p of panels) {
    if (!p.isFull) continue;
    seq++;
    const cx = p.bbox.x0 + p.bbox.w / 2, cy = p.bbox.y0 + p.bbox.h / 2;
    el(gLabels, 'text', { x: cx, y: cy + 14, ...theme.panelLabel }, String(seq));
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
      ...theme.cutLabel,
      'font-size': size,
    }, label);
  }

  const gDims = el(svg, 'g', { class: 'layer-dims' });
  drawPolygonEdgeLabels(gDims, roomPoly, {
    fontSize: 56, offset: 220, color: theme.roomEdgeLabel,
    minLength: 100, outward: true, fontWeight: 600,
  });
  for (const p of panels) {
    if (p.isFull || p.isRectangular) continue;
    if (Math.min(p.w, p.h) < 180) continue;
    drawPolygonEdgeLabels(gDims, p.polygon, {
      fontSize: 30, offset: 38, color: theme.cutEdgeLabel,
      minLength: 160, outward: false, fontWeight: 600,
      avoid: p.screws || placeScrews(p),
    });
  }

  // Anchor offsets are bbox-relative; meaningful for rectangular rooms,
  // approximate for polygons (drawn vs bounding box, not actual walls).
  const pw = longAxisX ? PANEL_LONG  : PANEL_SHORT;
  const ph = longAxisX ? PANEL_SHORT : PANEL_LONG;
  const ax  = cxBB + (offset ? offset.dx || 0 : 0) - pw / 2;
  const ay  = cyBB + (offset ? offset.dy || 0 : 0) - ph / 2;
  const ax2 = ax + pw;
  const ay2 = ay + ph;
  drawOffsetV(gDims, cxBB, bbox.y0, ay,        `${Math.round(ay - bbox.y0)} mm`);
  drawOffsetV(gDims, cxBB, ay2,     bbox.y1,   `${Math.round(bbox.y1 - ay2)} mm`);
  drawOffsetH(gDims, cyBB, bbox.x0, ax,        `${Math.round(ax - bbox.x0)} mm`);
  drawOffsetH(gDims, cyBB, ax2,     bbox.x1,   `${Math.round(bbox.x1 - ax2)} mm`);

  const gScrews = el(svg, 'g', { class: 'layer-screws' });
  for (const p of panels) {
    for (const s of (p.screws || placeScrews(p))) {
      el(gScrews, 'circle', {
        cx: s.x, cy: s.y, r: SCREW_R,
        ...(s.offBatten ? theme.screwWarn : theme.screw),
      });
    }
  }

  // Room border (polygon, on top so cut edges don't bleed past it)
  el(svg, 'polygon', { points: roomPts, ...theme.roomBorder });

  // Edit handles (topmost): drag a corner to move it, drag an edge
  // midpoint to add a corner, double-click a corner to remove it.
  // Stripped from PDF export.
  const gHandles = el(svg, 'g', { class: 'layer-handles' });
  const handleR = Math.max(50, Math.min(W, L) * 0.03);
  for (let i = 0; i < roomPoly.length; i++) {
    const a = roomPoly[i], b = roomPoly[(i + 1) % roomPoly.length];
    const mid = el(gHandles, 'circle', {
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, r: handleR * 0.55,
      'data-edge': i, ...theme.handleMid,
    });
    el(mid, 'title', {}, 'Drag to add a corner');
  }
  for (let i = 0; i < roomPoly.length; i++) {
    const c = el(gHandles, 'circle', {
      cx: roomPoly[i].x, cy: roomPoly[i].y, r: handleR,
      'data-vertex': i, ...theme.handle,
    });
    el(c, 'title', {}, 'Drag to move corner · double-click to remove');
  }
}

// Label each edge of a polygon with its length. Used for the room
// outline (outward, large) and for non-rectangular cut panels (inward,
// small). The interior side is detected by sampling perpendicular to
// the edge, so it works for concave polygons too. Pass `avoid` (points
// with radius SCREW_R) to dodge screw markers — the label is tried at
// the midpoint first, then shifted along the edge; if every candidate
// would still collide, the label is skipped.
function drawPolygonEdgeLabels(g, poly, opts) {
  const { fontSize, offset, color, minLength, outward, fontWeight = 500, avoid } = opts;
  const minSep = fontSize * 1.1 + SCREW_R + 6;
  const candidates = [0.5, 0.32, 0.68, 0.22, 0.78];

  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < minLength) continue;

    const px = -dy / length;
    const py =  dx / length;

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const inside = pointInPolygon({ x: mx + px, y: my + py }, poly);
    const sign = (outward ? !inside : inside) ? 1 : -1;

    let lx, ly, placed = false;
    for (const t of candidates) {
      const cx = a.x + dx * t;
      const cy = a.y + dy * t;
      const tx = cx + px * sign * offset;
      const ty = cy + py * sign * offset;
      if (avoid && avoid.some(s => Math.hypot(s.x - tx, s.y - ty) < minSep)) continue;
      lx = tx; ly = ty; placed = true;
      break;
    }
    if (!placed) continue;

    let angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angleDeg >= 90)      angleDeg -= 180;
    else if (angleDeg < -90) angleDeg += 180;

    el(g, 'text', {
      x: lx, y: ly,
      transform: `rotate(${angleDeg} ${lx} ${ly})`,
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-family': 'sans-serif',
      'font-size': fontSize,
      'font-weight': fontWeight,
      fill: color,
    }, `${Math.round(length)}`);
  }
}

// Edge-to-edge distances between adjacent battens. Battens are sorted by
// their perpendicular coordinate; for each adjacent pair we draw a label
// at the gap midpoint, placed past the wall-length labels so it doesn't
// crowd them. Long-axis-X rooms (battens horizontal) → labels on the
// left, rotated. Long-axis-Y rooms → labels above the top wall.
function drawBattenGapLabels(g, battens, bbox, longAxisX, battenWidth) {
  if (battens.length < 2) return;
  const extents = battens.map(b => {
    if (b.perimeter) {
      const cs = longAxisX ? b.corners.map(c => c.y) : b.corners.map(c => c.x);
      return { min: Math.min(...cs), max: Math.max(...cs) };
    }
    const center = b.horizontal ? b.y : b.x;
    return { min: center - battenWidth / 2, max: center + battenWidth / 2 };
  });
  extents.sort((a, b) => a.min - b.min);

  const OFFSET = 400;
  for (let i = 0; i < extents.length - 1; i++) {
    const gap = extents[i + 1].min - extents[i].max;
    if (gap < 1) continue;
    const mid = (extents[i].max + extents[i + 1].min) / 2;

    const attrs = {
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      'font-family': 'sans-serif',
      'font-size': 42,
      'font-weight': 600,
      fill: theme.battenLabel,
    };
    if (longAxisX) {
      attrs.x = bbox.x0 - OFFSET;
      attrs.y = mid;
      attrs.transform = `rotate(-90 ${attrs.x} ${attrs.y})`;
    } else {
      attrs.x = mid;
      attrs.y = bbox.y0 - OFFSET;
    }
    el(g, 'text', attrs, `${Math.round(gap)}`);
  }
}

// Interior dim: vertical line at x from y0..y1, with perpendicular ticks
// and a label placed to the right of the line. Used for anchor offsets.
function drawOffsetV(g, x, y0, y1, label) {
  if (y1 - y0 < 80) return;
  el(g, 'line', { x1: x, y1: y0, x2: x, y2: y1, ...theme.offsetDim });
  const t = 50;
  el(g, 'line', { x1: x - t / 2, y1: y0, x2: x + t / 2, y2: y0, ...theme.offsetTick });
  el(g, 'line', { x1: x - t / 2, y1: y1, x2: x + t / 2, y2: y1, ...theme.offsetTick });
  el(g, 'text', {
    x: x + 45, y: (y0 + y1) / 2 + 14,
    ...theme.offsetLabel,
    'text-anchor': 'start',
  }, label);
}

function drawOffsetH(g, y, x0, x1, label) {
  if (x1 - x0 < 80) return;
  el(g, 'line', { x1: x0, y1: y, x2: x1, y2: y, ...theme.offsetDim });
  const t = 50;
  el(g, 'line', { x1: x0, y1: y - t / 2, x2: x0, y2: y + t / 2, ...theme.offsetTick });
  el(g, 'line', { x1: x1, y1: y - t / 2, x2: x1, y2: y + t / 2, ...theme.offsetTick });
  el(g, 'text', {
    x: (x0 + x1) / 2, y: y - 20,
    ...theme.offsetLabel,
    'text-anchor': 'middle',
  }, label);
}

// -------- UI: summary, cut list, layer toggles --------

function renderSummary(roomPoly, group, purchase, wastePct, screwCount, battenMeters, costs, panelPrice, screwPackPrice, battenPrice, so) {
  const bb = polygonBBox(roomPoly);
  const m2 = polygonArea(roomPoly) / 1e6;
  els.summary.innerHTML = `
    <h3>Summary</h3>
    <div class="stat"><span>Bounding box</span><strong>${Math.round(bb.w)} × ${Math.round(bb.h)} mm</strong></div>
    <div class="stat"><span>Ceiling area</span><strong>${m2.toFixed(2)} m²</strong></div>
    <div class="stat"><span>Pieces in layout</span><strong>${group.totalPieces}</strong></div>
    <div class="stat"><span>Full panels (uncut)</span><strong>${group.fullCount}</strong></div>
    <div class="stat"><span>Cut pieces</span><strong>${group.cutCount}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>cut from (complementary cuts paired)</span><span>${purchase.cutPanels} panels</span></div>
    <div class="stat total"><span>Panels to purchase</span><strong>${purchase.withWaste}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>incl. ${wastePct}% waste</span><span>(${purchase.layoutPanels} before waste)</span></div>
    <div class="stat total"><span>Screws needed</span><strong>${screwCount}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>screw packs of 100</span><span>${costs.screwPacks}</span></div>
    <div class="stat total"><span>Battens needed</span><strong>${battenMeters.toFixed(2)} m</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>edges along long axis + interior @ 600 mm</span></div>
    ${so && so.crossFirst != null ? `
    <div class="stat total"><span>First batten centerline</span><strong>${so.crossFirst} mm</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>from ${so.crossWall} wall · then 600 mm c/c</span></div>` : ''}
    ${so && so.longFirst != null ? `
    <div class="stat"><span>First panel end joint</span><strong>${so.longFirst} mm</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>from ${so.longWall} wall (even rows) · odd rows +600 mm</span></div>` : ''}
    <div class="stat total"><span>Panel cost</span><strong>${fmtMoney(costs.panelCost)}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>${purchase.withWaste} × ${fmtMoney(panelPrice)}</span></div>
    <div class="stat"><span>Screw cost</span><strong>${fmtMoney(costs.screwCost)}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>${costs.screwPacks} × ${fmtMoney(screwPackPrice)}</span></div>
    <div class="stat"><span>Batten cost</span><strong>${fmtMoney(costs.battenCost)}</strong></div>
    <div class="stat" style="font-size:0.78rem; color:#888;"><span>${battenMeters.toFixed(2)} m × ${fmtMoney(battenPrice)}</span></div>
    <div class="stat total"><span><strong>Total</strong></span><strong>${fmtMoney(costs.totalCost)}</strong></div>
  `;
}

function renderCutList(group, offBattenScrews) {
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
  if (offBattenScrews > 0) {
    html += `<div class="warn-banner">
      ${offBattenScrews} screw${offBattenScrews === 1 ? ' has' : 's have'} no batten beneath (marked red in the drawing) — plan an extra batten or noggin at those spots.
    </div>`;
  }
  els.cutList.innerHTML = html;
}

function fmtSigned(n) { return (n > 0 ? '+' : '') + Math.round(n); }

// Status line under the optimize/re-center buttons. `extra` is a
// transient message (optimizer outcome) appended after the state.
function renderAnchorStatus(extra) {
  if (!els.anchorStatus) return;
  const { dx, dy } = anchorOffset;
  let txt = (dx === 0 && dy === 0)
    ? 'Anchor: centered'
    : `Anchor offset: x ${fmtSigned(dx)} · y ${fmtSigned(dy)} mm`;
  if (extra) txt += ` — ${extra}`;
  els.anchorStatus.textContent = txt;
}

// Synchronous optimizer entry point (the button handler wraps this in
// a timeout so the "Optimizing…" label can paint first). Applies the
// best layout and reports what improved vs the current one.
function runOptimize() {
  const { polygon: roomPoly, polygonErrors } = readInputs();
  if (polygonErrors.length || roomPoly.length < 3) return;

  const bb = polygonBBox(roomPoly);
  const naturalLongAxisX = bb.w >= bb.h;
  const currentLongAxisX = panelRotated ? !naturalLongAxisX : naturalLongAxisX;

  const current = scoreLayout(roomPoly, currentLongAxisX, anchorOffset);
  const cur = { dLong: currentLongAxisX ? anchorOffset.dx : anchorOffset.dy,
                dCross: currentLongAxisX ? anchorOffset.dy : anchorOffset.dx };
  current.offsetMag = layoutOffsetMag(cur.dLong, cur.dCross, currentLongAxisX === naturalLongAxisX);

  const best = optimizeLayout(roomPoly, naturalLongAxisX);
  if (!betterLayout(best, current)) {
    renderAnchorStatus('already optimal');
    return;
  }

  panelRotated = best.longAxisX !== naturalLongAxisX;
  localStorage.setItem('troldtekt-rotated', String(panelRotated));
  anchorOffset = best.offset;
  update();

  const parts = [];
  if (best.tiny < current.tiny) parts.push(`cuts < 150 mm: ${current.tiny} → ${best.tiny}`);
  if (best.panelsNeeded < current.panelsNeeded) parts.push(`panels: ${current.panelsNeeded} → ${best.panelsNeeded} (before waste)`);
  if (best.cutCount < current.cutCount) parts.push(`cut pieces: ${current.cutCount} → ${best.cutCount}`);
  renderAnchorStatus(parts.length ? `optimized · ${parts.join(' · ')}` : 'optimized');
}

function updateLayerClasses() {
  els.svg.classList.toggle('no-dims',    !els.showDims.checked);
  els.svg.classList.toggle('no-labels',  !els.showLab.checked);
  els.svg.classList.toggle('no-cuts',    !els.showCuts.checked);
  els.svg.classList.toggle('no-screws',  !els.showScrews.checked);
  els.svg.classList.toggle('no-battens', !els.showBattens.checked);
  els.svg.classList.toggle('no-handles', !els.showHandles.checked);
}

function collectState() {
  return {
    polygonText: els.polygon.value,
    waste: els.waste.value,
    panelPrice: els.panelPrice.value,
    screwPackPrice: els.screwPackPrice.value,
    battenPrice: els.battenPrice.value,
    battenWidth: els.battenWidth.value,
    rotated: panelRotated,
    offset: anchorOffset,
    hide: LAYER_KEYS.filter(([, id]) => !els[id].checked).map(([k]) => k).join(''),
  };
}

function applyState(s) {
  if (s.polygonText !== undefined) els.polygon.value = s.polygonText;
  const setNum = (elKey, v) => { if (isFinite(parseFloat(v))) els[elKey].value = v; };
  setNum('waste', s.waste);
  setNum('panelPrice', s.panelPrice);
  setNum('screwPackPrice', s.screwPackPrice);
  setNum('battenPrice', s.battenPrice);
  setNum('battenWidth', s.battenWidth);
  if (s.rotated !== undefined) {
    panelRotated = !!s.rotated;
    localStorage.setItem('troldtekt-rotated', String(panelRotated));
  }
  anchorOffset = s.offset
    ? { dx: parseFloat(s.offset.dx) || 0, dy: parseFloat(s.offset.dy) || 0 }
    : { dx: 0, dy: 0 };
  if (s.hide !== undefined) {
    for (const [k, id] of LAYER_KEYS) els[id].checked = !s.hide.includes(k);
  }
}

let lastWrittenHash = '';
function saveState() {
  const s = collectState();
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  const hash = encodeStateHash(s);
  if (hash && hash !== lastWrittenHash) {
    lastWrittenHash = hash;
    try { history.replaceState(null, '', '#' + hash); } catch (e) { /* file:// quirks */ }
  }
}

function initState() {
  const fromHash = decodeStateHash(location.hash);
  if (fromHash) {
    applyState(fromHash);
    lastWrittenHash = location.hash.replace(/^#/, '');
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (saved) applyState(saved);
  } catch (e) { /* corrupt state — fall back to defaults */ }
}

// -------- Main update --------

function readInputs() {
  const { poly, errors, notes } = parsePolygon(els.polygon.value);
  const waste = clamp(parseFloat(els.waste.value), 0, 50);
  const panelPrice     = clamp(parseFloat(els.panelPrice.value),     0, 1e6);
  const screwPackPrice = clamp(parseFloat(els.screwPackPrice.value), 0, 1e6);
  const battenPrice    = clamp(parseFloat(els.battenPrice.value),    0, 1e6);
  const battenWidth    = clamp(parseFloat(els.battenWidth.value),   20, 500);
  return {
    polygon: poly,
    polygonErrors: errors,
    polygonNotes: notes,
    waste:          isFinite(waste)          ? waste          : 0,
    panelPrice:     isFinite(panelPrice)     ? panelPrice     : 0,
    screwPackPrice: isFinite(screwPackPrice) ? screwPackPrice : 0,
    battenPrice:    isFinite(battenPrice)    ? battenPrice    : 0,
    battenWidth:    isFinite(battenWidth)    ? battenWidth    : 95,
  };
}
function clamp(v, lo, hi) { if (!isFinite(v)) return NaN; return Math.max(lo, Math.min(hi, v)); }

const moneyFmt = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtMoney(n) { return moneyFmt.format(n) + ' kr.'; }

function computeCosts(purchase, screwCount, battenMeters, panelPrice, screwPackPrice, battenPrice) {
  const screwPacks = Math.ceil(screwCount / 100);
  const panelCost  = purchase.withWaste * panelPrice;
  const screwCost  = screwPacks * screwPackPrice;
  const battenCost = battenMeters * battenPrice;
  return {
    screwPacks, panelCost, screwCost, battenCost,
    totalCost: panelCost + screwCost + battenCost,
  };
}

let lastState = null;
function update() {
  const { polygon: roomPoly, polygonErrors, polygonNotes, waste, panelPrice, screwPackPrice, battenPrice, battenWidth } = readInputs();

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
    `${roomPoly.length} vertices · bbox ${Math.round(bb.w)}×${Math.round(bb.h)} mm · ${m2.toFixed(2)} m²`
    + (polygonNotes.length ? ` · ${polygonNotes.join(' · ')}` : '');

  const naturalLongAxisX = bb.w >= bb.h;
  const longAxisX = panelRotated ? !naturalLongAxisX : naturalLongAxisX;
  const panels = generatePanels(roomPoly, longAxisX, anchorOffset);
  const battens = generateBattens(roomPoly, battenWidth, longAxisX, anchorOffset);
  const battenMeters = totalBattenLength(battens) / 1000;
  for (const p of panels) p.screws = placeScrews(p, battens, battenWidth, longAxisX);
  const group  = groupPanels(panels);
  const purchase = estimatePurchase(group.fullCount, group.cutGroups, waste);
  const screwCount = totalScrewCount(panels);
  const offBatten = offBattenScrewCount(panels);
  const costs = computeCosts(purchase, screwCount, battenMeters, panelPrice, screwPackPrice, battenPrice);
  const settingOut = computeSettingOut(roomPoly, longAxisX, anchorOffset);
  renderSVG(roomPoly, panels, battens, battenWidth, longAxisX, anchorOffset);
  renderSummary(roomPoly, group, purchase, waste, screwCount, battenMeters, costs, panelPrice, screwPackPrice, battenPrice, settingOut);
  renderCutList(group, offBatten);
  renderAnchorStatus();
  updateLayerClasses();
  lastState = { roomPoly, waste, panels, battens, battenMeters, battenWidth, group, purchase, screwCount, offBatten, costs, panelPrice, screwPackPrice, battenPrice, settingOut };
  saveState();
}

if (isBrowser) {
  // A new room shape invalidates a tuned anchor offset — reset it.
  els.polygon.addEventListener('input', () => {
    anchorOffset = { dx: 0, dy: 0 };
    update();
  });
  [els.waste, els.panelPrice, els.screwPackPrice, els.battenPrice, els.battenWidth].forEach(i => i.addEventListener('input', update));
  [els.showDims, els.showLab, els.showCuts, els.showScrews, els.showBattens, els.showHandles].forEach(c =>
    c.addEventListener('change', () => { updateLayerClasses(); saveState(); }));
  els.exportBtn.addEventListener('click', exportPDF);
  els.rotateBtn.addEventListener('click', () => {
    panelRotated = !panelRotated;
    localStorage.setItem('troldtekt-rotated', String(panelRotated));
    anchorOffset = { dx: 0, dy: 0 }; // offset was tuned to the other axis
    update();
  });
  els.optimizeBtn.addEventListener('click', () => {
    const btn = els.optimizeBtn;
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Optimizing…';
    setTimeout(() => {
      try { runOptimize(); }
      finally {
        btn.disabled = false;
        btn.textContent = prevText;
      }
    }, 30);
  });
  els.recenterBtn.addEventListener('click', () => {
    anchorOffset = { dx: 0, dy: 0 };
    update();
  });
  els.copyLink.addEventListener('click', async () => {
    saveState();
    try {
      await navigator.clipboard.writeText(location.href);
      els.copyLink.textContent = 'Copied!';
    } catch (e) {
      els.copyLink.textContent = 'Copy failed';
    }
    setTimeout(() => { els.copyLink.textContent = 'Copy link'; }, 1500);
  });
  // Applying a pasted/back-navigated hash (our own replaceState writes
  // never fire hashchange, but compare anyway).
  window.addEventListener('hashchange', () => {
    if (location.hash.replace(/^#/, '') === lastWrittenHash) return;
    const s = decodeStateHash(location.hash);
    if (!s) return;
    applyState(s);
    update();
  });

  // ---- Vertex editing on the SVG ----
  // pointerdown on a handle starts a drag (capture goes to the SVG root
  // because update() re-creates the handle elements every frame);
  // pointerdown on an edge midpoint inserts a vertex and drags it.
  // The textarea stays the source of truth: every move writes it and
  // re-renders via rAF-throttled update().
  let vertexDrag = null; // { poly, index }
  let dragFrame = 0;

  function svgEventPoint(evt) {
    const ctm = els.svg.getScreenCTM();
    if (!ctm) return null;
    const pt = els.svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(ctm.inverse());
  }

  function writePolyToTextarea(poly) {
    els.polygon.value = poly.map(p => `${p.x}, ${p.y}`).join('\n');
  }

  els.svg.addEventListener('pointerdown', e => {
    const t = e.target;
    const isVertex = t.dataset && t.dataset.vertex !== undefined;
    const isEdge   = t.dataset && t.dataset.edge   !== undefined;
    if ((!isVertex && !isEdge) || !lastState) return;
    e.preventDefault();
    // Work on the polygon that produced the current rendering — it is
    // already normalized, so handle indices match and parsePolygon
    // won't reverse it mid-drag.
    const poly = lastState.roomPoly.map(p => ({ x: p.x, y: p.y }));
    let index;
    if (isVertex) {
      index = +t.dataset.vertex;
    } else {
      const i = +t.dataset.edge;
      const a = poly[i], b = poly[(i + 1) % poly.length];
      index = i + 1;
      poly.splice(index, 0, { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });
    }
    vertexDrag = { poly, index };
    anchorOffset = { dx: 0, dy: 0 }; // the shape is changing
    try { els.svg.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    if (isEdge) {
      writePolyToTextarea(poly);
      update();
    }
  });

  els.svg.addEventListener('pointermove', e => {
    if (!vertexDrag) return;
    const p = svgEventPoint(e);
    if (!p) return;
    vertexDrag.poly[vertexDrag.index] = snapVertex(vertexDrag.poly, vertexDrag.index, p.x, p.y);
    writePolyToTextarea(vertexDrag.poly);
    if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; update(); });
  });

  const endDrag = () => {
    if (!vertexDrag) return;
    vertexDrag = null;
    if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; }
    update();
  };
  els.svg.addEventListener('pointerup', endDrag);
  els.svg.addEventListener('pointercancel', endDrag);

  els.svg.addEventListener('dblclick', e => {
    const t = e.target;
    if (!t.dataset || t.dataset.vertex === undefined || !lastState) return;
    const poly = lastState.roomPoly.map(p => ({ x: p.x, y: p.y }));
    if (poly.length <= 3) return;
    poly.splice(+t.dataset.vertex, 1);
    anchorOffset = { dx: 0, dy: 0 };
    writePolyToTextarea(poly);
    update();
  });

  // Printing happens on white paper — swap the SVG to the light
  // palette for the duration of the print, mirroring PDF export.
  // (style.css @media print handles the page chrome.)
  let printWasDark = false;
  window.addEventListener('beforeprint', () => {
    printWasDark = document.body.classList.contains('dark');
    if (printWasDark) { theme = THEMES.light; update(); }
  });
  window.addEventListener('afterprint', () => {
    if (printWasDark) { theme = THEMES.dark; update(); }
    printWasDark = false;
  });
}

// -------- Theme (light / dark) --------

function applyTheme(name) {
  theme = THEMES[name] || THEMES.light;
  document.body.classList.toggle('dark', name === 'dark');
  els.themeToggle.textContent = name === 'dark' ? 'Light mode' : 'Dark mode';
  els.themeToggle.setAttribute('aria-pressed', String(name === 'dark'));
}
function initTheme() {
  const stored = localStorage.getItem('troldtekt-theme');
  const preferred = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light';
  applyTheme(stored || preferred);
}
if (isBrowser) {
  els.themeToggle.addEventListener('click', () => {
    const next = document.body.classList.contains('dark') ? 'light' : 'dark';
    localStorage.setItem('troldtekt-theme', next);
    applyTheme(next);
    update();
  });
  initTheme();
}

// -------- Room templates (inspired by the floor plan) --------

// One template per distinct shape topology so the gallery shows the full
// range of polygons the calculator handles, not seven near-identical
// rectangles.
const TEMPLATES = [
  // Plain rectangle.
  { name: 'Værelse',        polygon: [{x:0,y:0},{x:3000,y:0},{x:3000,y:4000},{x:0,y:4000}] },
  // Trapezoid — one slanted wall.
  { name: 'Soveværelse',    polygon: [{x:0,y:0},{x:3500,y:0},{x:3000,y:4200},{x:0,y:4200}] },
  // Rectangle with a chimney-pocket notch.
  { name: 'Badeværelse',    polygon: [{x:0,y:0},{x:2500,y:0},{x:2500,y:3000},{x:1800,y:3000},{x:1800,y:2200},{x:1200,y:2200},{x:1200,y:3000},{x:0,y:3000}] },
  // Pentagon — one cut corner.
  { name: 'Entre',          polygon: [{x:0,y:0},{x:3000,y:0},{x:3000,y:3000},{x:2000,y:4000},{x:0,y:4000}] },
  // L-shape.
  { name: 'Køkken/alrum',   polygon: [{x:0,y:0},{x:6000,y:0},{x:6000,y:3500},{x:3500,y:3500},{x:3500,y:4500},{x:0,y:4500}] },
  // Octagonal (rectangle with all four corners chamfered).
  { name: 'Stue',           polygon: [{x:800,y:0},{x:4200,y:0},{x:5000,y:800},{x:5000,y:3700},{x:4200,y:4500},{x:800,y:4500},{x:0,y:3700},{x:0,y:800}] },
  // T-shape.
  { name: 'Kontor',         polygon: [{x:0,y:0},{x:3500,y:0},{x:3500,y:1500},{x:2500,y:1500},{x:2500,y:3500},{x:1000,y:3500},{x:1000,y:1500},{x:0,y:1500}] },
];

function templatePreviewHTML(template) {
  const bb = polygonBBox(template.polygon);
  const pad = Math.max(bb.w, bb.h) * 0.08;
  const points = template.polygon.map(p => `${p.x},${p.y}`).join(' ');
  const stroke = Math.max(bb.w, bb.h) / 55;
  return `<svg viewBox="${bb.x0 - pad} ${bb.y0 - pad} ${bb.w + 2 * pad} ${bb.h + 2 * pad}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <polygon points="${points}" fill="#fef3c7" stroke="#b08a3a" stroke-width="${stroke}" stroke-linejoin="round"/>
  </svg>`;
}

function renderTemplates() {
  const container = document.getElementById('templates');
  if (!container) return;
  container.innerHTML = TEMPLATES.map((t, i) => {
    const area = (polygonArea(t.polygon) / 1e6).toFixed(2);
    return `<button class="template-card" type="button" data-template="${i}" title="${t.name} — ${area} m²">
      <div class="template-preview">${templatePreviewHTML(t)}</div>
      <span class="template-name">${t.name}</span>
      <span class="template-area">${area} m²</span>
    </button>`;
  }).join('');
  container.addEventListener('click', e => {
    const card = e.target.closest('.template-card');
    if (!card) return;
    const idx = parseInt(card.dataset.template, 10);
    applyTemplate(TEMPLATES[idx], card);
  });
}

function applyTemplate(template, card) {
  els.polygon.value = template.polygon.map(p => `${p.x}, ${p.y}`).join('\n');
  anchorOffset = { dx: 0, dy: 0 };
  if (card) {
    document.querySelectorAll('.template-card.active').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
  }
  update();
}

if (isBrowser) {
  renderTemplates();
  initState(); // URL hash wins over localStorage, both over HTML defaults
  update();
}

// -------- PDF export --------

async function exportPDF() {
  // jsPDF + svg2pdf load from CDNs (with SRI); if either failed —
  // offline, blocked, or tampered — fail with a clear message instead
  // of a TypeError.
  if (!window.jspdf || !window.jspdf.jsPDF || typeof window.svg2pdf === 'undefined') {
    alert('PDF export is unavailable: the jsPDF/svg2pdf libraries could not be loaded from their CDNs. Check your connection and reload the page.');
    return;
  }
  const btn = els.exportBtn;
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Generating…';
  // PDFs are printed on white paper — re-render the SVG with the light
  // palette before snapshotting so the export never comes out dark.
  const wasDark = document.body.classList.contains('dark');
  if (wasDark) { theme = THEMES.light; update(); }
  try {
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const { roomPoly, waste, group, purchase, screwCount, offBatten, battenMeters, costs, panelPrice, screwPackPrice, battenPrice, settingOut } = lastState;
    const bb = polygonBBox(roomPoly);
    const W = Math.round(bb.w), L = Math.round(bb.h);

    const clone = els.svg.cloneNode(true);
    clone.classList.remove('no-dims', 'no-labels', 'no-cuts', 'no-screws', 'no-battens');
    const handleLayer = clone.querySelector('.layer-handles');
    if (handleLayer) handleLayer.remove(); // edit handles are screen-only

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
    pdf.text(`Room (bbox): ${W} × ${L} mm`, margin, 23);
    pdf.text(`Scale 1:${scaleDenom}`, pageW - margin, 23, { align: 'right' });
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
    pdf.text(`Room (bbox): ${W} × ${L} mm`, margin, 23);

    let y = 34;
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('Summary', margin, y); y += 6;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
    const m2 = polygonArea(roomPoly) / 1e6;
    const lines = [
      `Ceiling area: ${m2.toFixed(2)} m²`,
      `Pieces in layout: ${group.totalPieces}`,
      `Full panels (uncut): ${group.fullCount}`,
      `Cut pieces: ${group.cutCount}  (cut from ${purchase.cutPanels} source panels, complementary cuts paired)`,
      `Panels to purchase (incl. ${waste}% waste): ${purchase.withWaste}`,
      `   – before waste: ${purchase.layoutPanels}`,
      `Screws needed: ${screwCount}  (${costs.screwPacks} pack${costs.screwPacks === 1 ? '' : 's'} of 100)`,
      `Battens needed: ${battenMeters.toFixed(2)} m  (edges along long axis + interior @ 600 mm)`,
    ];
    if (offBatten > 0) {
      lines.push(`NOTE: ${offBatten} screw${offBatten === 1 ? '' : 's'} without a batten beneath — add battens/noggins there.`);
    }
    if (settingOut && settingOut.crossFirst != null) {
      lines.push(`Setting out: first batten centerline ${settingOut.crossFirst} mm from ${settingOut.crossWall} wall, then 600 mm c/c`);
    }
    if (settingOut && settingOut.longFirst != null) {
      lines.push(`   first panel end joint ${settingOut.longFirst} mm from ${settingOut.longWall} wall (even rows), 1200 mm c/c, odd rows +600 mm`);
    }
    for (const line of lines) { pdf.text(line, margin, y); y += 5.2; }
    y += 6;

    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
    pdf.text('Cost', margin, y); y += 6;
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(10);
    const costLines = [
      [`Panels   (${purchase.withWaste} × ${fmtMoney(panelPrice)})`,           fmtMoney(costs.panelCost)],
      [`Screws   (${costs.screwPacks} × ${fmtMoney(screwPackPrice)})`,         fmtMoney(costs.screwCost)],
      [`Battens  (${battenMeters.toFixed(2)} m × ${fmtMoney(battenPrice)})`,   fmtMoney(costs.battenCost)],
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
    if (wasDark) { theme = THEMES.dark; update(); }
  }
}

const __api = {
  parsePolygon, polygonBBox, polygonArea, polygonSignedArea, polygonCentroid,
  pointInPolygon, clipPolygonByRect, findSelfIntersection, segmentsIntersect,
  generatePanels, generateBattens, totalBattenLength, computeSettingOut,
  groupPanels, piecesPerPanel, estimatePurchase, packCutPieces,
  scoreLayout, optimizeLayout, betterLayout,
  encodeStateHash, decodeStateHash, snapVertex,
  placeScrews, screwOnBatten, totalScrewCount, offBattenScrewCount,
};
if (isBrowser) window.__troldtekt = { ...__api, runOptimize };
if (typeof module !== 'undefined' && module.exports) module.exports = __api;
