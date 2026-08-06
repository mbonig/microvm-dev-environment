# Mobile key toolbar — implementation spec

A handoff spec for implementing an on-screen key bar for touch devices in a
browser xterm.js terminal. Written to be implemented **from scratch against a
different fork** — it describes an adapter boundary and drop-in code rather than
a patch, because the surrounding file has diverged.

Implemented and verified in `mbonig/microvm-dev-environment`. Frontend-only: no
backend, no protocol change, no new dependencies.

---

## 1. The problem

Software keyboards on phones and tablets have no `Esc`, no `Ctrl`, and no arrow
keys. That makes a browser terminal close to useless on mobile:

- Claude Code's TUI needs arrows to navigate and `Esc` to interrupt.
- Ordinary shell work needs `Ctrl-C`, `Ctrl-D`, `Tab` completion, and `↑` for
  history.

None of it is reachable. The fix is a row of those keys, rendered on touch
devices only, that emits the same byte sequences a physical keyboard would.

## 2. Scope

**In:** `Esc`, `Tab`, `Shift-Tab`, sticky `Ctrl`, sticky `Alt`, `←` `↓` `↑` `→`,
`Home`, `End`, `PgUp`, `PgDn`.

**Out (deliberate):** function keys F1–F12, a paste button, a remappable key set,
gesture input. Touch *scrolling* is a separate concern and a separate change.

**Non-negotiable properties:**

1. The bar must never cover terminal content — including the cursor row.
2. Tapping a key must not dismiss the software keyboard.
3. Desktop must be completely unaffected: no extra DOM, no layout change.

---

## 3. Prerequisites and assumptions

| Assumption | Why it matters | If your fork differs |
|---|---|---|
| xterm.js **5.x** | `terminal.modes.applicationCursorKeysMode` is public API from 4.14 | Code is guarded — degrades to normal-mode sequences, see §6.3 |
| A single function that sends input bytes to the backend | The toolbar reuses it so synthetic keys are indistinguishable from typed ones | Factor one out first — see §4.1 |
| App shell is a **column flexbox** with the terminal area at `flex: 1` | The bar is a flex sibling that steals height from the terminal | Make it one; this is the mechanism, not decoration |
| `<meta name="viewport" content="… interactive-widget=resizes-content">` | Android Chrome shrinks the layout viewport for the keyboard | Add it; iOS is handled separately in §6.2 |

---

## 4. Integration points

Five places to touch. Everything else is drop-in.

### 4.1 Factor out the input send path

Find where typed input is sent. In a ttyd-protocol fork it looks like this:

```js
terminal.onData((data) => {
  if (!ws || ws.readyState !== 1) return;
  const encoded = new TextEncoder().encode(data);
  const msg = new Uint8Array(1 + encoded.length);
  msg[0] = 0x30;            // ttyd INPUT opcode '0'
  msg.set(encoded, 1);
  ws.send(msg);
});
```

Split it into a reusable function, and wrap the data in `applyModifiers`:

```js
function sendInput(data) {
  if (!data || !ws || ws.readyState !== 1) return;   // silent no-op when down
  const encoded = new TextEncoder().encode(data);
  const msg = new Uint8Array(1 + encoded.length);
  msg[0] = 0x30;
  msg.set(encoded, 1);
  ws.send(msg);
}

terminal.onData((data) => sendInput(applyModifiers(data)));
```

**`applyModifiers` on the `onData` path is load-bearing**, not a convenience.
It is what makes "tap `Ctrl`, then type `c` on the software keyboard" produce
`^C`. Put it anywhere else and sticky modifiers only work for keys that are
physically on the bar.

The early return matters too: taps on a dead socket must be discarded, not throw.

### 4.2 Add the container

Last child of the app shell, **after** the terminal area:

