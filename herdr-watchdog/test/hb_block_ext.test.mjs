// hb_block refusals must reach the model as a one-line failed tool result.
// HB_DIR points the CLI at a throwaway flag directory (never the live one).
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-block-"));
process.env.HB_DIR = tmp;
process.env.HERDR_PANE_ID = "w1:p1";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const mod = await jiti.import(path.resolve(HERE, "..", "hb_block.ts"), { default: true });
const tools = [];
mod({ registerTool: (t) => tools.push(t), on: () => {}, registerCommand: () => {} });
check("registers one tool", tools.length === 1, String(tools.length));
const t = tools[0] || {};

// A flag directory that cannot be created: the CLI refuses, the tool must turn
// that into a one-line failed tool result instead of dumping its stderr.
process.env.HB_DIR = "/dev/null/nope";
try {
  await t.execute("c1", { action: "block", reason: "waiting" }, undefined, undefined, {});
  check("an unusable flag dir is a failed tool result", false);
} catch (e) {
  check("an unusable flag dir is a failed tool result", true);
  check("its message is one line", !String(e.message).includes("\n"), JSON.stringify(e.message));
  check("its message is not empty", String(e.message).trim().length > 0, JSON.stringify(e.message));
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
