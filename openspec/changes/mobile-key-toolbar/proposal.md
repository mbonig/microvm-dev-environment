## Why

On phones and tablets the software keyboard has no arrow keys, no Esc, and no
Ctrl — so the terminal is effectively read-only for anything interactive.
Claude Code's own TUI needs arrows and Esc to navigate prompts and interrupt a
run, and ordinary shell work needs Ctrl-C, Ctrl-D, Tab completion, and history
recall. Today none of those are reachable from a mobile browser, which makes the
"run Claude Code from any device" promise fail on exactly the devices that
motivate it.

## What Changes

- Add a **mobile key toolbar**: a horizontal bar of key buttons that appears on
  touch devices only, docked directly above the software keyboard when it is
  open and above the safe-area inset when it is closed.
- The toolbar sends key sequences into the **focused pane's** terminal using the
  same ttyd input path as typed characters, so it works identically across all
  panes and survives reconnects.
- **Sticky modifiers**: `Ctrl` and `Alt` are latching buttons. Tapping one arms
  it (visually highlighted); the next key — whether pressed on the toolbar or
  typed on the software keyboard — is sent with that modifier applied, then the
  modifier disarms. Double-tap latches it until tapped off.
- Key set: `Esc`, `Tab`, `Shift-Tab`, `Ctrl`, `Alt`, `←` `↓` `↑` `→`,
  `Home`, `End`, `PgUp`, `PgDn`. The row scrolls horizontally on narrow screens
  rather than wrapping or shrinking below a tappable size.
- **The terminal is never obscured**: the toolbar occupies layout space that the
  terminal viewport shrinks to accommodate, and panes refit (`FitAddon`) so the
  cursor line stays visible. It does not overlay terminal content.
- The toolbar is hidden entirely on non-touch/desktop browsers — no change to
  the existing desktop experience.

## Capabilities

### New Capabilities

- `mobile-key-toolbar`: On-screen key input for touch devices — visibility
  rules, key-to-byte-sequence mapping, sticky-modifier semantics, target-pane
  routing, and the layout contract that keeps the terminal unobscured.

### Modified Capabilities

<!-- None. openspec/specs/ is empty; no existing requirements change. -->

## Impact

- **Code**: `frontend/index.html` only — new markup for the toolbar, CSS
  (including `visualViewport`-driven positioning and safe-area handling), and
  JS for the key map, sticky-modifier state, and dispatch into
  `focusedPane.terminal`. A small helper is factored out of `Pane.onData` so
  synthetic input reuses the exact same encode-and-send path.
- **APIs / backend**: none. No changes to the token Lambda, the MicroVM image,
  `terminal.js`, or the ttyd wire protocol — the toolbar emits the same bytes a
  physical keyboard would.
- **Dependencies**: none added. No new CDN scripts; xterm.js `input()` and the
  existing WebSocket are sufficient.
- **Deployment**: picked up by the normal `frontend/index.html` S3 upload +
  CloudFront invalidation; no infrastructure change, no `template.yaml` edit.
- **Risk areas**: iOS Safari `visualViewport` behavior with
  `interactive-widget=resizes-content`, and keeping keyboard focus on the
  terminal when a toolbar button is tapped (must not steal focus and dismiss the
  keyboard).