```html
<div id="app">
  <div id="header">…</div>
  <div id="terminal-area"></div>   <!-- flex: 1 -->

  <!-- Buttons only. The pointerdown handler calls preventDefault() to keep
       focus on the terminal, which breaks any control that needs focus
       (input, select, link). -->
  <div id="keybar" role="toolbar" aria-label="Terminal keys"></div>
</div>
```

### 4.3 Make the shell height keyboard-aware

```css
#app {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  height: var(--app-h, 100dvh);   /* set from visualViewport on touch only */
}
```

If your shell has an inline `style="height:100dvh"`, remove it — an inline style
beats the stylesheet and `--app-h` will never take effect. (This bit us.)

### 4.4 Move the iOS safe-area inset to the bar

If you have `#app { padding-bottom: env(safe-area-inset-bottom); }`, override it
when the bar is present so the buttons clear the home indicator instead of
leaving a dead strip under them:

```css
@supports (padding: env(safe-area-inset-bottom)) {
  #app { padding-bottom: env(safe-area-inset-bottom); }
  body.touch #app { padding-bottom: 0; }   /* the bar owns the inset now */
}
```

### 4.5 Fill in the adapter

The only fork-specific code. Single-terminal version:

```js
const RC = {
  app:   () => document.getElementById('app'),
  bar:   () => document.getElementById('keybar'),
  // Target for synthetic keys.
  target: () => ({ terminal, send: sendInput, focus: () => terminal.focus() }),
  // Called whenever the available height changes.
  refit: () => { try { fitAddon.fit(); } catch {} },
};
```

Multi-terminal (split panes) version — route to the focused pane, falling back to
the first so the bar works before anything is tapped:

```js
const RC = {
  app: () => document.getElementById('app'),
  bar: () => document.getElementById('keybar'),
  target: () => {
    const p = focusedPane ?? [...panes.values()][0];
    return p && { terminal: p.terminal, send: (d) => p.send(d), focus: () => p.focus() };
  },
  refit: () => { for (const p of panes.values()) { try { p.fitAddon.fit(); } catch {} } },
};
```

`refit()` must also cause a resize frame to reach the server. With xterm's
`FitAddon` that happens for free: `fit()` changes `rows`, which fires
`terminal.onResize`, which your existing handler already forwards.

---

## 5. The code

### 5.1 CSS

```css
/* ── Mobile key toolbar ──────────────────────────────────────────────────
   A flex sibling of the terminal area, never an overlay: the terminal shrinks
   by exactly the bar's height and refits, so "doesn't cover the terminal" is
   structural rather than two heights kept in sync by hand. */
#keybar {
  display: none;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px));
  background: #16213e;
  border-top: 1px solid #0f3460;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
}
#keybar::-webkit-scrollbar { display: none; }
body.touch #keybar { display: flex; }

.keybar-btn {
  flex: 0 0 auto;
  min-width: 44px;
  height: 40px;                    /* >= 40px tap target */
  padding: 0 10px;
  background: #0f3460;
  color: #c9d1d9;
  border: 1px solid #1f3a5f;
  border-radius: 8px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;      /* no double-tap-zoom delay */
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.keybar-btn:active { background: #1a4a8a; }

/* Sticky modifiers — off / armed (one-shot) / locked, all distinguishable */
.keybar-btn.mod-armed  { border-color: #58a6ff; color: #58a6ff; }
.keybar-btn.mod-locked {
  background: #58a6ff;
  border-color: #58a6ff;
  color: #0d1117;
  font-weight: 700;
}

.keybar-sep { flex: 0 0 auto; width: 1px; height: 24px; background: #1f3a5f; }
```

Colours are from this project's palette — swap for your own. The structural
properties (`flex-shrink: 0`, `overflow-x: auto`, `white-space: nowrap`,
`touch-action`, the 40px height) are not cosmetic.

### 5.2 JavaScript

Drop in as-is once `RC` (§4.5) is defined.

