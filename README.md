# Kokulus Rift

**Watch earth like a human.**

Your Korveth hires cannot read a single thing on a standard monitor, because
Earth displays emit essentially nothing above 400 nm. To a Korveth, your
carefully formatted quarterly deck is a blank warm-grey panel. This is bad for
morale and, we are told, for compliance.

Kokulus Rift re-encodes an image into the three near-ultraviolet bands a Korveth
eye actually uses, and previews it in false colour so a human can confirm the
memo is legible before sending it.

It is a static page. Everything runs in the browser: no uploads, no network
calls, no dependencies, no business model.

## The problem

More contrast will not save you. The information has to move to a band they can
reach. That is the whole product.

## The model

An RGB image samples a scene at roughly three wavelengths — 600 nm (R), 550 nm
(G) and 450 nm (B). Korveth photoreceptors sit the same distance apart but
shifted down the spectrum by the amount the **spectral shift** slider sets.

`assets/uv-transform.js` models reflectance as a Lagrange quadratic through the
three human sample points and reads it off at the shifted wavelengths. Every
branch of that is linear in (r, g, b), so the whole transform collapses to a
single 3×3 matrix per shift value, which the page renders live under
*Diagnostics*.

Two properties fall out of the quadratic that are worth knowing:

- **Row coefficients sum to 1 at every wavelength**, so neutral greys stay
  neutral no matter how far the shift travels.
- **The matrix stays full rank** across the whole range (determinant 1.0 at 0 nm
  down to 0.048 at 180 nm). Extrapolating along the nearest slope instead —
  the obvious first approach — makes all three bands converge on the same
  blue-green gradient past about 90 nm and silently discards the red channel.

Past the ends of the sampled range the extrapolation distance is damped by an
exponential rolloff, so the model never runs arbitrarily far beyond its own data.

### What it is not

An RGB image contains no measured ultraviolet, and nothing can recover what was
never captured. This is a faithful *re-encoding* of the information in the image,
not a photograph of real UV radiance. Anyone claiming otherwise is lying to you
at a valuation.

For the actual job — making Earth material readable to a Korveth — the
distinction does not matter, because the problem was never missing UV detail. It
was a monitor that emits no UV at all.

## Layout

| Controls | Effect |
| --- | --- |
| Spectral shift | 0–180 nm. At 0 nm the output is the untouched original. |
| UV gain | Brightness after auto-exposure. |
| Legibility contrast | S-curve applied in display space, after sRGB encoding. |
| Render | `native` false colour, `violet` near-UV tint, or `mono` for documents. |
| Invert | For emissive UV panels, where bright means emitting. |

Scrolling over the result sweeps the spectral shift; hold <kbd>Shift</kbd> for
1 nm steps.

The **Korveth legibility** readout is the standard deviation of rendered band
luminance on a 0–100 scale — a rough proxy for whether detail survives the
translation.

## Editing the page

Asset URLs carry a `?v=N` query string:

```html
<link rel="stylesheet" href="assets/styles.css?v=2">
```

GitHub Pages serves assets with `cache-control: max-age=600` and the filenames
never change, so a browser that has seen an older version will keep using it for
ten minutes after a deploy. **Bump `N` in `index.html` whenever you change a file
in `assets/`** and returning visitors pick the change up immediately.

## Running it

It is a static page with no build step:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` over `file://` works too.

## Series A roadmap

`assets/uv-transform.js` is a UMD module with no browser APIs, operating on raw
RGBA buffers — the same shape `ImageData` and a server-side decoder both hand
you. It runs unchanged under Node:

```js
const UV = require('./assets/uv-transform.js');
const stats = UV.translate(src, dst, { shift: 125, contrast: 0.4, render: 'mono' });
```

Next up: `POST /v1/translate` for stills and a WebSocket channel for live
content, so a whole floor of Korveths can be served at once. Because the
transform is a single 3×3 matrix per shift value, a streaming implementation can
send the matrix once per parameter change and let the client apply it, rather
than re-encoding every frame server side. This is extremely cheap, and will be
appearing in the deck as "edge-native".
