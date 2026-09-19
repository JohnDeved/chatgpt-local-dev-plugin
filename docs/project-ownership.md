# Injected project-lease provider (not activated)

This draft implements the provider in the **Local Dev repository**, not in
Populous New Dawn. `ProjectLeases` and `LeaseStorage` require an explicit absolute
registry directory. Constructing either object does not access the filesystem.
All new lifecycle tests inject a disposable registry inside a temporary home.
The running plugin, real `~/.local-dev` registry, Application Support, tunnel,
approval preferences and Worker6 edits are not changed by this draft.

## Current delivery boundary

The live `CoreRuntime`/dispatcher integration was platform-safety-blocked before
its source patch executed. It was not retried or routed through another tool.
Consequently **the new provider is not instantiated by the production server**,
its project/read/release tools are not exposed, and the live ownership acceptance
contract remains failing. This is useful source/test work preserved as a draft,
not a finished Local Dev access fix. Do not install or deploy it as one.

`test/ownership.integration.test.mjs` deliberately retains the requested real
stdio acceptance assertions. The current server rejects `mode: read` and lacks
the release/handoff APIs, so four cases fail. The tests are not skipped or
weakened to make the repository gate green.

## Cooperative provider design

The injected registry is owner-private. A Darwin kernel `O_EXLOCK` on one permanent
transaction inode serializes processes. Closing its file descriptor, including
normal OS cleanup after process exit, releases the mutex. No lock file is deleted
to reclaim ownership and force-release sends no process signals.

State updates use a versioned, strictly validated record and an HMAC authenticated
with an owner-private registry key. Loss of initialized state fails closed; HMAC
is not hardware rollback protection against the same OS user restoring a complete
old signed snapshot. A lost key with existing state fails closed.
Symlinked/nonprivate state files are rejected. This is a same-user cooperative
integrity boundary, **not** a sandbox against arbitrary code running as that OS
user. Nothing in this module changes Local Dev or platform approval policy.

Each provider has a server-generated runtime generation, PID and process start
stamp. A kernel-held runtime marker supplies liveness independently of PID reuse.
Leases bind a canonical real path, filesystem device/inode, optional Git HEAD,
mode, session and random generation. Callers must receive their session identity
from the trusted transport dispatcher; future tool schemas must not accept an
arbitrary owner/runtime ID or a caller-authored success Boolean.

Read leases coexist. Writers fence the canonical Git worktree root, so sibling
package directories cannot own independent writers; separate worktrees remain
independent. Non-Git scopes use ordinary canonical path overlap. Symlinks canonicalize to the same scope.
A provisional lease protects selection; it cannot authorize reads/writes or mint
release receipts. The previous generation and handoff ID are bound at reservation,
and commit is single-use. Abort leaves old ownership intact. Side-effecting setup
hooks require a separately authenticated committed operation; the blocked runtime
integration must not execute them under a bare provisional lease. Reads validate HEAD;
writers may intentionally change it but cannot silently change the directory inode.

A live idle lease may expire. A confirmed dead runtime's idle leases, including an uncommitted reservation with
no authorized work, can be reconciled without waiting for TTL. Active write operations and recorded background work are quarantined instead of being guessed dead.
This is intentional: the provider does **not** claim that a dead parent proves
its writer children are gone. Runtime integration must feed authenticated process
lifecycle observations before that limitation can be closed.

Scoped release requires the current runtime/session generation and no active work.
It returns `relinquished: true, released: false` plus an expiring handoff ID. A new
independent owner must atomically acquire the exact source identity using that
handoff ID. The acquiring runtime must differ, not merely its session name. Only then can
`handoff()` return `released: true`; a source reacquisition
or HEAD/inode change invalidates it. A neutral path alone is never release proof.

`forceRelease` checks canonical path, exact generation, a nonempty reason and actual
reclaimability. It audits the request and outcome, refuses active work, and cannot
release a later replacement generation. It does not terminate processes or delete
registry lock files.

Each access returns a unique operation ID; completion consumes it exactly once.
Background records retain their originating operation/PID and cannot be cleared by
another completion. The internal `backgroundExited` observer requires the exact
pair; future runtime integration must call it only after independently confirming
that owned child's exit, never expose it as a caller-supplied proof tool.

Provider `close()` is terminal and waits for in-flight provider transactions before
closing its kernel marker. Closed instances cannot create or continue ownership.

## Proven and unproven behavior

`test/project-leases.test.mjs` starts real independent Node client processes against
one injected directory. It verifies concurrent readers/excluded writer, source to
evidence switching and independent acquisition, voluntary dead-owner exit,
concurrent-writer exclusion, idle fencing, audited force-release, active-operation
protection, path aliases, HEAD mismatch and authenticated-state tampering. Each
client exits cooperatively or voluntarily; tests do not signal another process.
Raw request/result records can be captured with `OWNERSHIP_TEST_RECEIPTS` pointing
to a test-only output directory.

These provider tests are **not** successful live MCP reviewer bindings. The
production acceptance tests exercise the actual stdio server separately and remain
red until the blocked dispatcher work is safely completed. PR125/126/127 actual
checkouts have not been opened by the new provider. Earlier Worker3 matrix and
previous denied attempts remain history, not results of this implementation.

## Review status and remaining candidate defect

Independent review of the first candidate rejected six state-machine/integrity
issues. The current source adds bound reservation arguments, single-use commit,
unique operation tokens, per-operation background records, missing-state failure,
Git-worktree writer fencing, dead-idle pending recovery and terminal close. Fourteen
targeted provider tests pass, but this is not independent acceptance of the new head.

A remaining pending-previous edge was identified during follow-up: `reserve` and
`commit` still accept an uncommitted prior generation as `previous`, so switching
can call the internal removal path for a provisional record. The source guard and
regression edit for that edge were platform-safety-blocked before application.
The denied edit was not retried or rerouted. Keep the candidate rejected/draft and
**do not deploy** until this path is corrected and independently re-reviewed. A
passing tested subset is not a license to suppress that known gap.

## Cooperative EOF repair

The existing SDK stdio transport does not forward input EOF into `server.onclose`.
A small independent server change sends `process.stdin`'s `end` event through the
existing owned `close()` lifecycle. This avoids orphaning future test servers on
ordinary client disconnect; it introduces no new process-kill path.

The first baseline harness exposed this defect and its enclosing Python timeout
terminated the direct harness parent; eight old test servers and their test worker
were left idle. They are listed in the retained failure receipt and were not
arbitrarily killed. Subsequent tests with the source EOF repair exit cooperatively.
Do not claim that newer cleanup receipts also cleaned that older baseline.

## Commands and deployment gate

Run `npm run check` exactly as required by AGENTS. A failing live acceptance is an
honest failing gate, not permission to bypass it. Targeted provider tests are:

```sh
npm run build
node --test test/project-leases.test.mjs
node --test test/ownership.integration.test.mjs
```

A correct future runtime integration must cover the complete call boundary,
per-session downstream state, read-only file operations, process pinning, independent
handoff verification and original approval/steering gates. Do not deploy until
that work, all real-client assertions, repository checks and independent review
pass. Publish this draft PR before any deployment. Installation later must use
only the supported repository installer and explicitly authorized runtime
reconnect, not direct writes to the live registry or Application Support.
