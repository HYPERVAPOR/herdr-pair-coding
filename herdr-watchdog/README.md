# herdr-watchdog

A heartbeat watchdog for paired agents in [herdr](https://herdr.dev).

Every 20 seconds it checks each `worker`/`reviewer` pair and nudges the right
pane when nobody is making progress. Agents can silence it while running a long
task or waiting on a human.

## Behavior

Per tab, in order:

1. Find the pair: pane labels must contain `worker` and `reviewer`.
2. If the reviewer's `is_heartbeat_blocked` flag is `true`, do nothing.
3. If any working pane changed its session file in the last 10 minutes, stay
   silent.
4. If all working panes have been quiet for more than 10 minutes, treat the
   pair as stuck.
5. If no pane is working, send message B.

When stuck:

- Reviewer itself is busy with no output → `send-keys esc` to interrupt, then
  send A1.
- A worker is stuck and the reviewer is idle → send A2.
- Neither is working → send B.

Messages contain no timing numbers; `--dry-run` and logs do.

## hb_block

The reviewer gets one tool:

```json
{ "action": "block" | "unblock", "reason": "one line, ≤120 chars" }
```

- `block`: talking to a human, finished this round, waiting for a decision, or
  running a long task.
- `unblock`: back to pair coding.

Repeated calls are no-ops. History keeps the last ~20 entries. Flag file:
`~/.herdr/watchdog/<session>__<tab>.json`.

The reviewer status bar shows `hb_block:true 😴` or `hb_block:false 👂`.

## Ops

- State: `~/.herdr/watchdog/`.
- Restart after changing the script: `systemctl --user restart herdr-watchdog`.
- `touch PAUSE` pauses; `--dry-run` does one silent pass.
- `herdr-watchdog top` is a read-only live view: a scrolling braille ECG (one
  QRS per daemon pass), the pair tree with quiet-time gauges, and a signal that
  runs down the trunk into the pane the watchdog just called. `?` opens a
  legend of the marks and the quiet gauge; `q` quits.
  `herdr-watchdog top --demo` previews the whole animation with synthetic pairs
  (reads and writes nothing).
- Change `hb_block.ts` and `/reload`; no pane restart needed.

## Test

```bash
python3 herdr-watchdog/test/selftest.py
```
