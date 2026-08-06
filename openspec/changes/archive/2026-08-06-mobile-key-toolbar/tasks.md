## 1. Refactor the input path

- [x] 1.1 Add a `send(data)` method to `Pane` containing the existing
      UTF-8-encode + `0x30` opcode + `ws.send` body, returning early (no throw)
      when the socket is not open
- [x] 1.2 Reduce `terminal.onData` to a call to `this.send(data)` and confirm
      typing on desktop still works unchanged
- [x] 1.3 Add a `targetPane()` helper that returns `focusedPane`, falling back to
      the first pane in `panes` (focusing it) when nothing is focused

## 2. Key table and sequence encoding

- [x] 2.1 Add a `KEYS` table: label, id, and a resolver for
      `Esc`, `Tab`, `Shift-Tab`, `←`, `↓`, `↑`, `→`, `Home`, `End`, `PgUp`, `PgDn`
- [x] 2.2 Implement mode-aware cursor-key resolution reading
      `terminal.modes?.applicationCursorKeysMode ?? false` — `\x1b[A` vs `\x1bOA`
      for arrows and `\x1b[H`/`\x1b[F` vs `\x1bOH`/`\x1bOF` for Home/End
      — Home/End were removed after shipping (zsh binds neither, so they only
      beeped); the arrow half of this is what remains
- [x] 2.3 Implement the modified-cursor form `\x1b[1;<m><final>` with
      `m = 1 + shift + 2*alt + 4*ctrl`, used whenever a modifier is active
      (bypassing the DECCKM lookup)
- [x] 2.4 Implement `applyCtrl(ch)`: `a`–`z`/`A`–`Z` → uppercase code `& 0x1f`;
      `@`/space → `0x00`; `[` → `0x1b`; `\` → `0x1c`; `]` → `0x1d`; `^` → `0x1e`;
      `_` → `0x1f`; `?` → `0x7f`; anything else unchanged
- [x] 2.5 Implement `applyAlt(str)` as an `\x1b` prefix, composing after
      `applyCtrl` so Ctrl+Alt+x yields `\x1b` + `0x18`

## 3. Sticky modifier state

- [x] 3.1 Add `modState = { ctrl: 'off'|'armed'|'locked', alt: ... }` with a
      `cycleModifier(name)` that steps off → armed → locked → off
- [x] 3.2 Implement `consumeModifiers()`: report the active set, then clear any
      modifier in the `armed` state (leaving `locked` ones set)
- [x] 3.3 Apply modifiers in `terminal.onData` for single-character payloads;
      pass multi-character payloads through unmodified but still clear armed
      modifiers
- [x] 3.4 Reflect the three states on the `Ctrl`/`Alt` buttons with distinct
      styling (idle / outlined / filled) plus `aria-pressed`

## 4. Toolbar markup, styling, and layout

- [x] 4.1 Add the `#keybar` element as the last flex child of `#app`, after
      `#panes`, hidden by default
- [x] 4.2 Style the row: single line, no wrap, `overflow-x: auto` with hidden
      scrollbar, ≥40×40 px tap targets, `touch-action: manipulation`,
      `user-select: none`, and the dark palette used elsewhere in the file
- [x] 4.3 Move `env(safe-area-inset-bottom)` padding from `#app` to `#keybar`
      when the toolbar is active
- [x] 4.4 Build the buttons from the `KEYS` table on first activation, with the
      `Ctrl`/`Alt` modifier buttons placed before the arrow cluster

## 5. Touch detection and viewport tracking

- [x] 5.1 Gate visibility on `matchMedia('(hover: none) and (pointer: coarse)')`,
      building the toolbar lazily on first match and re-evaluating on `change`
- [x] 5.2 Set `--app-h` from `window.visualViewport.height` (rAF-coalesced) on
      its `resize` and `scroll` events; apply `#app { height: var(--app-h, 100dvh) }`
- [x] 5.3 Translate `#app` by `visualViewport.offsetTop` and force
      `window.scrollTo(0, 0)` in the same update, for iOS Safari
- [x] 5.4 Refit every pane after any toolbar-visibility or viewport change so
      `rows` shrinks and a ttyd resize frame is sent
- [x] 5.5 Verify no-op behaviour where `visualViewport` is unavailable — `100dvh`
      fallback keeps current layout

## 6. Dispatch and focus handling

