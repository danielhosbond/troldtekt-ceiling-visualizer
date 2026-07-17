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
const pieces = (w, h, n) => Array.from({ length: n }, () => ({ w, h }));
{
  check(T.estimatePurchase(0, [...pieces(600, 340, 1), ...pieces(600, 860, 1)], 0).cutPanels === 1,
        'packing: 600x340 + 600x860 share one panel');
  check(T.estimatePurchase(0, pieces(300, 600, 4), 0).cutPanels === 1,
        'packing: 4x 300x600 from one panel');
  check(T.estimatePurchase(0, pieces(250, 1200, 2), 0).cutPanels === 1,
        'packing: 2x 250x1200 side by side in one panel');
  check(T.estimatePurchase(0, pieces(600, 700, 2), 0).cutPanels === 2,
        'packing: 700-long pieces cannot pair (1400 > 1200)');
  check(T.estimatePurchase(0, [...pieces(600, 300, 1), ...pieces(250, 900, 2)], 0).cutPanels === 1,
        'packing: mixed strips + side-by-side fills one panel');
  check(T.estimatePurchase(0, [...pieces(600, 300, 2), ...pieces(250, 900, 2)], 0).cutPanels === 2,
        'packing: 810000 mm² of cuts cannot fit one 720000 mm² panel');
  const p = T.estimatePurchase(5, [...pieces(600, 340, 2), ...pieces(600, 860, 2)], 10);
  check(p.layoutPanels === 7, 'packing: fullCount + packed cut panels');
  check(p.withWaste === Math.ceil(7 * 1.1), 'packing: waste applied after packing');
}
{
  // Direction-respecting packing never rotates: these two pieces only
  // share a panel if the 600x250 may turn 90°.
  const mix = [{ w: 600, h: 250 }, { w: 250, h: 1200 }];
  check(T.estimatePurchase(0, mix, 0, true).cutPanels === 1,
        'packing: rotation lets 600x250 nest beside 250x1200');
  check(T.estimatePurchase(0, mix, 0, false).cutPanels === 2,
        'packing: respecting direction forbids the rotated nesting');
  // Placements in no-rotate mode keep the given orientation.
  const packed = T.packCutPieces([{ w: 600, h: 250, letter: 'A' }], false);
  const pc = packed[0].strips[0].pieces[0];
  check(pc.w === 600 && pc.h === 250 && pc.letter === 'A',
        'packing: no-rotate placement keeps w across, h along');
}
{
  // On a real room the packed estimate is never worse than the old
  // per-group formula, and never below the area lower bound.
  for (const [name, poly] of [['rect', RECT], ['L-shape', LSHAPE], ['trapezoid', TRAPEZOID]]) {
    const panels = T.generatePanels(poly);
    const g = T.groupPanels(panels);
    const perGroup = g.cutGroups.reduce((s, x) => s + Math.ceil(x.count / x.piecesPerPanel), 0);
    const cutPieces = T.cutPiecesFromPanels(panels, undefined, false, null);
    const est = T.estimatePurchase(g.fullCount, cutPieces, 0);
    check(est.cutPanels <= perGroup, `${name}: packing beats or matches per-group estimate`);
    const areaBound = Math.ceil(cutPieces.reduce((s, x) => s + x.w * x.h, 0) / 720000);
    check(est.cutPanels >= areaBound, `${name}: packing respects the area lower bound`);

    // Every recorded placement is inside its panel, strips don't
    // overlap, and pieces within a strip don't overlap.
    let placementsOK = true, placedArea = 0;
    for (const panel of est.packedPanels) {
      const strips = [...panel.strips].sort((a, b) => a.y0 - b.y0);
      let prevEnd = 0;
      for (const s of strips) {
        if (s.y0 < prevEnd - 1e-6 || s.y0 + s.len > 1200 + 1e-6) placementsOK = false;
        prevEnd = s.y0 + s.len;
        let prevX = 0;
        for (const piece of [...s.pieces].sort((a, b) => a.x - b.x)) {
          if (piece.x < prevX - 1e-6 || piece.x + piece.w > 600 + 1e-6) placementsOK = false;
          if (piece.y !== s.y0 || piece.h > s.len + 1e-6) placementsOK = false;
          prevX = piece.x + piece.w;
          placedArea += piece.w * piece.h;
        }
      }
    }
    check(placementsOK, `${name}: cutting-diagram placements are valid`);
    const inputArea = cutPieces.reduce((s, x) => s + x.w * x.h, 0);
    check(approx(placedArea, inputArea), `${name}: every piece is placed exactly once`);
  }
}
{
  // Group lettering: A for the biggest group, all letters distinct.
  const g = T.groupPanels(T.generatePanels(TRAPEZOID));
  check(g.cutGroups[0] && g.cutGroups[0].letter === 'A', 'letters: first group is A');
  const letters = g.cutGroups.map(x => x.letter);
  check(new Set(letters).size === letters.length, 'letters: all groups distinct');
  check(T.groupLetter(0) === 'A' && T.groupLetter(25) === 'Z' && T.groupLetter(26) === 'AA',
        'letters: base-26 rollover');
}
{
  // PDF cutting diagrams drawn against a stub: every piece rect lies
  // inside one of the panel outline rects, and long lists paginate.
  const rects = [];
  let pages = 0;
  const stub = {
    rect: (x, y, w, h, style) => rects.push({ x, y, w, h, filled: style === 'FD' }),
    text: () => {}, setFont: () => {}, setFontSize: () => {},
    setFillColor: () => {}, setDrawColor: () => {}, setTextColor: () => {},
    setLineWidth: () => {}, addPage: () => { pages++; },
  };
  const est = T.estimatePurchase(0, [
    ...pieces(600, 340, 9), ...pieces(600, 860, 9), ...pieces(250, 1200, 4),
  ], 0);
  T.drawCutDiagrams(stub, est.packedPanels, { margin: 12, pageW: 210, pageH: 297, startY: 30 });
  const outlines = rects.filter(r => !r.filled);
  const pieceRects = rects.filter(r => r.filled);
  check(outlines.length === est.packedPanels.length, 'diagrams: one outline per source panel');
  const totalPieces = est.packedPanels.reduce((s, p) => s + p.strips.reduce((t, st) => t + st.pieces.length, 0), 0);
  check(pieceRects.length === totalPieces, 'diagrams: one rect per placed piece');
  const inside = pieceRects.every(pr => outlines.some(o =>
    pr.x >= o.x - 0.01 && pr.y >= o.y - 0.01 &&
    pr.x + pr.w <= o.x + o.w + 0.01 && pr.y + pr.h <= o.y + o.h + 0.01));
  check(inside, 'diagrams: every piece rect sits inside a panel outline');
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

// ---- setting-out measurements ----
{
  // 3600x4800, long axis vertical: battens are vertical (first
  // centerline measured from the left wall), panel end joints are
  // horizontal (measured from the top wall).
  const so = T.computeSettingOut(RECT);
  check(so.crossWall === 'left' && so.crossFirst === 300, 'setting out: first batten centerline 300 mm from left wall');
  check(so.longWall === 'top' && so.longFirst === 600, 'setting out: first panel joint 600 mm from top wall');

  const soOff = T.computeSettingOut(RECT, false, { dx: 150, dy: -100 });
  check(soOff.crossFirst === 450, 'setting out: batten line follows x offset');
  check(soOff.longFirst === 500, 'setting out: panel joint follows y offset');
}
{
  // Any room/offset: first lines stay inside one spacing of the wall.
  for (const poly of [LSHAPE, TRAPEZOID]) {
    const so = T.computeSettingOut(poly, undefined, { dx: -250, dy: 200 });
    check(so.crossFirst === null || (so.crossFirst > 0 && so.crossFirst <= 600),
          'setting out: batten line within 600 mm of the wall');
    check(so.longFirst === null || (so.longFirst > 0 && so.longFirst <= 1200),
          'setting out: panel joint within 1200 mm of the wall');
  }
  // A room smaller than one grid spacing has no interior lines.
  const tiny = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 400 }, { x: 0, y: 400 }];
  const soTiny = T.computeSettingOut(tiny);
  check(soTiny.crossFirst === null && soTiny.longFirst === null,
        'setting out: sub-grid room reports no chalk lines');
}