```js
// ── Mobile key toolbar ───────────────────────────────────────────────────────
// Software keyboards have no Esc, no Ctrl, and no arrow keys. On touch devices
// we render a row of them below the terminal. Inert on desktop: the bar is
// display:none and the viewport tracking below is skipped.

// Sticky modifiers: off → armed (applies to one key) → locked (until cleared).
// Locked exists because Ctrl-a Ctrl-k style sequences are common enough that
// re-arming every time is painful.
const modState = { ctrl: 'off', alt: 'off' };

function cycleModifier(name) {
  modState[name] = { off: 'armed', armed: 'locked', locked: 'off' }[modState[name]];
  renderModifiers();
}

// Report which modifiers are active, then drop the one-shot ones.
function consumeModifiers() {
  const active = { ctrl: modState.ctrl !== 'off', alt: modState.alt !== 'off' };
  let changed = false;
  for (const name of ['ctrl', 'alt']) {
    if (modState[name] === 'armed') { modState[name] = 'off'; changed = true; }
  }
  if (changed) renderModifiers();
  return active;
}

// Ctrl-<char> → the classic control code; characters without one pass through.
const CTRL_PUNCT = { '@': 0x00, ' ': 0x00, '[': 0x1b, '\\': 0x1c, ']': 0x1d, '^': 0x1e, '_': 0x1f, '?': 0x7f };

function applyCtrl(ch) {
  if (/^[a-zA-Z]$/.test(ch)) return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
  const code = CTRL_PUNCT[ch];
  return code === undefined ? ch : String.fromCharCode(code);
}

// Alt-<char> goes out ESC-prefixed, which is what readline and TUIs expect.
function applyAlt(str) { return '\x1b' + str; }

// Applied to characters coming from the software keyboard. Multi-character
// payloads (paste, IME commit) pass through untouched — mangling only the first
// character would be worse than ignoring the modifier — but still clear it so it
// can't linger unnoticed.
function applyModifiers(data) {
  if (modState.ctrl === 'off' && modState.alt === 'off') return data;
  const { ctrl, alt } = consumeModifiers();
  if ([...data].length !== 1) return data;
  let out = ctrl ? applyCtrl(data) : data;
  if (alt) out = applyAlt(out);
  return out;
}

// Arrow/Home/End encoding depends on DECCKM. At a shell prompt the CSI form is
// right, but a program that enabled application cursor keys mode looks up
// terminfo's \EOA and won't recognise \E[A — so arrows would silently do nothing
// in exactly the TUI this feature exists to fix. Read the mode per press.
// (Guarded so an xterm.js version bump degrades to normal-mode sequences rather
// than throwing.)
const CURSOR_FINALS = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };

function cursorSeq(term, name, mods) {
  const final = CURSOR_FINALS[name];
  if (mods.ctrl || mods.alt) {
    // The parameterised form carries the modifier and is unambiguous either way,
    // so the DECCKM lookup only applies to the unmodified case.
    return `\x1b[1;${1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)}${final}`;
  }
  return ((term?.modes?.applicationCursorKeysMode ?? false) ? '\x1bO' : '\x1b[') + final;
}

// `seq` receives the target terminal and the active modifiers and returns the
// bytes to send. Modifier buttons carry `mod` instead.
const KEYS = [
  { label: 'Esc',  seq: () => '\x1b' },
  { label: 'Tab',  seq: () => '\t' },
  { label: '⇧Tab', seq: () => '\x1b[Z' },
  { sep: true },
  { label: 'Ctrl', mod: 'ctrl' },
  { label: 'Alt',  mod: 'alt' },
  { sep: true },
  { label: '←', seq: (t, m) => cursorSeq(t, 'left', m) },
  { label: '↓', seq: (t, m) => cursorSeq(t, 'down', m) },
  { label: '↑', seq: (t, m) => cursorSeq(t, 'up', m) },
  { label: '→', seq: (t, m) => cursorSeq(t, 'right', m) },
  { sep: true },
  { label: 'Home', seq: (t, m) => cursorSeq(t, 'home', m) },
  { label: 'End',  seq: (t, m) => cursorSeq(t, 'end', m) },
  { label: 'PgUp', seq: () => '\x1b[5~' },
  { label: 'PgDn', seq: () => '\x1b[6~' },
];

const modButtons = {};
let keybarBuilt = false;

// An invisible sticky modifier is a trap, so all three states are distinct.
function renderModifiers() {
  for (const [name, btn] of Object.entries(modButtons)) {
    btn.classList.toggle('mod-armed',  modState[name] === 'armed');
    btn.classList.toggle('mod-locked', modState[name] === 'locked');
    btn.setAttribute('aria-pressed', String(modState[name] !== 'off'));
  }
}

function buildKeybar() {
  if (keybarBuilt) return;
  keybarBuilt = true;
  const bar = RC.bar();
  for (const key of KEYS) {
    if (key.sep) {
      const sep = document.createElement('span');
      sep.className = 'keybar-sep';
      bar.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'keybar-btn';
    btn.type = 'button';
    btn.textContent = key.label;
    // preventDefault() on pointerdown is what keeps focus on xterm's textarea —
    // without it every press would dismiss the software keyboard. It also
    // suppresses the follow-up click, so the key fires here, exactly once.
    // pointerdown rather than touchstart so stylus and hybrid devices work too.
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); pressKey(key); });
    if (key.mod) modButtons[key.mod] = btn;
    bar.appendChild(btn);
  }
  renderModifiers();
}

function pressKey(key) {
  if (key.mod) { cycleModifier(key.mod); return; }
  const t = RC.target();
  if (!t) return;
  // Armed modifiers are consumed by whatever key comes next, including keys with
  // no modified form — leaving one armed would be a mode with no way out.
  const mods = consumeModifiers();
  t.send(key.seq(t.terminal, mods));  // no-op if the socket is down
  t.focus();  // so the first tap on a fresh page also raises the keyboard
}

// "Is this a finger-first device" — the question we actually care about. UA
// sniffing misclassifies iPads (they report desktop Safari) and maxTouchPoints
// alone lights up on touch-enabled laptops, where the bar is clutter. Updates
// live, so devtools device mode works without a reload.
const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');

function applyTouchMode() {
  const touch = touchQuery.matches;
  document.body.classList.toggle('touch', touch);
  if (touch) buildKeybar();   // lazy: desktop pays for one media query
  syncViewport();
  RC.refit();
}

// iOS Safari ignores interactive-widget=resizes-content: the layout viewport
// keeps its full height and the keyboard slides over it, so only visualViewport
// sees the space actually left. Android Chrome already shrinks the layout
// viewport, where this agrees with 100dvh. We never try to detect "keyboard
// open" — we just consume whatever height we're handed, open or closed.
const vv = window.visualViewport;
let vvFrame = null;

function syncViewport() {
  if (!vv || vvFrame) return;
  vvFrame = requestAnimationFrame(() => {
    vvFrame = null;
    if (!touchQuery.matches) {
      // Desktop stays on the plain 100dvh path, untouched by any of this.
      document.documentElement.style.removeProperty('--app-h');
      RC.app().style.transform = '';
      return;
    }
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
    // iOS scrolls the page to reveal the focused input — undo that, and shift
    // the app down to wherever the visual viewport now starts.
    RC.app().style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    RC.refit();
  });
}

if (vv) {
  vv.addEventListener('resize', syncViewport);
  vv.addEventListener('scroll', syncViewport);
}
// Without visualViewport, --app-h is never set and #app falls back to 100dvh.
touchQuery.addEventListener('change', applyTouchMode);
applyTouchMode();
```

