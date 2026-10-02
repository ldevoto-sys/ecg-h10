// Prueba de extremo a extremo con Chromium y una banda H10 simulada (mock de Web Bluetooth).
// Ejecutar: NODE_PATH=<ruta a node_modules con playwright> node ecg-h10/test/e2e.js
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');

const server = http.createServer((req, res) => {
  const f = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});

const MOCK = `
(() => {
  const mk = () => Object.assign(new EventTarget(), { value: null, async startNotifications() {}, async stopNotifications() {} });
  const ctrl = mk(), data = mk(), hr = mk(), batt = mk();
  const dev = Object.assign(new EventTarget(), { name: 'Polar H10 MOCK' });
  window.__mock = { skipFrame: false, startBytes: null, timer: null, ts: 1000000000000n, connects: 0 };
  const M = window.__mock;
  let synth = null;
  const send = (c, bytes) => { c.value = new DataView(Uint8Array.from(bytes).buffer); c.dispatchEvent(new Event('characteristicvaluechanged')); };
  function startFrames() {
    synth = synth || DSP.createSynth({ hr: 72, noise: 15, seed: 21 });
    M.timer = setInterval(() => {
      const a = synth.next(73);
      M.ts += BigInt(Math.round(73 / 130 * 1e9));
      if (M.skipFrame) { M.skipFrame = false; M.ts += BigInt(Math.round(73 / 130 * 1e9)); }
      const b = new Uint8Array(10 + 73 * 3), dv = new DataView(b.buffer);
      dv.setUint8(0, 0); dv.setBigUint64(1, M.ts, true); dv.setUint8(9, 0);
      a.forEach((v, i) => { const u = v & 0xffffff; b[10 + i * 3] = u & 255; b[11 + i * 3] = (u >> 8) & 255; b[12 + i * 3] = (u >> 16) & 255; });
      data.value = new DataView(b.buffer); data.dispatchEvent(new Event('characteristicvaluechanged'));
      send(hr, [0x10, 72, 0x00, 0x04]); // flags: RR presente; RR = 1024 -> 1000 ms
    }, 40);
  }
  data.startNotifications = async () => { if (M.preStream && !M.timer) startFrames(); };
  ctrl.writeValueWithResponse = async v => {
    const b = Array.from(new Uint8Array(v.buffer || v));
    if (b[0] === 0x03) { // STOP
      if (!M.ignoreStop) clearInterval(M.timer), M.timer = null;
      setTimeout(() => send(ctrl, [0xF0, 0x03, 0x00, 0x00, 0x00]), 10); return;
    }
    M.startBytes = b;
    const already = !!M.timer; // ya transmitiendo desde un intento anterior
    if (M.dead) { setTimeout(() => send(ctrl, [0xF0, 0x02, 0x00, 0x08, 0x00]), 20); return; } // banda que rechaza y no transmite
    setTimeout(() => { send(ctrl, [0xF0, 0x02, 0x00, already ? 0x06 : 0x00, 0x00]); if (!already) startFrames(); }, 20);
  };
  const svc = { pmd: { getCharacteristic: async u => u.endsWith('81-02e7-f387-1cad-8acd2d8df0c8') ? ctrl : data },
                heart_rate: { getCharacteristic: async () => hr },
                battery_service: { getCharacteristic: async () => Object.assign(batt, { readValue: async () => new DataView(Uint8Array.from([87]).buffer) }) } };
  dev.gatt = { connected: false,
    async connect() { M.connects++; dev.gatt.connected = true; return { getPrimaryService: async n => n.startsWith('fb005c80') ? svc.pmd : svc[n] }; },
    disconnect() { dev.gatt.connected = false; clearInterval(M.timer); M.timer = null; } };
  M.drop = () => { clearInterval(M.timer); M.timer = null; dev.gatt.connected = false; dev.dispatchEvent(new Event('gattserverdisconnected')); };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => dev }, configurable: true });
})();`;

