# Example profiles

Two role files for `pi -ne` runs, plus the rule files they load. Copy all four
to `~/.pi/agent/profiles/`, then edit the rules to match your own setup.

- `worker.conf` + `worker.md.example`
- `reviewer.conf` + `reviewer.md.example`

- `worker.conf`: writes code, no tools to read other panes.
- `reviewer.conf`: adds `last_answer` (read the worker's answer) and `hb_block`
  (silence the watchdog).

They assume the bundle is installed with `pi install git:...`. If you keep a
checkout instead, set `HERDR_PAIR` to its path.

Panes must be labelled so the watchdog can pair them:

```bash
herdr pane rename <pane_id> worker
herdr pane rename <pane_id> reviewer
```
