## 1. API route and CORS

- [x] 1.1 Add a `TerminateVm` API event to `TokenFunction` in `template.yaml`:
      `RestApiId: !Ref TokenApi`, `Path: /vm`, `Method: delete` — inheriting
      `DefaultAuthorizer: CognitoAuthorizer`
- [x] 1.2 Widen `TokenApi`'s `Cors.AllowMethods` to `'GET,DELETE,OPTIONS'`,
      leaving `AddDefaultAuthorizerToCorsPreflight: false` as-is
- [x] 1.3 Widen the Lambda's `Access-Control-Allow-Methods` response header to
      `GET,DELETE,OPTIONS`
- [x] 1.4 Confirm no IAM change is needed — `TokenFunction` already carries
      region-scoped `lambda:*`, which covers `TerminateMicrovm`

## 2. Terminate handler

- [x] 2.1 Add `terminateMvm(mvmId)` calling
      `DELETE /2025-09-09/microvms/{id}` via the existing `sigv4Request`, with
      `body === undefined`
- [x] 2.2 Dispatch on HTTP method at the top of the handler, after the `OPTIONS`
      short-circuit and the `sub` check, so the auth path stays shared
- [x] 2.3 On `DELETE`: read `/remote-claude/users/<sub>/mvm-identifier` and
      terminate it; ignore any identifier supplied in the request
- [x] 2.4 Return 200 with `{ terminated: false }` when no identifier is stored,
      and `{ terminated: true, microvmId }` on success
- [x] 2.5 Treat a 404 from the control plane as success; let other failures fall
      through to the existing 500 error path
- [x] 2.6 Write no SSM parameters on this path — a stale identifier is
      self-healing via `getMvmState` on the next `GET /token`
- [x] 2.7 Log the terminate with the MicroVM id, matching the existing
      `console.log` style

## 3. Frontend: terminated state

- [x] 3.1 Add a module-level `vmTerminated` flag and return early from
      `Pane.scheduleReconnect()` when it is set
- [x] 3.2 Add `enterTerminatedState()`: set the flag, `stopPing()` and clear each
      pane's `reconnectTimer`, close each socket, and set each pane's state to
      disconnected
- [x] 3.3 Clear `authToken`, `mvmEndpoint`, and `tokenExpiresAt`, and cancel
      `refreshTimer`, so no cached credential can redial the dead VM
- [x] 3.4 Add a `Terminated` status (text plus a status class) and make
      `updateStatus()` return it while the flag is set, ahead of the existing
      connected/reconnecting/disconnected branches
- [x] 3.5 Do not call `pane.destroy()` — the pane DOM and ids must survive so the
      layout can be reconnected

## 4. Frontend: controls

- [x] 4.1 Add a terminate button to `#header-actions` next to `⊞ Split`, styled
      as a destructive action and distinguishable from it
- [x] 4.2 Confirm before sending, with wording that names both halves: running
      processes stop, home directory and workspace files are kept
- [x] 4.3 Disable the button and show progress while the request is in flight, so
      a double-click cannot fire two requests
- [x] 4.4 On success call `enterTerminatedState()`; on failure surface the error
      via `showError()` and leave the session alone
- [x] 4.5 Add a **Start new VM** control, shown only in the terminated state
- [x] 4.6 Relaunch clears `vmTerminated`, then runs the existing `start()` path
      so `GET /token` launches a fresh VM and the panes reconnect
- [x] 4.7 Keep the terminate button out of the mobile key toolbar row

## 5. Verification

- [x] 5.1 Extend `frontend/test/browser.mjs`: stub `DELETE /vm`, click terminate,
      assert every socket closed, no reconnect scheduled, no ping traffic, and
      the status reads terminated
- [x] 5.2 Browser test: cancelling the confirmation sends no request and leaves
      sockets open
- [x] 5.3 Browser test: relaunch after terminate re-fetches a token, reconnects
      the same pane ids, and clears the terminated status
- [x] 5.4 Browser test: a failed terminate surfaces an error and does not enter
      the terminated state
- [x] 5.5 Mutation-check the new assertions (`MUTATE=`) — removing the
      `vmTerminated` guard in `scheduleReconnect()` must fail 5.1
      — also checked: not clearing the cached token, and `updateStatus()`
      ignoring the flag; each fails only its own assertions
- [x] 5.6 Confirm the desktop and touch suites still pass unchanged
      — 71 unit + 72 browser + 24 pty, green from both `npm test` and a direct
      run (the pty suite now pins `EDITOR`, which `npm test` sets to `vi`;
      `zsh -f` reads it to choose vi vs emacs keybindings)
- [x] 5.7 Live check against the deployed stack: terminate, confirm the MicroVM
      reaches `TERMINATED` via `aws lambda-microvms get-microvm`, then Start new
      VM and confirm a different MicroVM id is running
- [x] 5.8 Live check: files written under the home directory before terminating
      are present in the new VM
- [x] 5.9 Live check: terminate twice in a row — the second returns 200, not an
      error
      — the second call returns `{terminated:true}` with the same id rather than
      `{terminated:false}`: the SSM parameter still holds it and the control
      plane's DELETE is itself idempotent, so it succeeds instead of 404ing.
      200 either way, which is what the requirement asks for.

Live checks ran against a throwaway Cognito user (`ALLOW_USER_PASSWORD_AUTH`),
not a real account, so no one's home directory was involved in the verification.
12/12 passed; the temp user, its VM, and its SSM parameters were cleaned up.

## 6. Documentation

- [x] 6.1 Note the terminate button and the idle/hard-cap timers it complements
      in the README's usage section
