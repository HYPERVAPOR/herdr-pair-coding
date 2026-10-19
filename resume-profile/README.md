# resume-profile

Tells herdr how to bring a pane back as the same role: it reports
`pi-profile <profile> --session <session file>` as the pane's resume command, and
herdr prefers it over its built-in `pi --session <file>` (which starts a bare pi:
no role prompt, no `--tools` whitelist, no `last_answer`/`hb_block`).

This is not a tool. It is mounted by the role profiles (`-e`) and does nothing
unless it runs inside a herdr pane.

```text
pi-profile <profile> --session <session file>
```

The profile name comes from `HERDR_PAIR_PROFILE`, which `bin/pi-profile` exports,
and otherwise from an exact `label = profile` line in
`~/.pi/agent/profiles/labels.conf`. With neither, nothing is reported and the
pane keeps herdr's built-in resume: a bare `pi` in a labelled pane is not
silently upgraded into a profile.

It reports as source `herdr:pi` / agent `pi`, the same reporter as herdr's own pi
integration, so it appends to the pane's agent instead of claiming it, and it
re-reports at session start, turn start and settle. herdr 0.9.3 persists the
command as `agent_resume.argv` in `~/.config/herdr/sessions/<name>/session.json`;
herdr's own state-only reports do not clear it. Older herdr versions accept the
report and ignore the command, so the pane restores as bare pi.

Turning herdr's agent restore off disables this too:
`[session] resume_agents_on_restore = false` in `~/.config/herdr/config.toml`.

Test: `node resume-profile/test/resume_argv.test.mjs` (no herdr, no socket).