(async () => {
  await new Promise(r => server.listen(0, r));
  const url = 'http://localhost:' + server.address().port + '/';
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.addInitScript({ content: fs.readFileSync(path.join(root, 'dsp.js'), 'utf8') }); // DSP para el mock
  await page.addInitScript(MOCK);
  await page.goto(url);

  // Escenario previo: la banda quedó transmitiendo y rechaza el inicio con 'estado inválido' (6)
  await page.evaluate(() => { window.__mock.ignoreStop = true; window.__mock.preStream = true; });
  await page.click('#bConnect');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('transmitiendo'));
  const start = await page.evaluate(() => window.__mock.startBytes);
  assert.deepStrictEqual(start, [0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00], 'comando de inicio ECG');
  assert.strictEqual(await page.textContent('#batt'), '87%');
  console.log('ok  - conexión, comando PMD y batería');

  await page.click('#bRec');
  await page.waitForFunction(() => S.rec && S.rec.n > 130 * 20);
  await page.click('#bMark');
  await page.evaluate(() => { window.__mock.skipFrame = true; }); // pierde una trama (~561 ms)
  await page.waitForFunction(() => S.rec.n > 130 * 40);
  await page.screenshot({ path: path.join(__dirname, 'shot-live.png') });
  // corte de conexión + reconexión automática
  await page.evaluate(() => window.__mock.drop());
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Reconectado'), null, { timeout: 15000 }).catch(async e => { console.log('estado:', await page.textContent('#status'), await page.evaluate(() => JSON.stringify({ frames: S.frames, connects: __mock.connects, timer: !!__mock.timer }))); throw e; });
  assert.ok(await page.evaluate(() => window.__mock.connects) >= 2);
  await page.waitForFunction(() => S.rec.n > 130 * 75);
  console.log('ok  - grabación, hueco de trama y reconexión automática');

  await page.click('#bRec');
  await page.waitForSelector('#aBody:not(.hide)', { timeout: 20000 });
  const info = await page.evaluate(() => ({
    gaps: A.data.gaps.map(g => Math.round(g.ms)), events: A.data.events.length, n: A.data.samples.length,
    hr: A.an.metrics.meanHR, beats: A.an.metrics.beats, valid: A.an.validPct, rr: A.data.rrDevice.length,
    first: Array.from(A.data.samples.slice(0, 3))
  }));
  console.log(info);
  assert.ok(info.gaps.some(ms => ms > 450 && ms < 700), 'hueco de trama detectado por timestamp: ' + info.gaps);
  assert.ok(info.gaps.some(ms => ms >= 1000), 'hueco de reconexión registrado');
  assert.strictEqual(info.events, 1);
  assert.ok(Math.abs(info.hr - 72) < 3, 'FC ' + info.hr);
  assert.ok(info.rr > 10, 'RR del dispositivo');
  assert.ok((await page.textContent('#evTable tbody')).includes('lpm'), 'tabla de síntomas con FC');
  await page.screenshot({ path: path.join(__dirname, 'shot-analysis.png'), fullPage: true });
  await page.locator('#trace').screenshot({ path: path.join(__dirname, 'shot-trace.png') });
  console.log('ok  - análisis: FC', info.hr.toFixed(1), 'lpm, huecos', info.gaps.join(', '), 'ms');

  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: path.join(__dirname, 'shot-print.pdf'), format: 'A4', printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  assert.ok((await page.textContent('#aCards')).includes('RMSSD'), 'tarjeta RMSSD');
  // exportación
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#xBeats')]);
  assert.ok(dl.suggestedFilename().endsWith('_latidos.csv'));
  console.log('ok  - exportación CSV');

  // sesión persistida
  await page.click('#t-sessions');
  await page.waitForSelector('#sessTable tbody tr');
  assert.ok((await page.textContent('#sessTable tbody')).includes('hueco'));
  console.log('ok  - sesión guardada en IndexedDB');

  // error visible: banda que rechaza el ECG y no transmite
  await page.reload();
  await page.evaluate(() => { window.__mock.dead = true; });
  await page.click('#bConnect');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Error al conectar'), null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  const msg = await page.textContent('#status');
  assert.ok(msg.includes('código 8'), 'mensaje de error persistente con código: ' + msg);
  assert.ok(await page.isEnabled('#bConnect'), 'se puede reintentar');
  console.log('ok  - error de conexión visible y reintentable:', msg);

  // simulador
  await page.reload(); await page.click('#bSim');
  await page.waitForFunction(() => S.ringN > 130 * 3);
  assert.ok(await page.isVisible('#modeBadge'), 'badge SIMULADO');
  console.log('ok  - simulador marcado como SIMULADO');

  assert.deepStrictEqual(errors, [], 'errores de consola: ' + errors.join(' | '));
  await browser.close(); server.close();
  console.log('\nE2E OK');
})().catch(e => { console.error('FALLÓ:', e); process.exit(1); });
