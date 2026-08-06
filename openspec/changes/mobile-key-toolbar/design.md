## Context

The frontend is a single hand-written `frontend/index.html` (~800 lines) with no
build step: xterm.js, the fit addon, and `amazon-cognito-identity-js` come from
CDN `<script>` tags, and the file is uploaded verbatim to S3 behind CloudFront.
Whatever we add has to live in that one file, in plain ES2020, with no new
dependencies.

Terminal input already has exactly one exit path — `Pane`'s `terminal.onData`
handler, which UTF-8-encodes the string, prefixes the ttyd input opcode `0x30`
(`'0'`), and writes it to that pane's WebSocket. Panes are tracked in a
`Map` with a module-level `focusedPane`. The page already declares
`interactive-widget=resizes-content` and uses `100dvh` on `#app`, and each pane
has a `ResizeObserver` that calls `fitAddon.fit()`; `terminal.onResize` sends the
ttyd resize frame. That existing plumbing is what makes "don't obscure the
terminal" cheap — we only need to change the box the panes live in.

Constraints worth naming up front:

- The two mobile browsers behave differently when the software keyboard opens.
  Chrome on Android with `interactive-widget=resizes-content` shrinks the layout
  viewport, so `100dvh` already does the right thing. iOS Safari ignores the
  hint: the layout viewport keeps its full height and the keyboard slides over
  it, shifting the *visual* viewport. Only `window.visualViewport` sees that.
- Touching a `<button>` moves DOM focus off xterm's hidden textarea, which
  dismisses the software keyboard. Any toolbar that steals focus is unusable.
- Arrow-key encoding is mode-dependent (DECCKM). Sending the wrong form works in
  bash but breaks inside ncurses/TUI programs — including Claude Code's own UI,
  which is the main thing we're fixing.

## Goals / Non-Goals

**Goals:**

- Make Esc, Ctrl-C/D/R/Z, Tab, and the arrows reachable on a phone.
- Correct sequences in both line-mode shells and full-screen TUIs.
- Zero footprint on desktop: no extra DOM, no layout change, no new listeners
  doing work.
- No new dependencies, no backend change, no protocol change.

**Non-Goals:**

- Function keys F1–F12 (deliberately excluded; can be added later behind an
  overflow row).
- A clipboard/paste button.
- A remappable or user-configurable key set.
- Per-pane modifier state — modifiers are global to the toolbar and apply to
  whichever pane is focused when the key lands.
- Gesture input (swipe-to-arrow) or a full on-screen keyboard replacement.

## Decisions

### 1. Toolbar is a flex sibling of `#panes`, not an overlay

`#app` is already `display:flex; flex-direction:column` with `#panes { flex: 1 }`.
Appending `#keybar` as the last child makes the panes shrink by exactly the
toolbar height, and the existing per-pane `ResizeObserver` refits and sends the
ttyd resize frame with no extra code. The alternative — `position: fixed` with a
`padding-bottom` on the panes — needs the two heights kept in sync by hand and
regresses the moment the row's height changes (font scaling, safe-area, a
second row later). Flex layout makes "never obscures the terminal" structural
rather than something we maintain.

### 2. Visual-viewport driven height, applied as a CSS variable

Set `--app-h` on `:root` from `window.visualViewport.height` and use
`#app { height: var(--app-h, 100dvh) }`, updating on the `resize` and `scroll`
events of `visualViewport` (rAF-coalesced). On iOS this pins the app to the
region above the keyboard; on Android it is a no-op that agrees with `100dvh`.
Also translate `#app` by `visualViewport.offsetTop` and `window.scrollTo(0, 0)`
on those events, because iOS scrolls the page to reveal the focused input.

`100dvh` stays as the fallback so nothing regresses where `visualViewport` is
missing. We deliberately do **not** try to detect keyboard-open as a boolean
(the common "height shrank by >150px" heuristic) — we only ever consume the
height we're given, which is the same code path open or closed.

The bottom safe-area inset moves from `#app` to `#keybar` when the toolbar is
present, so the buttons sit above the home indicator rather than the terminal
having a dead strip below the toolbar.

### 3. Act on `pointerdown` + `preventDefault()`, never on `click`

`preventDefault()` on `pointerdown` stops the browser from moving focus, which
is what keeps the software keyboard open. Since that also suppresses the
subsequent `mousedown`/`click`, the handler fires the key on `pointerdown`
itself — which doubles as better latency. Buttons additionally carry
`touch-action: manipulation` (no double-tap-zoom delay) and
`user-select: none` (no text-selection popover on long press). We use
`pointerdown` rather than `touchstart` so the same handler covers stylus and
hybrid devices without also binding a mouse path we don't want.

The toolbar re-focuses the target pane's terminal after dispatch, so the very
first tap on a fresh page also brings the keyboard up.

### 4. Sequences resolved per-press from `terminal.modes`

xterm.js 5.3 exposes `terminal.modes.applicationCursorKeysMode` as public API.
Reading it at press time yields `\x1bOA` inside a TUI and `\x1b[A` at a shell
prompt, from one table.

Alternatives rejected:

