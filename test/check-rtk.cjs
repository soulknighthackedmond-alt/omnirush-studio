#!/usr/bin/env node
"use strict";

/**
 * Checks the RTK integration without RTK installed and without an OmniRush
 * account: test/fake-rtk.cjs stands in for the binary, and the target object
 * is pointed at a throwaway HOME so nothing touches the real machine.
 *
 *   node test/check-rtk.cjs
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rtk = require("../electron/rtk.cjs");
const wsl = require("../electron/wsl.cjs");
const { exec } = require("../electron/proc.cjs");

const FAKE = path.join(__dirname, "fake-rtk.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omnirush-rtk-"));
const home = path.join(tmp, "home");
const workdir = path.join(tmp, "work");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workdir, { recursive: true });

let failures = 0;
function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
}

/** A native target that resolves its home to the temp dir and runs the fake. */
function fakeTarget() {
  const target = rtk.nativeTarget();
  target.home = async () => home;
  target.which = async (name) => (name === "rtk" ? "rtk" : null);
  target.exec = (argv, opts = {}) =>
    exec([process.execPath, FAKE, ...argv.slice(1)], {
      ...opts,
      env: { ...process.env, RTK_FAKE_HOME: home },
    });
  return target;
}

const config = { workdir, wslDistro: "Ubuntu", runner: "auto" };

(async () => {
  // --- PATH lookup on the real native target -----------------------------
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exeName = process.platform === "win32" ? "rtk.exe" : "rtk";
  fs.writeFileSync(path.join(binDir, exeName), "", "utf8");
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  const found = await rtk.nativeTarget().which("rtk");
  process.env.PATH = savedPath;
  check("native which() finds rtk on PATH", found && found.toLowerCase().endsWith(exeName.toLowerCase()), found || "not found");

  // --- status before enabling -------------------------------------------
  const target = fakeTarget();
  const before = await rtk.status(config, { target });
  check("status: rtk is found", before.cli.found === true);
  check("status: version is read", before.cli.version === "rtk 9.9.9-fake", String(before.cli.version));
  check("status: not enabled yet", before.enabled === false);
  check(
    "status: lists the OmniRush agent dir and the pi dir",
    before.dirs.length >= 2 && before.dirs.some((d) => d.id === "omnirush") && before.dirs.some((d) => d.id === "pi"),
    before.dirs.map((d) => d.id).join(","),
  );
  check("status: dirs do not exist yet", before.dirs.every((d) => d.exists === false));
  check("status: install hint mentions winget on Windows", /winget|install\.sh/.test(before.install), before.install);

  // --- enable mirrors the hook across directories -----------------------
  const enabled = await rtk.enable(config, { target });
  check("enable: succeeds", enabled.ok === true, enabled.error || "");
  check("enable: reports rtk init output", /installed pi extension/.test(enabled.output || ""), (enabled.output || "").slice(0, 80));
  check("enable: mirrored into the OmniRush agent dir", (enabled.copied || []).length === 1, JSON.stringify(enabled.copied));
  check("enable: status now says enabled", enabled.status.enabled === true);
  check(
    "enable: the pi dir and the OmniRush dir hold the hook",
    enabled.status.dirs.filter((d) => d.files.length > 0).length === 2,
    enabled.status.dirs.map((d) => `${d.id}:${d.files.length}`).join(" "),
  );
  check(
    "enable: leaves the project folder alone",
    !fs.existsSync(path.join(workdir, ".pi", "extensions", "rtk.ts")),
    path.join(workdir, ".pi", "extensions", "rtk.ts"),
  );
  check(
    "enable: the file on disk is the one RTK wrote",
    fs.existsSync(path.join(home, ".omnirush", "agent", "extensions", "rtk.ts")),
    path.join(home, ".omnirush", "agent", "extensions", "rtk.ts"),
  );

  // --- savings -----------------------------------------------------------
  const gain = await rtk.gain(config, { target });
  check("gain: succeeds", gain.ok === true, gain.error || "");
  check("gain: json is parsed", gain.json && gain.json.saved_tokens === 18234, JSON.stringify(gain.json));
  check("gain: saved tokens are read out of the table", gain.savedTokens === 18234, String(gain.savedTokens));
  check("gain: percentage is read out of the table", gain.percent === 30.7, String(gain.percent));

  // --- disable -----------------------------------------------------------
  const disabled = await rtk.disable(config, { target });
  check("disable: renames both hooks", (disabled.moved || []).length === 2, JSON.stringify(disabled.moved));
  check("disable: status is off again", disabled.status.enabled === false);
  check(
    "disable: backups are on disk",
    fs.existsSync(path.join(home, ".pi", "agent", "extensions", "rtk.ts.bak")),
  );

  // --- enabling without rtk installed ------------------------------------
  const bare = fakeTarget();
  bare.which = async () => null;
  const missing = await rtk.enable(config, { target: bare });
  check("enable: refuses cleanly when rtk is missing", missing.ok === false && /not installed/.test(missing.error || ""), missing.error || "");

  // --- command construction ---------------------------------------------
  check("wsl target: install uses the shell script", rtk.installCommand(rtk.wslTarget("Ubuntu")).includes("install.sh"));
  check("wsl target: label names the distro", rtk.wslTarget("Ubuntu").label === "WSL · Ubuntu");
  check("wsl: repair guidance mentions the VM platform", /Virtual Machine Platform/.test(wsl.GUIDANCE));

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? "all RTK checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
