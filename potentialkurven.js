"use strict";

function parseCurve(text) {
  const lines = text.split(/\r?\n/);
  const type = lines[1]?.trim();
  if (type !== "TE" && type !== "EIT") {
    throw new Error("Dieses Werkzeug unterstützt VoltaLab-CRV-Dateien mit dem Kurventyp TE oder EIT.");
  }
  const count = Number(lines[8]);
  if (lines[6]?.trim() !== "VoltaLab" || !Number.isSafeInteger(count) ||
      count < 1 || count > lines.length - 9) {
    throw new Error("Der VoltaLab-Dateikopf oder die Anzahl der Messpunkte ist ungültig.");
  }
  const points = lines.slice(9, 9 + count).map((line, index) => {
    const columns = line.trim().split(/\s+/);
    const values = columns.map(value => Number(value.replace(",", ".")));
    if (columns.length !== type.length || values.some(value => !Number.isFinite(value))) {
      throw new Error("Ungültiger Messpunkt " + (index + 1) + ".");
    }
    if (type === "TE") return { t: values[0], e: values[1] };
    return { e: values[0], i: values[1], t: values[2] };
  });
  return { type, points, suggestedArea: Number(lines[5]?.trim().replace(",", ".")) };
}

function regression(points, x, y = point => point.e) {
  const average = getter => points.reduce((sum, point) => sum + getter(point), 0) / points.length;
  const meanX = average(x);
  const meanE = average(y);
  const xx = average(point => (x(point) - meanX) ** 2);
  const ee = average(point => (y(point) - meanE) ** 2);
  const xe = average(point => (x(point) - meanX) * (y(point) - meanE));
  const slope = points.length > 1 && xx > 0 ? xe / xx : NaN;
  return { meanE, slope, r2: xx > 0 && ee > 0 ? xe ** 2 / (xx * ee) : NaN,
    predict: value => meanE + slope * (value - meanX) };
}

function tafelFit(points, lower, upper, sign, ordinate) {
  const window = points.filter(point => point.e >= lower && point.e <= upper && point.i * sign > 0);
  if (window.length < 3) return null;
  const fit = regression(window, point => point.e, ordinate);
  if (!(fit.slope * sign > 0) || !Number.isFinite(fit.r2)) return null;
  const nearest = window.reduce((edge, point) => sign > 0 ? Math.min(edge, point.e) : Math.max(edge, point.e),
    sign > 0 ? Infinity : -Infinity);
  return { ...fit, lower, upper, nearest, beta: 1000 / Math.abs(fit.slope) };
}

function tafelIntersection(cathode, anode) {
  const e = (cathode.predict(0) - anode.predict(0)) / (anode.slope - cathode.slope);
  const logJ = anode.predict(e);
  const current = 10 ** logJ;
  return e >= cathode.upper && e <= anode.lower && Number.isFinite(current) && current > 0
    ? { e, logJ } : null;
}

