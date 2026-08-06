# frontend tests

Verification suites for `frontend/index.html`. There is no build step — these
read the shipped file directly, so they can never drift from what deploys.

```bash
cd frontend/test
npm install && npx playwright install chromium   # first time only
npm test
```

`ptycheck.py` additionally needs `zsh`, `vim`, and `bash` on `$PATH`.

## The three suites

| File | Runs in | Checks |
|---|---|---|
| `unit.mjs` | node `vm` | The toolbar's pure logic, extracted from `index.html` between the `── Mobile key toolbar` and `── Visibility-change` markers. Both DECCKM states, the missing-`modes` fallback, the Ctrl/Alt character table, the modified-cursor form, the three-state modifier machine, paste/emoji pass-through. |
| `browser.mjs` | Playwright + Chromium | The real page, with the WebSocket and Cognito stubbed. Desktop inertness, bar geometry and pane refit, one-tap-one-sequence, modifier styling, multi-pane routing, dead-socket handling, locked modifiers end-to-end. |
| `ptycheck.py` | real pty | The emitted byte sequences fed into real `zsh` and `vim`, so the bytes are checked for *meaning* and not just shape: history recall, completion, `Ctrl-C` on a `sleep 100`, `Ctrl-D`, arrows under DECCKM, `Esc` back to normal mode. |

The split matters: `browser.mjs` proves the toolbar emits a given sequence,
`ptycheck.py` proves that sequence does the intended thing on the other end.
Neither alone is enough.

## Mutation testing

`browser.mjs` takes a `MUTATE='find=>replace'` env var that patches `index.html`
as it is served, so you can confirm an assertion actually bites:

```bash
MUTATE='if (focusedPane && !focusedPane.closed) return focusedPane;=>' npm run test:browser
# → the multi-pane routing assertions fail, as they should
```

It errors out if the search string isn't found, so a stale mutation can't
silently pass.

## What these cannot cover

Chromium emulation has no software keyboard, so the keyboard open/close
behaviour and iOS Safari's `visualViewport` path still need a real device. See
tasks 7.2 and 7.3 in `openspec/changes/mobile-key-toolbar/tasks.md`.
