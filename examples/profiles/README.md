# Example profiles

Two role files for `pi -ne` runs. Copy them to `~/.pi/agent/profiles/`, then
edit the rule-file paths (`--append-system-prompt`) to match your own setup.

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
