// Self-check for resume-profile/resume_argv.ts: which role a pane reports and
// what command it hands herdr. No herdr, no socket.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const base = path.join(os.homedir(), ".pi/agent/install/releases");
const PI_ROOT = path.join(base, fs.readdirSync(base).sort().pop(), "node_modules");
const require = createRequire(path.join(PI_ROOT, "noop.js"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: { typebox: path.join(PI_ROOT, "typebox/build/index.mjs") } });

let fail = 0;
const check = (n, c, extra = "") => { console.log((c ? "PASS  " : "FAIL  ") + n + (!c && extra ? "   <- " + String(extra).slice(0, 300) : "")); if (!c) fail++; };

const HERE = path.dirname(new URL(import.meta.url).pathname);
const mod = await jiti.import(path.resolve(HERE, "..", "resume_argv.ts"));

// labels.conf: exact label -> profile, comments and blanks ignored.
const labels = mod.parseLabels("# comment\n\nworker = tiiny-worker\nreviewer=other\nbad line\n");
check("labels.conf maps worker", labels.get("worker") === "tiiny-worker", String(labels.get("worker")));
check("labels.conf tolerates no spaces around =", labels.get("reviewer") === "other", String(labels.get("reviewer")));
check("labels.conf skips comments and junk", labels.size === 2, String(labels.size));

// Role: the profile that started pi wins, else the pane label, else nothing.
check("HERDR_PAIR_PROFILE wins over the label",
  mod.resumeRole({ HERDR_PAIR_PROFILE: "mine" }, "worker", labels) === "mine");
check("label falls back to labels.conf",
  mod.resumeRole({}, "worker", labels) === "tiiny-worker");
check("unmapped label reports nothing (bare pi is not upgraded)",
  mod.resumeRole({}, "master", labels) === null);
check("no label and no env reports nothing",
  mod.resumeRole({}, null, labels) === null);

// Command: pi-profile <role> --session <abs file>.
const f = "/home/u/.pi/agent/sessions/x/1.jsonl";
check("argv names pi-profile, the role and the session file",
  JSON.stringify(mod.resumeArgv("worker", f)) === JSON.stringify(["pi-profile", "worker", "--session", f]),
  JSON.stringify(mod.resumeArgv("worker", f)));
check("no session file yet -> nothing to report (keeps the saved command)",
  mod.resumeArgv("reviewer") === null, String(mod.resumeArgv("reviewer")));
check("first word is a plain command name, not a path",
  !path.isAbsolute(mod.resumeArgv("worker", f)[0]) && !mod.resumeArgv("worker", f)[0].includes("/"));

// Retry: herdr drops a report that arrives before it recognizes the pane's
// agent, so a refused or unanswered report is retried with a fresh seq.
import net from "node:net";

async function fakeSocket(dir, reply) {
  const sock = path.join(dir, "herdr.sock");
  const seen = [];
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (c) => {
      buf += c;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.split("\n")[0]);
      seen.push(req);
      const answer = reply(seen.length);
      if (answer) conn.write(answer + "\n");
    });
    conn.on("error", () => {});
  });
  await new Promise((r) => server.listen(sock, r));
  return { sock, seen, close: () => new Promise((r) => server.close(r)) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resume-test-"));
const sessionFile = path.join(tmp, "2026-01-01_test.jsonl");

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(sockPath, role) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = sockPath;
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_PAIR_PROFILE = role;
  const handlers = {};
  mod.default({ on: (name, fn) => { handlers[name] = fn; } });
  const ctx = { mode: "tui", isIdle: () => true, sessionManager: { getSessionFile: () => sessionFile } };
  await handlers.session_start({}, ctx);
  await settle(50);                     // the reports run in the background
}

// 1) refused once, then accepted -> exactly two reports, same resume_argv.
const refusedThenOk = await fakeSocket(tmp, (n) =>
  n === 1 ? '{"error":{"code":"resume_not_accepted","message":"nope"}}' : '{"result":{"type":"ok"}}');
await run(refusedThenOk.sock, "worker");
await settle(400);                      // first attempt refused at once, retry after 250 ms
await refusedThenOk.close();
check("a refused report is retried", refusedThenOk.seen.length === 2, String(refusedThenOk.seen.length));
check("the retry carries the same resume command",
  JSON.stringify(refusedThenOk.seen[1]?.params?.resume_argv) === JSON.stringify(refusedThenOk.seen[0]?.params?.resume_argv),
  JSON.stringify(refusedThenOk.seen.map((r) => r.params?.resume_argv)));
