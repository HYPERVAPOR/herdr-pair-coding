# herdr-pair-coding

Worker–reviewer pair coding on top of [herdr](https://herdr.dev): one agent
writes, another reviews, each in its own pane.

The core is three CLI tools. [pi](https://pi.dev) adds thin tool wrappers,
per-role tool allowlists, and an inline watchdog status (`hb_block:true 😴`);
the tools also work from any agent that can run shell commands.

## Set up with your agent

```text
Help me set up herdr-pair-coding: https://raw.githubusercontent.com/HYPERVAPOR/herdr-pair-coding/main/skills/herdr-pair-coding/SKILL.md
```

The skill is the long version: install, profiles, pane labels, watchdog,
verification, troubleshooting.

## What's inside

| Tool | Role |
|---|---|
| [`herdr-watchdog`](herdr-watchdog/README.md) | 20 s heartbeat; nudges or interrupts a stalled worker/reviewer pair; `hb_block` silences it |
| [`herdr-last-answer`](herdr-last-answer/README.md) | reviewer reads the worker's answer text, no TUI footer, no width truncation |
| [`refs-reclaim`](refs-reclaim/README.md) | archives and removes worktrees/branches only after proving them safe |

![Three worker–reviewer pairs, each with its own worktree, watched by one watchdog](docs/pair-loop.png)

## Install

```bash
pi install git:github.com/HYPERVAPOR/herdr-pair-coding
```

Needs [herdr](https://herdr.dev), `python3`, and `git` for `refs-reclaim`.
pi is optional: `herdr-last-answer <pane>`, `herdr-watchdog daemon` and
`refs-reclaim plan --repo <dir>` run as plain CLIs. Only mounted tools cost
context; anything you do not load adds nothing.

Everyday tools (`/tools`, `/copy-code`, `/keepctx`, `web_search`) are in
[`pi-utils`](https://github.com/HYPERVAPOR/pi-utils).

## Safety

`refs-reclaim` is read-only until `archive`/`apply`; `apply` requires
`confirm=true` and `--yes` and leaves alone anything it cannot prove safe. The
watchdog only reads state and sends messages.

MIT
