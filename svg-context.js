/* SVG export for the Canvas 2D operations used by Werkzeugdeck plots.
 * Drawings use their existing rendering function with this context as target.
 */
(() => {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[char]));
  const number = value => {
    if (!Number.isFinite(value)) throw new Error('Die Grafik enthält ungültige Koordinaten.');
    return String(Number(value.toFixed(6)));
  };

  class SvgContext {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.elements = [];
      this.definitions = [];
      this.stack = [];
      this.state = {
        fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif',
        textAlign: 'start', textBaseline: 'alphabetic', globalAlpha: 1,
        lineCap: 'butt', lineJoin: 'miter', dash: [], matrix: [1, 0, 0, 1, 0, 0], clips: []
      };
      this.beginPath();
    }

    save() { this.stack.push(structuredClone(this.state)); }
    restore() { if (this.stack.length) this.state = this.stack.pop(); }
    setLineDash(values) { this.state.dash = [...values]; }
    getLineDash() { return [...this.state.dash]; }
    translate(x, y) {
      const [a, b, c, d, e, f] = this.state.matrix;
      this.state.matrix = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
    }
    rotate(angle) {
      const [a, b, c, d, e, f] = this.state.matrix;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      this.state.matrix = [a * cos + c * sin, b * cos + d * sin, c * cos - a * sin, d * cos - b * sin, e, f];
    }
    point(x, y) {
      const [a, b, c, d, e, f] = this.state.matrix;
      return `${number(a * x + c * y + e)} ${number(b * x + d * y + f)}`;
    }
    beginPath() { this.path = []; this.hasPoint = false; }
    moveTo(x, y) { this.path.push(`M ${this.point(x, y)}`); this.hasPoint = true; }
    lineTo(x, y) {
      if (!this.hasPoint) return this.moveTo(x, y);
      this.path.push(`L ${this.point(x, y)}`);
    }
    closePath() { this.path.push('Z'); }
    rect(x, y, width, height) {
      this.moveTo(x, y); this.lineTo(x + width, y); this.lineTo(x + width, y + height);
      this.lineTo(x, y + height); this.closePath();
    }
    arc(x, y, radius, start, end, anticlockwise = false) {
      if (radius < 0) throw new Error('Ungültiger Kreisradius.');
      let sweep = end - start;
      if (!anticlockwise && sweep >= 2 * Math.PI) sweep = 2 * Math.PI;
      else if (anticlockwise && sweep <= -2 * Math.PI) sweep = -2 * Math.PI;
      else if (anticlockwise) sweep = -((-sweep % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI));
      else sweep = (sweep % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      this.lineTo(x + radius * Math.cos(start), y + radius * Math.sin(start));
      const segments = Math.ceil(Math.abs(sweep) / (Math.PI / 2));
      for (let index = 0; index < segments; index++) {
        const from = start + sweep * index / segments, to = start + sweep * (index + 1) / segments;
        const k = 4 / 3 * Math.tan((to - from) / 4);
        const p1 = this.point(x + radius * (Math.cos(from) - k * Math.sin(from)), y + radius * (Math.sin(from) + k * Math.cos(from)));
        const p2 = this.point(x + radius * (Math.cos(to) + k * Math.sin(to)), y + radius * (Math.sin(to) - k * Math.cos(to)));
        this.path.push(`C ${p1} ${p2} ${this.point(x + radius * Math.cos(to), y + radius * Math.sin(to))}`);
      }
    }
    append(markup) {
      for (const id of this.state.clips) markup = `<g clip-path="url(#${id})">${markup}</g>`;
      this.elements.push(markup);
    }
    paint(fill) {
      const s = this.state;
      return fill ? `fill="${escape(s.fillStyle)}" stroke="none" opacity="${number(s.globalAlpha)}"` :
        `fill="none" stroke="${escape(s.strokeStyle)}" stroke-width="${number(s.lineWidth)}" stroke-linecap="${escape(s.lineCap)}" stroke-linejoin="${escape(s.lineJoin)}" stroke-dasharray="${s.dash.map(number).join(' ')}" opacity="${number(s.globalAlpha)}"`;
    }
    fill() { this.append(`<path d="${this.path.join(' ')}" ${this.paint(true)}/>`); }
    stroke() { this.append(`<path d="${this.path.join(' ')}" ${this.paint(false)}/>`); }
    clip() {
      const id = `clip-${this.definitions.length}`;
      this.definitions.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${this.path.join(' ')}"/></clipPath>`);
      this.state.clips.push(id);
    }
    fillRect(x, y, width, height) {
      if (!width || !height) return;
      this.append(`<rect x="${number(width < 0 ? x + width : x)}" y="${number(height < 0 ? y + height : y)}" width="${number(Math.abs(width))}" height="${number(Math.abs(height))}" transform="matrix(${this.state.matrix.map(number).join(' ')})" ${this.paint(true)}/>`);
    }
    clearRect(x, y, width, height) {
      if (x !== 0 || y !== 0 || width !== this.width || height !== this.height) throw new Error('SVG unterstützt hier nur das Löschen der gesamten Zeichenfläche.');
      this.elements = [];
    }
    fillText(text, x, y) {
      const anchor = {left: 'start', start: 'start', center: 'middle', right: 'end', end: 'end'}[this.textAlign];
      const baseline = {alphabetic: 'alphabetic', top: 'text-before-edge', middle: 'central', bottom: 'text-after-edge', hanging: 'hanging', ideographic: 'ideographic'}[this.textBaseline];
      this.append(`<text x="${number(x)}" y="${number(y)}" text-anchor="${anchor}" dominant-baseline="${baseline}" transform="matrix(${this.state.matrix.map(number).join(' ')})" style="font:${escape(this.font)}" ${this.paint(true)}>${escape(text)}</text>`);
    }
    toSvg(title, description = '') {
      return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}" role="img"><title>${escape(title)}</title><desc>${escape(description)}</desc><defs>${this.definitions.join('')}</defs><rect width="100%" height="100%" fill="white"/>${this.elements.join('')}</svg>`;
    }
  }
  for (const property of ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'globalAlpha', 'lineCap', 'lineJoin']) {
    Object.defineProperty(SvgContext.prototype, property, {
      get() { return this.state[property]; },
      set(value) { this.state[property] = value; }
    });
  }
  globalThis.SvgContext = SvgContext;
})();
