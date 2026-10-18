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

// Load the shell from this package (relative to the test file, not a live ~/.pi path).
const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.resolve(HERE, "..", "last_answer.ts");
const mod = await jiti.import(EXT, { default: true });
const got = [];
mod({ registerTool: (t) => got.push(t), registerCommand: () => {} });
check("jiti loads and registers one tool", got.length === 1, JSON.stringify(got.map((t) => t.name))); const t = got[0] || {};
check("tool name is last_answer", t.name === "last_answer", t.name);
check("description says it is not a herdr subcommand", /not a herdr subcommand/.test(t.description || ""));
check("schema has target/n/tools", !!(t.parameters?.properties?.target && t.parameters?.properties?.n && t.parameters?.properties?.tools));

// 1) Real call: read a tmp pair's worker (which has already answered).
const out = await t.execute("c1", { target: "wE:p1M", n: 1 }, undefined, undefined, {});
check("reads a real pane (wE:p1M) and returns the body", out.content[0].text.length > 40, out.content[0].text.slice(0, 120));
check("body has no TUI footer noise", !/^[╭╰│]/.test(out.content[0].text.trim()), out.content[0].text.slice(0, 80));

// 2) n + tools
const out2 = await t.execute("c2", { target: "wE:p1M", n: 2, tools: true }, undefined, undefined, {});
check("n=2 + tools=true also returns content", out2.content[0].text.length > 40, out2.content[0].text.slice(0, 120));

// 3) Missing target -> should throw (exit 2).
let threw = "";
try { await t.execute("c3", { target: "wE:nope" }, undefined, undefined, {}); }
catch (e) { threw = e.message || ""; }
check("missing target -> throws", /herdr-last-answer:/.test(threw), threw.slice(0, 200));

// 4) The other side has not answered (exit 3) -> must not throw; returns "no readable answer yet".
const emptyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "la-")), "empty.jsonl");
fs.writeFileSync(emptyFile, "");
const fakeHerdr = path.join(os.tmpdir(), "fake-herdr-la");
fs.writeFileSync(fakeHerdr, `#!/bin/sh\ncat <<JSON\n{"result":{"agent":{"agent_session":{"kind":"path","value":"${emptyFile}"}}}}\nJSON\n`);
fs.chmodSync(fakeHerdr, 0o755);
process.env.HERDR_BIN = fakeHerdr;
const out3 = await t.execute("c4", { target: "wE:pX" }, undefined, undefined, {});
check("not answered yet (exit 3) -> message, not throw", /has no readable answer yet/.test(out3.content[0].text), out3.content[0].text.slice(0, 200));
delete process.env.HERDR_BIN;

console.log(fail ? `\nFAILED: ${fail}` : "\nALL PASS");
process.exit(fail ? 1 : 0);
