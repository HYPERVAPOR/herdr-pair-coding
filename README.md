# pi-dev-bundle

A **worker–reviewer pair-coding** setup for [pi](https://pi.dev) on top of
[herdr](https://herdr.dev).

Two agents work the same task in two panes: the **worker** writes, the
**reviewer** reads and pushes back. This bundle is the glue that makes that
pair behave like a team instead of two chat windows: a watchdog that notices
silence, a way for the reviewer to read the worker's answer, and a cleanup path
for the worktrees the pair leaves behind.

These extensions are not a grab bag. They exist because two agents in two panes
need things a single agent does not.

## Two layers

| Layer | Purpose | Pieces |
|---|---|---|
| Pair-coding | run two agents as worker + reviewer | `herdr-watchdog`, `herdr-last-answer`, `refs-reclaim`, example profiles |
| Daily driver | make one pi session nicer | `tools`, `copy-code`, `keepctx` |

The daily-driver tools work without herdr. The pair-coding layer does not: it
reads panes, sends keystrokes and finds worktrees through herdr.

## The loop

```text
worker pane                          reviewer pane
  writes code  ───────────────────▶   reads the answer      herdr-last-answer
       ▲                                    │
       │                                    ▼
       └──────── nudge / interrupt ────  watchdog             herdr-watchdog
                                            │
                           each side works in its own worktree
                                            │
                           finished worktrees are archived
                           and removed                       refs-reclaim
```

- `herdr-last-answer` gives the reviewer the worker's plain answer text, with no
  TUI footer and no pane-width re-wrapping.
- `herdr-watchdog` checks every 20 s whether the pair is still moving, and
  nudges or interrupts the right pane when it is not. `hb_block` lets the
  reviewer say "we are talking to a human, don't nudge us".
- `refs-reclaim` is the cleanup step. Parallel agents leave worktrees and
  branches everywhere; this proves a ref is safe to delete before deleting it.
- `examples/profiles/` holds a worker and a reviewer profile. Each mounts only
  the tools that role needs.

## Requirements

- pi and Node 22.19+
- [herdr](https://herdr.dev) for the pair-coding layer
- `python3` for `herdr-last-answer`, `herdr-watchdog`, `refs-reclaim`
- `git` for `refs-reclaim`; `glab` optional (merge-request state)

## Setup

The low-friction path is to let your agent do it. Paste this into pi, Claude
Code, Codex, or any agent that can read a URL and run shell commands:

> Help me set up pi-dev-bundle: https://raw.githubusercontent.com/HYPERVAPOR/pi-dev-bundle/main/skills/pi-dev-bundle/SKILL.md

That file is a skill: it explains the model, checks what is already installed,
and walks through pi, herdr, the bundle, the profiles and the watchdog. Read it
yourself first if you prefer.

Manual:

```bash
# 1. pi + herdr
curl -fsSL https://pi.dev/install.sh | sh
curl -fsSL https://herdr.dev/install.sh | sh
herdr integration install pi    # writes ~/.pi/agent/extensions/herdr-agent-state.ts

# 2. this bundle
pi install git:github.com/HYPERVAPOR/pi-dev-bundle

# 3. profiles: copy the examples, then edit paths and rule files
mkdir -p ~/.pi/agent/profiles
cp examples/profiles/*.conf ~/.pi/agent/profiles/
```

Start the watchdog in a pane, or as a systemd user service:

```bash
herdr-watchdog daemon
```

## What's inside

| Extension | Surface | Context cost | Requires |
|---|---|---|---|
| [`keepctx`](extensions/keepctx.ts) | `/keepctx` | 0 | pi |
| [`tools`](extensions/tools.ts) | `/tools` | 0 | pi |
| [`copy-code`](copy-code/README.md) | `/copy-code`, `alt+c` | 0 | pi |
| [`deepseek-search`](extensions/deepseek-search.ts) | `web_search` tool | tool schema | DeepSeek API key |
| [`herdr-last-answer`](herdr-last-answer/README.md) | `last_answer` tool | tool schema | herdr, Python 3 |
| [`herdr-watchdog`](herdr-watchdog/README.md) | `hb_block` tool + watchdog daemon | tool schema + background process | herdr, Python 3 |
| [`refs-reclaim`](refs-reclaim/README.md) | `refs_reclaim` tool, `/reclaim`, CLI | tool schema | git, Python 3 |

### keepctx

Compacts the conversation with a fixed brevity instruction: keep background,
current state, facts, goals and this pane's role; drop the reasoning in
between. Keeps long sessions from drifting.

### tools

`/tools` lists which tools are currently declared to the model (`✓`) and which
are registered but not active (`·`), including where each one came from. pi has
no built-in equivalent. Useful when a tool you expected is missing.

### copy-code

Copies the raw source of any earlier assistant code block to the clipboard.
This matters because the TUI wraps rendered lines to the pane width, so
mouse-selection gives you re-wrapped text with broken indentation. Blocks get
stable, increasing IDs; `/copy-code` opens a fuzzy picker (a plain number
matches an ID exactly).

### deepseek-search

A single `web_search` tool backed by the DeepSeek Search API, auth from pi's
credential store. Replaces multi-tool web packages that keep several schemas
resident.

### herdr-last-answer

Reads the plain answer text from another herdr pane, without the TUI footer and
without pane-width truncation. Thin shell over the `herdr-last-answer` script;
the script is the only implementation. The tool name stays `last_answer` so the
model-facing contract is stable.

### herdr-watchdog

A heartbeat watchdog for paired agents in herdr. Every 20 seconds it checks
whether a `worker`/`reviewer` pair has gone quiet, and if so nudges or
interrupts the right pane. Agents can declare "don't disturb us" through the
`hb_block` tool while running long tasks.

### refs-reclaim

A fail-closed pipeline for reclaiming git worktrees, local branches and remote
branches: `plan` (read-only classification) → `archive` (bundle + verify +
copy non-git files + sha256 manifest) → `apply` (re-check, then delete). A ref
is only removed if its tip is already contained in `origin/dev` or has been
archived and verified. Remote deletions use an expected-sha lease.

## Enabling the tool extensions

Four extensions register model-facing tools. Installing the bundle does not
mount them; load the ones you need. A git package is cloned to
`~/.pi/agent/git/github.com/HYPERVAPOR/pi-dev-bundle`, so `-e` points there.

One-line install (the whole bundle):

```bash
pi install git:github.com/HYPERVAPOR/pi-dev-bundle
```

Then mount a tool where you need it, either in a profile or in a one-off run:

```bash
PKG=~/.pi/agent/git/github.com/HYPERVAPOR/pi-dev-bundle

# deepseek-search: needs a DeepSeek key (/login deepseek)
pi -e "$PKG/extensions/deepseek-search.ts"

# herdr-last-answer: needs herdr + python3
pi -e "$PKG/herdr-last-answer/last_answer.ts" \
   --tools read,write,edit,ls,bash,last_answer

# herdr-watchdog: needs herdr + python3; also run the daemon (see its README)
pi -e "$PKG/herdr-watchdog/hb_block.ts" \
   --tools read,write,edit,ls,bash,hb_block

# refs-reclaim: needs git + python3; glab optional
pi -e "$PKG/refs-reclaim/reclaim.ts" \
   --tools read,write,edit,ls,bash,refs_reclaim
```

- In a profile, keep the `-e` and `--tools` lines and drop the leading `pi`.
- `--tools` is a whitelist: when you pass it, the tool's name must be listed or
  the model will not see it. Without `--tools`, a loaded tool is active by
  default.
- `herdr-watchdog` also needs the daemon for heartbeat messages
  (`herdr-watchdog daemon`, or the systemd unit in its README). The `hb_block`
  tool alone only writes the flag.

To load only these four through package filtering instead:

```json
{
  "packages": [
    {
      "source": "git:github.com/HYPERVAPOR/pi-dev-bundle",
      "extensions": [
        "extensions/deepseek-search.ts",
        "herdr-last-answer/last_answer.ts",
        "herdr-watchdog/hb_block.ts",
        "refs-reclaim/reclaim.ts"
      ]
    }
  ]
}
```

Profiles that run `-ne` disable package-loaded extensions, so they still need
explicit `-e` paths.

## Does installing this bloat the context?

No. `pi install git:...` clones the repository (about 350 KB on disk), but
loading is decided separately:

- Command-only extensions (`keepctx`, `tools`, `copy-code`) register **no
  tools**, so they add **0 tokens** to every request.
- Tool extensions (`deepseek-search`, `last_answer`, `hb_block`,
  `refs_reclaim`) add a tool schema, and only when they are loaded.
- Anything you do not list under `extensions` is never loaded: no tool, no
  command, no context cost.

To load only one, list only that file:

```json
{
  "packages": [
    {
      "source": "git:github.com/HYPERVAPOR/pi-dev-bundle",
      "extensions": ["extensions/copy-code.ts"]
    }
  ]
}
```

The unused files are still on disk because pi installs a git package as one
repository. If you also want them off disk, the bundle would need to be split
into one package per extension; that is not the case today.

## Safety notes

- `refs-reclaim` is read-only until you explicitly run `archive`/`apply`, and
  `apply` requires both `confirm=true` and `--yes`. Anything it cannot prove
  safe is left alone.
- `herdr-watchdog` only reads state and sends messages; it does not edit files.
- Extensions run with your user's permissions. Read the source before
  installing anything from a package.

## License

MIT
