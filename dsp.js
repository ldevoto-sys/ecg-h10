/* Procesamiento de ECG (Polar H10, 130 Hz). Funciona en navegador y en Node.
 * Sin dependencias. Uso personal, sin fines médicos. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FS = 130;
  const Q = Math.SQRT1_2; // Butterworth 2º orden

  // Umbrales heurísticos. NO están calibrados con datos reales: ajustar tras grabar con la banda.
  const CFG = {
    rrMin: 300, rrMax: 2000,        // ms, intervalos plausibles
    ectopicPct: 0.20,               // desviación vs mediana local para marcar latido corto/largo
    qualWinS: 5,                    // ventana de calidad de señal
    flatUv: 30,                     // rango < esto => sin señal
    noiseRatio: 0.15,               // RMS de ruido de alta frecuencia / rango de la señal
    satUv: 8000,                    // |señal| > esto => saturación / movimiento
    irrWinBeats: 30, irrStep: 10    // ventana de irregularidad (latidos)
  };

  // ---------- Filtros ----------
  function biquad(type, f0, fs, q) {
    const w0 = 2 * Math.PI * f0 / fs, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; }
    else { b0 = 1; b1 = -2 * cos; b2 = 1; } // notch
    const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  function applyBiquad(c, x) {
    const y = new Float64Array(x.length);
    let z1 = 0, z2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i], o = c[0] * v + z1;
      z1 = c[1] * v - c[3] * o + z2;
      z2 = c[2] * v - c[4] * o;
      y[i] = o;
    }
    return y;
  }

  // Fase cero (adelante + atrás) con extensión impar en los bordes.
  function filtfilt(sections, x) {
    const n = x.length;
    if (n < 16) return Float64Array.from(x);
    const pad = Math.min(n - 1, 3 * FS);
    const ext = new Float64Array(n + 2 * pad);
    for (let k = 1; k <= pad; k++) {
      ext[pad - k] = 2 * x[0] - x[k];
      ext[pad + n - 1 + k] = 2 * x[n - 1] - x[n - 1 - k];
    }
    for (let i = 0; i < n; i++) ext[pad + i] = x[i];
    let y = ext;
    for (const c of sections) {
      y = applyBiquad(c, y); y.reverse();
      y = applyBiquad(c, y); y.reverse();
    }
    return y.slice(pad, pad + n);
  }

  function ecgSections(fs, notchHz) {
    const s = [biquad('hp', 0.5, fs, Q), biquad('lp', 40, fs, Q)];
    if (notchHz) s.push(biquad('notch', notchHz, fs, 30));
    return s;
  }
  function ecgFilter(x, fs, notchHz) { return filtfilt(ecgSections(fs, notchHz), x); }

  // Filtro causal para el trazado en vivo.
  function createLiveFilter(fs, notchHz) {
    const sec = ecgSections(fs, notchHz);
    const st = sec.map(() => [0, 0]);
    return {
      process(v) {
        for (let k = 0; k < sec.length; k++) {
          const c = sec[k], s = st[k], o = c[0] * v + s[0];
          s[0] = c[1] * v - c[3] * o + s[1];
          s[1] = c[2] * v - c[4] * o;
          v = o;
        }
        return v;
      },
      reset() { st.forEach(s => { s[0] = 0; s[1] = 0; }); }
    };
  }

  // ---------- Utilidades ----------
  function percentile(arr, p) {
    if (!arr.length) return NaN;
    const a = Float64Array.from(arr).sort();
    return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  function sd(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
  }
  function median(a) { return percentile(a, 0.5); }

  // ---------- Detección de picos R (estilo Pan-Tompkins, offline) ----------
  function detectR(raw, fs, ecg) {
    const n = raw.length;
    const det = filtfilt([biquad('hp', 5, fs, Q), biquad('lp', 15, fs, Q)], raw);
    const sq = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) { const d = (det[i + 1] - det[i - 1]) * 0.5; sq[i] = d * d; }
    const half = Math.max(1, Math.round(0.12 * fs) >> 1);
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + sq[i];
    const integ = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
      integ[i] = (cs[b] - cs[a]) / (b - a);
    }
    const refr = Math.round(0.25 * fs);
    const cand = [];
    for (let i = 1; i < n - 1; i++) {
      if (integ[i] > integ[i - 1] && integ[i] >= integ[i + 1] && integ[i] > 0) {
        const last = cand[cand.length - 1];
        if (last !== undefined && i - last < refr) { if (integ[i] > integ[last]) cand[cand.length - 1] = i; }
        else cand.push(i);
      }
    }
    const amp = cand.map(i => integ[i]);
    const keep = [];
    const win = Math.round(5 * fs);
    let lo = 0, hi = 0;
    for (let j = 0; j < cand.length; j++) {
      while (cand[lo] < cand[j] - win) lo++;
      while (hi < cand.length && cand[hi] <= cand[j] + win) hi++;
      const ref = percentile(amp.slice(lo, hi), 0.75);
      if (amp[j] >= 0.35 * ref) keep.push(cand[j]);
    }
    // Refinar sobre la señal filtrada 0.5–40 Hz
    const r = Math.round(0.1 * fs);
    const refined = keep.map(c => {
      let m = c, mv = -1;
      for (let k = Math.max(0, c - r); k <= Math.min(n - 1, c + r); k++) {
        const v = Math.abs(ecg[k]);
        if (v > mv) { mv = v; m = k; }
      }
      return m;
    }).sort((a, b) => a - b);
    const out = [];
    for (const p of refined) {
      const last = out[out.length - 1];
      if (last !== undefined && p - last < refr) { if (Math.abs(ecg[p]) > Math.abs(ecg[last])) out[out.length - 1] = p; }
      else out.push(p);
    }
    return out;
  }

  // ---------- Análisis de sesión ----------
  // samples: µV a 130 Hz. gaps: [{idx, ms}] = ms perdidos justo antes del índice idx.
  function analyze(samples, fs, gaps, opts) {
    opts = opts || {};
    fs = fs || FS;
    const cfg = Object.assign({}, CFG, opts.cfg || {});
    const notch = opts.notch === undefined ? 50 : opts.notch;
    const n = samples.length;
    gaps = (gaps || []).filter(g => g.idx > 0 && g.idx < n).sort((a, b) => a.idx - b.idx);

    const cumGap = []; // tiempo acumulado perdido en gaps[k]
    let acc = 0;
    for (const g of gaps) { acc += g.ms / 1000; cumGap.push(acc); }
    const timeOf = i => {
      let k = -1;
      for (let j = 0; j < gaps.length && gaps[j].idx <= i; j++) k = j;
      return i / fs + (k >= 0 ? cumGap[k] : 0);
    };

    const bounds = [0];
    for (const g of gaps) if (g.idx !== bounds[bounds.length - 1]) bounds.push(g.idx);
    bounds.push(n);
    const segs = [];
    for (let k = 0; k < bounds.length - 1; k++) segs.push([bounds[k], bounds[k + 1]]);

    const x = Float64Array.from(samples);
    const ecg = new Float64Array(n);
    const bad = new Uint8Array(n);
    const peaks = [];
    const segOfPeak = [];

    segs.forEach(([a, b], sid) => {
      const sub = x.subarray(a, b);
      if (b - a < 10 * fs) {
        const m = b - a ? mean(sub) : 0;
        for (let i = a; i < b; i++) { ecg[i] = x[i] - m; bad[i] = 1; }
        return;
      }
      const e = ecgFilter(sub, fs, notch);
      ecg.set(e, a);
      for (const p of detectR(sub, fs, e)) { peaks.push(a + p); segOfPeak.push(sid); }
      // calidad de señal por ventanas
      const hf = filtfilt([biquad('hp', 30, fs, Q)], sub);
      const w = Math.round(cfg.qualWinS * fs);
      for (let s = 0; s < b - a; s += w) {
        const t = Math.min(b - a, s + w);
        const ew = e.subarray(s, t), hw = hf.subarray(s, t);
        const range = percentile(ew, 0.99) - percentile(ew, 0.01);
        let rms = 0, mx = 0;
        for (let i = 0; i < hw.length; i++) { rms += hw[i] * hw[i]; mx = Math.max(mx, Math.abs(ew[i])); }
        rms = Math.sqrt(rms / hw.length);
        const isBad = range < cfg.flatUv || rms > cfg.noiseRatio * range || mx > cfg.satUv;
        if (isBad) bad.fill(1, a + s, a + t);
      }
    });

    // Rangos de mala calidad para dibujar
    const badRanges = [];
    for (let i = 0; i < n; i++) {
      if (bad[i]) {
        const s = i; while (i < n && bad[i]) i++;
        badRanges.push([s, i]);
      }
    }

    // Latidos
    const beats = peaks.map((p, k) => {
      const b = { i: p, t: timeOf(p), seg: segOfPeak[k], rr: null, ok: false, flag: '' };
      if (k > 0 && segOfPeak[k - 1] === segOfPeak[k]) {
        const pp = peaks[k - 1];
        b.rr = (p - pp) / fs * 1000;
        b.ok = b.rr >= cfg.rrMin && b.rr <= cfg.rrMax && !bad[p] && !bad[pp];
      }
      return b;
    });
    for (let k = 0; k < beats.length; k++) {
      if (!beats[k].ok) continue;
      const nb = [];
      for (let j = Math.max(0, k - 5); j <= Math.min(beats.length - 1, k + 5); j++) {
        if (j !== k && beats[j].ok) nb.push(beats[j].rr);
      }
      if (nb.length < 4) continue;
      const med = median(nb);
      if (beats[k].rr < (1 - cfg.ectopicPct) * med) beats[k].flag = 'corto';
      else if (beats[k].rr > (1 + cfg.ectopicPct) * med) beats[k].flag = 'largo';
    }

    // Métricas globales
    const okBeats = beats.filter(b => b.ok);
    const rr = okBeats.map(b => b.rr);
    let metrics = null;
    if (rr.length >= 2) {
      const dpairs = []; // diferencias sucesivas válidas, con el tiempo del 2º latido
      for (let k = 1; k < beats.length; k++) {
        if (beats[k].ok && beats[k - 1].ok) dpairs.push({ t: beats[k].t, d: beats[k].rr - beats[k - 1].rr });
      }
      const diffs = dpairs.map(x => x.d);
      const m = mean(rr);
      // FC con promedio móvil de 10 latidos: máximo y mínimo con su posición
      let maxHR = null, minHR = null;
      for (let k = 9; k < okBeats.length; k++) {
        const hr = 60000 / mean(rr.slice(k - 9, k + 1)), o = { hr, t: okBeats[k].t, i: okBeats[k].i };
        if (!maxHR || hr > maxHR.hr) maxHR = o;
        if (!minHR || hr < minHR.hr) minHR = o;
      }
      // FC media en ventanas de 60 s (paso 10 s, mínimo 30 latidos)
      let hr1minMax = null, hr1minMin = null;
      for (let s0 = okBeats[0].t, lo = 0, hi = 0; s0 + 60 <= okBeats[okBeats.length - 1].t; s0 += 10) {
        while (lo < okBeats.length && okBeats[lo].t <= s0) lo++;
        while (hi < okBeats.length && okBeats[hi].t <= s0 + 60) hi++;
        if (hi - lo < 30) continue;
        const hr = 60000 / mean(rr.slice(lo, hi)), o = { hr, t: s0, i: okBeats[lo].i };
        if (!hr1minMax || hr > hr1minMax.hr) hr1minMax = o;
        if (!hr1minMin || hr < hr1minMin.hr) hr1minMin = o;
      }
      metrics = {
        beats: rr.length,
        meanHR: 60000 / m,
        minHR: minHR && minHR.hr, maxHR: maxHR && maxHR.hr, minHRpos: minHR, maxHRpos: maxHR,
        hr1minMax, hr1minMin,
        pctTachy: 100 * rr.filter(v => v < 400).length / rr.length,   // >150 lpm
        pctBrady: 100 * rr.filter(v => v > 1200).length / rr.length,  // <50 lpm
        meanRR: m,
        sdnn: sd(rr),
        rmssd: diffs.length ? Math.sqrt(mean(diffs.map(d => d * d))) : null,
        pnn50: diffs.length ? 100 * diffs.filter(d => Math.abs(d) > 50).length / diffs.length : null,
        flagged: beats.filter(b => b.flag).length,
        flaggedPct: 100 * beats.filter(b => b.flag).length / rr.length
      };
    }

    // Irregularidad en ventanas de latidos consecutivos válidos
    const windows = [];
    let run = [];
    const flush = () => {
      for (let s = 0; s + cfg.irrWinBeats <= run.length; s += cfg.irrStep) {
        const w = run.slice(s, s + cfg.irrWinBeats), r = w.map(b => b.rr), m = mean(r);
        const d = []; for (let k = 1; k < r.length; k++) d.push(r[k] - r[k - 1]);
        windows.push({
          t0: w[0].t, t1: w[w.length - 1].t, i0: w[0].i,
          meanHR: 60000 / m,
          cv: sd(r) / m,
          rmssdNorm: Math.sqrt(mean(d.map(v => v * v))) / m,
          pct50: 100 * d.filter(v => Math.abs(v) > 50).length / d.length
        });
      }
      run = [];
    };
    for (const b of beats) { if (b.ok) run.push(b); else flush(); }
    flush();

    const badSamples = bad.reduce((s, v) => s + v, 0);
    return {
      ecg, peaks, beats, bad, badRanges, segs, timeOf, metrics, windows,
      durationS: timeOf(n - 1) + 1 / fs,
      validPct: n ? 100 * (1 - badSamples / n) : 0
    };
  }

  // ---------- Sintetizador (simulador y pruebas) ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // opts: hr (lpm), irregular (RR aleatorio, sin onda P), rrSeq(k)->seg, noise (µV RMS), seed
  function createSynth(opts) {
    opts = opts || {};
    const hr = opts.hr || 70, noise = opts.noise === undefined ? 15 : opts.noise;
    const rnd = mulberry32(opts.seed || 1);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const pAmp = opts.irregular ? 0 : 120;
    let k = 0;
    const nextRR = () => opts.rrSeq ? opts.rrSeq(k++) : opts.irregular ? 0.45 + 0.65 * rnd() : (60 / hr) * (1 + 0.03 * gauss());
    let t = 0, nextBeat = 0.4, beats = [];
    const g = (x, mu, s, a) => a * Math.exp(-0.5 * ((x - mu) / s) * ((x - mu) / s));
    const tpl = tau => g(tau, -0.16, 0.025, pAmp) + g(tau, -0.025, 0.010, -100) + g(tau, 0, 0.012, 1000) +
      g(tau, 0.025, 0.010, -200) + g(tau, 0.25, 0.045, 300);
    return {
      next(count) {
        const out = new Int32Array(count);
        for (let i = 0; i < count; i++, t += 1 / FS) {
          while (t + 0.2 >= nextBeat) { beats.push(nextBeat); nextBeat += nextRR(); }
          beats = beats.filter(b => t - b < 0.8);
          let v = 200 * Math.sin(2 * Math.PI * 0.2 * t) + noise * gauss();
          for (const b of beats) v += tpl(t - b);
          out[i] = Math.round(v);
        }
        return out;
      }
    };
  }

  return { FS, CFG, biquad, filtfilt, ecgFilter, createLiveFilter, detectR, analyze, createSynth, percentile, mean, sd, median };
});
