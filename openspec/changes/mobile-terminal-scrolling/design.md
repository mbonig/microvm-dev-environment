## Context

Same single-file, no-build frontend as `mobile-key-toolbar`: everything lands in
`frontend/index.html` in plain ES2020 against CDN-pinned xterm.js 5.3.

The current touch handling on a pane is two lines:

```js
this.el.addEventListener('click', () => this.focus());
this.el.addEventListener('touchend', (e) => { e.preventDefault(); this.focus(); }, { passive: false });
```

That is the whole story, and it is the bug. `terminal.focus()` focuses xterm's
hidden textarea; xterm positions that textarea at the cursor row so that IME
composition appears in the right place; the browser then scrolls a newly focused
element into view. So the sequence is: drag scrolls the viewport a little via
`.xterm-viewport`'s native scrolling → finger lifts → `touchend` fires →
`focus()` → browser scrolls the textarea (at the cursor, at the bottom) back
into view → the scroll is undone. "Jumps a few lines but ultimately can't work"
is exactly what that produces.

Two further gaps compound it. There is no drag/tap discrimination at all, so
every gesture ends in a focus call. And in the alternate screen buffer there is
no scrollback for `.xterm-viewport` to scroll, so dragging inside `less` or
`vim` does nothing at all — no amount of fixing the snap-back would help there.

Relevant xterm.js 5.3 public API: `scrollLines(amount)`, `scrollToBottom()`,
`onScroll(handler)`, `buffer.active` (with `type`, `viewportY`, `baseY`), and
`buffer.onBufferChange`.

## Goals / Non-Goals

**Goals:**

- Dragging scrolls, reliably, and stays where the finger left it.
- Dragging does something sensible inside full-screen programs.
- Text selection and copy still work on mobile.
- Desktop behavior byte-for-byte unchanged.
- No new dependencies, no backend change.

**Non-Goals:**

- Momentum/inertia scrolling (deliberately excluded — 1:1 tracking plus the
  two-finger fast mode covers the distance problem without a physics loop).
- Pinch-to-zoom font sizing.
- Horizontal scrolling — the terminal reflows to pane width, so there is nothing
  to pan to.
- Making mouse-reporting programs (`htop` clicks, `vim` mouse mode) respond to
  touch as mouse events.
- Changing scrollback size or server-side history.

## Decisions

### 1. Own the gesture; disable native panning on the pane

Set `touch-action: none` on `.pane` under the touch media query and handle
`touchstart`/`touchmove`/`touchend` ourselves, calling `preventDefault()` on
moves we consume. The alternative — leave `.xterm-viewport` to scroll natively
and just remove the bad `focus()` call — is tempting because it is a one-line
fix, but it cannot work in the alternate buffer (no scrollback to scroll), gives
no hook for two-finger fast scrolling, and leaves us at the mercy of xterm's
fake-tall-element viewport, which is what makes the scrolling feel steppy in the
first place. One mechanism we control beats two that fight.

Consequence to accept: `touch-action: none` also disables double-tap zoom on the
pane. That is fine — the pane is a fixed-size terminal, not a document.

### 2. Convert pixels to lines with a carried remainder

`linesDelta = (accumulatedPx / cellHeight) | 0`, then subtract the consumed
`lines * cellHeight` from the accumulator rather than zeroing it. Without the
carry, a slow drag repeatedly discards sub-cell movement and the terminal barely
moves — a second, subtler source of the "jumps a few lines then stops" feel.

Cell height is measured from the DOM (`.xterm-screen` client height divided by
`terminal.rows`) rather than read from xterm internals, and re-measured on
resize. `terminal._core._renderService.dimensions` would be more direct but is
private and would break on a CDN version bump.

### 3. Alternate buffer sends cursor keys

`terminal.buffer.active.type === 'alternate'` selects the branch at gesture
time. In that branch, each line of movement emits one cursor-up or cursor-down
sequence through `pane.send()`, DECCKM-aware via the same resolver
`mobile-key-toolbar` introduces. This is precisely what desktop terminals do for
the wheel in alternate scroll mode, so programs already expect it — no
server-side or terminfo cooperation needed.

Per-move-event key count is capped (~20) so a fast flick cannot emit hundreds of
sequences into the socket in one frame.