---

## 6. Design notes — please don't "simplify" these

Each of these looks like it could be shorter. Each one is the way it is for a
reason that bites otherwise.

### 6.1 The bar is a flex sibling, not a fixed overlay

The obvious implementation is `position: fixed; bottom: 0` plus a matching
`padding-bottom` on the terminal. That requires keeping two numbers in sync by
hand and breaks the moment the bar's height changes — font scaling, safe-area
insets, a second row later. As a flex sibling, the terminal shrinks by exactly
the bar's height automatically and the existing `ResizeObserver`/`fit()` path
does the rest. "Never covers the terminal" becomes structural.

### 6.2 `--app-h` from `visualViewport`, with no keyboard-open detection

Android Chrome with `interactive-widget=resizes-content` shrinks the layout
viewport, so `100dvh` already does the right thing. **iOS Safari ignores the
hint**: the layout viewport keeps its full height and the keyboard slides over
it. Only `window.visualViewport` sees the difference.

Resist the common `height shrank by > 150px ⇒ keyboard is open` heuristic. We
only ever consume the height we're given, which is the same code path whether
the keyboard is open or closed, and has no magic threshold to get wrong. The
`offsetTop` translate and `scrollTo(0, 0)` are needed because iOS scrolls the
page to reveal the focused input.

