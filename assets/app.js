/* app.js — UI for the Korveth UV Translator. All work is local to the browser. */
(function () {
  'use strict';

  var PREVIEW_CAP = 1400;  // longest side used for interactive rendering
  var EXPORT_CAP = 2400;   // longest side kept for the downloaded translation

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    loader: $('loader'), workspace: $('workspace'), dropzone: $('dropzone'),
    file: $('file'), sample: $('sample'),
    srcCanvas: $('srcCanvas'), uvCanvas: $('uvCanvas'),
    shift: $('shift'), gain: $('gain'), contrast: $('contrast'),
    render: $('render'), invert: $('invert'),
    shiftOut: $('shiftOut'), gainOut: $('gainOut'), contrastOut: $('contrastOut'),
    bandChip: $('bandChip'), sizeChip: $('sizeChip'),
    scoreFill: $('scoreFill'), scoreVal: $('scoreVal'), scoreVerdict: $('scoreVerdict'),
    matrix: $('matrix').querySelector('tbody'),
    download: $('download'), reset: $('reset'), change: $('change')
  };

  var state = {
    preview: null,   // { imageData } at PREVIEW_CAP
    exportSrc: null, // { imageData } at EXPORT_CAP
    name: 'image'
  };

  var uvCtx = el.uvCanvas.getContext('2d', { willReadFrequently: true });
  var srcCtx = el.srcCanvas.getContext('2d');

  /* ---------- loading ---------- */

  function fit(w, h, cap) {
    var s = Math.min(1, cap / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  function sample(img, cap) {
    var d = fit(img.width, img.height, cap);
    var c = document.createElement('canvas');
    c.width = d.w; c.height = d.h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, d.w, d.h);
    return ctx.getImageData(0, 0, d.w, d.h);
  }

  function load(img, name) {
    state.name = (name || 'image').replace(/\.[^.]+$/, '');
    state.preview = sample(img, PREVIEW_CAP);
    state.exportSrc = Math.max(img.width, img.height) > PREVIEW_CAP
      ? sample(img, EXPORT_CAP)
      : state.preview;

    el.srcCanvas.width = state.preview.width;
    el.srcCanvas.height = state.preview.height;
    srcCtx.putImageData(state.preview, 0, 0);

    el.uvCanvas.width = state.preview.width;
    el.uvCanvas.height = state.preview.height;

    el.sizeChip.textContent = img.width + ' × ' + img.height + ' px';
    el.loader.hidden = true;
    el.workspace.hidden = false;
    render();
  }

  function loadFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () { load(img, file.name); URL.revokeObjectURL(url); };
    img.onerror = function () { URL.revokeObjectURL(url); alert('That file could not be read as an image.'); };
    img.src = url;
  }

  /* ---------- rendering ---------- */

  function options() {
    return {
      shift: +el.shift.value,
      gain: +el.gain.value,
      contrast: +el.contrast.value,
      render: el.render.value,
      invert: el.invert.checked
    };
  }

  function render() {
    if (!state.preview) return;
    var src = state.preview;
    var out = uvCtx.createImageData(src.width, src.height);
    var stats = UVTransform.translate(src.data, out.data, options());
    uvCtx.putImageData(out, 0, 0);
    report(stats);
  }

  var queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; render(); });
  }

  function report(stats) {
    el.bandChip.textContent = 'bands ' + stats.wavelengths.map(function (w) {
      return Math.round(w);
    }).join(' / ') + ' nm';

    var score = stats.legibility;
    el.scoreVal.textContent = score.toFixed(1);
    el.scoreFill.style.width = Math.min(100, score * 2) + '%';

    var verdict = score >= 35 ? ['good', 'legible']
                : score >= 18 ? ['warn', 'marginal']
                : ['bad', 'unreadable'];
    el.scoreVerdict.className = 'verdict ' + verdict[0];
    el.scoreVerdict.textContent = '— ' + verdict[1];

    var rows = '';
    for (var i = 0; i < 3; i++) {
      rows += '<tr><td>' + Math.round(stats.wavelengths[i]) + ' nm</td>';
      for (var j = 0; j < 3; j++) rows += '<td>' + stats.matrix[i][j].toFixed(3) + '</td>';
      rows += '</tr>';
    }
    el.matrix.innerHTML = rows;
  }

  function syncLabels() {
    el.shiftOut.textContent = el.shift.value + ' nm';
    el.gainOut.textContent = (+el.gain.value).toFixed(2) + '×';
    el.contrastOut.textContent = Math.round(el.contrast.value * 100) + '%';
  }

  /* ---------- events ---------- */

  ['shift', 'gain', 'contrast'].forEach(function (k) {
    el[k].addEventListener('input', function () { syncLabels(); scheduleRender(); });
  });
  el.render.addEventListener('change', scheduleRender);
  el.invert.addEventListener('change', scheduleRender);

  el.file.addEventListener('change', function () { loadFile(this.files[0]); this.value = ''; });
  el.sample.addEventListener('click', function () { loadSample(); });

  ['dragenter', 'dragover'].forEach(function (t) {
    el.dropzone.addEventListener(t, function (e) { e.preventDefault(); el.dropzone.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    el.dropzone.addEventListener(t, function () { el.dropzone.classList.remove('over'); });
  });
  el.dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    loadFile(e.dataTransfer.files[0]);
  });

  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) loadFile(items[0]);
  });

  /* The "scroll to translate" gesture: wheel over the result sweeps the shift. */
  el.uvCanvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var step = (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 1 : 5);
    el.shift.value = Math.max(0, Math.min(UVTransform.MAX_SHIFT, +el.shift.value + step));
    syncLabels();
    scheduleRender();
  }, { passive: false });

  el.reset.addEventListener('click', function () {
    el.shift.value = 0; el.gain.value = 1; el.contrast.value = 0;
    el.render.value = 'native'; el.invert.checked = false;
    syncLabels(); render();
  });

  el.change.addEventListener('click', function () {
    el.workspace.hidden = true;
    el.loader.hidden = false;
    state.preview = state.exportSrc = null;
  });

  el.download.addEventListener('click', function () {
    if (!state.exportSrc) return;
    var src = state.exportSrc;
    var c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    var ctx = c.getContext('2d');
    var out = ctx.createImageData(src.width, src.height);
    UVTransform.translate(src.data, out.data, options());
    ctx.putImageData(out, 0, 0);
    c.toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.name + '-korveth-' + el.shift.value + 'nm.png';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }, 'image/png');
  });

  /* ---------- sample memo ---------- */

  /*
   * A synthetic memo, so the page is usable without an upload. It deliberately
   * mixes pigments that behave very differently under the spectral shift: a
   * saturated blue header, a red stamp, a yellow highlight and neutral body text.
   */
  function loadSample() {
    var W = 1000, H = 1300;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');

    g.fillStyle = '#fdfdf8';
    g.fillRect(0, 0, W, H);

    g.fillStyle = '#1d4ed8';
    g.fillRect(0, 0, W, 140);
    g.fillStyle = '#f97316';
    g.beginPath(); g.arc(78, 70, 34, 0, Math.PI * 2); g.fill();

    g.fillStyle = '#ffffff';
    g.font = 'bold 34px Georgia, serif';
    g.fillText('INTERNAL MEMORANDUM', 132, 68);
    g.font = '20px Georgia, serif';
    g.fillText('Kokulus Rift Station — Joint Operations', 132, 100);

    g.fillStyle = '#111827';
    g.font = 'bold 26px Georgia, serif';
    g.fillText('Subject: Shift rotation, cycle 44', 70, 220);

    g.fillStyle = '#fde047';
    g.fillRect(66, 262, 720, 34);

    g.fillStyle = '#374151';
    g.font = '20px Georgia, serif';
    g.fillText('All Korveth personnel report to bay 3 before the second bell.', 70, 287);

    var widths = [860, 820, 870, 640, 855, 800, 870, 590, 845, 830, 710];
    g.fillStyle = '#4b5563';
    widths.forEach(function (w, i) {
      g.fillRect(70, 340 + i * 42, w, 13);
    });

    g.fillStyle = '#16a34a';
    g.fillRect(70, 850, 300, 13);

    g.save();
    g.translate(700, 1010);
    g.rotate(-0.22);
    g.strokeStyle = '#dc2626';
    g.lineWidth = 6;
    g.strokeRect(-150, -46, 300, 92);
    g.fillStyle = '#dc2626';
    g.font = 'bold 40px Georgia, serif';
    g.textAlign = 'center';
    g.fillText('URGENT', 0, 14);
    g.restore();

    g.textAlign = 'left';
    g.fillStyle = '#6b7280';
    g.font = 'italic 18px Georgia, serif';
    g.fillText('Posted on a standard Earth display. Invisible to Korveth eyes.', 70, 1240);

    load(c, 'sample-memo');
  }

  /* ---------- init ---------- */

  syncLabels();
})();
