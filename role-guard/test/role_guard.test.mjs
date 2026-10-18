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
const mod = await jiti.import(path.resolve(HERE, "..", "role_guard.ts"));

check("worker label -> worker", mod.wantedRole("worker") === "worker");
check("api-reviewer label -> reviewer", mod.wantedRole("api-reviewer") === "reviewer");
check("ambiguous label -> null", mod.wantedRole("worker-reviewer") === null);
check("unrelated label -> null", mod.wantedRole("master") === null);

let handlers = 0;
mod.default({ on: () => handlers++ });
check("registers one session hook", handlers === 1, String(handlers));

console.log(fail ? "\n" + fail + " failed" : "\nall passed");
process.exit(fail ? 1 : 0);
