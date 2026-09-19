# Project-lease provider and runtime integration

This draft implements the provider in the **Local Dev repository**, not in
Populous New Dawn. `ProjectLeases` and `LeaseStorage` require an explicit absolute
registry directory. Constructing either object does not access the filesystem.
All new lifecycle tests inject a disposable registry inside a temporary home.
The running plugin, real `~/.local-dev` registry, Application Support, tunnel,
approval preferences and Worker6 edits are not changed by this draft.

## Current delivery boundary

The production server injects one provider rooted at
`~/.local-dev/project-leases`, derives session identity in the trusted dispatcher,
and keeps active project generations per authenticated session. `project.open`
supports explicit read/write mode and exact source identity constraints;
`project.read`, `project.files`, `project.release`, `project.forceRelease`, and
`project.handoff` expose the bounded lifecycle. Commands, diffs, file reads,
setup hooks, and retained background children are pinned to their exact generation.

The live stdio acceptance cases use disposable homes and registry directories.
They cover concurrent readers, writer exclusion, scoped release, transactional
switching, stale-generation fencing, cooperative force-release, and independent
runtime handoff. This source integration is not an installed deployment.

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
mode, session and random generation. Callers receive their session identity from
the trusted transport dispatcher; tool schemas do not accept an arbitrary
owner/runtime ID or a caller-authored success Boolean.

Read leases coexist. Writers fence the canonical Git worktree root, so sibling
package directories cannot own independent writers; separate worktrees remain
independent. Non-Git scopes use ordinary canonical path overlap. Symlinks canonicalize to the same scope.
A provisional lease protects selection; it cannot authorize reads/writes or mint
release receipts. The previous generation and handoff ID are bound at reservation,
and commit is single-use. Abort leaves old ownership intact. Side-effecting setup
hooks require a separately authenticated committed operation; the runtime never
executes them under a bare provisional lease. Reads validate HEAD;
writers may intentionally change it but cannot silently change the directory inode.

A live idle lease may expire. A confirmed dead runtime's idle leases, including an uncommitted reservation with
no authorized work, can be reconciled without waiting for TTL. Active write operations and recorded background work are quarantined instead of being guessed dead.
This is intentional: the provider does **not** claim that a dead parent proves
its writer children are gone. The runtime records each owned background PID and
clears it only after the process manager observes exit.

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
pair and the runtime calls it only after the process manager confirms that owned
child's exit; it is not exposed as a caller-supplied proof tool.

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

The production acceptance tests exercise the actual stdio server separately and
prove the native tool boundary with independent processes. PR125/126/127 actual
checkouts have not been opened by this source test. Earlier Worker3 matrix and
previous denied attempts remain history, not results of this implementation.

## Review status and remaining candidate defect

Independent review of the first candidate rejected six state-machine/integrity
issues. The current source adds bound reservation arguments, single-use commit,
unique operation tokens, per-operation background records, missing-state failure,
Git-worktree writer fencing, dead-idle pending recovery and terminal close. The
follow-up pending-previous edge is guarded in both reservation and commit and has
a regression test. Independent review of this integrated head is still required
before deployment.

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

A correct delivery must keep the complete call boundary, read-only file operations,
process pinning, independent handoff verification and original approval/steering
gates. Do not deploy until all real-client assertions, repository checks and
independent review pass. Publish this stacked PR before any deployment. Installation later must use
only the supported repository installer and explicitly authorized runtime
reconnect, not direct writes to the live registry or Application Support.