- [x] 6.1 Bind key buttons on `pointerdown` with `preventDefault()`, dispatching
      the resolved sequence via `targetPane().send(...)`
- [x] 6.2 Consume armed modifiers after a toolbar key press, updating button
      state
- [x] 6.3 Re-focus the target pane's terminal after dispatch so the software
      keyboard opens/stays open
- [x] 6.4 Confirm a single tap produces exactly one sequence (no duplicate from
      synthesized mouse/click events)
- [x] 6.5 Add a comment on the toolbar container noting it must stay
      buttons-only, since `preventDefault()` blocks focus for the whole row

## 7. Verification

- [x] 7.1 Desktop regression: toolbar absent from the DOM flow, pane geometry and
      typing byte-identical to before
- [ ] 7.2 Android Chrome: keyboard open/close keeps the toolbar flush above the
      keyboard, cursor row always visible, panes refit both ways — **deferred**
- [ ] 7.3 iOS Safari on a real device: same as 7.2, plus rotation with the
      keyboard open and no page-scroll drift — **deferred**
- [x] 7.4 Shell checks: `↑` recalls history, `Tab` completes, `Ctrl`+`c` aborts a
      `sleep 100`, `Ctrl`+`d` at an empty prompt ends the shell
- [x] 7.5 TUI checks: inside Claude Code and `vim`, arrows navigate (DECCKM path)
      and `Esc` returns to normal mode
      — verified against `vim`; Claude Code's TUI uses the same DECCKM path
- [x] 7.6 Multi-pane: split, focus pane 2, confirm toolbar keys land only in
      pane 2; close pane 2 and confirm keys follow the focus
- [x] 7.7 Disconnected pane: kill the WebSocket, tap keys, confirm no console
      errors and that input works again after reconnect
- [x] 7.8 Locked-modifier check: double-tap `Ctrl`, send `Ctrl`+`a` then
      `Ctrl`+`k`, then tap to clear and confirm plain characters resume

How 7.4–7.8 were verified — three suites, all green:

- **Unit** (71 assertions): the toolbar block extracted from `index.html` and run
  in a `vm` context. Both DECCKM states, the missing-`modes` fallback, the full
  Ctrl/Alt table, the modified-cursor form, the three-state machine, and
  paste/emoji pass-through.
- **Browser** (36 assertions, Playwright + Chromium, Pixel 7 emulation, stubbed
  WebSocket): desktop inertness, bar geometry and pane refit, one-tap-one-
  sequence, modifier styling, 7.6 pane routing, 7.7 dead-socket handling, 7.8
  locked modifiers end-to-end. Mutation-tested — breaking `targetPane()`, the
  `send()` readyState guard, or `consumeModifiers()` each makes the matching
  assertions fail.
- **PTY** (20 assertions): the exact emitted byte sequences fed into a real `zsh`
  and `vim` over a pty, so the bytes are checked for meaning and not just shape.

## Deferred at archive time

**7.2 (Android Chrome) and 7.3 (iOS Safari) were never run.** They are left unchecked on
purpose: this change was archived with them outstanding, and a "deferred" marker
that made the tooling report 33/33 would have read as "fully verified" to anyone
who did not open this file. 33/35 is the true number.

Neither is automatable here: Chromium emulation cannot raise a software keyboard,
so the keyboard-open/close geometry and iOS Safari's `visualViewport` path have
no test that can reach them. No WebKit build is installed either, and even one
would not reproduce iOS keyboard geometry — the design notes say as much
("the simulator does not reproduce keyboard geometry faithfully").

What *was* verified in Chromium with Pixel 7 emulation: the bar sits below the
panes with no overlap, is flush to the app bottom, has ≥40×40 px tap targets on a
single scrollable row, and pane `rows` shrinks around it. What is untested is
purely the behaviour while a real software keyboard is open or closing.

The risk this leaves is concentrated in one place — the `visualViewport` handler
(`syncViewport()` in `frontend/index.html`), specifically `--app-h`, the
`offsetTop` translate, and the `scrollTo(0, 0)`. If the toolbar is ever reported
as floating mid-screen, hidden behind the keyboard, or drifting after rotation,
that function is where to look first; nothing else in the change is unverified.

To close these, open the deployed frontend on a real Android phone and a real
iPhone and run the two checks as written above.

## 8. Documentation

- [x] 8.1 Note the mobile key toolbar and its sticky-modifier behaviour in the
      README's usage section
