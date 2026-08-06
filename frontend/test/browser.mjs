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
      `window.APP_CONFIG = { tokenApiUrl: 'https://token.test/token', userPoolId: 'us-east-1_stub', userPoolClientId: 'stub' };`);
    if (process.env.MUTATE) {
      // Split on the FIRST '=>' only: the replacement routinely contains arrow
      // functions, and splitting on all of them silently truncates it into
      // invalid JS — which looks like the mutation 'working'.
      const i = process.env.MUTATE.indexOf('=>');
      if (i < 0) throw new Error("MUTATE must be 'find=>replace'");
      const a = process.env.MUTATE.slice(0, i), b = process.env.MUTATE.slice(i + 2);
      if (!body.includes(a)) throw new Error('mutation target missing');
      return respond(res, body.replace(a, b));
    }
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
window.APP_CONFIG = { tokenApiUrl: 'https://token.test/token', userPoolId: 'us-east-1_stub', userPoolClientId: 'stub' };
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
// Auto-accept confirm() by default (close-pane, terminate). Tests that need a
// cancelled confirmation flip window.__confirmAnswer.
window.__confirmAnswer = true;
window.confirm = () => window.__confirmAnswer;
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
  const tokenCalls = [];
  let tokenStatus = 200;
  await page.route('https://token.test/token', (r) => {
    tokenCalls.push(r.request().method());
    if (tokenStatus !== 200) return r.fulfill({ status: tokenStatus, contentType: 'application/json', body: '{"error":"boom"}' });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ authToken: 'tok', endpoint: 'https://mvm.test', expiresInSeconds: 3600, vmState: 'running' }) });
  });
  // Registered after /token so it wins — Playwright matches routes newest-first.
  const terminateCalls = [];
  let terminateStatus = 200;
  await page.route('https://token.test/vm', (r) => {
    terminateCalls.push({ method: r.request().method(), auth: r.request().headers()['authorization'] });
    if (terminateStatus !== 200) return r.fulfill({ status: terminateStatus, contentType: 'text/plain', body: 'nope' });
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ terminated: true, microvmId: 'mvm-1' }) });
  });
  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById('app').style.display === 'flex');
  await page.waitForFunction(() => window.__sockets.length > 0 && window.__sockets[0].readyState === 1);
  return {
    context, page, tokenCalls, terminateCalls,
    setTerminateStatus: (n) => { terminateStatus = n; },
    setTokenStatus: (n) => { tokenStatus = n; },
  };
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
  eq(btns, 11, '11 key buttons (no Home/End)');
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

