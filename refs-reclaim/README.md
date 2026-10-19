# refs-reclaim

Reclaim git worktrees, local branches and remote branches safely.

Rule: **prove it can be deleted before deleting it; otherwise leave it alone.**

Pipeline: `plan` (read-only) → `archive` (bundle + verify + sha256) → `apply`
(re-check, then delete).

## Invariants

- Protected names: `dev`, `preprod`, `prod`, `main`.
- A ref may be deleted only if its tip is already in `origin/dev`, or has been
  archived into a verified bundle with a recorded sha256.
- A ref may be deleted only if its own commits are authored by someone in
  `--authors` (`REFS_RECLAIM_AUTHORS`); a branch whose tip author is anyone else is
  `MANUAL`. "Content is in dev" never means "this ref is ours to delete".
- Non-git files in a worktree must be copied to the archive and hashed before
  the worktree is removed.
- Only `origin/*` is used as the baseline; `git fetch --prune` runs first.

## Platform

`plan`/`archive`/`apply` work wherever git does, but the in-use scan reads
`/proc`. On macOS it is unavailable, so `apply` fails closed; `--force-unsafe`
skips that check and is not recommended.

## Classification

- `T1`: safe to delete.
- `T2`: archive first, then delete (`--allow-unmerged-branch` required).
- `PROTECTED` / `MANUAL` / `PRUNE` / `BLOCKED`: do not delete.
- Detached worktrees are always `MANUAL`.
- A branch authored by someone outside `--authors` is `MANUAL` (gate `AU`), even
  when its content is fully merged.

A worktree is also blocked when it has tracked changes, unpushed commits,
unarchived untracked files, an active pane, or recent file changes
(`--idle-hours`, default 2).

## Pipeline

`fetch` → `worktree prune` → classify → archive → remove worktree → delete
branch → delete remote ref → log.

Fail-closed on: fetch failure, bundle verify failure, herdr unreachable,
unreadable `/proc`, failed MR lookup, lease mismatch, non-zero removal,
refused branch delete, or unprovable safety.

## Interfaces

```bash
refs-reclaim plan    --repo <dir> [--idle-hours 2] [--summary-only] [--authors "Ann,Bo"]
refs-reclaim archive --repo <dir> --plan <plan.json> --yes
refs-reclaim apply   --repo <dir> --plan <plan.json> --archive-manifest <archive.json> --yes \
                     [--authors "Ann,Bo"] [--only worktrees] [--only branches]
```

`--authors` takes substrings of `Name <email>`; it is also read from
`REFS_RECLAIM_AUTHORS`. Gate `AU` runs in `plan` (verdict `MANUAL`) and again in
`apply` (row skipped), so a plan made before the allowlist was set is still safe.
`--only` **replaces** the default set; it never adds to it.

pi tool `refs_reclaim` (`action=plan|archive|apply`, `confirm=true` required for
`apply`) and a read-only `/reclaim` command. Load it explicitly with
`-e refs-reclaim/reclaim.ts` plus `--tools …,refs_reclaim`; it is not in the
package manifest.

## Test

```bash
python3 refs-reclaim/test/selftest.py
node    refs-reclaim/test/load.mjs
```

Failures are reported as a failed tool result (pi's `throw`) whose message is one line — what failed plus the next step; the longer explanation stays in this README.