- *Always send `\x1b[A`.* Simplest, but ncurses looks up `kcuu1` = `\EOA` when
  the program has enabled DECCKM, so arrows would silently do nothing in exactly
  the TUI this change exists to fix.
- *Dispatch a synthetic `KeyboardEvent` at xterm's textarea and let xterm encode
  it.* Most "correct" in principle, and would handle every mode for free, but it
  depends on untrusted-event handling and on internal keyCode expectations that
  aren't part of xterm's public contract. Reading one documented mode flag is
  far less to get wrong.

When a modifier is active, arrows/Home/End switch to the CSI parameterised form
`\x1b[1;<m><final>` with `m = 1 + (shift?1:0) + (alt?2:0) + (ctrl?4:0)` — e.g.
Ctrl-→ is `\x1b[1;5C`. That form is unambiguous regardless of DECCKM, so the
mode lookup only applies to the unmodified case.

### 5. One shared `sendKey(pane, str)`; modifier translation lives in `onData`

`Pane` grows a `send(data)` method holding the existing encode-and-write body,
and `terminal.onData` becomes a thin caller. The toolbar calls `pane.send()`
directly for its own keys, so it never re-enters `onData`.

Characters typed on the *software keyboard* arrive through `onData`, so that is
where an armed modifier is consumed: if a modifier is active and the payload is
a single character, translate it (Ctrl → `code & 0x1f` via a small table, Alt →
`\x1b` prefix) and then clear one-shot modifiers. Multi-character payloads
(paste, IME commit) pass through untouched and clear the modifier — mangling
only the first character of a paste would be worse than ignoring the modifier.

This split matters: putting the translation in `onData` is what makes "tap Ctrl,
then type c on the real keyboard" work, which is the single most-used
combination and the one a fixed `^C` button alone would not generalise.

### 6. Three-state modifiers (off / armed / locked)

Single tap arms for one key; a second tap locks; a third clears. Locked mode
exists because `Ctrl-a` `Ctrl-k` style sequences and repeated `Ctrl-n`
navigation are common enough that re-arming every time is painful. Each state
gets a distinct visual treatment (idle, outlined-accent, filled-accent) so the
armed/locked distinction is readable at a glance — an invisible sticky modifier
is a trap.

### 7. Touch detection via media query, not user-agent

`matchMedia('(hover: none) and (pointer: coarse)')` with a `change` listener.
UA sniffing misclassifies iPads (which report desktop Safari) and needs upkeep;
`navigator.maxTouchPoints` alone lights up on touch-enabled laptops where the
toolbar would be pure clutter. The media query answers the question we actually
care about — "is this a finger-first device" — and updates live, which also
makes the feature testable in devtools device mode without a reload.

The toolbar is built lazily on first match and toggled with `display: none`, so
desktop pays nothing beyond one media query.

## Risks / Trade-offs

- **iOS Safari `visualViewport` quirks** (delayed/duplicate resize events, the
  page scrolling under the keyboard) → coalesce updates in `requestAnimationFrame`,
  handle both `resize` and `scroll`, and force `scrollTo(0, 0)`. Verify on a real
  device; the simulator does not reproduce keyboard geometry faithfully.
- **`preventDefault()` on `pointerdown` blocks focus for the whole toolbar** →
  the row must not contain any element that legitimately needs focus. Keeping it
  buttons-only is a standing constraint, worth a code comment.
- **`terminal.modes` is public in xterm 5.3 but the version is CDN-pinned** →
  read it defensively (`terminal.modes?.applicationCursorKeysMode ?? false`) so a
  version bump degrades to normal-mode sequences instead of throwing.
- **Every pane refit sends a ttyd resize frame** → keyboard open/close will
  reflow running TUIs. That is correct behaviour (the visible area really did
  change) but it will repaint; the rAF coalescing keeps it to one frame per
  transition rather than a burst.
- **Sticky modifiers are a mode, and modes get lost** → mitigated by the
  three-state visual indicator and by clearing one-shot modifiers on the very
  next input event of any kind, so a stale armed `Ctrl` can't survive unnoticed.
- **Toolbar height reduces terminal rows on small phones** → a ~48 px row costs
  roughly 2–3 rows at the current 14 px/1.3 line-height. Accepted: unusable rows
  you can't navigate are worth less than two rows you can.

## Migration Plan

Additive and frontend-only. Deploy is the existing `frontend/index.html` sync to
S3 plus a CloudFront invalidation — no `template.yaml` change, no MicroVM image
rebuild, no Lambda redeploy. Rollback is redeploying the previous
`index.html`. Desktop behaviour is unchanged by construction, so the blast
radius is mobile sessions only, and a bad deploy leaves mobile exactly where it
is today rather than worse.

## Open Questions

- Should the toolbar be dismissible (a collapse handle) for users who want the
  extra rows back on a small phone? Deferred — ship it always-on, add a toggle
  only if the row proves to be in the way.
- Is `Shift` worth adding as a third sticky modifier for Shift-arrow selection
  in TUIs? Left out for now; the `\x1b[1;2<final>` encoding is already in the
  table if we want it.
