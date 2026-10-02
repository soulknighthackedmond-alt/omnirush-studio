"use strict";

/**
 * Checks the runner's launch plan *inside a packaged build*.
 *
 * In a packaged app `process.execPath` is "OmniRush Studio.exe", so spawning it
 * with a script path would relaunch the GUI instead of the OmniRush CLI. This
 * asserts the packaged binary resolves a real interpreter instead.
 *
 * Usage (from the project root, after `npm run dist:dir`):
 *   set ELECTRON_RUN_AS_NODE=1 && "release\win-unpacked\OmniRush Studio.exe" test\check-packaged.cjs "release\win-unpacked\resources\app.asar"
 */

const path = require("node:path");
const fs = require("node:fs");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
}

const asar = path.resolve(process.argv[2] || path.join(__dirname, "..", "release", "win-unpacked", "resources", "app.asar"));
const runner = require(path.join(asar, "electron", "runner.cjs"));

const config = {
  cliPath: "",
  model: "gpt-6-astra",
  thinking: "",
  workdir: "C:/Users/aungt",
  extraArgs: "",
  yolo: true,
  staticModels: true,
  wslDistro: "Ubuntu",
  runner: "native",
};

check("running inside Electron's node mode", !!process.versions.electron, `electron ${process.versions.electron}`);
check("process.execPath is the app binary", /OmniRush Studio\.exe$/i.test(process.execPath), process.execPath);
check("the asar is readable", fs.existsSync(asar), asar);

const launch = runner.buildLaunch(config, "native");
check("native launch plan resolves", !!launch, launch ? launch.display : "no launcher found");

if (launch) {
  const spawnsItself = path.resolve(launch.command).toLowerCase() === path.resolve(process.execPath).toLowerCase();
  check(
    "the CLI is not spawned with the Electron GUI binary",
    !spawnsItself || launch.env.ELECTRON_RUN_AS_NODE === "1",
    spawnsItself ? `reused Electron with ELECTRON_RUN_AS_NODE=${launch.env.ELECTRON_RUN_AS_NODE}` : launch.command,
  );
  check("the entry point is omnirush/src/bin.js", launch.args.some((a) => /omnirush[\\/]src[\\/]bin\.js$/i.test(a)), launch.args[0]);
  check("the RPC flags are present", launch.args.includes("--mode") && launch.args.includes("rpc"), launch.args.join(" "));
  check("yolo is passed as --yolo on Windows", launch.args.includes("--yolo"), "");
}

const wsl = runner.buildLaunch(config, "wsl");
// The WSL flags are quoted shell words inside the `bash -lc` script, not
// separate argv entries, so the check has to look at the joined command.
const wslScript = wsl.args.join(" ");
check("wsl launch uses bash -lc", wsl.command === "wsl.exe" && wsl.args.includes("bash"), wsl.args.join(" "));
check("wsl passes --approve, not --yolo", wslScript.includes("--approve") && !wslScript.includes("--yolo"), "");

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length}/${results.length} checks FAILED` : `\nall ${results.length} packaged checks passed`);
process.exit(failed.length ? 1 : 0);
