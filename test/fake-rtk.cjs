#!/usr/bin/env node
"use strict";

/**
 * Stand-in for the RTK binary.
 *
 * The real thing is not installed here (and installing it needs the network),
 * so the integration tests drive this instead: it speaks the same command line
 * — `--version`, `init -g --agent pi`, `init --show`, `gain` — and writes its
 * hook into RTK_FAKE_HOME so each test gets a throwaway install.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = process.env.RTK_FAKE_HOME || os.homedir();
const args = process.argv.slice(2);
const piDir = path.join(home, ".pi", "agent", "extensions");
const hook = path.join(piDir, "rtk.ts");

const out = (text) => process.stdout.write(`${text}\n`);

if (args[0] === "--version") {
  out("rtk 9.9.9-fake");
  process.exit(0);
}

if (args[0] === "init") {
  if (args.includes("--show")) {
    out(`agent: pi\nhook: ${hook}\nstatus: installed`);
    process.exit(0);
  }
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(hook, "// fake RTK hook for the integration checks\nexport default function rtk() {}\n", "utf8");
  out(`installed pi extension at ${hook}`);
  process.exit(0);
}

if (args[0] === "gain") {
  if (args.includes("json")) {
    out(
      JSON.stringify({
        sessions: 3,
        input_tokens: 41234,
        output_tokens: 5120,
        saved_tokens: 18234,
        savings_percent: 30.7,
      }),
    );
    process.exit(0);
  }
  out("RTK gain\nsessions: 3\ninput tokens: 41,234\noutput tokens: 5,120\nsaved: 18,234 tokens\ncompression: 30.7%");
  process.exit(0);
}

out(`unknown command: ${args.join(" ")}`);
process.exit(2);
