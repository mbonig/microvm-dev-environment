// Browser checks for the mobile key toolbar, driving the real frontend/index.html
// in Chromium with the WebSocket and auth stubbed out.
// Covers tasks 7.6 (multi-pane routing), 7.7 (disconnected pane), 7.8 (locked
// modifiers end-to-end), and the emulator-observable parts of 7.2 (geometry/refit).
import { chromium, devices } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/test\/$/, '');

const respond = (res, body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
const server = http.createServer((req, res) => {
  try {
    // Same substitution the deploy script does — the inline APP_CONFIG script
    // runs after addInitScript, so it has to be filled here.
    const body = readFileSync(`${ROOT}/index.html`, 'utf8').replace(
      'window.APP_CONFIG = {};',
      `window.APP_CONFIG = { tokenApiUrl: 'https://token.test/t', userPoolId: 'us-east-1_stub', userPoolClientId: 'stub' };`);
    if (process.env.MUTATE) { const [a, b] = process.env.MUTATE.split('=>'); if (!body.includes(a)) throw new Error('mutation target missing'); return respond(res, body.replace(a, b)); }
    respond(res, body);
  } catch (e) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

let pass = 0, fail = 0;
const errors = [];
function ok(cond, what, extra = '') {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  FAIL ${what}${extra ? '\n    ' + extra : ''}`);
}
const eq = (a, b, what) => ok(a === b, what, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// Replaces the Cognito CDN bundle with a stub that reports a valid session, so
// the page goes straight to the app instead of the login screen.
const COGNITO_STUB = `
window.AmazonCognitoIdentity = {
  CognitoUserPool: function () {
    this.getCurrentUser = () => ({
      getSession: (cb) => cb(null, {
        isValid: () => true,
        getIdToken: () => ({ getJwtToken: () => 'stub.jwt.token' }),
      }),
    });
  },
  CognitoUser: function () {}, AuthenticationDetails: function () {},
};`;

// Records every frame the page writes, per pane socket, and never touches the net.
const WS_STUB = `
window.APP_CONFIG = { tokenApiUrl: 'https://token.test/t', userPoolId: 'us-east-1_stub', userPoolClientId: 'stub' };
window.__sockets = [];
const dec = new TextDecoder();
class StubWS {
  constructor(url, protocols) {
    this.url = url; this.protocols = protocols; this.readyState = 0;
    this.sent = []; this.binaryType = '';
    window.__sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('send on non-open socket');
    if (typeof data === 'string') { this.sent.push({ json: data }); return; }
    const u8 = new Uint8Array(data);
    this.sent.push({ cmd: String.fromCharCode(u8[0]), payload: dec.decode(u8.slice(1)), bytes: [...u8] });
  }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
  addEventListener() {}
}
StubWS.prototype.CONNECTING = 0; StubWS.prototype.OPEN = 1;
window.WebSocket = StubWS;
// Auto-accept the close-pane confirm().
window.confirm = () => true;
`;

const browser = await chromium.launch();

async function newPage(ctxOpts) {
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(WS_STUB);
  await page.route('**/amazon-cognito-identity*.js', (r) =>
    r.fulfill({ contentType: 'application/javascript', body: COGNITO_STUB }));
  await page.route('https://token.test/**', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ authToken: 'tok', endpoint: 'https://mvm.test', expiresInSeconds: 3600, vmState: 'running' }) }));
  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById('app').style.display === 'flex');
  await page.waitForFunction(() => window.__sockets.length > 0 && window.__sockets[0].readyState === 1);
  return { context, page };
}

// Input frames only: drop the handshake JSON, the ttyd resize frames ('1') and
// the NUL keepalives, leaving what the user actually sent.
const input = (page, i) => page.evaluate(
  (i) => (window.__sockets[i]?.sent || []).filter((f) => f.cmd === '0').map((f) => f.payload), i);
const clearSent = (page) => page.evaluate(() => window.__sockets.forEach((s) => (s.sent = [])));
const tap = async (page, label) => {
  await page.locator(`#keybar .keybar-btn`, { hasText: new RegExp(`^${label}$`) }).first().tap();
  await page.waitForTimeout(30);
};

// ── Desktop baseline (7.1 re-check) ─────────────────────────────────────────
{
  console.log('\ndesktop — toolbar inert');
  const { context, page } = await newPage({ viewport: { width: 1280, height: 800 } });
  eq(await page.evaluate(() => document.body.classList.contains('touch')), false, 'body has no .touch');
  eq(await page.evaluate(() => getComputedStyle(document.getElementById('keybar')).display), 'none', '#keybar display:none');
  eq(await page.evaluate(() => document.getElementById('keybar').getBoundingClientRect().height), 0, '#keybar height 0');
  eq(await page.evaluate(() => document.getElementById('keybar').children.length), 0, '#keybar not built');
  eq(await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-h')), '', '--app-h unset');
  await context.close();
}

// ── Touch device ────────────────────────────────────────────────────────────
const { context, page } = await newPage({ ...devices['Pixel 7'] });

{
  console.log('7.2 (emulator-observable) — geometry and refit');
  eq(await page.evaluate(() => document.body.classList.contains('touch')), true, 'body.touch set');
  const btns = await page.locator('#keybar .keybar-btn').count();
  eq(btns, 13, '13 key buttons');
  eq(await page.locator('#keybar .keybar-sep').count(), 3, '3 separators');

  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('#keybar .keybar-btn')].map((b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top }; }));
  ok(boxes.every((b) => b.w >= 40 && b.h >= 40), 'every tap target >= 40x40',
    JSON.stringify(boxes.filter((b) => b.w < 40 || b.h < 40)));
  ok(new Set(boxes.map((b) => Math.round(b.top))).size === 1, 'buttons on a single row');
  ok(await page.evaluate(() => { const k = document.getElementById('keybar'); return k.scrollWidth > k.clientWidth; }),
    'row overflows horizontally (scrollable, not wrapped)');

  const geo = await page.evaluate(() => {
    const app = document.getElementById('app').getBoundingClientRect();
    const panes = document.getElementById('panes').getBoundingClientRect();
    const bar = document.getElementById('keybar').getBoundingClientRect();
    return { app, panes, bar };
  });
  ok(geo.bar.top >= geo.panes.bottom - 1, 'bar sits below the panes, no overlap',
    `panes.bottom=${geo.panes.bottom} bar.top=${geo.bar.top}`);
  ok(Math.abs(geo.bar.bottom - geo.app.bottom) < 1, 'bar flush with the app bottom');
  ok(geo.bar.height >= 40, `bar height ${geo.bar.height}px`);

  // The bar takes its height out of the terminal, and the pane refits to match.
  const rowsWithBar = await page.evaluate(() => panes.get('main').terminal.rows);
  const rowsWithout = await page.evaluate(async () => {
    document.getElementById('keybar').style.display = 'none';
    panes.get('main').fitAddon.fit();
    const r = panes.get('main').terminal.rows;
    document.getElementById('keybar').style.display = '';
    panes.get('main').fitAddon.fit();
    return r;
  });
  ok(rowsWithBar < rowsWithout, `panes refit around the bar (${rowsWithBar} rows vs ${rowsWithout} without)`);
}

{
  console.log('6.4 — one tap = one sequence');
  await clearSent(page);
  await tap(page, 'Esc');
  const sent = await input(page, 0);
  eq(sent.length, 1, 'exactly one frame per tap');
  eq(sent[0], '\x1b', 'Esc payload');
}

{
  console.log('7.8 — locked modifier end-to-end');
  await clearSent(page);
  const ctrl = page.locator('#keybar .keybar-btn', { hasText: /^Ctrl$/ });
  await ctrl.tap();                                   // armed
  eq(await ctrl.getAttribute('aria-pressed'), 'true', 'armed sets aria-pressed');
  ok(await ctrl.evaluate((b) => b.classList.contains('mod-armed')), 'armed styling');
  await ctrl.tap();                                   // locked
  ok(await ctrl.evaluate((b) => b.classList.contains('mod-locked')), 'locked styling');
  ok(!(await ctrl.evaluate((b) => b.classList.contains('mod-armed'))), 'locked is not also armed');

  // All three states must be visually distinct.
  const styles = [];
  for (const cls of ['', 'mod-armed', 'mod-locked']) {
    styles.push(await ctrl.evaluate((b, c) => {
      const saved = b.className;
      b.className = 'keybar-btn' + (c ? ' ' + c : '');
      const s = getComputedStyle(b);
      const out = [s.backgroundColor, s.borderColor, s.color, s.fontWeight].join('|');
      b.className = saved;
      return out;
    }, cls));
  }
  eq(new Set(styles).size, 3, 'idle / armed / locked all render differently');

  // Ctrl-a then Ctrl-k typed on the (software) keyboard while locked.
  await page.locator('#panes .pane .term textarea').first().focus();
  await page.keyboard.type('a');
  await page.keyboard.type('k');
  await page.waitForTimeout(30);
  let seq = await input(page, 0);
  eq(seq.join(''), '\x01\x0b', 'locked Ctrl gives ^A ^K');
  ok(await ctrl.evaluate((b) => b.classList.contains('mod-locked')), 'still locked after two keys');

  await clearSent(page);
  await ctrl.tap();                                   // off
  eq(await ctrl.getAttribute('aria-pressed'), 'false', 'cleared');
  await page.locator('#panes .pane .term textarea').first().focus();
  await page.keyboard.type('hi');
  await page.waitForTimeout(30);
  eq((await input(page, 0)).join(''), 'hi', 'plain characters resume');
}

{
  console.log('7.6 — multi-pane routing');
  await page.locator('#split-btn').tap();
  await page.waitForFunction(() => window.__sockets.length === 2 && window.__sockets[1].readyState === 1);
  eq(await page.evaluate(() => panes.size), 2, 'two panes');
  eq(await page.evaluate(() => focusedPane.id), 't2', 'new pane is focused');

  await clearSent(page);
  await tap(page, 'Esc');
  eq((await input(page, 1)).join(''), '\x1b', 'key lands in focused pane 2');
  eq((await input(page, 0)).join(''), '', 'pane 1 receives nothing');

  // Focus back to pane 1 and confirm the key follows the focus.
  await page.evaluate(() => panes.get('main').focus());
  await clearSent(page);
  await tap(page, 'Tab');
  eq((await input(page, 0)).join(''), '\t', 'key follows focus to pane 1');
  eq((await input(page, 1)).join(''), '', 'pane 2 receives nothing');

  // Close pane 1 (the focused one) — keys must fall through to the survivor.
  await page.evaluate(() => closePane('main'));
  await page.waitForFunction(() => panes.size === 1);
  await clearSent(page);
  await tap(page, 'Esc');
  eq((await input(page, 1)).join(''), '\x1b', 'key follows to the remaining pane after close');
}

{
  console.log('7.7 — disconnected pane');
  const before = errors.length;
  await page.evaluate(() => { window.__sockets[1].readyState = 3; });   // socket dead, no reconnect yet
  await clearSent(page);
  for (const k of ['Esc', 'Tab', '↑', '←']) await tap(page, k);
  await page.evaluate(() => document.querySelector('#panes .pane .term textarea').focus());
  await page.keyboard.type('x');
  await page.waitForTimeout(50);
  eq(errors.length - before, 0, 'no console errors while disconnected', errors.slice(before).join('\n    '));
  eq((await input(page, 1)).join(''), '', 'nothing queued onto the dead socket');

  // Reconnect and confirm input flows again.
  await page.evaluate(() => panes.values().next().value.connect());
  await page.waitForFunction(() => window.__sockets.at(-1).readyState === 1);
  await clearSent(page);
  await tap(page, 'Esc');
  const last = await page.evaluate(() => window.__sockets.length - 1);
  eq((await input(page, last)).join(''), '\x1b', 'input works again after reconnect');
}

await context.close();
await browser.close();
server.close();

if (errors.length) console.log(`\nconsole errors seen (${errors.length}):\n  ` + errors.join('\n  '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
