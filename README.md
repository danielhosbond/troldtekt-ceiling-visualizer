# Troldtekt Panel Calculator

A single-page web app for planning Troldtekt 600 × 1200 mm acoustic
ceiling panel installations in arbitrary room shapes. Produces a
**centered halv forbandt** layout, a cut list, a screw count, a wooden
batten layout, a cost estimate, and a printable PDF.

No build step. Hostable as static files on GitHub Pages.

## Features

- **Arbitrary room polygons** — any number of vertices, any angles
  including diagonals. Enter vertices as `x, y` (mm). Input is
  validated: self-intersecting or zero-area polygons are rejected with
  a message, duplicate/closing vertices are dropped, and
  counter-clockwise input is automatically reversed to clockwise.
- **Interactive editing in the drawing** — drag a corner handle to move
  it (positions snap to a 10 mm grid, and to a neighbour's x/y within
  60 mm so walls stay straight), drag an edge midpoint to add a corner,
  double-click a corner to remove it. The textarea stays the source of
  truth and updates live.
- **Persistence and share links** — the full state (room, prices,
  toggles, rotation, anchor offset) is saved to `localStorage` and
  mirrored into the URL hash on every change, so a layout survives
  reloads and can be bookmarked or shared. "Copy link" in the header
  copies the URL. A pasted link wins over the locally saved state.
- **Centered halv forbandt tiling** — the anchor panel is placed on
  the bounding-box center (or polygon centroid if the bbox center is
  outside the polygon, e.g. for L-shapes). Odd rows offset by 600 mm
  along the panel's long axis.
- **Layout optimizer** — the "Optimize layout" button grid-searches
  anchor offsets (50 mm steps, both panel orientations) and applies the
  layout that minimizes, in order: cuts narrower than 150 mm, panels to
  purchase, number of cut pieces, and distance from the centered
  anchor. The status line under the button reports what improved
  (e.g. "cuts < 150 mm: 10 → 0 · cut pieces: 16 → 11"); "Re-center"
  restores the centered layout. Editing the polygon or rotating panels
  resets the offset.
- **Panel cut classification** — `full`, `edge`, `corner`, `shaped`.
  Shaped cuts are clipped polygons (from diagonal walls); their
  bounding box is shown alongside their actual outline.
- **Per-wall measurements** — every polygon edge is labeled with its
  length on the outside of the wall. Non-rectangular cut panels also
  get a per-side measurement inside the piece (auto-dodging screw
  markers; labels move along the edge or are skipped if no clear spot
  exists).
- **Screw placement** — 4 corners at 25 mm inset + 2 middle screws on
  the long edges when the panel's long side is ≥ 800 mm. For shaped
  cuts, screws outside the polygon are dropped. Every screw is checked
  against the batten layout: screws with no batten beneath are snapped
  (up to 300 mm along the cross axis) onto the nearest batten that is
  still inside the cut; if none is reachable the screw is drawn red and
  a warning suggests an extra batten/noggin there. Total screw count
  and pack-of-100 count are computed.
- **Wooden battens (lægter)** — optional layer with two roles:
  - *Perimeter battens* sit flush against every wall that runs parallel
    to the panel's long axis (the long side of the Troldtekt), extending
    inward by the batten width.
  - *Interior battens* run parallel to the panel long axis at the panel
    grid's row boundaries (600 mm spacing). Grid lines that land on a
    perimeter wall are skipped so the two layers never overlap.
  - Edge-to-edge gap labels are drawn outside the room past the
    wall-length labels.
- **Purchase estimate with cut pairing** — all cut pieces are packed
  into virtual 600×1200 source panels (first-fit-decreasing guillotine,
  rotation allowed), so complementary cuts share a panel: a 600×340 and
  a 600×860 count as one panel, not two. The summary shows how many
  source panels the cut pieces come from.
- **Cost estimate** — panel cost + screw cost + batten cost (kr./m × m
  required), summed in DKK.
- **Live SVG drawing** with toggleable layers: room dimensions, full
  panel labels (sequence numbers), cut measurements, screw positions,
  and wooden battens.
- **Zoom and pan** — +/−/Fit buttons on the drawing, Ctrl/Cmd+scroll
  (trackpad pinch works the same way), touch pinch, and drag on empty
  space to pan. Plain scrolling still scrolls the page. Zoom is
  view-only state: PDF export and printing always show the whole room,
  and entering a new room resets to fit.
- **Light / dark theme** — toggle in the top-right of the header
  (persisted in `localStorage`, defaults to `prefers-color-scheme`).
  Dark palette uses dark-grey surfaces with orange accents; PDF export
  always renders against a light palette so prints stay legible.
- **Setting-out measurements** — the summary (and PDF) lists the chalk
  lines an installer marks first: distance from the wall to the first
  interior batten centerline (then 600 mm c/c) and to the first panel
  end joint (then 1200 mm, odd rows shifted 600 mm). Measured from the
  bounding-box walls — exact for rectangular rooms, approximate for
  polygons.
