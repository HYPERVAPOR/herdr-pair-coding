#!/usr/bin/env python3
"""Scenario tests for herdr-last-answer (fake session jsonl + fake herdr; no real panes, no real requests).

Approach: build synthetic session files, write a fake `herdr` that only answers
`agent get`, point HERDR_BIN at it, run the real script, and assert what it
should and should not print.

    python3 test_last_answer.py            # run everything
    python3 test_last_answer.py -v         # print details per scenario
"""
import json
import os
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, os.pardir, "herdr-last-answer"))
VERBOSE = "-v" in sys.argv
EXIT_NO_ANSWER = 3      # contract: 3 = the other side has not answered yet (including "session file not persisted")

LONG_PATH = "/home/user/.pi/agent/sessions/--home-user-.pi-agent--/2026-10-13T10-24-11-042Z_01a134ca-8922-73c4-87de-407a1eafcaa0/notes/deep/" \
            "a-very-long-non-ascii-directory-name-áéíóú-ñçüß/final-file-name.md"
SECRET = "SECRET_TOOLRESULT_MUST_NOT_BE_PRINTED"
TUI_NOISE = ("↑", "↓", "────", "🐴")

failures = []


def check(label, cond, detail=""):
    if cond:
        print("ok   %s" % label)
        if VERBOSE:
            print("     %s" % detail)
    else:
        failures.append(label)
        print("FAIL %s" % label)
        if detail:
            print("     %s" % detail.replace("\n", "\n     "))


def msg(role, content, ts="2026-10-13T19:00:00.000Z"):
    return json.dumps({"type": "message", "timestamp": ts,
                       "message": {"role": role, "content": content}}, ensure_ascii=False)


def text(t):
    return {"type": "text", "text": t}


def thinking(t="internal reasoning that must not be printed"):
    return {"type": "thinking", "thinking": t, "thinkingSignature": "sig"}


def tool_call(name, arg):
    key = "command" if name == "bash" else ("path" if name == "read" else "edits")
    return {"type": "toolCall", "id": "call_%s" % name, "name": name, "arguments": {key: arg}}


def tool_result(t):
    return {"type": "text", "text": t}


