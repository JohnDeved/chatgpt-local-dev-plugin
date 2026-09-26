# Native source-file editing

## Why command-based file writing was happening

The connected ChatGPT tool catalogue exposed project read/list and process tools, but no native
file writer or patch action. Inspection of the original `coreTools()` registry confirmed that
`project.write` and `project.edit` did not exist. The server instructions instead preferred optional
downstream semantic tools.

A separate discovery probe of the user's configured Serena server successfully enumerated
`create_text_file`, `replace_content`, symbol replacements and other editing tools. Those actions
were absent from this conversation's exposed connector catalogue even though they were enabled in
the local configuration. This establishes a server/client tool-surface mismatch, not its exact
platform/cache cause. No user configuration or allowlist was changed to bypass it.

Without a usable editing action, the assistant fell back to Python/Node command snippets. That gap
should have been reported earlier instead of hidden behind repeated script-generated changes.
There is no evidence that Local Dev itself minified the files or removed source whitespace. Both
transported source and generated code retain the whitespace supplied by the caller; code layout and
formatting quality remain the caller's responsibility.

The fix supplies editing as native Local Dev tools, independent of Serena, and tells agents to
prefer them for ordinary text changes. Semantic tools remain useful for symbol-aware refactoring
when actually exposed. Builds, tests, asset generators and other real programs still use `dev.run`.

## Tools

### Create a source file

After opening the project in write mode and declaring work with `run.start`/`run.update`, call:

```json
{
  "path": "src/example.ts",
  "content": "export function greet() {\n  return \"Hello\";\n}\n"
}
```

with `project.write`. Pass literal source as the `content` value, not a Python script, shell heredoc,
base64 blob or JSON serialization of the source. The normal MCP argument encoding is sufficient.
Missing regular parent directories are created by default; set `createParents: false` to refuse
that behavior. Existing files are never overwritten without `expectedSha256`.

### Edit an existing file

First call `project.read` with `{ "path": "src/example.ts" }`. It returns:

```text
path, text, bytes, sha256
```

Copy that exact `sha256` into the next request's `expectedSha256`; do not invent a hash. Call
`project.edit` with the path, hash and literal replacements:

```text
path: src/example.ts
expectedSha256: the sha256 returned by project.read
edits:
  - oldText: return "Hello";
    newText: return "Welcome";
```

Each `oldText` must match exactly once, including whitespace. Replacements run sequentially against
the evolving text in memory. All must succeed before the file is published. Empty `newText` deletes
the matched span; empty `oldText` is rejected. Include more context for repeated or ambiguous text.
Dollar signs, backslashes and regex-looking text are literal, not replacement-program syntax.

For a complete-file replacement, use `project.write` with the existing file's current
`expectedSha256` and the full new content. That is appropriate for generated or substantially
rewritten small text files, not a way to ignore a stale-file error.

Both edit/write return a receipt containing `path`, `created`, `changed`, `beforeSha256`, `sha256`
and `bytes`; edit adds `editsApplied`. The new hash can be used for a subsequent edit when the caller
knows the resulting text. Errors explain how to recover. `PROJECT_FILE_CHANGED` means reread;
`PROJECT_EDIT_NOT_FOUND` or `PROJECT_EDIT_AMBIGUOUS` means inspect/refine the matching text. No
partial set of replacements is written on these failures.

## Formatting and limits

These tools do not format, minify, normalize line endings or add a final newline. They preserve
UTF-8 Unicode, BOM, tabs, CRLF/LF, blank lines and the final-newline choice exactly as supplied.
Use the repository's formatter as a separate step when desired. Rewriting a file with badly
formatted content will still produce a badly formatted file; the tool cannot infer code style.

The supported input is a regular UTF-8 text file without NUL bytes, up to **1 MiB of encoded bytes**.
An edit call permits **1–100 replacements**, with combined old/new text capped at **2 MiB** and each
intermediate/final file capped at 1 MiB. Invalid UTF-8, unpaired Unicode surrogates, oversized files,
binary data and nonregular files are rejected, not silently truncated or decoded with replacement
characters. Binary asset generation remains a job for the relevant build or asset tool.

