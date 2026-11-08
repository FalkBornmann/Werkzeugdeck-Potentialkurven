/* Shared, dependency-free export controls for independent Werkzeugdeck tools. */
(() => {
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function videoType() {
    if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
    return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || null;
  }
  async function drawSource(context, source, width, height) {
    if (source instanceof SVGElement) {
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(source)], {type: 'image/svg+xml'}));
      try {
        const image = new Image(); image.src = url; await image.decode();
        context.drawImage(image, 0, 0, width, height);
      } finally { URL.revokeObjectURL(url); }
    } else context.drawImage(source, 0, 0, width, height);
  }
  async function recordVideo(adapter, seconds, signal, progress) {
    const mimeType = videoType();
    if (!mimeType) throw new Error('Dieser Browser unterstützt keinen lokalen Videoexport. PNG und SVG sind verfügbar.');
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d');
    const fps = 20, frames = Math.round(seconds * fps), chunks = [];
    let stream, recorder, recordingError;
    const wait = ms => new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Abgebrochen', 'AbortError'));
      const abort = () => { clearTimeout(timer); reject(new DOMException('Abgebrochen', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, {once: true});
    });
    async function paint(fraction) {
      const source = await adapter.frame(fraction);
      if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
      context.fillStyle = 'white'; context.fillRect(0, 0, 1280, 720);
      const box = source instanceof SVGElement ? source.viewBox.baseVal : source;
      const scale = Math.min(1232 / box.width, 574 / box.height);
      context.save(); context.translate((1280 - box.width * scale) / 2, 104 + (574 - box.height * scale) / 2);
      await drawSource(context, source, box.width * scale, box.height * scale); context.restore();
      context.fillStyle = adapter.color || '#193e35'; context.fillRect(0, 0, 1280, 90);
      context.fillStyle = 'white'; context.font = 'bold 26px system-ui'; context.fillText(adapter.title, 24, 35);
      context.font = '20px system-ui'; context.fillText(adapter.caption(), 24, 68);
      context.fillStyle = '#52695f'; context.font = '15px system-ui';
      context.fillText('Werkzeugdeck · Modellanimation · Zeitverlauf komprimiert · ohne Ton', 24, 704);
    }
    try {
      await paint(0);
      stream = canvas.captureStream(0);
      let track = stream.getVideoTracks()[0];
      if (!track.requestFrame) { stream.getTracks().forEach(t => t.stop()); stream = canvas.captureStream(fps); track = stream.getVideoTracks()[0]; }
      recorder = new MediaRecorder(stream, {mimeType, videoBitsPerSecond: 3000000});
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => { recordingError = event.error || new Error('Die Videoaufzeichnung ist fehlgeschlagen.'); };
      recorder.start(250);
      const start = performance.now();
      for (let frame = 0; frame < frames; frame++) {
        if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
        if (recordingError) throw recordingError;
        await paint(frame / (frames - 1));
        track.requestFrame?.();
        progress(Math.round((frame + 1) / frames * 100));
        await wait(Math.max(0, start + (frame + 1) * 1000 / fps - performance.now()));
      }
      recorder.stop(); await stopped;
      if (recordingError) throw recordingError;
      const blob = new Blob(chunks, {type: recorder.mimeType || mimeType});
      if (!blob.size) throw new Error('Es wurden keine Videobilder erzeugt.');
      return {blob, extension: blob.type.includes('mp4') ? 'mp4' : 'webm'};
    } finally {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stream?.getTracks().forEach(track => track.stop());
    }
  }

  function mount({anchor, items, defaultItem, defaultFormat = 'png', legacyButtons = []}) {
    if (!anchor || !items.length) throw new Error('Exportmenü benötigt eine Position und mindestens eine Darstellung.');
    const panel = document.createElement('section'); panel.className = 'wd-export-menu';
    panel.setAttribute('aria-label', 'Grafiken und Simulation speichern');
    panel.innerHTML = '<h3>Speichern</h3><div class="wd-export-fields"><label>Darstellung<select data-export-object></select></label><label>Dateityp<select data-export-format></select></label><label data-video-duration hidden>Filmlänge<select><option value="5">5 Sekunden</option><option value="10" selected>10 Sekunden</option><option value="20">20 Sekunden</option></select></label><button type="button" data-export-save>Speichern</button><button type="button" data-export-cancel hidden>Abbrechen</button></div><p class="hint" data-export-hint></p><p role="status" aria-live="polite" data-export-message></p>';
    anchor.append(panel);
    const object = panel.querySelector('[data-export-object]'), format = panel.querySelector('[data-export-format]');
    const save = panel.querySelector('[data-export-save]'), cancel = panel.querySelector('[data-export-cancel]');
    const duration = panel.querySelector('[data-video-duration]'), hint = panel.querySelector('[data-export-hint]');
    const message = panel.querySelector('[data-export-message]');
    let busy = false, controller;
    for (const item of items) object.add(new Option(item.label, item.id));
    object.value = defaultItem || items[0].id;
    const current = () => items.find(item => item.id === object.value);
    function refreshFormats() {
      const previous = format.value || defaultFormat;
      format.replaceChildren(new Option('PNG · Bild', 'png'), new Option('SVG · Vektorgrafik', 'svg'));
      if (current().video) {
        const type = videoType();
        const option = new Option(type ? `Video · ${type.includes('mp4') ? 'MP4' : 'WebM'}` : 'Video · Browser nicht unterstützt', 'video');
        option.disabled = !type; format.add(option);
      }
      format.value = [...format.options].some(option => option.value === previous && !option.disabled) ? previous : defaultFormat;
      refresh();
    }
    function refresh() {
      if (busy) return;
      const item = current();
      for (const option of format.options) if (option.value === 'video') option.disabled = !videoType() || item.videoReady?.() === false;
      save.disabled = item.enabled?.() === false || format.selectedOptions[0]?.disabled === true;
      duration.hidden = format.value !== 'video';
      hint.textContent = format.value === 'video' ? 'Der gesamte berechnete Verlauf wird auf die Filmlänge verdichtet. Tab aktiv halten. Während der Aufnahme sind die Eingaben gesperrt; Abbrechen stellt den vorherigen Zeitpunkt wieder her.' : 'PNG und SVG übernehmen den aktuell gewählten Darstellungszustand. Die Datei entsteht lokal auf deinem Gerät.';
    }
    object.addEventListener('change', refreshFormats);
    format.addEventListener('change', refresh);
    cancel.addEventListener('click', () => controller?.abort());
    for (const button of legacyButtons) button.hidden = true;
    for (const parent of new Set(legacyButtons.map(button => button.parentElement))) {
      if (parent !== anchor && [...parent.children].every(child => child.hidden)) parent.hidden = true;
    }
    const observer = new MutationObserver(mutations => {
      if (mutations.some(mutation => !panel.contains(mutation.target))) refresh();
    });
    observer.observe(document.body, {subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden']});
    save.addEventListener('click', async () => {
      refresh(); if (save.disabled || busy) return;
      const item = current(), type = format.value;
      busy = true; message.textContent = '';
      const disabled = [...document.querySelectorAll('input,select,button')].filter(control => control !== cancel).map(control => [control, control.disabled]);
      let adapter;
      try {
        if (type !== 'video') { await item.save(type); message.textContent = 'Grafik gespeichert.'; return; }
        controller = new AbortController();
        disabled.forEach(([control]) => { control.disabled = true; });
        cancel.hidden = false;
        adapter = item.video();
        const result = await recordVideo(adapter, Number(duration.querySelector('select').value), controller.signal, percent => { message.textContent = `Video wird erzeugt … ${percent} %`; });
        if (controller.signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
        download(result.blob, `${item.id}-simulation.${result.extension}`);
        message.textContent = 'Video gespeichert.';
      } catch (error) {
        message.textContent = error.name === 'AbortError' ? 'Videoexport abgebrochen.' : `Speichern fehlgeschlagen: ${error.message}`;
      } finally {
        try { adapter?.restore(); }
        finally {
          disabled.forEach(([control, value]) => { control.disabled = value; });
          cancel.hidden = true; busy = false; controller = null; refresh();
        }
      }
    });
    refreshFormats();
    return {panel, refresh};
  }
  globalThis.WDExports = {mount, recordVideo, videoType};
})();
