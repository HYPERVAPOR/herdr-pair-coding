// refs-reclaim extension load test: run reclaim.ts through pi's bundled jiti, capture the
// registrations with a fake pi, and call execute(action=plan) once (read-only) to verify the
// TS -> CLI -> python path.
//
// Run: node test/load.mjs
// Note: no real repository is touched (a bare origin + clone are created in a temp dir); only
// plan is called, never apply.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WD = path.dirname(HERE);
const EXT = path.join(WD, "reclaim.ts");

// pi's node_modules (jiti / typebox come from here); pick the highest release version
function piNodeModules() {
  if (process.env.PI_NODE_MODULES) return process.env.PI_NODE_MODULES;
  const base = path.join(os.homedir(), ".pi", "agent", "install", "releases");
  const rel = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, "node_modules"))).sort();
  if (!rel.length) throw new Error("cannot find pi's node_modules (set PI_NODE_MODULES)");
  return path.join(base, rel[rel.length - 1], "node_modules");
}
const PI_ROOT = piNodeModules();

let fail = 0;
const check = (n, c, extra = "") => {
  console.log((c ? "PASS  " : "FAIL  ") + n + (!c && extra ? "   <- " + String(extra).slice(0, 300) : ""));
  if (!c) fail++;
};
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---- temp repository (bare origin + clone; plan needs origin to fetch) ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-load-"));
const origin = path.join(root, "origin.git");
const seed = path.join(root, "seed");
const repo = path.join(root, "repo");
execFileSync("git", ["init", "-q", "--bare", origin]);
git(["symbolic-ref", "HEAD", "refs/heads/dev"], origin);
fs.mkdirSync(seed);
git(["init", "-q"], seed);
git(["config", "user.email", "a@b.c"], seed);
git(["config", "user.name", "t"], seed);
fs.writeFileSync(path.join(seed, "f.txt"), "x\n");
git(["add", "."], seed);
git(["commit", "-qm", "base"], seed);
git(["branch", "-M", "dev"], seed);
git(["remote", "add", "origin", origin], seed);
git(["push", "-q", "origin", "dev"], seed);
execFileSync("git", ["clone", "-q", origin, repo]);
git(["config", "user.email", "a@b.c"], repo);
git(["config", "user.name", "t"], repo);
git(["fetch", "-q", "origin", "--prune"], repo);

try {
  const require = createRequire(path.join(PI_ROOT, "noop.js"));
  const { createJiti } = require("jiti");
  const jiti = createJiti(import.meta.url, {
    alias: { typebox: path.join(PI_ROOT, "typebox", "build", "index.mjs") },
  });
  const mod = await jiti.import(EXT, { default: true });

  const got = { tools: [], commands: [] };
  mod({
    registerTool: (t) => got.tools.push(t),
    registerCommand: (n, c) => got.commands.push([n, c]),
  });

  check("module loads through jiti (no syntax/parse error)", true);
  check("registers exactly one tool named refs_reclaim",
        got.tools.length === 1 && got.tools[0].name === "refs_reclaim",
        JSON.stringify(got.tools.map((t) => t.name)));
  const t = got.tools[0] || {};
  check("tool has label/description/parameters/execute", !!(t.label && t.description && t.parameters && t.execute));
  check("registers the /reclaim command", got.commands.length === 1 && got.commands[0][0] === "reclaim");

  const out = await t.execute("tc1", { action: "plan", repo, idle_hours: 2, extra_base: undefined },
                              undefined, undefined, { cwd: repo });
  const text = out.content[0].text;
  check("execute(plan) goes through TS->CLI->python (has a base= line)", /^base=origin\/dev@/m.test(text), text);
  check("summary has a verdict line (T1|T2|BLOCKED|MANUAL|PROTECTED)",
        /^(T1|T2|BLOCKED|MANUAL|PROTECTED|PRUNE)\s/m.test(text), text);
  check("summary gives the plan path", /^plan=.*plan-.*\.json$/m.test(text), text);

  let refused = "";
  try {
    await t.execute("tc2", { action: "apply", repo, plan: "x", archive_manifest: "y" }, undefined, undefined, { cwd: repo });
  } catch (e) { refused = e.message || ""; }
  check("apply without confirm=true -> throws", /confirm=true/.test(refused), refused);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\nFAILED: ${fail}` : "\nALL PASS");
process.exit(fail ? 1 : 0);
