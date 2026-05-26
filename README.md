# Troldtekt Panel Calculator

A single-page web app for planning Troldtekt 600 × 1200 mm acoustic
ceiling panel installations in arbitrary room shapes. Produces a
**centered halv forbandt** layout, a cut list, a screw count, a wooden
batten layout, a cost estimate, and a printable PDF.

No build step. Hostable as static files on GitHub Pages.

## Features

- **Arbitrary room polygons** — any number of vertices, any angles
  including diagonals. Enter vertices clockwise as `x, y` (mm).
- **Centered halv forbandt tiling** — the anchor panel is placed on
  the bounding-box center (or polygon centroid if the bbox center is
  outside the polygon, e.g. for L-shapes). Odd rows offset by 600 mm
  along the panel's long axis.
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
  cuts, screws outside the polygon are dropped. Total screw count and
  pack-of-100 count are computed.
- **Wooden battens (lægter)** — optional layer with two roles:
  - *Perimeter battens* sit flush against every wall that runs parallel
    to the panel's long axis (the long side of the Troldtekt), extending
    inward by the batten width.
  - *Interior battens* run parallel to the panel long axis at the panel
    grid's row boundaries (600 mm spacing). Grid lines that land on a
    perimeter wall are skipped so the two layers never overlap.
  - Edge-to-edge gap labels are drawn outside the room past the
    wall-length labels.
- **Cost estimate** — panel cost + screw cost + batten cost (kr./m × m
  required), summed in DKK.
- **Live SVG drawing** with toggleable layers: room dimensions, full
  panel labels (sequence numbers), cut measurements, screw positions,
  and wooden battens.
- **Light / dark theme** — toggle in the top-right of the header
  (persisted in `localStorage`, defaults to `prefers-color-scheme`).
  Dark palette uses dark-grey surfaces with orange accents; PDF export
  always renders against a light palette so prints stay legible.
- **PDF export** (jsPDF + svg2pdf): page 1 is the drawing with all
  layers on plus scale 1:N; page 2 is the materials summary, cost
  block, and grouped cut list (including batten metres).

## Usage

Open `index.html` in a browser, or host the directory as static files.
Live preview locally:

```sh
python3 -m http.server
# open http://localhost:8000/
```

### Polygon input format

One vertex per line, walked clockwise, separators are flexible
(`,`, ` `, `;`):

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

### Console testing

`window.__troldtekt` exposes the pure geometry functions:

```js
const poly = [{x:0,y:0},{x:3600,y:0},{x:3600,y:4800},{x:0,y:4800}];
__troldtekt.generatePanels(poly);
__troldtekt.generateBattens(poly, 95);   // pass batten width in mm
__troldtekt.totalBattenLength(battens);  // returns mm
__troldtekt.groupPanels(panels);
__troldtekt.estimatePurchase(fullCount, cutGroups, wastePct);
```

## Conventions and assumptions

- Panel's long side (1200 mm) is laid along the bounding box's longer
  axis.
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
  summary, cut list, theme switching, PDF export.
- `CLAUDE.md` — architectural notes for future contributors / AI
  assistants.

## Dependencies

CDN-loaded at runtime:

- [`jsPDF`](https://github.com/parallax/jsPDF) — PDF generation.
- [`svg2pdf.js`](https://github.com/yWorks/svg2pdf.js) — render SVG into
  a jsPDF document via `pdf.svg(svgElement, options)`.