Updates are coalesced in `requestAnimationFrame` because iOS emits duplicate and
delayed resize events.

### 6.3 Cursor keys resolve DECCKM per press

Three options were considered:

1. **Always send `\x1b[A`.** Simplest. Works in bash. But ncurses looks up
   `kcuu1` = `\EOA` when the program has enabled application cursor keys mode,
   so arrows silently do nothing inside exactly the TUI this feature exists to
   fix. Rejected.
2. **Dispatch a synthetic `KeyboardEvent` at xterm's textarea** and let xterm
   encode it. Most "correct" in principle, handles every mode for free, but
   depends on untrusted-event handling and internal keyCode expectations that
   aren't part of xterm's public contract. Rejected as more to get wrong.
3. **Read `terminal.modes.applicationCursorKeysMode` per press.** One documented
   flag, one table. Chosen.

When a modifier is active, the parameterised form `\x1b[1;<m><final>` is used
instead — unambiguous regardless of DECCKM — so the mode lookup only applies to
the unmodified case.

### 6.4 `pointerdown` + `preventDefault()`, never `click`

`preventDefault()` on `pointerdown` stops the browser moving focus, which is the
only thing keeping the software keyboard open. Because that also suppresses the
follow-up `mousedown`/`click`, the key must fire on `pointerdown` itself — which
is also lower latency.

**Consequence:** the toolbar container must stay buttons-only. Anything that
legitimately needs focus (an `<input>`, a `<select>`, a link) will not work
inside it. Worth a code comment where the container is declared.

### 6.5 Three-state modifiers

Single tap arms for one key; second tap locks; third clears. Locked exists
because `Ctrl-a` `Ctrl-k` sequences and repeated `Ctrl-n` navigation are common
enough that re-arming each time is painful. All three states need distinct
styling — an invisible sticky modifier is a trap.

Armed modifiers are consumed by the *next key of any kind*, including keys with
no modified form (`Esc`, `Tab`). Leaving one armed would be a mode with no
visible way out.

### 6.6 Media query, not user-agent

`(hover: none) and (pointer: coarse)` answers the question we actually care
about — "is this finger-first". UA sniffing misclassifies iPads, which report
desktop Safari. `navigator.maxTouchPoints` alone lights up on touch-enabled
laptops where the bar is pure clutter. The media query also updates live, so
devtools device mode works without a reload — which makes the whole feature
testable from a desktop browser.

---

## 7. Verification

### 7.1 Sequence tables

| Key | Bytes |
|---|---|
| `Esc` | `\x1b` |
| `Tab` | `\x09` |
| `Shift-Tab` | `\x1b[Z` |
| `PgUp` | `\x1b[5~` |
| `PgDn` | `\x1b[6~` |

| Key | Normal (DECCKM off) | Application (DECCKM on) |
|---|---|---|
| `↑` | `\x1b[A` | `\x1bOA` |
| `↓` | `\x1b[B` | `\x1bOB` |
| `→` | `\x1b[C` | `\x1bOC` |
| `←` | `\x1b[D` | `\x1bOD` |
| `Home` | `\x1b[H` | `\x1bOH` |
| `End` | `\x1b[F` | `\x1bOF` |

