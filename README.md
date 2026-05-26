# Troldtekt Panel Calculator

A single-page web app for planning Troldtekt 600 × 1200 mm acoustic
ceiling panel installations in arbitrary room shapes. Produces a
**centered halv forbandt** layout, a cut list, a screw count, a cost
estimate, and a printable PDF.

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
- **Screw placement** — 4 corners at 25 mm inset + 2 middle screws on
  the long edges when the panel's long side is ≥ 800 mm. For shaped
  cuts, screws outside the polygon are dropped. Total screw count and
  pack-of-100 count are computed.
- **Cost estimate** — panel cost = panels-to-buy × unit price;
  screw cost = packs × pack price; totals in DKK.
- **Live SVG drawing** with toggleable layers: room dimensions, full
  panel labels (sequence numbers), cut measurements, and screw
  positions.
- **PDF export** (jsPDF + svg2pdf): page 1 is the drawing with all
  layers on plus scale 1:N; page 2 is the materials summary, cost
  block, and grouped cut list.

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
__troldtekt.generatePanels([{x:0,y:0},{x:3600,y:0},{x:3600,y:4800},{x:0,y:4800}])
__troldtekt.groupPanels(panels)
__troldtekt.estimatePurchase(fullCount, cutGroups, wastePct)
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
- Anchor-offset dimension lines are drawn from the bounding-box edges,
  not the actual polygon walls (they coincide for rectangular rooms).
- Defaults: 10 % waste, 129 kr. / panel, 170 kr. / 100 screws.

## Files

- `index.html` — markup only, loads CSS and JS.
- `style.css` — UI chrome and layer-toggle rules. SVG element fills
  and strokes are applied as presentation attributes in `app.js` so
  svg2pdf reads them reliably.
- `app.js` — geometry, rendering, summary, cut list, PDF export.
- `CLAUDE.md` — architectural notes for future contributors / AI
  assistants.

## Dependencies

CDN-loaded at runtime:

- [`jsPDF`](https://github.com/parallax/jsPDF) — PDF generation.
- [`svg2pdf.js`](https://github.com/yWorks/svg2pdf.js) — render SVG into
  a jsPDF document via `pdf.svg(svgElement, options)`.
