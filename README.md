# pi-dev-bundle

A small collection of extensions for [pi](https://pi.dev) that make long
terminal coding-agent sessions easier to live in.

Everything here is built around one rule: **do not tax every request.**

- Slash commands register **no tools**, so they add **0 tokens** to the model
  context. They cost nothing until you type them.
- Model-facing tools are **opt-in** and meant to be mounted per profile, so you
  only pay for the tools a given role actually needs.

## Install

```bash
pi install git:github.com/HYPERVAPOR/pi-dev-bundle
```

That loads every extension in `package.json`. If you only want the zero-token
commands, add this to `~/.pi/agent/settings.json` instead (object form narrows
which resources load):

```json
{
  "packages": [
    {
      "source": "git:github.com/HYPERVAPOR/pi-dev-bundle",
      "extensions": [
        "extensions/keepctx.ts",
        "extensions/tools.ts",
        "extensions/copy-code.ts"
      ]
    }
  ]
}
```

### Does installing this bloat the context?

No. `pi install git:...` clones the repository (about 350 KB on disk), but
loading is decided separately:

- Command-only extensions (`keepctx`, `tools`, `copy-code`) register **no
  tools**, so they add **0 tokens** to every request.
- Tool extensions (`deepseek-search`, `last-answer`, `hb_block`,
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

## What's inside

| Extension | Surface | Context cost | Requires |
|---|---|---|---|
| [`keepctx`](extensions/keepctx.ts) | `/keepctx` | 0 | pi |
| [`tools`](extensions/tools.ts) | `/tools` | 0 | pi |
| [`copy-code`](copy-code/README.md) | `/copy-code`, `alt+c` | 0 | pi |
| [`deepseek-search`](extensions/deepseek-search.ts) | `web_search` tool | tool schema | DeepSeek API key |
| [`last-answer`](last-answer/README.md) | `last_answer` tool | tool schema | herdr, Python 3 |
| [`herdr-watchdog`](herdr-watchdog/README.md) | `hb_block` tool + watchdog daemon | tool schema + background process | herdr, Python 3 |
| [`refs-reclaim`](refs-reclaim/README.md) | `refs_reclaim` tool, `/reclaim`, CLI | tool schema | git, Python 3; `glab` optional |

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

# last-answer: needs herdr + python3
pi -e "$PKG/last-answer/last_answer.ts" \
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
        "last-answer/last_answer.ts",
        "herdr-watchdog/hb_block.ts",
        "refs-reclaim/reclaim.ts"
      ]
    }
  ]
}
```

Profiles that run `-ne` disable package-loaded extensions, so they still need
explicit `-e` paths.

### keepctx

Compacts the conversation with a fixed brevity instruction: keep background,
current state, facts, goals and this pane's role; drop the reasoning in
between. Keeps long sessions from drifting.

### tools

`/tools` lists which tools are currently declared to the model (`✓`) and which
are registered but not active (`·`), including where each one came from. pi has
no built-in equivalent.

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

### last-answer

Reads the plain answer text from another herdr pane, without the TUI footer and
without pane-width truncation. Thin shell over the `last-answer` script; the
script is the only implementation.

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

## Requirements

- `node` (pi provides the host packages)
- `python3` for `last-answer`, `herdr-watchdog`, `refs-reclaim`
- [`herdr`](https://herdr.dev) for the herdr-specific tools
- `glab` optional, only for checking merge-request state in `refs-reclaim`

## Safety notes

- `refs-reclaim` is read-only until you explicitly run `archive`/`apply`, and
  `apply` requires both `confirm=true` and `--yes`. Anything it cannot prove
  safe is left alone.
- `herdr-watchdog` only reads state and sends messages; it does not edit files.
- Extensions run with your user's permissions. Read the source before
  installing anything from a package.

## License

MIT
