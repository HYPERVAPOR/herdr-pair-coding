// @ts-nocheck
/**
 * Resume-command reporter: tell herdr how to bring this pane back as the same
 * role, not as bare pi.
 *
 * herdr's built-in restore runs `pi --session <file>` for a pi pane, which
 * loses the profile (no role prompt, no --tools whitelist, no last_answer /
 * hb_block). herdr lets the agent that holds a pane report its own resume
 * command instead, and that command wins over the built-in one:
 *
 *     herdr pane report-agent <pane> --source herdr:pi --agent pi --state idle \
 *       -- pi-profile worker --session /path/to/session.jsonl
 *
 * Constraints from herdr: the first word is a plain command name on PATH (not a
 * path), no apostrophes or control characters, <= 64 args / 8 KiB, and the
 * reporter must already hold the pane (it does: the official
 * herdr-agent-state.ts reported it at session start).
 *
 * The report can be dropped: herdr only stores resume_argv once the pane's agent
 * is recognized, and at session start we often beat that detection — the answer
 * is `resume_not_accepted`, or nothing at all while the previous command stays
 * in place (which would bring the pane back as the *old* role). So: parse the
 * answer, and retry a few times with a fresh seq (herdr drops non-increasing
 * seq), then give up silently.
 *
 * Version note: measured working on herdr 0.9.3, which persists the command as
 * agent_resume.argv when the pane's own agent reports it. A binary that does not
 * support self-reported resume commands accepts the report and ignores the
 * command, so the pane resumes as bare pi there; nothing else changes. The same
 * report sent from outside the pane (herdr pane report-agent on the CLI) is
 * accepted but never persisted — it has to come from the pane's agent.
 *
 * Role source, in order: $HERDR_PAIR_PROFILE (exported by bin/pi-profile, so a
 * profile-started pane knows its own name) then an exact `label = profile` line
 * in ~/.pi/agent/profiles/labels.conf. No role -> no report: a bare pi in a
 * labelled pane is not silently upgraded to a profile.
 *
 * We report as the same source/agent as the official pi integration
 * (herdr:pi / pi) instead of taking the pane over with our own source id: herdr
 * drops the agent name, state and resume command when the pane's agent exits,
 * so a second claimant would fight the official reports for the same pane.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const SOURCE = "herdr:pi";
const AGENT = "pi";

function enabled() {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
}

export function parseLabels(text) {
  const labels = new Map();
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(\S+)\s*$/);
    if (m) labels.set(m[1], m[2]);
  }
  return labels;
}

// No role -> null. An explicit profile name always wins over the label.
export function resumeRole(env, label, labels) {
  if (env.HERDR_PAIR_PROFILE) return env.HERDR_PAIR_PROFILE;
  return (label && labels && labels.get(label)) || null;
}

// No session file (nothing written to disk yet) -> no command at all: a bare
// `pi-profile <role>` would add nothing and would overwrite a good saved one.
export function resumeArgv(role, sessionFile) {
  return sessionFile ? ["pi-profile", role, "--session", sessionFile] : null;
}

function labelsConf(file = path.join(process.env.HOME || "", ".pi/agent/profiles/labels.conf")) {
  try {
    return parseLabels(fs.readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}

function paneLabel() {
  try {
    const out = execFileSync(process.env.HERDR_BIN_PATH || "herdr",
      ["pane", "get", process.env.HERDR_PANE_ID], { encoding: "utf8", timeout: 5000 });
    const m = out.match(/"label"\s*:\s*"([^"]*)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const ATTEMPT_TIMEOUT_MS = 300;
// 0 + 250 + 750 + 1500 ms of waiting, four attempts, < 4 s worst case.
const RETRY_DELAYS = [0, 250, 750, 1500];

// herdr ignores a report whose seq is not greater than the last accepted one.
// The official integration reports on the same events with its own
// Date.now()*1000 + counter; measured on 0.9.3, its later reports without
// resume_argv leave ours in place, so there is nothing to re-assert.
let seq = 0;

function nextSeq() {
  seq = Math.max(seq + 1, Date.now() * 1000 + 1);
  return seq;
}

// One attempt. Resolves "ok" only when herdr answers without an error: an
// accepted report looks like {"result":{"type":"ok"}}, a refusal like
// {"error":{"code":"resume_not_accepted",...}}.
export function send(report, socketPath, timeoutMs = ATTEMPT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    let data = "";
    const socket = net.createConnection(socketPath);
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    socket.on("error", () => finish("error"));
    socket.on("connect", () => socket.write(`${JSON.stringify(report)}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
      const nl = data.indexOf("\n");
      if (nl < 0) return;                 // wait for the full line
      let answer;
      try {
        answer = JSON.parse(data.slice(0, nl));
      } catch {
        return finish("error");
      }
      // Accepted: {"id":...,"result":{...}}. Refused: {"id":...,"error":{...}}.
      finish(answer && answer.error ? "error" : answer && answer.result ? "ok" : "error");
    });
    socket.on("end", () => finish("error"));
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    timer.unref?.();
  });
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export default function (pi) {
  if (!enabled()) {
    return;
  }

  let role = null;
  let rootSession = false;

  // One retry chain at a time, latest state wins. Two chains would race: a slow
  // `working` retry landing after a fast `idle` success would put the pane back
  // to working until the next event, and herdr-watchdog reads that state.
  let inFlight = false;
  let wanted;

  function publish(state, ctx) {
    if (!rootSession || !role) return;
    wanted = { state, ctx };
    if (!inFlight) void drain();
  }

  async function drain() {
    if (inFlight) return;
    inFlight = true;
    try {
      while (wanted) {
        const { state, ctx } = wanted;
        wanted = undefined;
        if (!(await report(state, ctx))) continue;
      }
    } finally {
      inFlight = false;
      if (wanted) void drain();
    }
  }

  // Resolves true when herdr took the report, false when it was dropped.
  async function report(state, ctx) {
    let sessionFile;
    try {
      const file = ctx?.sessionManager?.getSessionFile?.();
      if (typeof file === "string" && path.isAbsolute(file)) sessionFile = file;
    } catch {}
    const argv = resumeArgv(role, sessionFile);
    if (!argv) return false;            // nothing on disk yet: keep the saved one
    const params = { pane_id: process.env.HERDR_PANE_ID, source: SOURCE, agent: AGENT, state };
    params.agent_session_path = sessionFile;
    params.resume_argv = argv;
    for (const delay of RETRY_DELAYS) {
      if (delay) await sleep(delay);
      if (wanted) return false;         // a newer state is queued: send that instead
      params.seq = nextSeq();           // herdr drops a seq it has already seen
      const req = { id: `${SOURCE}:resume:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method: "pane.report_agent", params: { ...params } };
      if (await send(req, process.env.HERDR_SOCKET_PATH) === "ok") return true;
    }
    return false;
  }

  pi.on("session_start", (_event, ctx) => {
    // RPC/JSON/print modes are headless: no pane to restore.
    if (ctx?.mode !== "tui") return;
    rootSession = true;
    role = process.env.HERDR_PAIR_PROFILE
      ? process.env.HERDR_PAIR_PROFILE                    // started by pi-profile
      : resumeRole(process.env, paneLabel(), labelsConf());  // -e this file by hand
    if (!role) return;
    publish(ctx?.isIdle?.() === false ? "working" : "idle", ctx);
  });

  pi.on("agent_start", (_event, ctx) => publish("working", ctx));
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx?.isIdle?.() === true) publish("idle", ctx);
  });
}
