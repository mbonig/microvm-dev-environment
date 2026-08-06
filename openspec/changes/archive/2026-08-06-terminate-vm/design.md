## Context

`functions/token-vend/index.js` is a single 258-line CommonJS handler behind API
Gateway with a Cognito authorizer. It has exactly one route today,
`GET /token`, and one job: find-or-create this user's MicroVM and mint a 55-minute
proxy auth token for it. Per-user state lives in two SSM parameters keyed by the
Cognito `sub`:

```
/remote-claude/users/<sub>/mvm-identifier
/remote-claude/users/<sub>/mvm-endpoint
```

AWS calls go through a hand-rolled `sigv4Request(method, host, path, body)` —
there is no AWS SDK client for the MicroVM control plane in the function, just
`https` plus `crypto`. `TerminateMicrovm` is `DELETE /2025-09-09/microvms/{id}`,
returns 200, and is documented idempotent, so it drops straight into that helper
with `body === undefined`.

Three facts about the existing code shape the whole design:

- **`GET /token` already handles a dead VM.** It reads the stored id, calls
  `getMvmState`, and for anything that is not `RUNNING` or `SUSPENDED` — which
  includes `TERMINATED` and `NOT_FOUND` — it launches a new MicroVM and
  overwrites both parameters. Relaunch is not new code.
- **The function cannot delete SSM parameters.** Its policy grants
  `ssm:PutParameter` and `ssm:GetParameter` plus a read-only policy template.
  There is no `ssm:DeleteParameter`.
- **The frontend caches the token and endpoint in module state.**
  `ensureToken()` returns early while `Date.now() < tokenExpiresAt - 60000`, and
  `Pane.connect()` reads the module-level `authToken`/`mvmEndpoint`. A pane that
  reconnects after a terminate will happily redial the dead endpoint with a
  still-valid token.

## Goals / Non-Goals

**Goals:**

- Stop the VM on demand, in one click plus a confirmation, from any device.
- Terminate strictly the caller's own VM.
- Leave the browser in an honest, quiet state afterwards — no retry storm
  against an endpoint that is gone.
- Get back to a working VM without a page reload.

**Non-Goals:**

- Suspend/resume controls. The idle policy already suspends at 2h and
  `autoResumeEnabled` brings it back; exposing that is a separate question.
- Deleting the user's home, workspace bucket contents, or S3 Files access point.
  Terminate ends compute, not data.
- Cross-tab coordination. A second tab open on the same account will not learn
  about the terminate (see Risks).
- An admin view for terminating *other* users' VMs.
- Changing the idle policy or the 8h cap.

## Decisions

### 1. `DELETE /vm`, not `DELETE /token`

The resource being destroyed is the MicroVM, not the token. `DELETE /token`
would read as "revoke my credential", which is a different and also-plausible
future operation — overloading it now would make that one unaddable. A new path
on the same `AWS::Serverless::Api` inherits `DefaultAuthorizer: CognitoAuthorizer`
with no extra auth wiring, so the cost of a separate route is one `Events` entry.

Same Lambda rather than a second function: it already has the SSM read, the
sigv4 helper, and the `sub`-scoping logic, and a second function would duplicate
all three to save nothing. The handler dispatches on HTTP method.

### 2. The VM id comes from the token, never from the request

The handler ignores any body or path parameter and reads
`/remote-claude/users/<sub>/mvm-identifier` using the `sub` from the
authorizer-verified claims — the same lookup `GET /token` does. There is no
input that could name someone else's MicroVM, so the per-user boundary is
structural rather than a validation step that could be forgotten. This mirrors
how the existing route already works and is the reason no new IAM scoping is
needed.

### 3. Leave the SSM parameters alone

The obvious cleanup — delete both parameters after terminating — would require
adding `ssm:DeleteParameter` to the function's policy. It is also unnecessary:
`GET /token` calls `getMvmState` on the stored id, sees `TERMINATED` (or
`NOT_FOUND` once the record ages out), and launches a fresh VM, overwriting both
parameters on the way. A stale id is self-healing.

So the terminate path performs exactly one write-side effect — the `DELETE` to
the control plane — and the change needs no IAM edit at all. Fewer permissions
for the same behaviour is worth the slightly untidy parameter.

### 4. Missing or already-terminated VM is a success, not an error

If the parameter does not exist, there is nothing to terminate and the caller's
desired end state already holds; return 200 with a flag saying nothing was
running. `TerminateMicrovm` is itself idempotent, so a double-click or a retry
after a network blip also returns 200. The button must never leave the user
staring at an error for a VM that is, in fact, gone.

