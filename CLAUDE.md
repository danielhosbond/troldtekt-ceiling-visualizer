# Troldtekt Panel Calculator

Single-file static web app for planning Troldtekt 600 × 1200 mm acoustic
ceiling panel layouts with a **centered halv forbandt** (half-bond) pattern.
Built for hosting on GitHub Pages.

## Stack

- Three app files: `index.html`, `style.css`, `app.js`. No build step.
- jsPDF + svg2pdf.js loaded from CDN for PDF export.
- `app.js` is loaded with `defer` so it runs after the DOM is parsed.
- No package.json, no node_modules, no bundler.
- `test.js` — dev-only assertion tests for the pure geometry. Run with
  `node test.js`, or without Node via the JavaScriptCore shell that
  ships with macOS:
  `jsc -e 'var module = { exports: {} };' app.js test.js`
  (`jsc` lives in `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/`).
  `app.js` skips all DOM wiring when `document` is undefined and
  exports its pure functions via `module.exports`. Run the tests after
  any change to geometry, grouping, batten, or screw logic.

## Architecture

All logic lives in `app.js`.

1. **Room model**: an arbitrary polygon (any number of vertices, any angles
   including diagonals). The user enters vertices as "x, y" lines in the
   textarea. `parsePolygon` validates them: drops duplicate/closing
   vertices, rejects zero-area and self-intersecting polygons
   (`findSelfIntersection`, O(n²) segment test), and normalizes
   counter-clockwise input to clockwise (positive shoelace with y-down).
2. `generatePanels(roomPoly, longAxisX, offset)` — pure function. Tiles
   600×1200 panels in halv forbandt across the polygon's bounding box,
   anchored on the bbox center (falls back to the polygon centroid if
   the bbox center lies outside the polygon, e.g. for L-shapes), plus
   an optional anchor offset. Each panel rect is clipped to
   the room polygon via Sutherland-Hodgman (`clipPolygonByRect`) — the
   panel rect is always convex so it works as the clip region even when
   the room polygon is non-convex.
3. Each clipped panel piece records its actual polygon, its bounding box,
   and an `isRectangular` flag (bbox area ≈ polygon area). Cut types:
   `full`, `edge`, `corner`, `shaped` (non-rectangular).
4. `groupPanels(panels)` — buckets cut panels by (w, h) and computes per-group
   stats (count, type: edge / corner, pieces-per-source-panel).
5. `estimatePurchase(...)` — packs all cut pieces into virtual 600×1200
   source panels via `packCutPieces` (two-level guillotine,
   first-fit-decreasing, 90° rotation allowed) so complementary cuts
   share a panel, then applies the user-set waste %. Kerf is ignored.
6. **Layout optimizer** (`optimizeLayout`) — grid-searches anchor
   offsets (50 mm step, both orientations) and returns the layout
   minimizing, in order: cuts < 150 mm, panels to purchase, cut-piece
   count, offset distance from centered. Offsets are canonical:
   dLong ∈ (−600, 600], dCross ∈ (−300, 300] (the pattern repeats, and
   a 600 mm cross shift equals a 600 mm long shift). The active offset
   lives in `anchorOffset` and is passed to `generatePanels`,
   `generateBattens`, and `renderSVG`; it resets whenever the polygon
   changes or the user rotates/re-centers.
7. `renderSVG(roomPoly, panels, ...)` — draws room outline, centerlines,
   grid, cut highlights, panel labels, and dimension lines as layered
   SVG groups.
8. PDF export clones the live SVG, stages it offscreen so `getComputedStyle`
   works for svg2pdf, then renders two A4 pages (drawing + cut list).

## Conventions

- Edits to layout logic should be testable from the browser console via
  `window.__troldtekt.generatePanels(roomPoly, longAxisX, offset)`
  (see README for the full exposed API) and from `test.js`.
- Keep CSS minimalist and vanilla — no preprocessor, no framework, no JS UI lib.
- Don't introduce a build step or dependencies that need installation.
  Anything new should be CDN-loadable or fit in the single file.
- Avoid emojis in code, UI, and commit messages.

## Open assumptions worth revisiting

- **Panel orientation**: long side along the room's longer axis by
  default; the rotate button and the optimizer can override it.
- **Halv forbandt axis**: offset along the panel's long axis (so half-panels
  appear at the short ends of rows). Standard for Troldtekt.
- **Min cut warning**: any cut < 150 mm in either bbox dimension is flagged
  red in the drawing and noted in the cut list.
- **Cut grouping uses bounding-box dims**: two shaped cuts with the same
  bbox but mirrored geometry are grouped together. The drawing shows the
  actual shape so the installer can tell which is which.
- **Anchor offset dimensions**: drawn from the bbox edges, not the actual
  polygon walls. For rectangular rooms these coincide; for polygons they
  are approximate.
- **Screw placement** (see `placeScrews` in `app.js`): 4 corner screws at
  25 mm inset on every panel ≥ 60 mm in each dim, plus 2 middle screws on
  the long edges at the long-axis midpoint when the panel's long side is
  ≥ 800 mm. Full 600×1200 panels get 6 screws; smaller cuts get 4.
- **Screws must hit battens**: when battens are passed to `placeScrews`,
  each screw is checked against the batten layout. A screw with no
  batten beneath is moved along the cross axis (max 300 mm,
  `SCREW_SNAP_MAX`) to the nearest batten still inside the cut polygon;
  unreachable ones keep their spot but are flagged `offBatten`, drawn
  red, and counted in a cut-list / PDF warning. `update()` precomputes
  `panel.screws`; renderers fall back to bare `placeScrews(p)` if unset.
- **Purchase estimate**: `packCutPieces` packs all cut pieces (bbox
  dims) into virtual source panels — complementary cuts across groups
  are paired (a 600×340 and a 600×860 share one panel). It's a
  first-fit-decreasing guillotine heuristic, so it can still slightly
  over-count vs a perfect packing; kerf is ignored. The cut list's
  "N per source panel" note is per-group info and can undersell the
  cross-group packing.
- **Optimizer scoring**: lexicographic — tiny cuts, then panels to buy
  (before waste), then cut-piece count, then offset magnitude (ties
  prefer centered and the natural orientation). A 50 mm grid can miss
  narrow feasible windows; `OPTIMIZE_STEP` controls it.