// ---- i18n string table ----
{
  const en = Object.keys(T.STRINGS.en).sort();
  const da = Object.keys(T.STRINGS.da).sort();
  check(en.length === da.length && en.every((k, i) => k === da[i]),
        'i18n: en and da have exactly the same keys');
  // Placeholder parity: {0}, {1}… must appear in both translations.
  const holes = s => (String(s).match(/\{\d\}/g) || []).sort().join('');
  const mismatched = en.filter(k => holes(T.STRINGS.en[k]) !== holes(T.STRINGS.da[k]));
  check(mismatched.length === 0,
        `i18n: placeholders match in both languages (${mismatched.join(', ') || 'ok'})`);
  check(T.t('statusOk', 4, 100, 200, '1.00') === '4 vertices · bbox 100×200 mm · 1.00 m²',
        't: placeholder interpolation works');
  check(T.t('no-such-key') === 'no-such-key', 't: unknown keys fall through');
}

// ---- state hash round-trip ----
{
  const state = {
    polygonText: '0, 0\n3600, 0\n3600, 4800\n0, 4800',
    waste: '12', panelPrice: '129', screwPackPrice: '170',
    battenPrice: '10.5', battenWidth: '95',
    rotated: true, offset: { dx: 150, dy: -100 }, hide: 'cs',
  };
  const hash = T.encodeStateHash(state);
  check(hash.startsWith('p=0,0;3600,0;3600,4800;0,4800'), 'hash: polygon encoded compactly');
  check(!/[%#?\s]/.test(hash), 'hash: no characters needing escaping');
  const back = T.decodeStateHash('#' + hash);
  check(back.polygonText === state.polygonText, 'hash: polygon round-trips');
  check(back.waste === 12 && back.panelPrice === 129 && back.battenPrice === 10.5
        && back.screwPackPrice === 170 && back.battenWidth === 95, 'hash: numbers round-trip');
  check(back.rotated === true, 'hash: rotation round-trips');
  const dirHash = T.encodeStateHash({ ...state, respectDirection: true });
  check(dirHash.includes('dir=1') && T.decodeStateHash(dirHash).respectDirection === true,
        'hash: direction toggle round-trips');
  check(T.decodeStateHash(hash).respectDirection === false,
        'hash: direction toggle defaults to off when omitted');
  check(back.offset.dx === 150 && back.offset.dy === -100, 'hash: anchor offset round-trips');
  check(back.hide === 'cs', 'hash: hidden layers round-trip');
}
{
  // Defaults are omitted from the hash and absent on decode.
  const hash = T.encodeStateHash({ polygonText: '0, 0\n1200, 0\n1200, 600\n0, 600', waste: '10' });
  check(!hash.includes('rot') && !hash.includes('ox') && !hash.includes('hide'),
        'hash: default rotation/offset/layers omitted');
  const back = T.decodeStateHash(hash); // also works without the leading #
  check(back.rotated === false && back.hide === '' && back.offset === undefined,
        'hash: omitted rotation/layers decode to defaults so shared links render identically');
  check(T.decodeStateHash('') === null, 'hash: empty input → null');
  check(T.decodeStateHash('#w=10') === null, 'hash: no polygon → null');
  check(T.encodeStateHash({ polygonText: 'garbage' }) === '', 'hash: invalid polygon → empty string');
}

// ---- vertex snapping ----
{
  const poly = [{ x: 0, y: 0 }, { x: 3600, y: 0 }, { x: 3600, y: 4800 }, { x: 0, y: 4800 }];
  const s1 = T.snapVertex(poly, 1, 3577, 42);
  check(s1.x === 3600 && s1.y === 0, 'snapVertex: snaps to neighbour axes within 60 mm');
  const s2 = T.snapVertex(poly, 1, 3212, 2004);
  check(s2.x === 3210 && s2.y === 2000, 'snapVertex: rounds to 10 mm grid away from neighbours');
  const s3 = T.snapVertex(poly, 1, -500, 31000);
  check(s3.x === 0 && s3.y === 30000, 'snapVertex: clamps to the valid coordinate range');
}

// ---- drawing view (zoom) math ----
{
  const fit = T.fitViewBox(RECT);
  check(fit.x === -900 && fit.y === -900 && fit.w === 5400 && fit.h === 6600,
        'fitViewBox: room bbox plus 900 mm padding');

  const v = { x: 0, y: 0, w: 1000, h: 800 };
  const z1 = T.zoomViewBox(v, 2, 250, 200, 100, 5000);
  check(z1.w === 500 && z1.h === 400, 'zoomViewBox: factor 2 halves the view');
  check(approx((250 - z1.x) / z1.w, 250 / 1000) && approx((200 - z1.y) / z1.h, 200 / 800),
        'zoomViewBox: the anchor point stays at the same screen position');

  const z2 = T.zoomViewBox(v, 2, undefined, undefined, 100, 5000);
  check(z2.x === 250 && z2.y === 200 && z2.w === 500, 'zoomViewBox: defaults to zooming around the center');

  check(T.zoomViewBox(v, 100, 500, 400, 250, 5000).w === 250, 'zoomViewBox: clamps to min width');
  const zOut = T.zoomViewBox(v, 0.01, 500, 400, 250, 3000);
  check(zOut.w === 3000 && approx(zOut.h, 2400), 'zoomViewBox: clamps to max width, aspect preserved');
}

// ---- totalScrewCount fallback (no battens assigned) ----
{
  const panels = T.generatePanels(RECT);
  check(T.totalScrewCount(panels) > 0, 'totalScrewCount works without batten assignment');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (typeof process !== 'undefined') process.exit(failed ? 1 : 0);
else if (failed) throw new Error(`${failed} test(s) failed`);
