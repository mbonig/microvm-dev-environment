## ADDED Requirements

### Requirement: Tap and drag are distinguished

A touch on a pane SHALL be classified as a tap or a drag. A tap SHALL focus that
pane's terminal (raising the software keyboard); a drag SHALL scroll and SHALL
NOT change focus. Classification SHALL use a movement threshold of 10 CSS pixels
and a duration threshold of 400 ms: a gesture that stays within the movement
threshold and ends within the duration threshold is a tap, otherwise it is a
drag.

#### Scenario: Tap to focus

- **WHEN** the user taps a pane without moving their finger
- **THEN** that pane's terminal receives focus and the software keyboard opens

#### Scenario: Drag does not focus

- **WHEN** the user drags vertically across a pane and lifts their finger
- **THEN** focus does not change
- **AND** the viewport stays where the drag left it — it does not snap back to
  the cursor row

#### Scenario: Drag on an unfocused pane

- **WHEN** two panes are open, pane A is focused, and the user drags on pane B
- **THEN** pane B scrolls
- **AND** pane A remains the focused pane

#### Scenario: No duplicate action from emulated mouse events

- **WHEN** a drag completes and the browser emits a synthesized `click`
- **THEN** the click is suppressed and does not focus the pane

### Requirement: One-finger drag scrolls the normal buffer

While the normal (non-alternate) buffer is active, a one-finger vertical drag
SHALL scroll the terminal's scrollback in the direction of the finger, tracking
it approximately 1:1. Pixel movement SHALL be converted to lines using the
terminal's measured cell height, and the sub-cell remainder SHALL be carried
across move events so that slow drags scroll smoothly instead of stepping.

#### Scenario: Dragging down reveals earlier output

- **WHEN** the user drags one finger downward
- **THEN** the view scrolls back toward earlier output, moving with the finger

#### Scenario: Dragging up returns toward the prompt

- **WHEN** the user drags one finger upward
- **THEN** the view scrolls toward more recent output

#### Scenario: Slow drag

- **WHEN** the user drags slowly by less than one cell height per frame
- **THEN** the accumulated movement still produces scrolling once it exceeds one
  cell, with no movement lost

#### Scenario: Drag past the top of scrollback

- **WHEN** the user keeps dragging after reaching the oldest line in scrollback
- **THEN** scrolling stops at the top without error or visual glitch

#### Scenario: Horizontal drag

- **WHEN** the user drags predominantly horizontally
- **THEN** the terminal does not scroll vertically

### Requirement: Two-finger drag scrolls fast

A two-finger vertical drag SHALL scroll in the same direction as a one-finger
drag but by a large multiple of the distance, so that long scrollback can be
crossed in a few gestures. The multiplier SHALL be a single named constant.

#### Scenario: Crossing long scrollback

- **WHEN** the user drags two fingers downward across the pane
- **THEN** the view scrolls back by many screens, not by the dragged number of lines

#### Scenario: Finger count changes mid-gesture

- **WHEN** a second finger touches down during a one-finger drag, or lifts during
  a two-finger drag
- **THEN** the gesture continues without a positional jump — the new finger
  count takes effect from that point forward

### Requirement: Drag drives cursor keys in the alternate buffer

When the alternate screen buffer is active there is no scrollback, so a vertical
drag SHALL instead send cursor up/down key sequences to the pane — one key per
line of equivalent movement, in the direction that moves the program's view the
same way the finger moves. Sequences SHALL respect the terminal's application
cursor keys mode (DECCKM), and the number of keys sent per move event SHALL be
capped to avoid flooding the connection.

#### Scenario: Scrolling in less

- **WHEN** `less` is running and the user drags one finger downward
- **THEN** cursor-up sequences are sent and `less` scrolls back through the file

#### Scenario: Application cursor keys mode

- **WHEN** the running program has enabled DECCKM and a drag would send cursor-up
- **THEN** `\x1bOA` is sent rather than `\x1b[A`

#### Scenario: Fast drag is rate-limited

- **WHEN** a single move event represents more lines than the per-event cap
- **THEN** at most the cap's worth of key sequences is sent for that event

#### Scenario: Returning to the normal buffer

- **WHEN** the full-screen program exits and the normal buffer becomes active
- **THEN** dragging scrolls scrollback again, with no leftover key-sending behavior

### Requirement: Long-press preserves text selection

A press held beyond the tap duration without exceeding the movement threshold
SHALL hand the gesture back to xterm and the browser, so that native text
selection and the copy popover remain available.

#### Scenario: Selecting output to copy

- **WHEN** the user presses and holds on terminal text, then drags to extend
- **THEN** the terminal does not scroll
- **AND** text selection occurs and the copy popover is reachable

#### Scenario: Long-press does not scroll afterwards

- **WHEN** a long-press has handed off the gesture
- **THEN** no scroll or cursor-key output is produced for the remainder of that
  gesture

### Requirement: Single scroll mechanism

On touch devices the pane SHALL opt out of browser-native panning so that
`.xterm-viewport`'s own scrolling does not compete with the gesture handler. On
pointer-primary devices the pane's behavior SHALL be unchanged, including mouse
wheel scrolling and click-drag selection.

#### Scenario: No competing scroll

- **WHEN** the user drags on a pane on a touch device
- **THEN** exactly one scroll occurs — the gesture handler's — with no rubber-band
  or double-speed movement from the browser also scrolling the viewport

#### Scenario: Desktop unaffected

- **WHEN** the app is used with a mouse
- **THEN** wheel scrolling, click-to-focus, and click-drag text selection behave
  exactly as before this change

### Requirement: Jump-to-bottom control

Each pane SHALL show a floating control while, and only while, that pane is
scrolled away from the bottom of its scrollback. Tapping it SHALL scroll that
pane to the bottom. The control SHALL NOT take focus from the terminal, and
SHALL NOT be shown while the alternate buffer is active.

#### Scenario: Appears when scrolled up

- **WHEN** the user scrolls a pane back through its scrollback
- **THEN** the jump-to-bottom control becomes visible in that pane only

#### Scenario: Returns to the prompt

- **WHEN** the user taps the control
- **THEN** the pane scrolls to the bottom and the control hides

#### Scenario: Hidden at the bottom

- **WHEN** the pane is already at the bottom of its scrollback
- **THEN** the control is not visible

#### Scenario: Does not dismiss the keyboard

- **WHEN** the software keyboard is open and the user taps the control
- **THEN** the keyboard stays open and terminal focus is unchanged

#### Scenario: Hidden in a full-screen program

- **WHEN** the alternate screen buffer is active
- **THEN** the control is not shown, since there is no scrollback to return from

### Requirement: Live output does not disrupt reading

Scrolled-up position SHALL be preserved while new output arrives, so that reading
back through output is not interrupted by a running command.

#### Scenario: Output arrives while scrolled up

- **WHEN** the pane is scrolled up and the server sends new output
- **THEN** the view stays where the user left it
- **AND** the jump-to-bottom control remains visible

#### Scenario: Typing returns to the prompt

- **WHEN** the pane is scrolled up and the user types a character
- **THEN** the view scrolls to the bottom so the prompt and the typed character
  are visible
