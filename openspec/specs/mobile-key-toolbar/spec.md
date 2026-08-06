# mobile-key-toolbar

On-screen key input for touch devices: visibility rules, key-to-byte-sequence
mapping, sticky-modifier semantics, target-pane routing, and the layout
contract that keeps the terminal unobscured.

> The keyboard-tracking requirement below is **unverified on real hardware** —
> tasks 7.2 (Android Chrome) and 7.3 (iOS Safari) were deferred when this
> change was archived, because no available emulator can raise a software
> keyboard. See `openspec/changes/archive/2026-08-06-mobile-key-toolbar/tasks.md`.

### Requirement: Touch-only visibility

The mobile key toolbar SHALL be rendered only on touch-primary devices, and
SHALL be absent from the layout — not merely transparent or off-screen — on
pointer-primary (desktop) browsers. Detection SHALL use the
`(hover: none) and (pointer: coarse)` media query and SHALL react to live
changes (e.g. a tablet gaining a trackpad, or a device-mode toggle in devtools).

#### Scenario: Phone or tablet browser

- **WHEN** the app loads in a browser where `(hover: none) and (pointer: coarse)` matches
- **THEN** the key toolbar is visible at the bottom of the app shell

#### Scenario: Desktop browser

- **WHEN** the app loads in a browser with a mouse or trackpad
- **THEN** the key toolbar is not displayed and consumes no vertical space
- **AND** the terminal panes occupy exactly the same area as before this change

#### Scenario: Pointer capability changes at runtime

- **WHEN** the media query result flips while the app is open
- **THEN** the toolbar appears or disappears accordingly
- **AND** every pane refits so no terminal rows are left hidden or unused

### Requirement: Terminal is never obscured

The toolbar SHALL occupy dedicated layout space below the terminal panes rather
than overlaying them. No terminal cell, and in particular no cursor row, may sit
beneath the toolbar at any time.

#### Scenario: Toolbar shown

- **WHEN** the toolbar becomes visible
- **THEN** the panes container shrinks by the toolbar's height
- **AND** each pane's `FitAddon` refits so `rows` reflects the reduced height
- **AND** a resize frame is sent to the server for each connected pane

#### Scenario: Output fills the screen

- **WHEN** a command prints enough output to fill the terminal
- **THEN** the last line and the cursor remain fully visible above the toolbar

### Requirement: Toolbar tracks the software keyboard

The toolbar SHALL remain directly above the software keyboard while the keyboard
is open, and directly above the bottom safe-area inset while it is closed, on
both browsers that resize the layout viewport for the keyboard (Chrome Android
with `interactive-widget=resizes-content`) and browsers that do not (iOS Safari).

#### Scenario: Keyboard opens

- **WHEN** the software keyboard opens
- **THEN** the app shell is constrained to the visual viewport height
- **AND** the toolbar renders immediately above the keyboard with no gap and no overlap
- **AND** the panes refit to the remaining space

#### Scenario: Keyboard closes

- **WHEN** the software keyboard is dismissed
- **THEN** the toolbar settles above the bottom safe-area inset
- **AND** the panes refit to reclaim the freed space

#### Scenario: Device rotation with keyboard open

- **WHEN** the device is rotated while the keyboard is open
- **THEN** the toolbar and panes re-lay-out to the new visual viewport without
  the toolbar being left off-screen or floating mid-screen

### Requirement: Input routes to the focused pane

Every key emitted by the toolbar SHALL be delivered to the currently focused
pane's terminal over that pane's WebSocket, using the same encoding path as
characters typed on a physical keyboard.

#### Scenario: Multiple panes open

- **WHEN** two panes are open, pane B is focused, and a toolbar key is tapped
- **THEN** the key sequence is written to pane B's socket only
- **AND** pane A receives nothing

#### Scenario: No pane focused

- **WHEN** no pane is currently focused and a toolbar key is tapped
- **THEN** the key is routed to the first pane and that pane becomes focused

#### Scenario: Focused pane is disconnected

- **WHEN** the focused pane's WebSocket is not open and a toolbar key is tapped
- **THEN** the key is discarded without throwing
- **AND** the toolbar remains usable once the pane reconnects

### Requirement: Toolbar taps do not dismiss the keyboard

Tapping a toolbar button SHALL NOT move DOM focus away from the terminal's
input element, so the software keyboard stays open across repeated presses.

#### Scenario: Repeated arrow presses

- **WHEN** the user taps `↑` several times with the keyboard open
- **THEN** the keyboard remains open for the whole sequence
- **AND** each tap sends one key sequence — no duplicates from synthesized
  mouse/click events following the touch

### Requirement: Base key set and sequences

The toolbar SHALL provide `Esc`, `Tab`, `Shift-Tab`, `Ctrl`, `Alt`, `←`, `↓`,
`↑`, `→`, `PgUp`, and `PgDn`, and SHALL emit these unmodified sequences:

`Home` and `End` were removed after shipping: zsh, the VM's login shell, binds
no sequence for either, so both keys only beeped at the prompt. The encoding was
correct — a physical `Home` key is equally dead there — but a button that does
nothing is worse than an absent one. `Ctrl`+`a` / `Ctrl`+`e` cover the need.