if (typeof document !== "undefined") {
  const get = id => document.getElementById(id);
  const value = id => get(id).value;
  const number = id => get(id).valueAsNumber;
  const volts = id => number(id) / 1000;
  const format = new Intl.NumberFormat("de", { maximumSignificantDigits: 5 });
  const show = number => Number.isFinite(number) ? format.format(number) : "–";
  const currentFactors = { A: 1, mA: 1e-3, "µA": 1e-6, nA: 1e-9 };
  const areaFactors = { "cm²": 1, "mm²": 0.01, "m²": 10000 };
  const canvas = get("plot");
  const ctx = canvas.getContext("2d");
  let curve, selected, fileName;
  let plotState;
  let automaticWindows = new Map();
  let loadVersion = 0;
  const polar = () => value("mode") !== "time";
  const log = () => value("mode") === "tafel";
  const area = () => number("area") * areaFactors[value("areaUnit")];
  const factor = () => currentFactors[value("currentUnit")];
  const density = point => point.i * factor() / area();
  const x = point => polar() ? point.e : point.t;
  const y = point => {
    if (!polar()) return point.e;
    if (log()) return point.i === 0 ? -10 : Math.log10(Math.abs(density(point)));
    return area() > 0 && factor() ? density(point) : point.i;
  };

  function extent(points, getter) {
    let min = Infinity, max = -Infinity;
    for (const point of points) {
      const v = getter(point);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return [min, max];
  }

  function reset() {
    const [min, max] = extent(curve.points, x);
    get("lower").value = polar() ? min * 1000 : min;
    get("upper").value = polar() ? max * 1000 : max;
    get("first").value = 1;
    get("last").value = curve.points.length;
    get("view").value = "all";
    render();
  }

  function draw(points, fits, corrosion, context = ctx) {
    plotState = {points, fits, corrosion};
    const visible = value("view") === "window" ? selected : points;
    const unit = value("currentUnit");
    const xLabel = polar() ? "Potential (mV)" : "Zeit (s)";
    const left = 170, right = 1165, top = 32, bottom = 450;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!visible.length || (log() && !(area() > 0 && factor()))) return;
    function padded([min, max]) {
      const pad = (max - min) * 0.05 || Math.max(Math.abs(min) * 0.05, 1e-9);
      return [min - pad, max + pad];
    }
    const [xmin, xmax] = padded(extent(visible, x));
    const hasZeros = log() && visible.some(point => point.i === 0);
    const nonzero = log() ? visible.filter(point => point.i !== 0) : visible;
    const [rawMin, rawMax] = nonzero.length ? extent(nonzero, y) : [-9, -9];
    const floor = Math.min(-10, Math.floor(rawMin) - 1);
    const [ymin, ymax] = log()
      ? [hasZeros ? floor : Math.floor(rawMin), Math.max(Math.floor(rawMin) + 1, Math.ceil(rawMax))]
      : padded([rawMin, rawMax]);
    const normalized = polar() && area() > 0 && factor();
    const peak = Math.max(Math.abs(rawMin), Math.abs(rawMax));
    const units = [["A", 1], ["mA", 1e-3], ["µA", 1e-6], ["nA", 1e-9], ["pA", 1e-12]];
    const [displayUnit, scale] = units.find(([, step]) => peak >= step) ?? units.at(-1);
    const yScale = !polar() ? 1000 : normalized ? 1 / scale : factor() ? factor() * 1000 : 1;
    const yLabel = log() ? "|j| (A/cm²) · logarithmisch" : !polar() ? "Potential (mV)" :
      normalized ? "Stromdichte (" + displayUnit + "/cm²)" : "Strom (" + (unit ? "mA" : "Dateieinheit") + ")";
    const px = v => left + (v - xmin) / (xmax - xmin) * (right - left);
    const py = v => bottom - (v - ymin) / (ymax - ymin) * (bottom - top);
    context.font = "20px system-ui";
    context.fillStyle = "#132c3c";
    context.lineWidth = 1;
    context.strokeStyle = "#d4e1e7";
    for (let tick = 0; tick <= 5; tick++) {
      const fraction = tick / 5;
      const gx = left + fraction * (right - left);
      context.beginPath();
      context.moveTo(gx, top);
      context.lineTo(gx, bottom);
      context.stroke();
      context.textAlign = "center";
      context.fillText(show((xmin + fraction * (xmax - xmin)) * (polar() ? 1000 : 1)), gx, bottom + 28);
    }
    const ticks = log()
      ? Array.from({ length: ymax - ymin + 1 }, (_, index) => ymin + index)
      : Array.from({ length: 6 }, (_, index) => ymin + index / 5 * (ymax - ymin));
    const exponent = value => String(value).replace(/[\d-]/g, digit => "⁰¹²³⁴⁵⁶⁷⁸⁹⁻"[digit === "-" ? 10 : Number(digit)]);
    context.textAlign = "right";
    for (const tick of ticks) {
      const gy = py(tick);
      context.beginPath();
      context.moveTo(left, gy);
      context.lineTo(right, gy);
      context.stroke();
      const label = log() ? (hasZeros && tick === floor ? "0*" : "10" + exponent(tick)) : show(tick * yScale);
      context.fillText(label, left - 9, gy + 6);
    }
    if (hasZeros) {
      context.textAlign = "left";
      context.fillText("* Nullwerte an der Darstellungsgrenze", left, 24);
    }
    context.textAlign = "center";
    context.fillText(xLabel, (left + right) / 2, 520);
    context.save();
    context.translate(23, (top + bottom) / 2);
    context.rotate(-Math.PI / 2);
    context.fillText(yLabel, 0, 0);
    context.restore();
    context.save();
    context.beginPath();
    context.rect(left, top, right - left, bottom - top);
    context.clip();
    context.strokeStyle = "#1746bc";
    context.lineWidth = 2;
    context.beginPath();
    visible.forEach((point, index) => {
      const method = index && (value("view") !== "window" ||
        point.index === visible[index - 1].index + 1) ? "lineTo" : "moveTo";
      context[method](px(x(point)), py(hasZeros && point.i === 0 ? floor : y(point)));
    });
    context.stroke();
    context.fillStyle = "#00736f";
    if (!log() && selected.length < visible.length) {
      for (const point of selected) context.fillRect(px(x(point)) - 2, py(y(point)) - 2, 4, 4);
    }
    for (const fit of fits) {
      const start = fit.lower ?? extent(selected, x)[0];
      const end = fit.upper ?? extent(selected, x)[1];
      context.strokeStyle = "#ac471c";
      context.setLineDash([8, 5]);
      context.beginPath();
      context.moveTo(px(start), py(fit.predict(start)));
      context.lineTo(px(end), py(fit.predict(end)));
      context.stroke();
    }
    if (log()) {
      context.setLineDash([4, 5]);
      context.strokeStyle = "#00736f";
      context.fillStyle = "#00736f";
      context.font = "16px system-ui";
      context.textAlign = "left";
      const markers = [
        [volts("passivation"), "E Passivierung", true],
        [volts("transpassive"), "E transpassiv", true],
        [Math.log10(number("passive")), "j passiv", false],
        [Math.log10(number("limiting")), "j Grenzstrom", false]
      ];
      for (const [position, label, vertical] of markers) {
        if (!Number.isFinite(position)) continue;
        const gx = vertical ? px(position) : left;
        const gy = vertical ? top : py(position);
        context.beginPath();
        context.moveTo(gx, gy);
        context.lineTo(vertical ? gx : right, vertical ? bottom : gy);
        context.stroke();
        context.fillText(label, gx + 5, vertical ? top + 20 : gy - 5);
      }
      if (corrosion) {
        context.beginPath();
        context.arc(px(corrosion.e), py(corrosion.logJ), 5, 0, 2 * Math.PI);
        context.fill();
      }
    }
    context.restore();
  }

  function render() {
    const limits = polar() ? "Potential (mV)" : "Zeit (s)";
    get("lowerLabel").textContent = limits + " von";
    get("upperLabel").textContent = limits + " bis";
    get("tailSetting").hidden = polar();
    get("linearSetting").hidden = !polar() || log();
    get("runAutomatic").disabled = !get("automatic").checked;
    get("polarOptions").hidden = !polar();
    get("stern").hidden = !polar() || log();
    get("tafelOptions").hidden = !log();
    get("fitHint").textContent = log() ? "Für die Darstellung wie in VoltaMaster gib die exponierte Fläche ein." :
      "Wähle einen linearen Bereich um den Stromnulldurchgang. Bei mehreren Durchläufen begrenze die Auswahl auf einen Zweig.";
    const readLimit = polar() ? volts : number;
    const lower = readLimit("lower"), upper = readLimit("upper");
    const first = number("first"), last = number("last");
    selected = curve.points.filter(point => x(point) >= lower && x(point) <= upper &&
      (!polar() || (point.index >= first && point.index <= last)));
    const fit = selected.length && !log() ? regression(selected, x, y) : null;
    const details = [selected.length + " Messpunkte ausgewählt"];
    if (!selected.length) details.push("Prüfe die Grenzen des Auswertefensters.");
    if (fit && !polar()) {
      details.push("Mittelwert " + show(fit.meanE * 1000) + " mV",
        "Drift " + show(fit.slope * 60000) + " mV/min");
    }
    const fits = [];
    let corrosion;
    if (!polar() && Number.isFinite(fit?.slope)) fits.push(fit);
    if (fit && polar()) {
      const [min, max] = extent(selected, point => point.i);
      const resistance = area() > 0 ? 1 / (fit.slope * area()) : 1 / (fit.slope * factor());
      if (min >= 0 || max <= 0 || selected.length < 3) {
        details.push("Für Rₚ mindestens drei Punkte und beide Stromvorzeichen auswählen.");
      } else if (!factor()) {
        details.push("Für Rₚ die Stromeinheit aus dem Messprogramm wählen.");
      } else if (!(resistance > 0 && Number.isFinite(resistance))) {
        details.push("Die Auswahl ergibt keinen positiven Polarisationswiderstand.");
      } else {
        fits.push(fit);
        details.push("Rₚ " + show(resistance) + " Ω", "E bei I = 0 " + show(-1000 * fit.predict(0) / fit.slope) + " mV",
          "R² " + show(fit.r2));
        if (area() > 0) {
          const normalized = resistance * area();
          details.push("Rₚ × Fläche " + show(normalized) + " Ω·cm²");
          const a = number("betaA") / 1000, c = number("betaC") / 1000;
          if (a > 0 && c > 0) {
            const b = a * c / (Math.LN10 * (a + c));
            details.push("Stern–Geary B " + show(b * 1000) + " mV", "jₖₒᵣᵣ " + show(b / normalized) + " A/cm²");
          }
        } else if (value("area")) details.push("Die exponierte Fläche muss positiv sein.");
      }
    }
    if (log()) {
      if (!(area() > 0 && factor())) {
        details.push("Für die Stromdichte Stromeinheit und positive Fläche angeben.");
      } else {
        const cathode = tafelFit(selected, volts("cMin"), volts("cMax"), -1, y);
        const anode = tafelFit(selected, volts("aMin"), volts("aMax"), 1, y);
        for (const [name, branch] of [["kathodisch", cathode], ["anodisch", anode]]) {
          if (!branch) continue;
          fits.push(branch);
          details.push("β " + name + " " + show(branch.beta) + " mV/Dekade (R² " + show(branch.r2) + ")");
        }
        if (cathode && anode) {
          corrosion = tafelIntersection(cathode, anode);
          if (corrosion) {
            const { e, logJ } = corrosion;
            fits[0] = { ...cathode, upper: e };
            fits[1] = { ...anode, lower: e };
            details.push("Eₖₒᵣᵣ " + show(e * 1000) + " mV", "jₖₒᵣᵣ " + show(10 ** logJ) + " A/cm²");
            const separation = (anode.slope - cathode.slope) *
              Math.min(e - cathode.nearest, anode.nearest - e);
            if (separation < 1) details.push("Tafel-Kriterium: Der Gegenast trägt modelliert mehr als 10 % bei.");
          } else details.push("Der Schnittpunkt liegt außerhalb des Bereichs zwischen den Fitfenstern.");
        } else details.push("Je Zweig mindestens drei Punkte mit passendem Vorzeichen und passender Steigung auswählen.");
      }
    }
    get("result").textContent = details.join(" · ");
    get("csv").disabled = !selected.length;
    get("png").disabled = (value("view") === "window" && !selected.length) || (log() && !(area() > 0 && factor()));
    get("svg").disabled = get("png").disabled;
    draw(curve.points, fits, corrosion);
  }

  get("file").addEventListener("change", async () => {
    const version = ++loadVersion;
    const file = get("file").files[0];
    get("analysis").hidden = true;
    if (!file) {
      get("status").textContent = "Wähle eine CRV-Datei.";
      return;
    }
    try {
      const parsed = parseCurve(await file.text());
      if (version !== loadVersion) return;
      curve = parsed;
      curve.points.forEach((point, index) => { point.index = index + 1; });
      fileName = file.name.replace(/\.crv$/i, "");
      get("mode").options[1].disabled = curve.type === "TE";
      get("mode").options[2].disabled = curve.type === "TE";
      const [minPotential, maxPotential] = extent(curve.points, point => point.e);
      get("mode").value = curve.type === "TE" ? "time" : maxPotential - minPotential <= 0.12 ? "polar" : "tafel";
      get("currentUnit").value = curve.type === "EIT" ? "A" : "";
      get("area").value = "";
      get("headerArea").hidden = curve.type !== "EIT" || !(curve.suggestedArea > 0);
      get("headerArea").textContent = show(curve.suggestedArea) + " cm² aus Dateikopf übernehmen";
      get("ocp").value = "";
      get("autoStatus").textContent = "";
      automaticWindows = new Map();
      for (const id of ["cMin", "cMax", "aMin", "aMax", "passivation", "transpassive", "passive", "limiting"]) get(id).value = "";
      get("status").textContent = file.name + " · " + curve.type + " · " + curve.points.length + " Messpunkte";
      get("analysis").hidden = false;
      reset();
      applyAutomatic();
    } catch (error) {
      if (version === loadVersion) get("status").textContent = error.message;
    }
  });

  function download(blob, extension) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName + "-" + value("mode") + "." + extension;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  get("mode").addEventListener("change", () => { reset(); applyAutomatic(); });
  get("reset").addEventListener("click", reset);
  get("headerArea").addEventListener("click", () => {
    get("areaUnit").value = "cm²";
    get("area").value = curve.suggestedArea;
    render();
    applyAutomatic();
  });

  function applyAutomatic() {
    const status = get("autoStatus");
    status.textContent = "";
    if (!get("automatic").checked) return;
    if (log()) {
      for (const [id, previous] of automaticWindows) {
        if (number(id) === previous) get(id).value = "";
      }
      automaticWindows.clear();
      render();
    }
    if (!polar()) {
      const tail = number("tail") / 100;
      if (!(tail > 0 && tail <= 1)) {
        status.textContent = "Gib einen Anteil von 1 bis 100 % ein.";
        return;
      }
      const [start, end] = extent(curve.points, point => point.t);
      get("lower").value = end - (end - start) * tail;
      get("upper").value = end;
      status.textContent = "Ruhepotential und Drift aus dem letzten Abschnitt. Das Zeitfenster bleibt editierbar.";
      render();
      return;
    }

    const branch = curve.points.filter(point => point.index >= number("first") && point.index <= number("last"));
    const crossings = [];
    let previous;
    for (const point of branch) {
      if (point.i === 0) continue;
      if (previous && Math.sign(previous.i) !== Math.sign(point.i)) {
        crossings.push(previous.e - previous.i * (point.e - previous.e) / (point.i - previous.i));
      }
      previous = point;
    }
    const reference = volts("ocp");
    const center = log() && Number.isFinite(reference) ? reference :
      crossings.length === 1 ? crossings[0] : NaN;
    if (!Number.isFinite(center)) {
      status.textContent = "Kein eindeutiger Stromnulldurchgang. Begrenze die Messpunktnummern auf einen Zweig" +
        (log() ? " oder gib das OCP ein." : ".");
      return;
    }
    if (!log()) {
      const halfWidth = volts("linearWidth");
      if (!(halfWidth > 0)) {
        status.textContent = "Gib eine positive Breite für das Fitfenster ein.";
        return;
      }
      get("lower").value = (center - halfWidth) * 1000;
      get("upper").value = (center + halfWidth) * 1000;
      status.textContent = "Fitfenster um den interpolierten Stromnulldurchgang. Prüfe den linearen Verlauf.";
      render();
      return;
    }

    const ocp = center;
    const zone = number("zone") / 1000;
    const width = number("segment") / 1000;
    if (!(area() > 0 && factor() && Number.isFinite(ocp) && width > 0 && zone > width)) {
      status.textContent = "Gib die Fläche an. Die Segmentbreite muss kleiner als die Suchzone sein.";
      return;
    }
    const find = (min, max, sign) => {
      const points = selected.filter(point => point.i * sign > 0 && point.e >= min && point.e <= max);
      const candidates = [];
      for (const { e: start } of points) {
        if (start + width > max + 1e-12) continue;
        const fit = tafelFit(points, start, start + width, sign, y);
        if (fit && fit.r2 >= 0.95) candidates.push(fit);
      }
      return candidates.sort((a, b) => b.r2 - a.r2);
    };
    const cathodes = find(ocp - zone, ocp, -1);
    const anodes = find(ocp, ocp + zone, 1);
    let best;
    for (const cathode of cathodes) {
      if (best && cathode.r2 + anodes[0].r2 <= best.score) break;
      const anode = anodes.find(candidate => {
        const intersection = tafelIntersection(cathode, candidate);
        if (!intersection) return false;
        const separation = (candidate.slope - cathode.slope) *
          Math.min(intersection.e - cathode.nearest, candidate.nearest - intersection.e);
        return separation >= 1;
      });
      if (!anode) continue;
      const score = cathode.r2 + anode.r2;
      if (!best || score > best.score) best = { cathode, anode, score };
    }
    if (!best) {
      status.textContent = "Keine geeigneten Tafel-Fenster. Die Automatik verlangt R² ≥ 0,95 je Zweig, einen Schnittpunkt zwischen den Fenstern und höchstens 10 % modellierten Gegenstrom. Prüfe die Kurve und passe Suchzone oder Segmentbreite an.";
      return;
    }
    for (const [prefix, fit] of [["c", best.cathode], ["a", best.anode]]) {
      get(prefix + "Min").value = fit.lower * 1000;
      get(prefix + "Max").value = fit.upper * 1000;
      for (const suffix of ["Min", "Max"]) {
        const id = prefix + suffix;
        automaticWindows.set(id, number(id));
      }
    }
    status.textContent = "Tafel-Fenster vorgeschlagen (R² ≥ 0,95 je Zweig, modellierter Gegenstrom ≤ 10 %). Prüfe die Fenster auf Aktivierungskontrolle.";
    render();
  }
  get("runAutomatic").addEventListener("click", applyAutomatic);
  get("automatic").addEventListener("change", () => { render(); applyAutomatic(); });
  for (const id of ["tail", "linearWidth", "ocp", "zone", "segment", "area", "areaUnit", "currentUnit"]) {
    get(id).addEventListener("change", applyAutomatic);
  }
  for (const id of ["lower", "upper", "first", "last", "view", "currentUnit", "area", "areaUnit",
    "betaA", "betaC", "cMin", "cMax", "aMin", "aMax", "passivation", "transpassive", "passive", "limiting"]) {
    get(id).addEventListener("input", render);
  }
  get("csv").addEventListener("click", () => {
    const hasCurrent = curve.type === "EIT";
    const unit = value("currentUnit") || "Dateieinheit";
    const rows = [["Messpunkt", "Zeit (s)", "Potential (mV)", ...(hasCurrent ? ["Strom (" + unit + ")"] : [])]];
    for (const point of selected) {
      rows.push([point.index, point.t, point.e * 1000, ...(hasCurrent ? [point.i] : [])]);
    }
    download(new Blob([rows.map(row => row.join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }), "csv");
  });
  get("svg").addEventListener("click", () => {
    if (!plotState || get("svg").disabled) return;
    const context = new SvgContext(canvas.width, canvas.height);
    draw(plotState.points, plotState.fits, plotState.corrosion, context);
    download(new Blob([context.toSvg(fileName + " · " + value("mode"), get("result").textContent)], {
      type: "image/svg+xml;charset=utf-8"
    }), "svg");
  });
  get("png").addEventListener("click", () => {
    canvas.toBlob(blob => { if (blob) download(blob, "png"); });
  });
}
