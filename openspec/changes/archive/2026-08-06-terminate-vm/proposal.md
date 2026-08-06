## Why

There is no way to stop your MicroVM. The only paths to a stopped VM today are
the idle policy — `maxIdleDurationSeconds: 7200`, so two hours after the last
*inbound* proxy traffic — or the eight-hour `maximumDurationInSeconds` hard cap.
Closing the tab starts that two-hour clock but nothing else; the VM keeps running
and keeps costing money the whole time.

That is the wrong default for the cases where you know you are done: finishing
for the day, or wanting a clean VM after wedging the current one. Both currently
mean waiting out a timer you can see but cannot touch. The control-plane
operation already exists (`TerminateMicrovm`) and the token Lambda already holds
the IAM permission to call it — there is simply nothing wired to it.

## What Changes

- Add a **Terminate VM** button to the app header, next to `⊞ Split`, behind a
  confirmation that names what is lost (running processes) and what is not
  (files under the persistent home).
- Add a **`DELETE /vm`** route to the existing token API, on the same Cognito
  authorizer, handled by the same `token-vend` Lambda. It terminates the calling
  user's MicroVM and only that user's — the id comes from the verified `sub`
  claim, never from the request.
- After a successful terminate the UI **stays down until the user acts**:
  reconnect loops stop, sockets close, the status reads `Terminated`, and a
  **Start new VM** button appears. Nothing relaunches on its own.
- `GET /token` needs no change — it already treats a `TERMINATED` MicroVM as
  "launch a fresh one", so **Start new VM** is the existing cold-start path.

## Capabilities

### New Capabilities

- `terminate-vm`: On-demand MicroVM termination — the authorized API route, the
  per-user scoping rule, the confirmation and post-terminate UI state, and the
  teardown contract that stops reconnect traffic against a dead endpoint.

### Modified Capabilities

<!-- None. openspec/specs/ is empty; no existing requirements change. -->

## Impact

- **Code**: `functions/token-vend/index.js` (method dispatch + a terminate
  handler), `frontend/index.html` (button, confirmation, teardown, terminated
  state, relaunch).
- **APIs / backend**: one new route, `DELETE /vm`, on the existing `TokenApi`.
  The Lambda's CORS `Access-Control-Allow-Methods` gains `DELETE`, as does the
  API's `Cors.AllowMethods`.
- **IAM**: none. `TokenFunction` already carries region-scoped `lambda:*`, which
  covers `TerminateMicrovm`. Notably the change is designed to avoid needing
  `ssm:DeleteParameter`, which the function does *not* have — see the design.
- **Dependencies**: none added.
- **Deployment**: a full `./scripts/deploy.sh` run — this touches
  `template.yaml` and the Lambda, so the frontend-only
  `--skip-infra --skip-image --skip-mvm` path is not sufficient. The MicroVM
  image is unchanged, so `--skip-image` remains valid.
- **Risk areas**: leaving panes retrying against a terminated endpoint; a second
  browser tab that did not observe the terminate; and the destructiveness of the
  action itself — a mis-tap must not silently kill a running job.