## Safety and concurrency

The actions are marked mutating/destructive, are subject to the existing local approval and declared
work gates, and require the authenticated session's writer lease. They neither enable auto-approval
nor change the permission model. No active project or a read-only/revoked project lease prevents
writing. Session edits are serialized with project switching so two concurrent stale requests cannot
silently overwrite each other.

Write paths must be relative to the active project. Parent traversal, absolute paths, symlink path
components, symlink targets, hard-linked targets and `.git`/`.hg`/`.svn` metadata are rejected.
New content is prepared in a same-directory temporary file, synced and then published without
truncating the existing file. Creation uses a no-clobber link; replacements recheck the observed
file identity/content and use a same-directory rename. Original ordinary permission/executable bits
are preserved. A no-op retains the existing inode.

These checks are cooperative editing safeguards, **not a filesystem sandbox against a malicious
concurrent local process**. Portable Node filesystem APIs do not provide a single atomic
compare-and-swap of content plus parent-directory resolution; an unrelated writer racing the final
check/rename is outside the guarantee. File publication is atomic, not a transaction across multiple
files. New empty parent directories can remain after a failed/cancelled create. ACLs, extended
attributes, ownership changes and power-loss directory durability are not claimed to be preserved.
Cancellation is honored before publication; a completed filesystem commit is not undone or reported
as rolled back because a cancellation arrived afterward.

## Activation and verification

The new native tools are included in `coreTools()` and MCP `tools/list` without any selected
optional server. An old running server or old ChatGPT connector schema does not acquire them from
a source edit alone. Build/install the intended Local Dev revision using the normal owner-controlled
workflow, reconnect the updated runtime, and refresh the Local Dev tool definitions in ChatGPT.
Confirm that `project.write` and `project.edit` appear and `project.read` returns `sha256`.

This change does **not** modify the user's production approval settings, shared Codex registry or
running tunnel. It does not impersonate an undiscovered tool or force a runtime restart. If the
refreshed server advertises actions that the connector still does not expose, report that activation
mismatch separately rather than calling the edit implementation broken.

The regression suite first failed against the original core (both editing tools absent), then
passed the new implementation. It exercises actual stdio MCP create/read/edit calls with no
downstream servers and isolated temporary-home approval configuration. Coverage includes exact
Unicode/line-ending preservation, stale hashes, all-or-none replacements, ambiguous literals,
protected paths, symlinks/hardlinks, byte limits, permissions, cancellation, writer leases and
same-session concurrency. The same implementation was used to write this documentation through
an already authorized development command during bootstrap; that is not a claim that the existing
conversation's tool schema had been hot-reloaded.

Run the repository-wide gate with `npm run check` and the polishing gate with `npm run polish`.
Real ChatGPT/tunnel activation of the new tool names must be checked after the user refreshes the
connection; isolated MCP tests alone are not that evidence. The unfinished Emerald Together battle
work is outside this patch and remains preserved for resumption.

## Recorded validation — 2026-09-26

`npm run polish` completed successfully, including the complete `npm run check` sequence:
163 backend tests, 42 desktop tests, 114 Chromium/WebKit UI checks, the native macOS menu-bar
workflow and the packaged Electrobun production-renderer/RPC smoke test. Twenty new native editing
tests and two new real-MCP workflow/gating tests cover this change.

The first full check encountered a pre-existing, unchanged WebKit live-following test failure.
That test passed five isolated repeats and the final complete check without changing the desktop
UI or weakening its assertions. This result is recorded rather than hiding the first failure.
Fallow's new-only audit passes with no new gated findings; broader inherited complexity/duplication
and advisory repository findings remain. No runtime dependency or tool-approval-policy changes
were needed. The running ChatGPT connector has not been restarted or refreshed by these checks.
