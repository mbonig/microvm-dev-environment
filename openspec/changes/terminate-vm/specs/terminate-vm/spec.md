## ADDED Requirements

### Requirement: Authorized terminate route

The token API SHALL expose a `DELETE /vm` route that terminates the calling
user's MicroVM. The route SHALL require the same Cognito authorization as
`GET /token`, and SHALL be handled by the existing `token-vend` function.

#### Scenario: Authenticated request

- **WHEN** a signed-in user calls `DELETE /vm` with a valid ID token
- **THEN** their MicroVM is terminated
- **AND** the response is 200

#### Scenario: Unauthenticated request

- **WHEN** `DELETE /vm` is called without a valid token
- **THEN** the request is rejected by the authorizer before the function runs

#### Scenario: CORS preflight

- **WHEN** the browser sends `OPTIONS /vm` before the delete
- **THEN** the preflight succeeds without a token
- **AND** the allowed methods include `DELETE`

### Requirement: Termination is scoped to the calling user

The MicroVM to terminate SHALL be identified solely by the `sub` claim from the
authorizer-verified token, read from
`/remote-claude/users/<sub>/mvm-identifier`. The handler SHALL NOT accept a
MicroVM identifier from the request path, query, or body.

#### Scenario: Two users with running VMs

- **WHEN** user A calls `DELETE /vm`
- **THEN** only user A's MicroVM is terminated
- **AND** user B's MicroVM continues running

#### Scenario: Request attempts to name a VM

- **WHEN** a request body or query parameter contains another user's MicroVM id
- **THEN** it is ignored and the caller's own MicroVM is the one terminated

### Requirement: Terminate is idempotent

A terminate request SHALL succeed when there is nothing to terminate, so that
repeat clicks, retries, and an already-stopped VM all reach the same end state
without surfacing an error.

#### Scenario: No VM has ever been launched

- **WHEN** the user has no stored MicroVM identifier and calls `DELETE /vm`
- **THEN** the response is 200
- **AND** the response indicates that nothing was running

#### Scenario: VM already terminated

- **WHEN** the stored MicroVM is already terminated or no longer exists
- **THEN** the response is 200 rather than an error

#### Scenario: Control plane rejects the call

- **WHEN** the terminate call fails for a reason other than the VM being absent
- **THEN** the response is an error
- **AND** the client surfaces it instead of claiming success

### Requirement: A subsequent token request launches a fresh VM

After termination, the next `GET /token` SHALL launch a new MicroVM for the user
and return a token and endpoint for it, without requiring any manual cleanup of
stored state.

#### Scenario: Start a new VM after terminating

- **WHEN** the user terminates and then requests a token
- **THEN** a new MicroVM is launched
- **AND** the stored identifier and endpoint are updated to the new VM

#### Scenario: Persistent data survives

- **WHEN** a new MicroVM is launched after a terminate
- **THEN** the user's home directory and workspace contents are still present

### Requirement: Terminate control in the app header

The app SHALL present a terminate control in the header action area, alongside
the split control. The control SHALL require an explicit confirmation before
sending the request, and the confirmation SHALL state both that running
processes stop and that files in the home directory and workspace are kept.

#### Scenario: User confirms

- **WHEN** the user activates the control and confirms
- **THEN** the terminate request is sent

#### Scenario: User cancels

- **WHEN** the user activates the control and dismisses the confirmation
- **THEN** no request is sent
- **AND** the session continues untouched

#### Scenario: Touch device

- **WHEN** the app is used on a phone or tablet
- **THEN** the terminate control is reachable from the header
- **AND** it is not placed in the mobile key toolbar row

### Requirement: Terminated state stops all reconnect activity

On a successful terminate the client SHALL enter a terminated state in which no
pane attempts to reconnect, no keepalive traffic is sent, and the cached auth
token and endpoint are discarded so nothing can redial the terminated VM.

#### Scenario: Sockets close after terminate

- **WHEN** the terminate succeeds
- **THEN** every pane's WebSocket is closed
- **AND** no pane schedules a reconnect
- **AND** no keepalive pings are sent

#### Scenario: Status reflects the terminated VM

- **WHEN** the client is in the terminated state
- **THEN** the status reads as terminated rather than reconnecting or
  disconnected

#### Scenario: Cached credential is not reused

- **WHEN** the client is in the terminated state and the previously issued token
  has not yet expired
- **THEN** no connection is attempted with it

### Requirement: Relaunch without a page reload

While in the terminated state the app SHALL offer a control that launches a new
MicroVM and restores the existing pane layout, without requiring the user to
reload the page.

#### Scenario: Start a new VM

- **WHEN** the user activates the relaunch control
- **THEN** a fresh token is fetched, which launches a new MicroVM
- **AND** the terminated state is cleared so panes may reconnect
- **AND** the warm-up status is shown while the VM boots

#### Scenario: Pane layout is preserved

- **WHEN** the user had split into multiple panes before terminating
- **THEN** the same panes are present after relaunching
- **AND** each reconnects to the new VM

#### Scenario: Relaunch fails

- **WHEN** the token request fails during relaunch
- **THEN** the error is surfaced
- **AND** the app remains in a state the user can retry from
