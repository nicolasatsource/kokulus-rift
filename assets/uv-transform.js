/*
 * uv-transform.js — Prism spectral re-encoder (pure, no DOM).
 *
 * This module is deliberately free of browser APIs so the same code can back
 * the planned REST streaming endpoint (see README "Roadmap"). It operates on
 * raw RGBA byte buffers, which is what both `ImageData` and a server-side
 * decoder hand you.
 *
 * Model
 * -----
 * Human sRGB samples a scene at roughly three wavelengths: 600nm (R), 550nm
 * (G), 450nm (B). Korvethan photoreceptors sit the same distance apart but
 * shifted down the spectrum by `shift` nm, into the near ultraviolet.
 *
 * Reflectance across the three human samples is modelled as a quadratic; past
 * the ends of that range the extrapolation distance is damped by an exponential
 * rolloff, so the model never runs arbitrarily far beyond its own data.
 *
 * Every branch of that is linear in (r, g, b), so the whole spectral slide
 * collapses to a single 3x3 matrix per shift value. `bandMatrix()` exposes it;
 * the UI renders it so the transform is inspectable rather than magic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UVTransform = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BAND_R = 600, BAND_G = 550, BAND_B = 450;  // human sample points, nm
  var TAU = 90;                                   // extrapolation rolloff, nm
  var MAX_SHIFT = 180;                            // deepest supported slide, nm

  var TO_LINEAR = new Float32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i / 255;
    TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  var TO_SRGB = new Uint8ClampedArray(4096);
  for (var j = 0; j < 4096; j++) {
    var v = j / 4095;
    TO_SRGB[j] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  }

  /* Damped distance: full strength near the sampled range, saturating at TAU. */
  function damp(d) {
    return TAU * (1 - Math.exp(-d / TAU));
  }

  /*
   * Coefficients of reflectance(lambda) as a linear combination of r, g, b.
   *
   * A Lagrange quadratic through the three human sample points. Using all three
   * points (rather than extrapolating along the nearest slope) is what keeps the
   * band matrix full rank at deep shifts: a slope-based extrapolation makes every
   * Korvethan band converge on the same blue-green gradient and silently throws the
   * red channel away. The quadratic keeps r, g and b distinguishable all the way
   * down. Coefficients sum to 1 at every lambda, so neutrals stay neutral.
   *
   * Outside the sampled 450-600nm range the extrapolation distance is damped, so
   * no shift can push the model arbitrarily far past the data it actually has.
   */
  function bandRow(lambda) {
    var eff = lambda;
    if (lambda < BAND_B) eff = BAND_B - damp(BAND_B - lambda);
    else if (lambda > BAND_R) eff = BAND_R + damp(lambda - BAND_R);

    return [
      (eff - BAND_B) * (eff - BAND_G) / ((BAND_R - BAND_B) * (BAND_R - BAND_G)),
      (eff - BAND_B) * (eff - BAND_R) / ((BAND_G - BAND_B) * (BAND_G - BAND_R)),
      (eff - BAND_G) * (eff - BAND_R) / ((BAND_B - BAND_G) * (BAND_B - BAND_R))
    ];
  }

  /*
   * 3x3 matrix taking linear sRGB to the three Korvethan band responses.
   * shift = 0 is the identity matrix, so the slider starts at "no translation".
   */
  function bandMatrix(shift) {
    return [
      bandRow(BAND_R - shift),
      bandRow(BAND_G - shift),
      bandRow(BAND_B - shift)
    ];
  }

  function wavelengths(shift) {
    return [BAND_R - shift, BAND_G - shift, BAND_B - shift];
  }

  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  /* 256-entry tone curve applied in display space, after sRGB encoding. */
  function toneCurve(contrast, invert) {
    var lut = new Uint8ClampedArray(256);
    for (var i = 0; i < 256; i++) {
      var t = i / 255;
      var s = smoothstep(smoothstep(t));
      var out = t + (s - t) * contrast;
      lut[i] = Math.round(255 * (invert ? 1 - out : out));
    }
    return lut;
  }

  var HIST_BINS = 256;

  /*
   * Smallest luminance range the auto-exposure will stretch to full scale.
   * Without a floor, a low-contrast scene (a wall, a sheet of paper, a screen
   * showing one flat colour) drives the amplification into the tens or hundreds
   * and the picture detonates into pure clipping. 1/16 keeps faint material
   * genuinely liftable while bounding the gain; the UV gain slider sits on top.
   */
  var MIN_SPAN = 0.0625;

  /*
   * Auto-exposure: the shifted bands can land far outside [0,1], so stretch the
   * 1st-99th percentile of Korvethan luminance back into range before rendering.
   */
  function exposure(src, m) {
    /*
     * Histogram bounds are derived from the matrix rather than fixed. Each band
     * is a linear combination of (r,g,b), all in [0,1], so a row's reachable
     * range runs from the sum of its negative coefficients to the sum of its
     * positive ones. The bounds are the union across rows. At deep shifts the
     * coefficients grow past 3, and a fixed range piled every sample into the
     * end bins and returned a meaningless percentile.
     */
    var loBound = 0, hiBound = 0;
    for (var r0 = 0; r0 < 3; r0++) {
      var neg = 0, pos = 0;
      for (var c0 = 0; c0 < 3; c0++) {
        if (m[r0][c0] < 0) neg += m[r0][c0]; else pos += m[r0][c0];
      }
      if (neg < loBound) loBound = neg;
      if (pos > hiBound) hiBound = pos;
    }
    if (hiBound - loBound < 1e-6) { loBound -= 0.5; hiBound += 0.5; }

    var hist = new Uint32Array(HIST_BINS);
    var px = src.length >> 2;
    var stride = px > 400000 ? 4 : 1;
    var counted = 0;
    var scale = HIST_BINS / (hiBound - loBound);

    for (var p = 0; p < px; p += stride) {
      var i = p << 2;
      var r = TO_LINEAR[src[i]], g = TO_LINEAR[src[i + 1]], b = TO_LINEAR[src[i + 2]];
      /*
       * All three bands go into the histogram, not just their luminance. The
       * normalisation that comes out of this is applied to each band
       * separately, and on a saturated scene a single band's spread can dwarf
       * the luminance spread — measuring luminance alone scaled that band
       * straight off the end and clipped the frame solid.
       */
      var k1 = m[0][0] * r + m[0][1] * g + m[0][2] * b;
      var k2 = m[1][0] * r + m[1][1] * g + m[1][2] * b;
      var k3 = m[2][0] * r + m[2][1] * g + m[2][2] * b;

      var bin = Math.floor((k1 - loBound) * scale);
      if (bin < 0) bin = 0; else if (bin >= HIST_BINS) bin = HIST_BINS - 1;
      hist[bin]++;
      bin = Math.floor((k2 - loBound) * scale);
      if (bin < 0) bin = 0; else if (bin >= HIST_BINS) bin = HIST_BINS - 1;
      hist[bin]++;
      bin = Math.floor((k3 - loBound) * scale);
      if (bin < 0) bin = 0; else if (bin >= HIST_BINS) bin = HIST_BINS - 1;
      hist[bin]++;
      counted += 3;
    }

    var loTarget = counted * 0.01, hiTarget = counted * 0.99;
    var acc = 0, lo = loBound, hi = hiBound;
    for (var k = 0; k < HIST_BINS; k++) {
      var prev = acc;
      acc += hist[k];
      if (prev < loTarget && acc >= loTarget) lo = loBound + (k / scale);
      if (prev < hiTarget && acc >= hiTarget) { hi = loBound + ((k + 1) / scale); break; }
    }

    /* Centre the floor on the measured range, so a flat scene stays mid-grey
       instead of being shoved to one end. */
    if (hi - lo < MIN_SPAN) {
      var mid = (lo + hi) / 2;
      lo = mid - MIN_SPAN / 2;
      hi = mid + MIN_SPAN / 2;
    }
    return { lo: lo, span: hi - lo };
  }

  function enc(v) {
    return TO_SRGB[v <= 0 ? 0 : (v >= 1 ? 4095 : (v * 4095) | 0)];
  }

  /*
   * Render the Korvethan bands back into something a human monitor can show.
   *
   *   native — the three bands driven straight onto R/G/B. False colour, but it
   *            preserves every distinction a Korvethan eye would make.
   *   violet — band luminance only, tinted toward the near-UV edge humans can
   *            still just about see. Closest to "what they experience".
   *   mono   — band luminance, neutral grey. The readable option for documents.
   */
  var RENDERERS = {
    native: function (out, o, k1, k2, k3, y, tone) {
      out[o] = tone[enc(k1)];
      out[o + 1] = tone[enc(k2)];
      out[o + 2] = tone[enc(k3)];
    },
    violet: function (out, o, k1, k2, k3, y, tone) {
      var hot = y * y * y;
      out[o] = tone[enc(y * 0.62 + hot * 0.38)];
      out[o + 1] = tone[enc(y * 0.16 + hot * 0.52)];
      out[o + 2] = tone[enc(y)];
      return;
    },
    mono: function (out, o, k1, k2, k3, y, tone) {
      var g = tone[enc(y)];
      out[o] = g; out[o + 1] = g; out[o + 2] = g;
    }
  };

  /*
   * translate(src, dst, opts) -> stats
   *
   *   src   Uint8ClampedArray, RGBA, source pixels
   *   dst   Uint8ClampedArray, RGBA, same length (may alias src)
   *   opts  { shift = 0, gain = 1, contrast = 0, render = 'native', invert = false,
   *           exposure = null }
   *
   * `exposure` overrides the auto-exposure that would otherwise be measured from
   * this frame. A live feed passes a smoothed value here, because re-measuring
   * every frame makes the picture pump as the scene moves.
   *
   * Returns { legibility, matrix, wavelengths, exposure }, where `legibility` is
   * the standard deviation of the rendered Korvethan luminance on a 0-100 scale —
   * a rough proxy for "would a Korvethan pick detail out of this" — and `exposure`
   * is whichever exposure the call actually used.
   */
  function translate(src, dst, opts) {
    opts = opts || {};
    var shift = Math.max(0, Math.min(MAX_SHIFT, opts.shift || 0));
    var gain = opts.gain == null ? 1 : opts.gain;
    var render = RENDERERS[opts.render] || RENDERERS.native;
    var tone = toneCurve(opts.contrast || 0, !!opts.invert);

    var m = bandMatrix(shift);
    var ex = opts.exposure || exposure(src, m);
    var norm = gain / ex.span;
    var bias = -ex.lo * norm;

    var px = src.length >> 2;
    var stride = px > 400000 ? 4 : 1;
    var sum = 0, sumSq = 0, n = 0;

    for (var p = 0; p < px; p++) {
      var i = p << 2;
      var r = TO_LINEAR[src[i]], g = TO_LINEAR[src[i + 1]], b = TO_LINEAR[src[i + 2]];

      var k1 = (m[0][0] * r + m[0][1] * g + m[0][2] * b) * norm + bias;
      var k2 = (m[1][0] * r + m[1][1] * g + m[1][2] * b) * norm + bias;
      var k3 = (m[2][0] * r + m[2][1] * g + m[2][2] * b) * norm + bias;
      var y = 0.30 * k1 + 0.50 * k2 + 0.20 * k3;

      render(dst, i, k1, k2, k3, y, tone);
      dst[i + 3] = src[i + 3];

      if (p % stride === 0) {
        var l = 0.30 * dst[i] + 0.50 * dst[i + 1] + 0.20 * dst[i + 2];
        sum += l; sumSq += l * l; n++;
      }
    }

    var mean = sum / n;
    var variance = Math.max(0, sumSq / n - mean * mean);
    return {
      legibility: Math.min(100, Math.sqrt(variance) / 1.28),
      matrix: m,
      wavelengths: wavelengths(shift),
      exposure: ex
    };
  }

  /* The auto-exposure pass on its own, for callers that smooth it over time. */
  function measureExposure(src, shift) {
    return exposure(src, bandMatrix(Math.max(0, Math.min(MAX_SHIFT, shift || 0))));
  }

  return {
    translate: translate,
    measureExposure: measureExposure,
    bandMatrix: bandMatrix,
    wavelengths: wavelengths,
    MAX_SHIFT: MAX_SHIFT,
    HUMAN_BANDS: [BAND_R, BAND_G, BAND_B]
  };
});