A 404 from the control plane is treated the same way. Genuine failures (403,
5xx) surface as errors.

### 5. Terminating is a client-side teardown too, driven by an explicit flag

Calling the API is the easy half. Without a teardown, every pane's `onclose`
fires `scheduleReconnect()` and the app dials a dead endpoint with exponential
backoff forever, showing `Reconnecting…` — which reads as a bug and generates
pointless traffic.

A module-level `vmTerminated` flag, checked at the top of `scheduleReconnect()`,
is the mechanism. On terminate the client sets the flag, stops each pane's ping
and reconnect timers, closes each socket, and **clears the cached credential**
(`authToken = null; tokenExpiresAt = 0`) so nothing can redial with it.

Panes are *not* destroyed. Their DOM and ids stay, so **Start new VM** clears the
flag, re-fetches a token — which launches a fresh MicroVM — and reconnects the
same pane layout. Using `pane.destroy()` here would throw away the split layout
the user deliberately set up.

The flag rather than reusing the per-pane `closed` boolean: `closed` means "this
pane was closed by the user, kill its shell", and `closePane` sends a kill
command on that basis. Overloading it would make relaunch have to un-close panes,
and would risk sending session kills to a VM that no longer exists.

### 6. Confirmation names the blast radius, in both directions

`confirm()` — consistent with `closePane`, which already uses it, and no new UI
machinery. The wording has to say both halves, because the scary half is not the
whole truth:

> Terminate the VM? Anything running in it stops immediately. Files in your home
> directory and workspace are kept.

Users who do not know the home is on an S3 Files access point will otherwise
assume terminate means data loss, and never press it — which is the same as not
shipping the feature.

### 7. Header placement, not the mobile key toolbar

The button goes in `#header-actions` beside `⊞ Split`. The key toolbar is
deliberately buttons-only for *terminal keys* and its container calls
`preventDefault()` on `pointerdown` to keep focus on the terminal; a destructive
action sitting in a row of rapid-fire key taps is a mis-tap waiting to happen.
The header is reachable on touch and desktop alike and is where the other
app-level action already lives.

## Risks / Trade-offs

- **A second tab keeps the VM alive.** Tab A terminates; tab B's panes drop,
  reconnect, and its cached token is still valid — but the endpoint is gone, so
  it will spin in backoff until the token expires or the user reloads, at which
  point `GET /token` launches a *new* VM. The terminate still worked; the second
  tab just resurrects one. Accepted for now: cross-tab coordination needs a
  broadcast channel or polling, and the single-tab case is the real one. Worth
  revisiting if it bites.
- **Mis-tap kills a running job.** Mitigated by the confirmation and by header
  placement away from the key row. Not fully preventable, and the same is true
  of the existing per-pane `✕`.
- **Terminate races a `GET /token` in flight.** A token minted microseconds
  before the terminate is useless but harmless — connections fail and the client
  is already in the terminated state, which suppresses reconnects.
- **Idle policy still applies to the replacement VM.** Start new VM launches with
  the same 2h idle / 8h cap. This change adds a manual stop; it does not make
  the automatic one less blunt.
- **`lambda:*` is broader than this needs.** The function could be scoped to the
  specific MicroVM actions, but that is pre-existing and orthogonal; tightening
  it here would mix an unrelated security change into a feature PR.

## Migration Plan

Additive. One new API route, one new Lambda branch, additive frontend markup and
JS. No data migration, no MicroVM image rebuild.

Deploy is `./scripts/deploy.sh --skip-image` — infra must run because
`template.yaml` changes, the Lambda must redeploy, and the frontend syncs as
usual. Rollback is redeploying the previous stack; nothing is written that an
older version cannot read, since the change deliberately writes no new state.

Blast radius on failure is limited to the new button: `GET /token` is untouched,
so a broken terminate leaves normal connect/reconnect exactly as it is today.

## Open Questions

- Should the terminated state survive a reload — i.e. remember "I meant it, do
  not auto-launch" in `localStorage`? Today reloading calls `GET /token` and
  launches a fresh VM, which arguably defeats the point of having just stopped
  one. Deferred: shipping the button first will show whether the reload-relaunch
  is actually annoying in practice.
- Should the header also show *why* the VM is down when it stopped on its own
  (idle timeout vs. user terminate)? Out of scope here, but the terminated
  status text is the natural place for it later.
