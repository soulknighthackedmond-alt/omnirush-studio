#!/usr/bin/env node
"use strict";

/**
 * Diagnostic: drive the CLI in WSL exactly the way the app's WSL runner does
 * (JSONL over stdin/stdout) and print everything it says.
 *
 *   node test/probe-wsl.cjs [distro] [workdir]
 */

const { spawn } = require("node:child_process");

const distro = process.argv[2] || "Ubuntu";
const workdir = process.argv[3] || "C:\\Users\\aungt";
const flags = process.argv.slice(4).join(" ") || "--mode rpc --no-session --approve";
const mount = `/mnt/${workdir[0].toLowerCase()}${workdir.slice(2).replace(/\\/g, "/")}`;

const script = `cd ${JSON.stringify(mount).replace(/"/g, "")} && exec omnirush ${flags}`;
console.log(`[probe] wsl.exe -d ${distro} -e bash -lc ${script}`);

const child = spawn("wsl.exe", ["-d", distro, "-e", "bash", "-lc", script], { windowsHide: true });

let stdout = "";
let stderr = "";
let finished = false;

const done = (reason) => {
  if (finished) return;
  finished = true;
  console.log(`\n[probe] ${reason} exit=${child.exitCode} stdout=${stdout.length}B stderr=${stderr.length}B`);
  try {
    child.kill();
  } catch {
    /* gone */
  }
  process.exit(0);
};

child.stdout.on("data", (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
  if (/"(agent_settled|agent_end|error)"/.test(String(chunk))) setTimeout(() => done("agent finished"), 500);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});
child.on("error", (err) => console.log(`[probe] spawn error: ${err.message}`));

child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "Reply with exactly: hello from wsl" })}\n`);

setTimeout(() => done("timed out"), 150000);