def write_session(path, records):
    with open(path, "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(r + "\n")


def write_fake_herdr(path):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("""#!/bin/sh
# Fake herdr: answers only `agent get <target>`; the target name decides the response.
if [ "$1" != "agent" ] || [ "$2" != "get" ]; then
  echo '{"error":{"message":"fake herdr only supports agent get"}}' >&2; exit 1; fi
case "$3" in
  ok) printf '{"result":{"agent":{"agent_session":{"agent":"pi","kind":"path","value":"%s"}}}}\\n' "$FAKE_SESSION_PATH" ;;
  badkind) echo '{"result":{"agent":{"agent_session":{"agent":"pi","kind":"id","value":"ses_123"}}}}' ;;
  fail) echo '{"error":{"message":"agent not found"}}' >&2; exit 1 ;;
  *) echo '{"error":{"message":"unknown"}}' >&2; exit 1 ;;
esac
""")
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def run(target, *extra, session_path, fake_herdr):
    env = dict(os.environ, HERDR_BIN=fake_herdr, FAKE_SESSION_PATH=session_path)
    p = subprocess.run([sys.executable, SCRIPT, target, *extra],
                       capture_output=True, text=True, env=env, timeout=60)
    if VERBOSE:
        print("     $ herdr-last-answer %s %s -> exit %d" % (target, " ".join(extra), p.returncode))
        print("       stdout: %r" % p.stdout[:400])
        print("       stderr: %r" % p.stderr[:400])
    return p


def clean(label, out):
    """The output must not contain TUI elements (footer arrows / borders / badges)."""
    bad = [t for t in TUI_NOISE if t in out]
    check("%s output has no TUI elements%s" % (label, bad and " (found %r)" % bad or ""), not bad, out[:200])


def main():
    if not os.access(SCRIPT, os.X_OK):
        print("FAIL herdr-last-answer is not executable: %s" % SCRIPT)
        return 1
    tmp = tempfile.mkdtemp(prefix="herdr-last-answer-test-")
    fake_herdr = os.path.join(tmp, "fake-herdr")
    write_fake_herdr(fake_herdr)

    # ---- Synthetic session: 4 answers with thinking / toolCall / toolResult noise in between.
    #      A1 holds a long path (to prove no pane-width truncation); A4 follows a turn with 12 tools.
    recs = [msg("user", [text("start")]),
            msg("assistant", [thinking(), tool_call("bash", "ls -la /tmp")]),
            msg("toolResult", [tool_result(SECRET + ": this big tool output must never appear in herdr-last-answer" + " noise" * 200)]),
            msg("assistant", [text("first answer: long path %s preserved as-is" % LONG_PATH)]),
            msg("assistant", [tool_call("read", "/home/user/projects/pi-dev-bundle/herdr-watchdog/herdr-watchdog")]),
            msg("toolResult", [tool_result(SECRET)]),
            msg("assistant", [text("second answer A2")]),
            msg("assistant", [tool_call("edit", "[{\"newText\": \"...\"}]")]),
            msg("toolResult", [tool_result(SECRET)]),
            msg("assistant", [text("third answer A3")])]
    for i in range(1, 13):
        recs.append(msg("assistant", [tool_call("tool%02d" % i, "arg%02d-%s" % (i, "x" * 80))]))
        recs.append(msg("toolResult", [tool_result(SECRET)]))
    recs.append(msg("assistant", [text("last answer A4: full body, includes long path %s done." % LONG_PATH)]))
    # Tail: another tool-only turn (no answer). With the default --n 1 the result must still be A4.
    recs.append(msg("assistant", [tool_call("bash", "sleep 1")]))
    recs.append(msg("toolResult", [tool_result(SECRET)]))
    ok_session = os.path.join(tmp, "ok.jsonl")
    write_session(ok_session, recs)

    # A session with no assistant text: only user / thinking / toolResult.
    silent = os.path.join(tmp, "silent.jsonl")
    write_session(silent, [msg("user", [text("hello")]),
                           msg("assistant", [thinking()]),
                           msg("toolResult", [tool_result("ok")])])

    # ---- 1. Default --n 1: only the last answer, no TUI, no truncation, no tool noise.
    p = run("ok", session_path=ok_session, fake_herdr=fake_herdr)
    check("1. default exits 0", p.returncode == 0, p.stderr)
    check("1. default prints only the last answer A4",
          p.stdout.strip() == "last answer A4: full body, includes long path %s done." % LONG_PATH,
          repr(p.stdout[:300]))
    check("1. long path is not truncated (no … / ... in the body)",
          LONG_PATH in p.stdout and "…" not in p.stdout and "..." not in p.stdout)
    check("1. thinking is not printed", "internal reasoning" not in p.stdout)
    check("1. toolResult is not printed", SECRET not in p.stdout)
    check("1. tool summary is not printed (that is --tools)", "[tools]" not in p.stdout)
    clean("1.", p.stdout)

    # ---- 2. --n 3: three answers, in order.
    p3 = run("ok", "--n", "3", session_path=ok_session, fake_herdr=fake_herdr)
    check("2. --n 3 exits 0", p3.returncode == 0, p3.stderr)
    check("2. all three are present", all(s in p3.stdout for s in ("second answer A2", "third answer A3", "last answer A4")))
    check("2. order is A2 -> A3 -> A4", p3.stdout.find("A2") < p3.stdout.find("A3") < p3.stdout.find("A4"))
    check("2. three section markers", all("[%d/3]" % i in p3.stdout for i in (1, 2, 3)))
    check("2. only three (first answer A1 is absent)", "first answer" not in p3.stdout)
    check("2. toolResult is not printed", SECRET not in p3.stdout)
    clean("2.", p3.stdout)

    # ---- 3. --n exceeds available answers: print what exists, do not fail.
    p99 = run("ok", "--n", "99", session_path=ok_session, fake_herdr=fake_herdr)
    check("3. --n 99 exits 0 (no error)", p99.returncode == 0, p99.stderr)
    check("3. all four answers are printed", all(s in p99.stdout for s in ("first answer", "A2", "A3", "A4")))
    check("3. section markers are [1/4] (actual count)", "[1/4]" in p99.stdout and "[4/4]" in p99.stdout)

    # ---- 4. --tools: exactly one extra line with the last answer's tools, no toolResult.
    base = run("ok", session_path=ok_session, fake_herdr=fake_herdr).stdout
    pt = run("ok", "--tools", session_path=ok_session, fake_herdr=fake_herdr)
    check("4. --tools exits 0", pt.returncode == 0, pt.stderr)
    check("4. exactly one extra line vs without --tools", len(pt.stdout.splitlines()) == len(base.splitlines()) + 1,
          "base=%d tools=%d" % (len(base.splitlines()), len(pt.stdout.splitlines())))
    check("4. body is identical (the summary only appends)", pt.stdout.startswith(base.rstrip("\n")))
    tline = [l for l in pt.stdout.splitlines() if l.startswith("[tools]")]
    check("4. exactly one [tools] line", len(tline) == 1)
    check("4. summary contains the last turn's tools (tool01..tool10)",
          all("tool%02d" % i in tline[0] for i in range(1, 11)), tline[0][:200] if tline else "")
    check("4. more than 10 are truncated with a note (tool11/12 absent)",
          "tool11" not in tline[0] and "tool12" not in tline[0] and "2 more" in tline[0])
    check("4. does not contain the previous turn's tools (read/edit absent)", "read:" not in tline[0] and "edit:" not in tline[0])
    check("4. never prints the full toolResult", SECRET not in pt.stdout)
    clean("4.", pt.stdout)

    # ---- 5. No assistant text -> non-zero exit + fallback on stderr.
    p5 = run("ok", session_path=silent, fake_herdr=fake_herdr)
    check("5. non-zero exit when there is no answer", p5.returncode != 0, "exit=%d" % p5.returncode)
    check("5. stderr explains why", "has no assistant text" in p5.stderr, p5.stderr[:200])
    check("5. stderr gives the agent read fallback", "herdr agent read" in p5.stderr and "recent-unwrapped" in p5.stderr)
    check("5. not a silent success (stdout is empty)", p5.stdout.strip() == "")

    # ---- 6. Cannot get a path: herdr error / kind is not path / file does not exist.
    p6a = run("fail", session_path=ok_session, fake_herdr=fake_herdr)
    check("6. herdr agent get failure -> non-zero exit", p6a.returncode != 0, "exit=%d" % p6a.returncode)
    check("6. herdr failure gives the fallback on stderr", "herdr agent read" in p6a.stderr, p6a.stderr[:200])

    p6b = run("badkind", session_path=ok_session, fake_herdr=fake_herdr)
    check("6. kind!=path -> non-zero exit + explanation", p6b.returncode != 0 and "not path" in p6b.stderr, p6b.stderr[:200])
    check("6. kind!=path gives the fallback on stderr", "herdr agent read" in p6b.stderr)

    # A missing session file means the pane has not spoken (new session / just restarted).
    # Semantically it is the same as "file exists but has no assistant text", so it must
    # also be exit 3: the tool shell turns it into "it has not spoken, wait for delivery"
    # instead of handing a raw errno to the model (pi would render that as a failure).
    p6c = run("ok", session_path=os.path.join(tmp, "not-created-yet.jsonl"), fake_herdr=fake_herdr)
    check("6. missing session file -> exit 3 (not a failure)", p6c.returncode == EXIT_NO_ANSWER, "exit=%d" % p6c.returncode)
    check("6. missing file says it has not spoken", "has not spoken" in p6c.stderr, p6c.stderr[:200])
    check("6. missing file does not leak the raw errno", "Errno" not in p6c.stderr and "cannot read session file" not in p6c.stderr,
          p6c.stderr[:200])
    check("6. missing file gives the fallback on stderr", "herdr agent read" in p6c.stderr)

    # ---- 7. Bad arguments.
    p7 = run("ok", "--n", "0", session_path=ok_session, fake_herdr=fake_herdr)
    check("7. --n 0 is rejected (non-zero exit)", p7.returncode != 0, "exit=%d" % p7.returncode)

    print()
    if failures:
        print("================ %d failure(s) ================" % len(failures))
        for f in failures:
            print(" - %s" % f)
        return 1
    print("================ all passed ================")
    return 0


if __name__ == "__main__":
    sys.exit(main())
