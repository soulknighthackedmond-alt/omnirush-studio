"use strict";

/**
 * WSL health, and the two commands that fix the common failure.
 *
 * OmniRush refuses to serve model requests from native Windows — the gateway
 * answers `OmniRush on Windows now runs in WSL` — so on this platform the CLI
 * only ever works inside a distro. When the distro will not boot, every API
 * request fails with that same message and nothing about it is fixable from
 * inside the app; the best the app can do is name the OS-level cause and run
 * the repair commands that do not need a reboot.
 */

const { exec, firstLine, combined } = require("./proc.cjs");

const GUIDANCE = [
  "WSL cannot start its virtual machine (CreateVm failed).",
  "Run `wsl --update` and reboot, and make sure virtualization is enabled in the BIOS/UEFI and that the",
  "Windows features 'Virtual Machine Platform' and 'Windows Subsystem for Linux' are both ticked",
  "(optionalfeatures.exe). If it still fails, `wsl --set-version <distro> 1` runs a distro without a VM.",
].join(" ");

/** Is the distro actually able to run a command right now? */
async function probe(distro) {
  const name = distro || "Ubuntu";
  const result = await exec(["wsl.exe", "-d", name, "-e", "echo", "ok"], { timeoutMs: 60000 });
  return {
    ok: result.ok && result.stdout.includes("ok"),
    detail: (firstLine(result) || combined(result, 400) || "no output").trim(),
    durationMs: result.durationMs,
  };
}

async function status(distro) {
  const name = distro || "Ubuntu";
  const list = await exec(["wsl.exe", "-l", "-v"], { timeoutMs: 60000 });
  return {
    distro: name,
    listing: combined(list, 2000),
    ...(await probe(name)),
    guidance: GUIDANCE,
  };
}

/**
 * `wsl --update` then `wsl --shutdown` then re-probe. Both steps are safe to
 * run repeatedly; neither needs elevation on a normal install.
 */
async function repair(distro) {
  const name = distro || "Ubuntu";
  const steps = [];

  for (const [label, argv] of [
    ["wsl --update", ["wsl.exe", "--update"]],
    ["wsl --shutdown", ["wsl.exe", "--shutdown"]],
  ]) {
    const result = await exec(argv, { timeoutMs: 600000 });
    steps.push({ label, ok: result.ok, output: combined(result, 2000) });
  }

  const after = await probe(name);
  return { ok: after.ok, distro: name, steps, detail: after.detail, guidance: after.ok ? null : GUIDANCE };
}

module.exports = { GUIDANCE, probe, status, repair };
