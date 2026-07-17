'use strict';
// Run with: node test.js
// or, without Node, with the JavaScriptCore shell that ships with macOS:
//   jsc -e 'var module = { exports: {} };' app.js test.js
// Plain-assert tests for the pure geometry in app.js (no framework,
// no build step). app.js skips all DOM wiring when `document` is
// undefined and exports its pure functions via module.exports.

const T = typeof require === 'function'
  ? require('./app.js')
  : module.exports; // jsc: app.js already ran and filled module.exports
if (typeof console === 'undefined') {
  globalThis.console = { log: print, error: print };
}

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`FAIL: ${msg}`);
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function shoelace(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

const RECT = [{ x: 0, y: 0 }, { x: 3600, y: 0 }, { x: 3600, y: 4800 }, { x: 0, y: 4800 }];
const LSHAPE = [
  { x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 1500 },
  { x: 5000, y: 1500 }, { x: 5000, y: 4000 }, { x: 0, y: 4000 },
];
const TRAPEZOID = [{ x: 0, y: 0 }, { x: 3500, y: 0 }, { x: 3000, y: 4200 }, { x: 0, y: 4200 }];

// ---- parsePolygon ----
{
  const r = T.parsePolygon('0, 0\n3600 0\n(3600; 4800)\n0, 4800');
  check(r.errors.length === 0, 'parsePolygon accepts flexible separators');
  check(r.poly.length === 4, 'parsePolygon returns 4 vertices');
}
{
  const r = T.parsePolygon('0, 0\ngarbage\n3600, 4800\n0, 4800');
  check(r.errors.length > 0 && /Line 2/.test(r.errors[0]), 'parsePolygon reports the bad line');
}
{
  const r = T.parsePolygon('0, 0\n3600, 0');
  check(r.errors.some(e => /at least 3/.test(e)), 'parsePolygon rejects < 3 vertices');
}
{
  // Counter-clockwise input is normalized to clockwise (positive
  // signed area with y pointing down).
  const r = T.parsePolygon('0, 0\n0, 4800\n3600, 4800\n3600, 0');
  check(r.errors.length === 0, 'CCW polygon accepted');
  check(shoelace(r.poly) > 0, 'CCW polygon reversed to clockwise');
  check(r.notes.some(n => /clockwise/.test(n)), 'reversal is noted');
}
{
  // Repeated closing vertex is dropped.
  const r = T.parsePolygon('0, 0\n3600, 0\n3600, 4800\n0, 4800\n0, 0');
  check(r.errors.length === 0 && r.poly.length === 4, 'repeated closing vertex dropped');
}
{
  // Symmetric bowtie: the two triangles cancel to zero signed area.
  const r = T.parsePolygon('0, 0\n3000, 3000\n3000, 0\n0, 3000');
  check(r.errors.length > 0, 'symmetric bowtie rejected');
}
{
  // Asymmetric bowtie (nonzero area) — walls 2 and 4 cross.
  const r = T.parsePolygon('0, 0\n3000, 0\n0, 1000\n2000, 3000');
  check(r.errors.some(e => /self-intersects/.test(e)), 'bowtie rejected as self-intersecting');
}
{
  const r = T.parsePolygon('0, 0\n3000, 0\n1500, 0');
  check(r.errors.some(e => /zero area/.test(e)), 'degenerate (zero-area) polygon rejected');
}

// ---- generatePanels: full coverage, sane pieces ----
function coverageChecks(name, poly) {
  const panels = T.generatePanels(poly);
  const covered = panels.reduce((s, p) => s + p.area, 0);
  check(approx(covered, T.polygonArea(poly), 1), `${name}: panel pieces cover the room exactly`);
  check(panels.every(p => p.w <= 1200 && p.h <= 1200 && p.w >= 1 && p.h >= 1),
        `${name}: no piece exceeds panel dimensions`);
  check(panels.every(p => p.isFull === (Math.abs(p.area - 720000) < 1)),
        `${name}: isFull matches full-panel area`);
  return panels;
}
{
  const panels = coverageChecks('rect 3600x4800', RECT);
  const fulls = panels.filter(p => p.isFull);
  check(fulls.length > 0, 'rect: layout contains full panels');
  check(fulls.every(p => (p.w === 600 && p.h === 1200) || (p.w === 1200 && p.h === 600)),
        'rect: full panels are 600x1200');
}
coverageChecks('L-shape', LSHAPE);
{
  const panels = coverageChecks('trapezoid', TRAPEZOID);
  const shaped = panels.filter(p => p.type === 'shaped');
  check(shaped.length > 0, 'trapezoid: diagonal wall produces shaped cuts');
  check(shaped.every(p => !p.isRectangular), 'trapezoid: shaped cuts are non-rectangular');
}

// ---- groupPanels / estimatePurchase / piecesPerPanel ----
{
  const panels = T.generatePanels(RECT);
  const g = T.groupPanels(panels);
  check(g.fullCount + g.cutCount === g.totalPieces, 'groupPanels: counts add up');
  const grouped = g.cutGroups.reduce((s, x) => s + x.count, 0);
  check(grouped === g.cutCount, 'groupPanels: every cut lands in a group');

  const p = T.estimatePurchase(g.fullCount, g.cutGroups, 10);
  check(p.withWaste >= p.layoutPanels, 'estimatePurchase: waste only adds panels');
  check(p.layoutPanels >= g.fullCount, 'estimatePurchase: at least the full panels');
}
check(T.piecesPerPanel(600, 600) === 2, 'piecesPerPanel 600x600 = 2');
check(T.piecesPerPanel(300, 600) === 4, 'piecesPerPanel 300x600 = 4');
check(T.piecesPerPanel(600, 1200) === 1, 'piecesPerPanel 600x1200 = 1');
check(T.piecesPerPanel(200, 1200) === 3, 'piecesPerPanel 200x1200 = 3');

// ---- packing / purchase estimate ----
{
  const g = (w, h, count) => ({ w, h, count });
  check(T.estimatePurchase(0, [g(600, 340, 1), g(600, 860, 1)], 0).cutPanels === 1,
        'packing: 600x340 + 600x860 share one panel');
  check(T.estimatePurchase(0, [g(300, 600, 4)], 0).cutPanels === 1,
        'packing: 4x 300x600 from one panel');
  check(T.estimatePurchase(0, [g(250, 1200, 2)], 0).cutPanels === 1,
        'packing: 2x 250x1200 side by side in one panel');
  check(T.estimatePurchase(0, [g(600, 700, 2)], 0).cutPanels === 2,
        'packing: 700-long pieces cannot pair (1400 > 1200)');
  check(T.estimatePurchase(0, [g(600, 300, 1), g(250, 900, 2)], 0).cutPanels === 1,
        'packing: mixed strips + side-by-side fills one panel');
  check(T.estimatePurchase(0, [g(600, 300, 2), g(250, 900, 2)], 0).cutPanels === 2,
        'packing: 810000 mm² of cuts cannot fit one 720000 mm² panel');
  const p = T.estimatePurchase(5, [g(600, 340, 2), g(600, 860, 2)], 10);
  check(p.layoutPanels === 7, 'packing: fullCount + packed cut panels');
  check(p.withWaste === Math.ceil(7 * 1.1), 'packing: waste applied after packing');
}
{
  // On a real room the packed estimate is never worse than the old
  // per-group formula, and never below the area lower bound.
  for (const [name, poly] of [['rect', RECT], ['L-shape', LSHAPE], ['trapezoid', TRAPEZOID]]) {
    const g = T.groupPanels(T.generatePanels(poly));
    const perGroup = g.cutGroups.reduce((s, x) => s + Math.ceil(x.count / x.piecesPerPanel), 0);
    const est = T.estimatePurchase(g.fullCount, g.cutGroups, 0);
    check(est.cutPanels <= perGroup, `${name}: packing beats or matches per-group estimate`);
    const areaBound = Math.ceil(g.cutGroups.reduce((s, x) => s + x.count * x.w * x.h, 0) / 720000);
    check(est.cutPanels >= areaBound, `${name}: packing respects the area lower bound`);
  }
}

// ---- layout optimizer ----
{
  // 4800x4400: centered tiling leaves 100 mm slivers on both cross
  // edges; shifting the anchor 100 mm merges them into one 200 mm
  // strip. The optimizer must find that (or better).
  const room = [{ x: 0, y: 0 }, { x: 4800, y: 0 }, { x: 4800, y: 4400 }, { x: 0, y: 4400 }];
  const centered = T.scoreLayout(room, true, { dx: 0, dy: 0 });
  check(centered.tiny > 0, 'optimizer: centered 4800x4400 has < 150 mm cuts');
  const best = T.optimizeLayout(room, true);
  check(best.tiny === 0, 'optimizer: removes the < 150 mm cuts');
  check(best.panelsNeeded <= centered.panelsNeeded, 'optimizer: never needs more panels');
  check(best.cutCount <= centered.cutCount + 2, 'optimizer: cut count stays sane');

  // The offset it found still produces a full-coverage layout.
  const panels = T.generatePanels(room, best.longAxisX, best.offset);
  const covered = panels.reduce((s, p) => s + p.area, 0);
  check(approx(covered, T.polygonArea(room), 1), 'optimizer: offset layout still covers the room');
}
{
  // A room that is exactly one panel tiles perfectly when centered —
  // the optimizer must not report an "improvement".
  const room = [{ x: 0, y: 0 }, { x: 1200, y: 0 }, { x: 1200, y: 600 }, { x: 0, y: 600 }];
  const centered = T.scoreLayout(room, true, { dx: 0, dy: 0 });
  centered.offsetMag = 0;
  check(centered.tiny === 0 && centered.cutCount === 0 && centered.panelsNeeded === 1,
        'optimizer: single-panel room is perfect when centered');
  const best = T.optimizeLayout(room, true);
  check(!T.betterLayout(best, centered), 'optimizer: perfect centered layout is not "improved"');
}

// ---- generateBattens ----
{
  // 3600x4800 room, long axis vertical: perimeter battens on the two
  // 4800 walls + interior battens at x = 300..3300 step 600 (6 of them).
  const battens = T.generateBattens(RECT, 95);
  const perimeter = battens.filter(b => b.perimeter);
  const interior = battens.filter(b => !b.perimeter);
  check(perimeter.length === 2, 'battens: 2 perimeter battens on long-axis walls');
  check(interior.length === 6, 'battens: 6 interior battens at 600 mm grid');
  check(approx(T.totalBattenLength(battens), 8 * 4800, 1), 'battens: total length 38.4 m');
}

// ---- screws on battens ----
function screwChecks(name, poly, battenWidth = 95, offset) {
  const bbox = T.polygonBBox(poly);
  const longAxisX = bbox.w >= bbox.h;
  const panels = T.generatePanels(poly, longAxisX, offset);
  const battens = T.generateBattens(poly, battenWidth, longAxisX, offset);
  let off = 0, on = 0, inside = 0, total = 0;
  for (const p of panels) {
    p.screws = T.placeScrews(p, battens, battenWidth, longAxisX);
    for (const s of p.screws) {
      total++;
      if (s.offBatten) { off++; continue; }
      if (T.screwOnBatten(s, battens, battenWidth)) on++;
      if (T.pointInPolygon(s, poly)) inside++;
    }
  }
  check(on === total - off, `${name}: every unflagged screw sits on a batten`);
  check(inside === total - off, `${name}: every unflagged screw is inside the room`);
  check(T.offBattenScrewCount(panels) === off, `${name}: offBattenScrewCount agrees`);
  return { panels, off, total };
}
{
  const { off, total } = screwChecks('rect', RECT);
  check(off === 0, 'rect: no screw needs an extra batten');
  check(total > 0, 'rect: screws were placed');
}
screwChecks('L-shape', LSHAPE);
{
  // Diagonal wall: naive 25 mm-inset corner screws on shaped cuts land
  // between battens; they must be snapped or flagged, never silent.
  const { total } = screwChecks('trapezoid', TRAPEZOID);
  check(total > 0, 'trapezoid: screws were placed');
}
{
  // Narrow battens (20 mm) put the 25 mm inset outside the wood even on
  // full panels — snapping must pull every screw back onto a batten.
  const { off, total } = screwChecks('rect, 20 mm battens', RECT, 20);
  check(total > 0 && off === 0, 'narrow battens: all screws snapped onto battens');
}
{
  // With an anchor offset the battens follow the shifted grid, so the
  // screws-on-battens invariant must still hold.
  const { off, total } = screwChecks('rect with offset', RECT, 95, { dx: -100, dy: 150 });
  check(total > 0 && off === 0, 'offset layout: screws still land on battens');
  screwChecks('trapezoid with offset', TRAPEZOID, 95, { dx: 150, dy: -50 });
}

// ---- totalScrewCount fallback (no battens assigned) ----
{
  const panels = T.generatePanels(RECT);
  check(T.totalScrewCount(panels) > 0, 'totalScrewCount works without batten assignment');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (typeof process !== 'undefined') process.exit(failed ? 1 : 0);
else if (failed) throw new Error(`${failed} test(s) failed`);
