# Example profiles

Two role files for `pi -ne` runs, plus the rule files they load. Copy all four
to `~/.pi/agent/profiles/`, then edit the rules to match your own setup.

- `worker.conf` + `worker.md.example`
- `reviewer.conf` + `reviewer.md.example`

- `worker.conf`: writes code, no tools to read other panes.
- `reviewer.conf`: adds `last_answer` (read the worker's answer) and `hb_block`
  (silence the watchdog).

Both mount `resume-profile/resume_argv.ts`, which reports
`pi-profile <role> --session <file>` to herdr so a restarted pane comes back as
the same role instead of bare pi. `bin/pi-profile` exports
`HERDR_PAIR_PROFILE=<role>` for it; keep that line if you write your own profile.

They assume the bundle is installed with `pi install git:...`. The package does
not auto-load the tools; these profiles mount them explicitly. If you keep a
checkout instead, set `HERDR_PAIR` to its path.

Run one with the repo's `bin/pi-profile` script (symlink it into `~/.local/bin`):

```bash
pi-profile            # inside a pane labeled worker or reviewer
pi-profile worker     # outside herdr, or in an unlabeled pane
```

Inside herdr the pane label decides: `pi-profile` with no argument starts the
matching profile and refuses a role that disagrees with the label.

Panes must be labelled so the watchdog can pair them:

```bash
herdr pane rename <pane_id> worker
herdr pane rename <pane_id> reviewer
```