| Key | Bytes |
| --- | --- |
| `Esc` | `\x1b` |
| `Tab` | `\x09` |
| `Shift-Tab` | `\x1b[Z` |
| `PgUp` | `\x1b[5~` |
| `PgDn` | `\x1b[6~` |

#### Scenario: Escape interrupts a Claude Code prompt

- **WHEN** the user taps `Esc`
- **THEN** a single `0x1b` byte is sent to the focused pane

#### Scenario: Tab completion

- **WHEN** the user taps `Tab` at a shell prompt
- **THEN** a single `0x09` byte is sent and the shell attempts completion

#### Scenario: Reverse field navigation

- **WHEN** the user taps `Shift-Tab`
- **THEN** `\x1b[Z` is sent

### Requirement: Cursor keys respect application cursor mode

Arrow sequences SHALL be selected from the focused
terminal's DECCKM state (`terminal.modes.applicationCursorKeysMode`) at the
moment of the press, so full-screen programs receive the sequences their
terminfo expects.

| Key | Normal mode | Application cursor mode |
| --- | --- | --- |
| `↑` | `\x1b[A` | `\x1bOA` |
| `↓` | `\x1b[B` | `\x1bOB` |
| `→` | `\x1b[C` | `\x1bOC` |
| `←` | `\x1b[D` | `\x1bOD` |

#### Scenario: History recall at a shell prompt

- **WHEN** DECCKM is off and the user taps `↑`
- **THEN** `\x1b[A` is sent and the shell recalls the previous command

#### Scenario: Navigating inside a full-screen program

- **WHEN** a program has enabled application cursor keys mode and the user taps `↑`
- **THEN** `\x1bOA` is sent and the program's cursor moves up

### Requirement: Sticky Ctrl and Alt modifiers

`Ctrl` and `Alt` SHALL be latching buttons with three states — off, armed
(one-shot), and locked. A tap while off arms the modifier; a tap while armed
locks it; a tap while armed-or-locked in the locked state turns it off. An armed
modifier SHALL apply to exactly the next key and then return to off. A locked
modifier SHALL apply to every key until it is turned off. The current state
SHALL be visually distinguishable for each of the three states. `Ctrl` and `Alt`
SHALL be independently settable and combinable.

#### Scenario: Interrupting a running command

- **WHEN** the user taps `Ctrl` and then types `c` on the software keyboard
- **THEN** byte `0x03` is sent to the focused pane
- **AND** the `Ctrl` button returns to the off state

#### Scenario: Ctrl applied to a toolbar key

- **WHEN** the user taps `Ctrl` and then taps `→`
- **THEN** `\x1b[1;5C` is sent (word-right)

#### Scenario: Locking Ctrl for a sequence

- **WHEN** the user double-taps `Ctrl` and then types `a`, `k`
- **THEN** `0x01` and `0x0b` are both sent
- **AND** `Ctrl` remains locked until tapped again

#### Scenario: Disarming without using it

- **WHEN** the user taps `Ctrl` twice to lock it and once more to clear it, then types `c`
- **THEN** a plain `c` character is sent

#### Scenario: Combined modifiers

- **WHEN** both `Ctrl` and `Alt` are armed and the user types `x`
- **THEN** `\x1b` followed by `0x18` is sent
- **AND** both modifiers return to off

### Requirement: Ctrl and Alt translation of printable characters

When a modifier is active and a printable character arrives — from the software
keyboard or otherwise — the character SHALL be translated before it is sent:

- `Ctrl` + `a`–`z` / `A`–`Z` → the character's uppercase code point AND `0x1f`
- `Ctrl` + `@` or space → `0x00`; `[` → `0x1b`; `\` → `0x1c`; `]` → `0x1d`;
  `^` → `0x1e`; `_` → `0x1f`; `?` → `0x7f`
- `Ctrl` + any other character → the character unchanged
- `Alt` + character → `\x1b` followed by the character

#### Scenario: End-of-input

- **WHEN** `Ctrl` is armed and the user types `d`
- **THEN** byte `0x04` is sent

#### Scenario: Alt-prefixed word deletion

- **WHEN** `Alt` is armed and the user types `b`
- **THEN** `\x1b` followed by `b` is sent

#### Scenario: Ctrl with a character that has no control code

- **WHEN** `Ctrl` is armed and the user types `1`
- **THEN** `1` is sent unchanged and the modifier returns to off

#### Scenario: Multi-character input while a modifier is armed

- **WHEN** a modifier is armed and a paste or IME commit delivers more than one
  character at once
- **THEN** the text is sent unmodified and the modifier is cleared, rather than
  mangling the first character

### Requirement: Layout of the key row

The key row SHALL lay out on one line without wrapping, with tap targets of at
least 40×40 CSS pixels, and SHALL scroll horizontally when the keys exceed the
viewport width rather than shrinking the buttons or wrapping to a second row.
The toolbar's own height SHALL NOT exceed 25% of the visual viewport height.

#### Scenario: Narrow phone in portrait

- **WHEN** the app is opened on a 360 px-wide viewport
- **THEN** all keys stay on one row at full tap-target size
- **AND** the row scrolls horizontally to reach keys past the right edge

#### Scenario: Wide tablet in landscape

- **WHEN** the viewport is wide enough for every key
- **THEN** the full key set is visible with no horizontal scrolling
