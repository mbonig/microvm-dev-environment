## 1. Remove the snap-back and prepare the pane

- [ ] 1.1 Delete the `touchend` handler at `frontend/index.html:489-492` that
      calls `preventDefault()` + `this.focus()` unconditionally
- [ ] 1.2 Keep the `click` → `focus()` handler for desktop, gated by a
      `suppressClick` flag that any non-tap gesture sets
- [ ] 1.3 Add `touch-action: none` to `.pane` under the touch media query, and
      hide `.xterm-viewport`'s scrollbar so there is one visible scroll mechanism
- [ ] 1.4 Add a `cellHeight()` helper measuring `.xterm-screen` client height ÷
      `terminal.rows`, falling back to `fontSize * lineHeight` on a zero/`NaN`
      result

## 2. Gesture state machine

- [ ] 2.1 Add per-pane gesture state: `phase` (`idle`/`pending`/`scrolling`/
      `passthrough`), start point, start time, touch count, and a pixel accumulator
- [ ] 2.2 On `touchstart`, reset state to `pending` and record the touch midpoint,
      timestamp, and finger count
- [ ] 2.3 On `touchmove`, promote `pending` → `scrolling` once movement exceeds
      the 10 px threshold (movement wins over elapsed time), and `preventDefault()`
      only while in `scrolling`
- [ ] 2.4 Promote `pending` → `passthrough` at 400 ms with movement still under
      threshold; consume nothing and call no `preventDefault()` for the rest of
      that gesture
- [ ] 2.5 On `touchend` from `pending` under both thresholds, treat as a tap:
      focus the pane
- [ ] 2.6 On `touchend` from `scrolling` or `passthrough`, set `suppressClick`
      and do not change focus
- [ ] 2.7 Re-baseline the accumulator and reference point whenever the touch
      count changes mid-gesture

## 3. Scrolling the normal buffer

- [ ] 3.1 Accumulate vertical pixel delta per move event; ignore gestures whose
      movement is predominantly horizontal
- [ ] 3.2 Convert to lines as `(accum / cellHeight) | 0`, subtracting only the
      consumed `lines * cellHeight` so the sub-cell remainder carries forward
- [ ] 3.3 Apply `FAST_SCROLL_FACTOR` (start at 8) to the line count when two or
      more touches are active
- [ ] 3.4 Call `terminal.scrollLines(-lines)` so content follows the finger, and
      confirm clamping at the top and bottom of scrollback is graceful

## 4. Alternate-buffer cursor keys

- [ ] 4.1 Re-check `terminal.buffer.active.type === 'alternate'` on every move
      event rather than latching it at gesture start
- [ ] 4.2 In the alternate branch, emit one cursor-up/down sequence per line of
      movement via `pane.send()`, using the DECCKM-aware resolver from
      `mobile-key-toolbar` (or a local equivalent if that change is not applied yet)
- [ ] 4.3 Cap sequences emitted per move event at ~20 to avoid flooding the socket
- [ ] 4.4 Verify the branch flips back cleanly when the full-screen program exits

## 5. Jump-to-bottom control

- [ ] 5.1 Add a per-pane absolutely-positioned button, hidden by default, styled
      to match the existing pane chrome
- [ ] 5.2 Toggle visibility from `terminal.onScroll` by comparing
      `buffer.active.viewportY` with `buffer.active.baseY`
- [ ] 5.3 Force-hide it on `buffer.onBufferChange` into the alternate buffer, and
      re-evaluate on the way back
- [ ] 5.4 Bind on `pointerdown` with `preventDefault()` and call
      `terminal.scrollToBottom()` without touching focus
- [ ] 5.5 Confirm it does not overlap or interfere with the existing `.pane-close`
      button when multiple panes are open

## 6. Verification

- [ ] 6.1 Desktop regression: wheel scrolling, click-to-focus, and click-drag
      text selection all behave exactly as before
- [ ] 6.2 Android Chrome: drag back through a long scrollback, confirm the view
      stays put after lifting the finger — no snap-back to the prompt
- [ ] 6.3 iOS Safari on a real device: same as 6.2, plus no rubber-band or
      double-speed movement from a competing native scroll
- [ ] 6.4 Slow-drag test: move under one cell height per frame and confirm
      scrolling still accumulates with nothing lost
- [ ] 6.5 Two-finger drag crosses a full 5000-line scrollback in a few gestures;
      tune `FAST_SCROLL_FACTOR` on-device and record the final value
- [ ] 6.6 Finger-count change mid-drag causes no positional jump
- [ ] 6.7 Long-press then drag selects text and reaches the copy popover on both
      iOS Safari and Android Chrome
- [ ] 6.8 `less` on a long file and `vim`: dragging scrolls via cursor keys in
      both DECCKM states
- [ ] 6.9 Jump-to-bottom appears only when scrolled up, returns to the prompt,
      keeps the keyboard open, and stays hidden in a full-screen program
- [ ] 6.10 Scroll up during a long-running command: position holds while output
      arrives, and typing snaps to the bottom
- [ ] 6.11 Multi-pane: drag on the unfocused pane scrolls it without stealing
      focus from the other

## 7. Documentation

- [ ] 7.1 Note mobile scroll gestures — one-finger drag, two-finger fast scroll,
      long-press to select — in the README's usage section
