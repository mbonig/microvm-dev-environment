## Why

Scrolling back through terminal output is broken on mobile. Dragging moves the
view a few lines and then snaps back to the prompt, so reaching anything that
scrolled off screen is effectively impossible — which matters most on the device
where the screen is smallest.

The snap-back has a concrete cause: `frontend/index.html:489` registers a
`touchend` handler on the whole pane that calls `this.focus()` unconditionally,
including at the end of a scroll drag. `terminal.focus()` focuses xterm's hidden
textarea, which xterm parks at the cursor row, and the browser then scrolls that
focused element back into view. On top of that there is no tap-vs-drag
discrimination, and inside full-screen programs (`less`, `vim`, `htop`) there is
no scrollback at all, so dragging does nothing whatsoever.

## What Changes

- Replace the pane's unconditional `touchend` → `focus()` with a **gesture
  recognizer** that distinguishes a tap from a drag. Only a tap focuses the
  terminal and raises the keyboard; a drag never does.
- **One-finger vertical drag scrolls the terminal 1:1 with the finger.** Pixel
  deltas are converted to lines using the measured cell height, with the
  sub-cell remainder carried across move events so tracking is smooth rather
  than stepping.
- **Two-finger vertical drag scrolls fast**, covering many screens per drag, for
  crossing long scrollback quickly.
- **Alternate-screen buffer**: when a full-screen program is running there is no
  scrollback, so a drag is translated into cursor up/down key sequences instead
  — the same thing desktop terminals do with the mouse wheel in alternate scroll
  mode — making `less`, `vim`, and `htop` respond to dragging.
- **Jump-to-bottom button**: a small floating control appears in a pane only
  while that pane is scrolled up, snapping back to the live prompt in one tap.
- **Long-press falls through**: a press held without movement hands the gesture
  back to xterm/the browser so text selection and the native copy popover still
  work — the terminal is for reading output, and copying it must survive.
- The pane opts out of browser-native panning (`touch-action`) on touch devices
  so there is exactly one scroll mechanism instead of ours competing with
  `.xterm-viewport`'s.

## Capabilities

### New Capabilities

- `mobile-terminal-scrolling`: Touch gesture handling for terminal panes — tap
  vs. drag discrimination, drag-to-scroll in the normal buffer, drag-to-cursor-keys
  in the alternate buffer, fast two-finger scrolling, long-press pass-through for
  selection, and the scrolled-up jump-to-bottom affordance.

### Modified Capabilities

<!-- None. openspec/specs/ is empty; no existing requirements change. -->

## Impact

- **Code**: `frontend/index.html` only. The `touchend` handler at
  `frontend/index.html:489-492` is removed and replaced; new gesture state and
  handlers are added to `Pane`, plus a per-pane jump-to-bottom button and its
  `terminal.onScroll` / buffer-change wiring.
- **APIs / backend**: none. Scrollback lives client-side in xterm.js; the
  alternate-buffer path reuses the existing ttyd input channel.
- **Dependencies**: none added. Uses xterm.js public API — `scrollLines`,
  `scrollToBottom`, `onScroll`, `buffer.active`, `buffer.onBufferChange`.
- **Relationship to `mobile-key-toolbar`**: both changes touch the pane's touch
  handling and both need DECCKM-aware cursor-key encoding. Apply
  `mobile-key-toolbar` first; this change then reuses its `Pane.send()` helper
  and cursor-key resolver instead of duplicating them. Applying this one first
  is possible but means writing those two pieces here and reconciling later.
- **Risk areas**: suppressing browser-native touch panning without also
  suppressing text selection; correctly detecting the alternate buffer; and
  keeping the jump-to-bottom button from stealing focus and dismissing the
  keyboard.