- **PDF export** (jsPDF + svg2pdf): page 1 is the drawing with all
  layers on plus scale 1:N; page 2 is the materials summary, cost
  block, and grouped cut list (including batten metres). The CDN
  scripts carry SRI hashes; if they fail to load (offline), export
  shows a clear message instead of crashing.
- **Print stylesheet** — printing the page directly gives a
  zero-dependency alternative to the PDF: the drawing, summary, and
  cut list print on white (the SVG swaps to the light palette during
  printing); inputs and buttons are hidden.

## Usage

Open `index.html` in a browser, or host the directory as static files.
Live preview locally:

```sh
python3 -m http.server
# open http://localhost:8000/
```

### Polygon input format

One vertex per line, separators are flexible (`,`, ` `, `;`).
Winding direction doesn't matter — counter-clockwise input is
normalized to clockwise automatically:

```
0, 0
3600, 0
3600, 4800
0, 4800
```

For an L-shape:

```
0, 0
3000, 0
3000, 1500
5000, 1500
5000, 4000
0, 4000
```

The status line under the textarea reports vertex count, bounding box
size, and computed area.

### Tests

`test.js` asserts the geometry invariants (parser validation, full
panel coverage, batten totals, screws-on-battens). Run it with Node:

```sh
node test.js
```

or, without Node, with the JavaScriptCore shell that ships with macOS
(add its directory to your PATH or call it directly):

```sh
alias jsc=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
jsc -e 'var module = { exports: {} };' app.js test.js
```

### Console testing

`window.__troldtekt` exposes the pure geometry functions:

```js
const poly = [{x:0,y:0},{x:3600,y:0},{x:3600,y:4800},{x:0,y:4800}];
__troldtekt.generatePanels(poly);              // optional: longAxisX, {dx, dy}
__troldtekt.generateBattens(poly, 95);         // batten width in mm; optional axis/offset
__troldtekt.totalBattenLength(battens);        // returns mm
__troldtekt.groupPanels(panels);
__troldtekt.estimatePurchase(fullCount, cutGroups, wastePct);
__troldtekt.optimizeLayout(poly, true);        // best {offset, longAxisX, tiny, panelsNeeded}
__troldtekt.scoreLayout(poly, true, {dx:0, dy:0});
__troldtekt.runOptimize();                     // same as clicking "Optimize layout"
```

## Conventions and assumptions

- Panel's long side (1200 mm) is laid along the bounding box's longer
  axis by default; the rotate button and the optimizer can override it.
- The purchase estimate ignores saw kerf (the common complementary pair
  summing to exactly 1200 mm is a single cut) and packs shaped cuts by
  their bounding box.
- Halv forbandt offsets along the long axis by 600 mm on odd rows.
- Cuts smaller than 150 mm in either bounding-box dimension are flagged
  red on the drawing and noted in the cut list.
- Cut grouping is by bounding-box dimensions, so mirrored shaped cuts
  cluster together. The drawing shows the actual outline so the
  installer can tell which mirror is which.
- Battens always run parallel to the panel long axis. Perimeter battens
  only go on walls that run in that direction — walls perpendicular to
  the long axis are not lined with a batten (nail into joists/wall
  framing there instead).
- Anchor-offset dimension lines are drawn from the bounding-box edges,
  not the actual polygon walls (they coincide for rectangular rooms).
- Defaults: 10 % waste, 129 kr. / panel, 170 kr. / 100 screws,
  10 kr. / m batten, 95 mm batten width.

## Files

- `index.html` — markup only, loads CSS and JS.
- `style.css` — UI chrome (light + dark mode) and layer-toggle rules.
  SVG element fills and strokes are applied as presentation attributes
  in `app.js` so svg2pdf reads them reliably.
- `app.js` — geometry (panels, battens, polygon clipping), rendering,
  summary, cut list, theme switching, PDF export. Loadable in Node
  (DOM wiring is skipped, pure functions exported) for testing.
- `test.js` — assertion tests for the pure geometry, run with
  `node test.js` (dev-only, not loaded by the page).
- `CLAUDE.md` — architectural notes for future contributors / AI
  assistants.

## Dependencies

CDN-loaded at runtime, pinned with SRI integrity hashes:

- [`jsPDF`](https://github.com/parallax/jsPDF) — PDF generation.
- [`svg2pdf.js`](https://github.com/yWorks/svg2pdf.js) — render SVG into
  a jsPDF document via `pdf.svg(svgElement, options)`.

Everything except PDF export works offline once the page is loaded;
export fails with a clear message when the libraries are unavailable.
UI language is English with Danish domain terms kept where they are
the trade vocabulary (halv forbandt, room-template names, kr. prices).