### 4. Long-press hands the gesture back

A press that exceeds the tap duration while staying inside the movement
threshold sets the gesture to a `passthrough` state: we stop calling
`preventDefault()` and stop consuming moves for the rest of that touch, letting
xterm's own selection handling take over. Without this, `touch-action: none`
plus `preventDefault()` would make it impossible to select and copy terminal
output on a phone — unacceptable for a tool whose main job is showing you output
you want to keep.

This is the reason gesture classification is a small state machine
(`pending → scrolling | passthrough | tap`) rather than a pair of booleans:
`pending` is a real state, since for the first 400 ms we genuinely do not know
which gesture this is, and we must not commit early in either direction.

### 5. Two-finger drag is a multiplier, not a different gesture

Two fingers use the same pixel→line pipeline with a `FAST_SCROLL_FACTOR`
(start at 8) applied to the line count. Tracking the midpoint of the two touches
means adding or removing a finger mid-gesture shifts the reference point; we
re-baseline the accumulator on any change in touch count so the view does not
jump. One constant, one code path, no separate recognizer.

### 6. Jump-to-bottom is per-pane and focus-neutral

Each pane gets its own absolutely-positioned button, toggled from
`terminal.onScroll` by comparing `buffer.active.viewportY` against
`buffer.active.baseY`, and force-hidden on `buffer.onBufferChange` into the
alternate buffer. Like the key toolbar's buttons it acts on `pointerdown` with
`preventDefault()` so it cannot pull focus off the textarea and drop the
keyboard.

Per-pane rather than one global control because with a split, "scrolled up" is a
property of one pane, and a global button would have to guess which.

### 7. Keep the `click` handler, suppress it after a drag

Desktop still needs `click → focus`. A tap on mobile fires both our `touchend`
tap path and a synthesized `click`; focusing twice is harmless. A *drag* usually
suppresses the synthesized click already, but not reliably across browsers, so a
short-lived `suppressClick` flag set at the end of any non-tap gesture closes
that gap.

## Risks / Trade-offs

- **`touch-action: none` breaks selection if long-press pass-through has a bug**
  → this is the highest-value manual test; verify select-and-copy on both iOS
  Safari and Android Chrome before shipping, not just scrolling.
- **Long-press threshold fights with slow scrolling** — a user who starts a drag
  very slowly could cross 400 ms before 10 px and get pass-through instead of
  scroll → the movement threshold takes precedence: exceeding 10 px at any point
  commits to `scrolling` regardless of elapsed time, and only a gesture still
  inside the threshold at 400 ms becomes `passthrough`.
- **Cell-height measurement can be fractional or stale** → measure lazily per
  gesture start rather than caching across resizes, and guard against a zero or
  `NaN` height by falling back to `fontSize * lineHeight`.
- **Alternate-buffer detection is per-gesture, but the buffer can switch
  mid-gesture** → re-check the branch on every move event rather than latching it
  at `touchstart`.
- **Mouse-reporting programs get no touch equivalent** → accepted and documented;
  a drag inside `htop` scrolls via cursor keys instead of reporting a mouse
  event, which is the more useful of the two on a phone.
- **Overlap with `mobile-key-toolbar`** → both changes edit the same handler
  region and both need the cursor-key resolver. Apply the toolbar change first
  and reuse `Pane.send()` plus its resolver; applying in the other order means
  writing both helpers here and de-duplicating during the second apply.

## Migration Plan

Frontend-only and additive apart from deleting the four-line `touchend` handler.
Deploy is the existing `frontend/index.html` sync to S3 plus a CloudFront
invalidation; rollback is redeploying the previous `index.html`. Desktop is
unchanged by construction, so a bad deploy affects mobile sessions only — and
mobile scrolling is already broken, so the floor is low.

## Open Questions

- Is `FAST_SCROLL_FACTOR = 8` right? It is a guess; tune it on a real device
  against a full 5000-line scrollback and adjust the constant.
- Should the tap-to-focus threshold be time-based at all, or purely
  movement-based? Time is included so a stationary long-press can be
  distinguished for selection; if pass-through proves unreliable in practice,
  dropping the duration threshold and using an explicit selection affordance is
  the fallback.