check("the retry takes a new seq", refusedThenOk.seen[1]?.params?.seq > refusedThenOk.seen[0]?.params?.seq,
  JSON.stringify(refusedThenOk.seen.map((r) => r.params?.seq)));
check("the retry names the same pane/source/agent",
  refusedThenOk.seen[1]?.params?.pane_id === "w1:p1"
  && refusedThenOk.seen[1]?.params?.source === "herdr:pi"
  && refusedThenOk.seen[1]?.params?.agent === "pi");

// 2) never answered -> gives up after the whole budget instead of hanging pi.
const silent = await fakeSocket(tmp, () => null);
const started = Date.now();
await run(silent.sock, "worker");
await settle(3700);                     // rides out the whole retry budget
const tookMs = Date.now() - started;
await silent.close();
check("unanswered reports are retried and then dropped", silent.seen.length === 4, String(silent.seen.length));
check("the retry budget stays under 4 s", tookMs < 4000, String(tookMs));

// 2b) a newer state cancels the older retry chain (single flight): a slow
// `working` chain must not overwrite a newer `idle`, and the total number of
// sends stays bounded.
const racing = await fakeSocket(tmp, (n) => (n === 1
  ? '{"error":{"code":"resume_not_accepted","message":"nope"}}'
  : '{"result":{"type":"ok"}}'));
process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = racing.sock;
process.env.HERDR_PANE_ID = "w1:p1";
process.env.HERDR_PAIR_PROFILE = "worker";
const h3 = {};
mod.default({ on: (name, fn) => { h3[name] = fn; } });
const ctx3 = { mode: "tui", isIdle: () => false, sessionManager: { getSessionFile: () => sessionFile } };
h3.session_start({}, ctx3);                 // reports working, first attempt refused
await settle(50);                           // now sitting in the 250 ms backoff
h3.agent_settled({}, { ...ctx3, isIdle: () => true });   // idle queued
h3.agent_settled({}, { ...ctx3, isIdle: () => true });   // idle again: still one pending
await settle(900);
await racing.close();
const states = racing.seen.map((r) => r.params?.state);
check("the newest state wins, the stale one is not re-sent",
  JSON.stringify(states) === JSON.stringify(["working", "idle"]), JSON.stringify(states));
check("a superseded chain stops retrying (bounded sends)",
  racing.seen.length <= 3, String(racing.seen.length));
check("every send carries the resume command",
  racing.seen.every((r) => JSON.stringify(r.params?.resume_argv)?.includes("pi-profile")), JSON.stringify(states));

// 2c) send() reads the JSON answer: the word "error" in a payload is not a failure.
const wordy = await fakeSocket(tmp, () => '{"result":{"type":"ok","detail":"0 errors"}}');
const outcome = await mod.send({ id: "x", method: "pane.report_agent", params: {} }, wordy.sock);
await wordy.close();
check('a result carrying the word "error" still counts as ok', outcome === "ok", String(outcome));
const refusal = await fakeSocket(tmp, () => '{"error":{"code":"resume_not_accepted"}}');
const outcome2 = await mod.send({ id: "x", method: "pane.report_agent", params: {} }, refusal.sock);
await refusal.close();
check("an error answer is a failure", outcome2 === "error", String(outcome2));

// 3) no session file -> no report at all (never overwrites a saved command).
const quiet = await fakeSocket(tmp, () => '{"result":{"type":"ok"}}');
process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = quiet.sock;
process.env.HERDR_PANE_ID = "w1:p1";
process.env.HERDR_PAIR_PROFILE = "worker";
const h2 = {};
mod.default({ on: (name, fn) => { h2[name] = fn; } });
await h2.session_start({}, { mode: "tui", isIdle: () => true, sessionManager: { getSessionFile: () => undefined } });
await quiet.close();
check("no session file -> nothing is sent", quiet.seen.length === 0, String(quiet.seen.length));

// Outside herdr nothing is reported at all: registering the extension finds no hook.
// (This test runs inside a herdr pane too, so clear the env first.)
const saved = { ...process.env };
for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) delete process.env[k];
let hooks = 0;
mod.default({ on: () => hooks++ });
check("outside herdr the extension registers nothing", hooks === 0, String(hooks));

process.env.HERDR_ENV = "1";
process.env.HERDR_SOCKET_PATH = "/tmp/none.sock";
process.env.HERDR_PANE_ID = "w1:p1";
hooks = 0;
mod.default({ on: () => hooks++ });
check("inside herdr it hooks session_start, agent_start, agent_settled", hooks === 3, String(hooks));

for (const k of ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID"]) {
  if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