// ── Terminate / relaunch (change: terminate-vm) ─────────────────────────────
{
  console.log('5.2 — cancelling the confirmation does nothing');
  const t = await newPage({ viewport: { width: 1280, height: 800 } });
  await t.page.evaluate(() => { window.__confirmAnswer = false; });
  await t.page.locator('#terminate-btn').click();
  await t.page.waitForTimeout(80);
  eq(t.terminateCalls.length, 0, 'no request sent when the user cancels');
  eq(await t.page.evaluate(() => window.__sockets[0].readyState), 1, 'socket left open');
  eq(await t.page.evaluate(() => vmTerminated), false, 'not in terminated state');

  console.log('5.1 — terminate tears the client down');
  const errBefore = errors.length;
  await t.page.evaluate(() => { window.__confirmAnswer = true; });
  await t.page.locator('#terminate-btn').click();
  await t.page.waitForFunction(() => vmTerminated === true);
  await t.page.waitForTimeout(150);

  eq(t.terminateCalls.length, 1, 'exactly one terminate request');
  eq(t.terminateCalls[0].method, 'DELETE', 'sent as DELETE');
  ok(/^Bearer /.test(t.terminateCalls[0].auth || ''), 'carries the bearer token',
    JSON.stringify(t.terminateCalls[0].auth));
  eq(await t.page.evaluate(() => window.__sockets.every((s) => s.readyState === 3)),
    true, 'every socket closed');
  eq(await t.page.evaluate(() => [...panes.values()].some((p) => p.reconnectTimer)),
    false, 'no reconnect scheduled');
  eq(await t.page.evaluate(() => [...panes.values()].some((p) => p.pingTimer)),
    false, 'no keepalive timer left running');
  eq(await t.page.evaluate(() => authToken), null, 'cached token discarded');
  eq(await t.page.evaluate(() => tokenExpiresAt), 0, 'token expiry reset');
  eq(await t.page.locator('#status').textContent(), 'Terminated', 'status reads Terminated');
  eq(await t.page.evaluate(() => document.getElementById('status').className), 'terminated',
    'status carries the terminated class');
  eq(await t.page.evaluate(() => panes.size > 0), true, 'panes not destroyed');
  eq(await t.page.locator('#split-btn').isDisabled(), true, 'split disabled while terminated');
  eq(await t.page.locator('#terminate-btn').isVisible(), false, 'terminate button hidden');
  eq(await t.page.locator('#start-vm-btn').isVisible(), true, 'start-new-vm button shown');

  // The real failure mode this guards: a dropped socket must not restart the
  // backoff loop against an endpoint that no longer exists.
  const sockBefore = await t.page.evaluate(() => window.__sockets.length);
  await t.page.evaluate(() => window.__sockets.forEach((s) => s.onclose && s.onclose()));
  await t.page.waitForTimeout(400);
  eq(await t.page.evaluate(() => [...panes.values()].some((p) => p.reconnectTimer)),
    false, 'a further onclose still schedules nothing');
  eq(await t.page.evaluate(() => window.__sockets.length), sockBefore, 'no new socket opened');
  eq(errors.length - errBefore, 0, 'no console errors during terminate',
    errors.slice(errBefore).join('\n    '));

  console.log('5.3 — relaunch');
  const tokenCallsBefore = t.tokenCalls.length;
  const paneIdsBefore = await t.page.evaluate(() => [...panes.keys()]);
  await t.page.locator('#start-vm-btn').click();
  await t.page.waitForFunction((n) => window.__sockets.length > n, sockBefore);
  await t.page.waitForTimeout(150);
  ok(t.tokenCalls.length > tokenCallsBefore, 'a fresh token was fetched');
  eq(await t.page.evaluate(() => vmTerminated), false, 'terminated state cleared');
  eq((await t.page.evaluate(() => [...panes.keys()])).join(','), paneIdsBefore.join(','),
    'same pane layout after relaunch');
  eq(await t.page.evaluate(() => window.__sockets.at(-1).readyState), 1, 'reconnected');
  eq(await t.page.locator('#terminate-btn').isVisible(), true, 'terminate button back');
  eq(await t.page.locator('#start-vm-btn').isVisible(), false, 'start button hidden again');
  await t.context.close();
}

{
  console.log('5.4 — a failed terminate does not enter the terminated state');
  const t = await newPage({ viewport: { width: 1280, height: 800 } });
  t.setTerminateStatus(500);
  await t.page.locator('#terminate-btn').click();
  await t.page.waitForTimeout(250);
  eq(t.terminateCalls.length, 1, 'request was attempted');
  eq(await t.page.evaluate(() => vmTerminated), false, 'still not terminated');
  eq(await t.page.evaluate(() => window.__sockets[0].readyState), 1, 'socket left open');
  eq(await t.page.evaluate(() => authToken), 'tok', 'token retained');
  ok(await t.page.locator('#error-banner').isVisible(), 'error surfaced to the user');
  eq(await t.page.locator('#terminate-btn').isDisabled(), false, 're-enabled so it can be retried');
  await t.context.close();
}

{
  console.log('5.3b — relaunch failure falls back to the terminated state');
  const t = await newPage({ viewport: { width: 1280, height: 800 } });
  await t.page.locator('#terminate-btn').click();
  await t.page.waitForFunction(() => vmTerminated === true);
  t.setTokenStatus(500);
  await t.page.locator('#start-vm-btn').click();
  await t.page.waitForTimeout(400);
  eq(await t.page.evaluate(() => vmTerminated), true, 'back in the terminated state');
  eq(await t.page.locator('#start-vm-btn').isVisible(), true, 'user can retry');
  ok(await t.page.locator('#error-banner').isVisible(), 'error still shown');
  eq(await t.page.evaluate(() => document.getElementById('loading').style.display), 'none',
    'loading overlay not left spinning');
  await t.context.close();
}

await browser.close();
server.close();

if (errors.length) console.log(`\nconsole errors seen (${errors.length}):\n  ` + errors.join('\n  '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
