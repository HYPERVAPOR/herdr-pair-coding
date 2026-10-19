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
check("no session file yet -> role only",
  JSON.stringify(mod.resumeArgv("reviewer")) === JSON.stringify(["pi-profile", "reviewer"]));
check("first word is a plain command name, not a path",
  !path.isAbsolute(mod.resumeArgv("worker", f)[0]) && !mod.resumeArgv("worker", f)[0].includes("/"));

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