Modified cursor keys use `\x1b[1;<m><final>` with
`m = 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)` — e.g. `Ctrl-→` is `\x1b[1;5C`,
`Alt-←` is `\x1b[1;3D`, `Ctrl-Alt-↑` is `\x1b[1;7A`.

Ctrl translation: `a`–`z`/`A`–`Z` → uppercase code `& 0x1f`; `@` and space →
`0x00`; `[` → `0x1b`; `\` → `0x1c`; `]` → `0x1d`; `^` → `0x1e`; `_` → `0x1f`;
`?` → `0x7f`; anything else unchanged. Alt → `\x1b` prefix, composed after Ctrl
(so `Ctrl-Alt-x` is `\x1b` `0x18`).

### 7.2 Automated checks worth writing

The encoding functions are pure and testable without a browser. In the reference
implementation they were extracted straight out of the HTML with a regex and run
in a `vm` context — 47 assertions covering both DECCKM states, the missing-`modes`
fallback, the full Ctrl/Alt character table, the three-state machine, and
paste/emoji pass-through.

A browser pass (Playwright, ~33 assertions) covered what the unit tests can't:

- **Desktop:** `body` has no `.touch`, `#keybar` computes to `display: none` and
  0px height, `--app-h` unset, shell box unchanged.
- **Touch emulation** (`devices['Pixel 7']`): 13 buttons + 3 separators, all
  ≥40×40px, single row, `scrollWidth > clientWidth`, bar below the terminal with
  no overlap and flush to the shell bottom.
- **One tap = one sequence** — real `.tap()`, asserting no duplicate from the
  synthesized click. This is the check that proves §6.4.
- **Modifier state machine** end-to-end in the DOM, including that all three
  visual states differ.

Stub the send path (`RC.target()` returning a recorder) so these run without a
backend.

### 7.3 Manual checks — real hardware only

Emulation cannot produce a software keyboard, so these must be done on a device:

- Android Chrome: keyboard open/close keeps the bar flush above it, cursor row
  always visible, terminal refits both ways.
- iOS Safari: same, plus rotation with the keyboard open and no page-scroll
  drift. **iOS is the one to actually test** — it's the browser the
  `visualViewport` path exists for, and the simulator does not reproduce keyboard
  geometry faithfully.
- Shell: `↑` recalls history, `Tab` completes, `Ctrl`+`c` aborts a `sleep 100`,
  `Ctrl`+`d` at an empty prompt ends the shell.
- TUI: inside `vim`, arrows navigate (this is the DECCKM path) and `Esc` returns
  to normal mode.
- Tap a key while the socket is down: no console error, and input works again
  after reconnect.

---

## 8. Known limitations

- **~53px of vertical space** (about 2–3 rows at 14px/1.3 line-height) is taken
  from the terminal on touch devices. Accepted: rows you can't navigate are worth
  less than two rows you can.
- **No collapse handle.** If the bar proves to be in the way on small phones,
  adding a toggle is straightforward.
- **`touch-action: manipulation`** on the buttons disables double-tap zoom over
  them. Intended.
- **The 40px tap-target minimum and a "bar ≤ 25% of viewport" goal conflict**
  below roughly a 210px-tall visual viewport — i.e. a small phone in landscape
  with the keyboard open. In practice the bar is 53px and satisfies both
  everywhere realistic.
- **`Shift` is not a sticky modifier.** The `\x1b[1;2<final>` encoding is already
  in the table if Shift-arrow selection in TUIs turns out to be wanted.

---

## 9. Reference

Implemented in `frontend/index.html` of
`mbonig/microvm-dev-environment`, PR #2 (`03b7009`). Full artifacts —
proposal, design rationale, requirement specs with WHEN/THEN scenarios, and the
task breakdown — are under `openspec/changes/mobile-key-toolbar/`.
