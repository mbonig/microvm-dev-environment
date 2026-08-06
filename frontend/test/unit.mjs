// Unit checks for the mobile key toolbar's pure logic, extracted verbatim from
// frontend/index.html and run in a vm context with DOM stubs.
// Covers tasks 7.4 / 7.5 (sequence encoding) and 7.8 (modifier state machine).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const START = '// ── Mobile key toolbar';
const END = '// ── Visibility-change';
const a = HTML.indexOf(START), b = HTML.indexOf(END);
if (a < 0 || b < 0) throw new Error('could not locate toolbar block in index.html');
const src = HTML.slice(a, b);

// --- DOM stubs -------------------------------------------------------------
const mkBtn = () => {
  const cls = new Set();
  const attrs = {};
  return {
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) },
    setAttribute: (k, v) => (attrs[k] = v),
    getAttribute: (k) => attrs[k],
    _cls: cls, _attrs: attrs,
    style: {}, addEventListener() {}, appendChild() {},
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
  };
};

const created = [];
const keybarEl = mkBtn();
const ctx = {
  console,
  document: {
    createElement: (tag) => { const e = mkBtn(); e.tag = tag; created.push(e); return e; },
    body: { classList: { toggle() {} } },
    documentElement: { style: { setProperty() {}, removeProperty() {} } },
  },
  window: { matchMedia: () => ({ matches: false, addEventListener() {} }), scrollY: 0, scrollTo() {}, visualViewport: null },
  requestAnimationFrame: (fn) => fn(),
  keybarEl,
  appEl: mkBtn(),
  panes: new Map(),
  targetPane: () => null,
  refitPanes: () => {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
// Top-level const/let in a vm script are lexical, not global properties — hand
// the ones under test back out explicitly.
const EXPORTS = ['KEYS', 'modState', 'cycleModifier', 'consumeModifiers', 'applyCtrl', 'applyAlt', 'applyModifiers', 'cursorSeq', 'CURSOR_FINALS'];
const api = vm.runInContext(`${src}\n;({${EXPORTS.join(', ')}})`, ctx, { filename: 'index.html:keybar' });
Object.assign(ctx, api);

// --- assertions ------------------------------------------------------------
let pass = 0, fail = 0;
const hex = (s) => [...s].map((c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
function eq(actual, expected, what) {
  if (actual === expected) { pass++; return; }
  fail++;
  console.error(`  FAIL ${what}\n    expected ${JSON.stringify(expected)} (${hex(expected)})\n    actual   ${JSON.stringify(actual)} (${hex(actual)})`);
}
const key = (label) => ctx.KEYS.find((k) => k.label === label);
const term = (decckm) => ({ modes: { applicationCursorKeysMode: decckm } });
const NOMODS = { ctrl: false, alt: false };
const press = (label, t = term(false), m = NOMODS) => key(label).seq(t, m);

console.log('\nkey set — Home/End are deliberately absent');
// zsh, the VM's login shell, binds neither \x1b[H/\x1bOH nor \x1b[F/\x1bOF, so
// both keys only ever beeped at the prompt. Asserted so they cannot creep back
// in without someone also fixing the shell's keymap.
eq(key('Home'), undefined, 'no Home button');
eq(key('End'), undefined, 'no End button');
eq(ctx.KEYS.filter((k) => !k.sep).length, 11, '11 keys total');
eq(ctx.CURSOR_FINALS?.home, undefined, 'home dropped from CURSOR_FINALS');
eq(ctx.CURSOR_FINALS?.end, undefined, 'end dropped from CURSOR_FINALS');

console.log('\n7.4/7.5 — literal keys');
eq(press('Esc'), '\x1b', 'Esc');
eq(press('Tab'), '\t', 'Tab');
eq(press('⇧Tab'), '\x1b[Z', 'Shift-Tab');
eq(press('PgUp'), '\x1b[5~', 'PgUp');
eq(press('PgDn'), '\x1b[6~', 'PgDn');

console.log('7.4 — cursor keys, DECCKM off (shell prompt: ↑ recalls history)');
for (const [label, seq] of [['↑', '\x1b[A'], ['↓', '\x1b[B'], ['→', '\x1b[C'], ['←', '\x1b[D']])
  eq(press(label, term(false)), seq, `${label} normal`);

console.log('7.5 — cursor keys, DECCKM on (vim / Claude Code TUI)');
for (const [label, seq] of [['↑', '\x1bOA'], ['↓', '\x1bOB'], ['→', '\x1bOC'], ['←', '\x1bOD']])
  eq(press(label, term(true)), seq, `${label} application`);

console.log('7.5 — missing/renamed terminal.modes degrades to normal mode');
eq(press('↑', {}), '\x1b[A', '↑ with no modes object');
eq(press('↑', undefined), '\x1b[A', '↑ with no terminal');
eq(press('↑', { modes: {} }), '\x1b[A', '↑ with modes but no flag');

console.log('7.5 — modified cursor keys bypass DECCKM (unambiguous CSI form)');
eq(press('→', term(true), { ctrl: true, alt: false }), '\x1b[1;5C', 'Ctrl-→ under DECCKM');
eq(press('←', term(false), { ctrl: false, alt: true }), '\x1b[1;3D', 'Alt-←');
eq(press('↑', term(true), { ctrl: true, alt: true }), '\x1b[1;7A', 'Ctrl-Alt-↑');

console.log('7.4 — Ctrl translation on software-keyboard characters');
const ctrlCases = [['c', 0x03], ['C', 0x03], ['d', 0x04], ['a', 0x01], ['k', 0x0b], ['z', 0x1a], ['r', 0x12],
  ['@', 0x00], [' ', 0x00], ['[', 0x1b], ['\\', 0x1c], [']', 0x1d], ['^', 0x1e], ['_', 0x1f], ['?', 0x7f]];
for (const [ch, code] of ctrlCases) eq(ctx.applyCtrl(ch), String.fromCharCode(code), `Ctrl-${JSON.stringify(ch)}`);
for (const ch of ['1', '/', '.', '€']) eq(ctx.applyCtrl(ch), ch, `Ctrl-${ch} passes through`);
eq(ctx.applyAlt('x'), '\x1bx', 'Alt-x');

console.log('7.8 — three-state modifier machine');
const st = ctx.modState;
const cyc = ctx.cycleModifier;
eq(st.ctrl, 'off', 'initial ctrl');
cyc('ctrl'); eq(st.ctrl, 'armed', 'tap 1 → armed');
cyc('ctrl'); eq(st.ctrl, 'locked', 'tap 2 → locked');
cyc('ctrl'); eq(st.ctrl, 'off', 'tap 3 → off');

console.log('7.8 — armed is one-shot, locked persists');
cyc('ctrl');                                                     // armed
eq(ctx.applyModifiers('a'), '\x01', 'armed Ctrl + a → ^A');
eq(st.ctrl, 'off', 'armed cleared after one key');
eq(ctx.applyModifiers('b'), 'b', 'next char is plain');

cyc('ctrl'); cyc('ctrl');                                        // locked
eq(st.ctrl, 'locked', 'double-tap → locked');
eq(ctx.applyModifiers('a'), '\x01', 'locked Ctrl + a → ^A');
eq(ctx.applyModifiers('k'), '\x0b', 'locked Ctrl + k → ^K (still locked)');
eq(st.ctrl, 'locked', 'lock survives two keys');
cyc('ctrl');                                                     // off
eq(st.ctrl, 'off', 'tap clears lock');
eq(ctx.applyModifiers('a'), 'a', 'plain characters resume');

console.log('7.8 — Alt and Ctrl+Alt composition');
cyc('alt');
eq(ctx.applyModifiers('f'), '\x1bf', 'Alt-f');
eq(st.alt, 'off', 'alt consumed');
cyc('ctrl'); cyc('alt');
eq(ctx.applyModifiers('x'), '\x1b\x18', 'Ctrl-Alt-x → ESC 0x18');
eq(st.ctrl, 'off', 'ctrl consumed');
eq(st.alt, 'off', 'alt consumed');

console.log('7.8 — multi-char payloads pass through but still clear armed mods');
cyc('ctrl');
eq(ctx.applyModifiers('hello'), 'hello', 'paste unmangled');
eq(st.ctrl, 'off', 'armed ctrl cleared by paste');
cyc('ctrl');
eq(ctx.applyModifiers('😀'), '😀', 'astral char treated as one char, no ctrl form');
eq(st.ctrl, 'off', 'armed ctrl cleared by emoji');
eq(ctx.applyModifiers('plain'), 'plain', 'no-modifier fast path');

console.log('7.8 — consumeModifiers reports before clearing');
cyc('ctrl'); cyc('alt'); cyc('alt');                             // ctrl armed, alt locked
const rep = ctx.consumeModifiers();
eq(rep.ctrl, true, 'reports ctrl active');
eq(rep.alt, true, 'reports alt active');
eq(st.ctrl, 'off', 'armed ctrl dropped');
eq(st.alt, 'locked', 'locked alt kept');
cyc('alt');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
