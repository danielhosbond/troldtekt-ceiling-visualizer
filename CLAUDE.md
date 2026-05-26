# Troldtekt Panel Calculator

Single-file static web app for planning Troldtekt 600 × 1200 mm acoustic
ceiling panel layouts with a **centered halv forbandt** (half-bond) pattern.
Built for hosting on GitHub Pages.

## Stack

- Three files: `index.html`, `style.css`, `app.js`. No build step.
- jsPDF + svg2pdf.js loaded from CDN for PDF export.
- `app.js` is loaded with `defer` so it runs after the DOM is parsed.
- No package.json, no node_modules, no bundler.

## Architecture

All logic lives in `app.js`.

1. **Room model**: an arbitrary polygon (any number of vertices, any angles
   including diagonals). The user enters vertices clockwise as "x, y" lines
   in the textarea. `parsePolygon` validates them.
2. `generatePanels(roomPoly)` — pure function. Tiles 600×1200 panels in
   halv forbandt across the polygon's bounding box, anchored on the bbox
   center (falls back to the polygon centroid if the bbox center lies
   outside the polygon, e.g. for L-shapes). Each panel rect is clipped to
   the room polygon via Sutherland-Hodgman (`clipPolygonByRect`) — the
   panel rect is always convex so it works as the clip region even when
   the room polygon is non-convex.
3. Each clipped panel piece records its actual polygon, its bounding box,
   and an `isRectangular` flag (bbox area ≈ polygon area). Cut types:
   `full`, `edge`, `corner`, `shaped` (non-rectangular).
2. `groupPanels(panels)` — buckets cut panels by (w, h) and computes per-group
   stats (count, type: edge / corner, pieces-per-source-panel).
3. `estimatePurchase(...)` — sums per-group source-panel demand, then applies
   the user-set waste %.
4. `renderSVG(W, L, panels)` — draws room outline, centerlines, grid,
   cut highlights, panel labels, and dimension lines as layered SVG groups.
5. PDF export clones the live SVG, stages it offscreen so `getComputedStyle`
   works for svg2pdf, then renders two A4 pages (drawing + cut list).

## Conventions

- Edits to layout logic should be testable from the browser console via
  `window.__troldtekt.generatePanels(W, L)`.
- Keep CSS minimalist and vanilla — no preprocessor, no framework, no JS UI lib.
- Don't introduce a build step or dependencies that need installation.
  Anything new should be CDN-loadable or fit in the single file.
- Avoid emojis in code, UI, and commit messages.

## Open assumptions worth revisiting

- **Panel orientation**: long side always along the room's longer axis.
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
- **Purchase estimate**: per-group `ceil(count / piecesPerPanel)` summed,
  then × (1 + waste). Doesn't pair complementary cuts across groups (e.g. a
  600×340 and a 600×860 from one panel); this conservatively over-counts.
