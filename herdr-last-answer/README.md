# herdr-last-answer

Read the plain answer text from **another herdr pane**: no pi TUI footer, no
pane-width truncation.

| Face | Used by | How |
|---|---|---|
| CLI | humans / tests / scripts | `herdr-last-answer/herdr-last-answer` |
| Tool `last_answer` | the model (reviewer + master) | package manifest, or `-e herdr-last-answer/last_answer.ts` + `--tools …,last_answer` |

## Contract

- Source: `herdr agent get <target>` → `result.agent.agent_session.value`
  (`kind=path`) → that JSONL file.
- Only assistant text blocks are printed; thinking, tool calls and tool results
  are excluded. `--n N` returns the last N answers; `--tools` summarizes the
  tools called in the last turn.
- Exit codes: `0` content, `1` bad arguments, `2` fetch failed, `3` the other
  side has not answered yet.
- The shell throws only `2` at the model. `3` becomes "no answer yet" and asks
  the model to wait.
- `HERDR_BIN` overrides the herdr executable.

## Test

```bash
python3 herdr-last-answer/test/test_last_answer.py
node    herdr-last-answer/test/test_last_answer_ext.mjs
```
