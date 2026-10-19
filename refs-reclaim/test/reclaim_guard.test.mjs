// The apply gates are safety rails: they must reach the model as a failed tool
// result whose one-line message still says a human has to approve.
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
const mod = await jiti.import(path.resolve(HERE, "..", "reclaim.ts"), { default: true });
const tools = [];
mod({ registerTool: (t) => tools.push(t), on: () => {}, registerCommand: () => {} });
const t = tools[0] || {};
const ctx = { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-")) };

for (const [name, params, want] of [
  ["apply without confirm", { action: "apply", plan: "plan-x.json", archive_manifest: "a.json" }, /confirm=true/],
  ["apply without a human-approval hint", { action: "apply", plan: "plan-x.json" }, /confirm=true/],
  ["archive without plan", { action: "archive" }, /plan/],
]) {
  try {
    await t.execute("c1", params, undefined, undefined, ctx);
    check(`${name} is refused`, false);
  } catch (e) {
    check(`${name} is refused`, true);
    check(`${name}: one line`, !String(e.message).includes("\n"), JSON.stringify(e.message));
    check(`${name}: fits an 80-column pane (<=76)`, String(e.message).length <= 76, `${String(e.message).length}: ${e.message}`);
    check(`${name}: names the missing step`, want.test(e.message), e.message);
  }
}
const confirmErr = await t.execute("c1", { action: "apply", plan: "plan-x.json" }, undefined, undefined, ctx).catch((e) => e);
check("the confirm gate mentions the human approval", /human approval/.test(confirmErr.message), confirmErr.message);
check("the confirm gate is short enough for one line", confirmErr.message.length <= 76, `${confirmErr.message.length}: ${confirmErr.message}`);
console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
