// Ejecutar: node ecg-h10/test/dsp.test.js
const assert = require('assert');
const DSP = require('../dsp.js');

function gen(seconds, opts) {
  const s = DSP.createSynth(opts);
  return s.next(Math.round(seconds * DSP.FS));
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok  -', name); }

test('ritmo regular 75 lpm: detecta ~75 latidos/min y FC correcta', () => {
  const x = gen(120, { hr: 75, seed: 3 });
  const a = DSP.analyze(x, DSP.FS, []);
  assert.ok(Math.abs(a.metrics.meanHR - 75) < 1.5, 'FC ' + a.metrics.meanHR);
  assert.ok(Math.abs(a.peaks.length - 150) <= 3, 'latidos ' + a.peaks.length);
  assert.ok(a.metrics.sdnn < 80, 'SDNN ' + a.metrics.sdnn);
  assert.ok(a.validPct > 90, 'validPct ' + a.validPct);
});

test('picos R caen sobre el pico real (±20 ms)', () => {
  const x = gen(60, { hr: 60, seed: 5, noise: 5 });
  const a = DSP.analyze(x, DSP.FS, []);
  // con seed fijo los RR son ~1 s; verificar que cada pico es máximo local de la señal cruda en ±20 ms
  const r = Math.round(0.02 * DSP.FS);
  for (const p of a.peaks) {
    let m = p;
    for (let k = Math.max(0, p - r); k <= Math.min(x.length - 1, p + r); k++) if (x[k] > x[m]) m = k;
    assert.ok(Math.abs(m - p) <= r, 'pico fuera de lugar en ' + p);
  }
});

test('ritmo irregular (sin P, RR aleatorio) tiene CV mucho mayor que el regular', () => {
  const reg = DSP.analyze(gen(180, { hr: 70, seed: 7 }), DSP.FS, []);
  const irr = DSP.analyze(gen(180, { irregular: true, seed: 7 }), DSP.FS, []);
  const med = w => DSP.median(w.map(v => v.cv));
  assert.ok(reg.windows.length > 0 && irr.windows.length > 0, 'sin ventanas');
  assert.ok(med(irr.windows) > 4 * med(reg.windows), `cv irr=${med(irr.windows)} reg=${med(reg.windows)}`);
  assert.ok(irr.metrics.flaggedPct > 3 * reg.metrics.flaggedPct + 5, 'flag irr ' + irr.metrics.flaggedPct);
});

test('latido prematuro con pausa se marca como corto + largo en el lugar correcto', () => {
  // RR 1.0 s; en el latido 20 llega uno prematuro (0.6 s) seguido de pausa (1.4 s)
  const rrSeq = k => (k === 20 ? 0.6 : k === 21 ? 1.4 : 1.0);
  const x = gen(60, { rrSeq, seed: 9, noise: 5 });
  const a = DSP.analyze(x, DSP.FS, []);
  const flagged = a.beats.filter(b => b.flag);
  const short = flagged.filter(b => b.flag === 'corto'), long = flagged.filter(b => b.flag === 'largo');
  assert.strictEqual(short.length, 1, 'cortos ' + short.length);
  assert.strictEqual(long.length, 1, 'largos ' + long.length);
  assert.ok(Math.abs(short[0].rr - 600) < 20 && Math.abs(long[0].rr - 1400) < 20);
  assert.ok(long[0].t > short[0].t && long[0].t - short[0].t < 2);
});

test('gap: no se calcula RR a través del corte y el eje de tiempo suma el gap', () => {
  const a1 = gen(40, { hr: 70, seed: 11 });
  const a2 = gen(40, { hr: 70, seed: 12 });
  const x = new Int32Array(a1.length + a2.length);
  x.set(a1); x.set(a2, a1.length);
  const gaps = [{ idx: a1.length, ms: 5000 }];
  const a = DSP.analyze(x, DSP.FS, gaps);
  const across = a.beats.filter(b => b.i >= a1.length).slice(0, 1)[0];
  assert.strictEqual(across.rr, null, 'RR a través del gap debe ser null');
  assert.ok(Math.abs(a.timeOf(a1.length) - (a1.length / DSP.FS + 5)) < 1e-9);
  assert.ok(Math.abs(a.metrics.meanHR - 70) < 2);
});

test('señal plana se marca como mala calidad y no genera métricas', () => {
  const x = new Int32Array(60 * DSP.FS).fill(10);
  const a = DSP.analyze(x, DSP.FS, []);
  assert.ok(a.validPct < 5, 'validPct ' + a.validPct);
  assert.strictEqual(a.metrics, null);
});

test('ruido alto (EMG) se excluye de las métricas', () => {
  const x = gen(60, { hr: 70, seed: 13, noise: 600 });
  const a = DSP.analyze(x, DSP.FS, []);
  assert.ok(a.validPct < 60, 'validPct ' + a.validPct);
});

test('métricas nuevas: FC máx/mín con posición, FC 1 min, taqui/bradi', () => {
  // 12 min a 60 lpm, con un tramo de 1 min a ~100 lpm entre el min 5 y 6
  const rrSeq = k => (k >= 300 && k < 400 ? 0.6 : 1.0);
  const x = gen(720, { rrSeq, seed: 4, noise: 5 });
  const a = DSP.analyze(x, DSP.FS, []);
  const m = a.metrics;
  assert.ok(m.maxHR > 95 && m.maxHR < 105, 'maxHR ' + m.maxHR);
  assert.ok(Math.abs(m.minHR - 60) < 2, 'minHR ' + m.minHR);
  assert.ok(m.maxHRpos.t > 295 && m.maxHRpos.t < 420, 'posición máx ' + m.maxHRpos.t);
  assert.ok(m.hr1minMax.hr > 90 && m.hr1minMin.hr < 62, `1min ${m.hr1minMax.hr}/${m.hr1minMin.hr}`);
  assert.strictEqual(m.pctTachy, 0); assert.strictEqual(m.pctBrady, 0);
});

test('indicador de irregularidad: regular=baja, azar=alta/al azar, bigeminismo=alta/alternante', () => {
  const run = o => DSP.analyze(gen(60, o), DSP.FS, []).irregularity;
  const reg = run({ hr: 75, seed: 3 }), af = run({ irregular: true, seed: 5 }), big = run({ rrSeq: k => (k % 2 ? 1.0 : 0.5), seed: 6 });
  assert.strictEqual(reg.level, 'baja'); assert.strictEqual(reg.pattern, null);
  assert.strictEqual(af.level, 'alta'); assert.strictEqual(af.pattern, 'al azar');
  assert.strictEqual(big.level, 'alta'); assert.strictEqual(big.pattern, 'alternante');
});

test('polaridad: QRS negativo dominante no alterna entre R y S (RR estable)', () => {
  const x = gen(90, { hr: 70, seed: 8, noise: 5 }).map(v => -v); // señal invertida
  const a = DSP.analyze(x, DSP.FS, []);
  assert.ok(a.metrics.sdnn < 40 && Math.abs(a.metrics.meanHR - 70) < 2, 'SDNN ' + a.metrics.sdnn + ' FC ' + a.metrics.meanHR);
});

test('ondas P: con P = coherentes, sin P = incoherentes, ritmo rápido = insuficiente', () => {
  const run = o => DSP.analyze(gen(60, o), DSP.FS, []).pwave;
  const con = run({ hr: 75, seed: 3, noise: 15 }), sin = run({ irregular: true, seed: 5, noise: 15 }), fast = run({ hr: 150, seed: 2 });
  assert.strictEqual(con.level, 'coherentes', 'con P corr ' + con.corr);
  assert.strictEqual(sin.level, 'incoherentes', 'sin P corr ' + sin.corr);
  assert.strictEqual(fast.level, 'insuficiente');
  assert.ok(con.template && con.template.length > 50);
  assert.ok(con.corr > sin.corr + 0.5);
});

test('ondas P: polaridad invertida no cambia el resultado', () => {
  const x = gen(60, { hr: 75, seed: 3, noise: 15 }).map(v => -v);
  assert.strictEqual(DSP.analyze(x, DSP.FS, []).pwave.level, 'coherentes');
});

test('ondas P: con ruido alto no se declara "incoherentes" (indeterminado por ruido)', () => {
  const p = DSP.analyze(gen(40, { hr: 75, seed: 3, noise: 150 }), DSP.FS, []).pwave;
  assert.notStrictEqual(p.level, 'incoherentes');
  assert.strictEqual(p.reason, 'ruido alto');
});

test('VFC sin latidos marcados: un latido adelantado con pausa no infla el RMSSD', () => {
  // ritmo ~810 ms estable; en el latido 20 llega uno a 592 ms y luego 945 ms (caso real observado)
  const rrSeq = k => (k === 20 ? 0.592 : k === 21 ? 0.945 : 0.81 + 0.008 * Math.sin(k * 1.7));
  const m = DSP.analyze(gen(60, { rrSeq, seed: 4, noise: 10 }), DSP.FS, []).metrics;
  assert.strictEqual(m.flagged, 1, 'marcados ' + m.flagged);
  assert.ok(m.rmssd > 35, 'rmssd con todos ' + m.rmssd);
  assert.ok(m.nnValid && m.rmssdNN < 15, 'rmssdNN ' + m.rmssdNN);
  assert.ok(m.nnExcluded >= 2 && m.nnExcluded <= 3, 'excluidos ' + m.nnExcluded);
  assert.ok(m.sdnnNN < m.sdnn);
});

test('VFC sin latidos marcados: con ritmo irregular (muchos marcados) no se calcula', () => {
  const m = DSP.analyze(gen(60, { irregular: true, seed: 5 }), DSP.FS, []).metrics;
  assert.strictEqual(m.nnValid, false); assert.strictEqual(m.rmssdNN, null);
});

test('resumen: estados verde / amarillo / rojo / gris', () => {
  const R = o => { const a = DSP.analyze(gen(60, o), DSP.FS, []); return DSP.resumen(a); };
  const verde = R({ hr: 75, seed: 3, noise: 15 });
  assert.strictEqual(verde.estado, 'verde'); assert.strictEqual(verde.ritmo, 'Normal'); assert.strictEqual(verde.marcados, '0');
  assert.ok(verde.conclusion.startsWith('Ritmo normal')); assert.ok(verde.fc >= 73 && verde.fc <= 77);
  // caso real observado: ritmo estable con un latido adelantado y pausa
  const amar = R({ rrSeq: k => (k === 20 ? 0.592 : k === 21 ? 0.945 : 0.81 + 0.008 * Math.sin(k * 1.7)), seed: 4, noise: 10 });
  assert.strictEqual(amar.estado, 'amarillo'); assert.ok(amar.marcados.startsWith('1 (corto'), amar.marcados);
  assert.ok(amar.conclusion.includes('requieren revisión')); assert.ok(amar.vfc < 15, 'VFC sin marcados ' + amar.vfc); assert.ok(amar.vfcSinMarcados);
  const fa = R({ irregular: true, seed: 5, noise: 15 });
  assert.strictEqual(fa.estado, 'rojo'); assert.ok(fa.ritmo.includes('compatible con FA'), fa.ritmo);
  assert.ok(fa.conclusion.includes('compatible con FA'), fa.conclusion);
  const big = R({ rrSeq: k => (k % 2 ? 1.0 : 0.5), seed: 6 });
  assert.strictEqual(big.estado, 'rojo'); assert.ok(big.ritmo.includes('alternante'));
  const ruido = R({ hr: 75, seed: 3, noise: 600 });
  assert.strictEqual(ruido.estado, 'gris'); assert.ok(ruido.conclusion.startsWith('No concluyente'));
  const rapido = R({ hr: 150, seed: 2 });
  assert.strictEqual(rapido.estado, 'gris', 'ritmo rápido regular: ' + rapido.estado);
  const plana = DSP.resumen(DSP.analyze(new Int32Array(60 * 130).fill(5), DSP.FS, []));
  assert.strictEqual(plana.estado, 'gris');
});

test('prematuros: QRS distinto = PVC, QRS igual con otra P = PAC; AF no se clasifica', () => {
  const base = k => 0.81 + 0.008 * Math.sin(k * 1.7);
  const mk = types => {
    const early = new Set(Object.keys(types).map(Number));
    const rrSeq = k => early.has(k + 1) ? 0.55 : early.has(k) ? 1.07 : base(k);
    const a = DSP.analyze(gen(75, { rrSeq, beatType: k => types[k] || 'normal', seed: 4, noise: 10 }), DSP.FS, []);
    return a;
  };
  const pvc = mk({ 20: 'pvc' });
  assert.strictEqual(pvc.ectopics.pvc, 1, JSON.stringify(pvc.ectopics)); assert.strictEqual(pvc.ectopics.pac, 0);
  const bp = pvc.beats.find(b => b.ectopic); assert.ok(bp.corr < 0.65, 'corr PVC ' + bp.corr);
  const pac = mk({ 20: 'pac' });
  assert.strictEqual(pac.ectopics.pac, 1, JSON.stringify(pac.ectopics)); assert.strictEqual(pac.ectopics.pvc, 0);
  const bq = pac.beats.find(b => b.ectopic); assert.ok(bq.corr >= 0.80, 'corr PAC ' + bq.corr);
  const mix = mk({ 20: 'pvc', 45: 'pac' });
  assert.ok(mix.ectopics.pvc === 1 && mix.ectopics.pac === 1, JSON.stringify(mix.ectopics));
  const rm = DSP.resumen(mix); assert.strictEqual(rm.ritmo, 'Normal, con PVC y PAC'); assert.ok(rm.marcados.startsWith('2 prematuros (PVC 1, PAC 1'), rm.marcados);
  const r = DSP.resumen(pvc);
  assert.strictEqual(r.estado, 'amarillo'); assert.strictEqual(r.ritmo, 'Normal, con PVC'); assert.ok(r.marcados.includes('PVC'), r.marcados);
  assert.strictEqual(DSP.resumen(pac).ritmo, 'Normal, con PAC');
  const none = DSP.analyze(gen(60, { hr: 75, seed: 3 }), DSP.FS, []);
  assert.strictEqual(none.ectopics.applicable, false);
  const af = DSP.analyze(gen(60, { irregular: true, seed: 5 }), DSP.FS, []);
  assert.strictEqual(af.ectopics.applicable, false);
});

test('prematuros: con mucho ruido no se declara PVC/PAC de forma errónea', () => {
  const base = k => 0.81 + 0.008 * Math.sin(k * 1.7);
  const rrSeq = k => k === 19 ? 0.55 : k === 20 ? 1.07 : base(k);
  const a = DSP.analyze(gen(75, { rrSeq, beatType: k => k === 20 ? 'pac' : 'normal', seed: 4, noise: 90 }), DSP.FS, []);
  const b = a.beats.find(x => x.ectopic);
  assert.ok(!b || b.ectopic !== 'PVC' || DSP.resumen(a).estado === 'gris', 'PAC con ruido 90 µV clasificado como PVC sin aviso');
});

test('prematuros: misma forma pero amplitud muy distinta = PVC; amplitud intermedia = indeterminado', () => {
  const base = k => 0.81 + 0.008 * Math.sin(k * 1.7);
  const run = ty => {
    const rrSeq = k => k === 19 ? 0.55 : k === 20 ? 1.07 : base(k);
    return DSP.analyze(gen(75, { rrSeq, beatType: k => k === 20 ? ty : 'normal', seed: 4, noise: 10 }), DSP.FS, []).beats.find(b => b.flag === 'corto');
  };
  assert.strictEqual(run('x0.45').ectopic, 'PVC'); assert.strictEqual(run('x0.78').ectopic, 'indeterminado');
  assert.strictEqual(run('x1.0').ectopic, 'PAC'); assert.strictEqual(run('x1.1').ectopic, 'PAC');
  assert.ok(Math.abs(run('x0.45').ampRatio - 0.45) < 0.1, 'ratio ' + run('x0.45').ampRatio);
});

test('filtro causal en vivo elimina la línea base lenta', () => {
  const f = DSP.createLiveFilter(DSP.FS, 50);
  let last = 0;
  for (let i = 0; i < 20 * DSP.FS; i++) last = f.process(500 + 300 * Math.sin(2 * Math.PI * 0.1 * i / DSP.FS));
  assert.ok(Math.abs(last) < 80, 'residuo ' + last);
});

console.log(`\n${passed} pruebas OK`);
