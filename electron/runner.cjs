"use strict";

/**
 * Works out *how* to start the OmniRush CLI on this machine.
 *
 * Two runners exist:
 *   native - spawn the installed CLI directly (Linux, macOS, and Windows
 *            installs that still serve model traffic).
 *   wsl    - `wsl.exe -d <distro> -e bash -lc "omnirush ..."`. The OmniRush
 *            gateway currently refuses Windows-native model calls and tells the
 *            client to move to WSL, so this is the Windows path that works.
 *
 * Everything is a plain argv array; nothing is ever handed to a shell on the
 * host, so prompt text cannot be interpreted as a command.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const IS_WINDOWS = process.platform === "win32";

// Detection runs a real probe inside WSL, so the answer is cached briefly and
// the API path never pays for it on every request.
const DETECT_TTL_MS = 120000;
let detectionCache = null;

// Booting a stopped WSL2 VM takes far longer than a warm `command -v`, so the
// probe gets a generous budget: too short a timeout looks exactly like "WSL is
// broken" and drops the app onto the native runner, which the gateway refuses.
const WSL_PROBE_TIMEOUT_MS = 45000;

// A runner can look healthy and still die on a real run (a WSL distro that
// boots for the probe and then loses its VM, for example). Failures are
// remembered briefly so the next request prefers the other runner.
const FAILURE_TTL_MS = 300000;
const runFailures = new Map();

function markRunFailure(mode) {
  if (!mode) return;
  const entry = runFailures.get(mode) || { count: 0, at: 0 };
  entry.count += 1;
  entry.at = Date.now();
  runFailures.set(mode, entry);
  detectionCache = null;
}

function markRunSuccess(mode) {
  if (mode) runFailures.delete(mode);
}

function isFlaky(mode) {
  const entry = runFailures.get(mode);
  return !!entry && Date.now() - entry.at < FAILURE_TTL_MS;
}

/** True when the CLI itself died, as opposed to the model returning an error. */
function isProcessFailure(error) {
  return /CLI exited with code|could not start the OmniRush CLI|CLI timed out/i.test(String(error || ""));
}

function splitArgs(input) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input || ""))) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function npmGlobalRoots() {
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  if (process.env.PREFIX) roots.push(path.join(process.env.PREFIX, "lib", "node_modules"));
  roots.push(
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
  );
  return roots;
}

function findOnPath(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const suffixes = IS_WINDOWS ? [".cmd", ".exe", ".bat", ""] : ["", ".sh"];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const full = path.join(dir, name + suffix);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * The interpreter that runs a `.js` entry point such as `omnirush/src/bin.js`.
 *
 * Under `electron .` in development `process.execPath` is node itself, but in a
 * packaged build it is OmniRush Studio.exe — spawning that with a script path
 * would relaunch the GUI instead of the CLI. So a packaged app looks for a real
 * node on PATH and falls back to Electron's own node mode.
 */
function nodeLauncher() {
  if (!process.versions.electron) return { command: process.execPath, env: {} };
  const node = findOnPath("node");
  if (node && !/\.(cmd|bat)$/i.test(node)) return { command: node, env: {} };
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/**
 * `%APPDATA%\npm\omnirush.cmd` is only a shim. Node refuses to spawn a .cmd
 * without a shell, so prefer the real entry point next to it.
 */
function entryFromShim(shim) {
  const dir = path.dirname(shim);
  const candidates = [
    path.join(dir, "node_modules", "omnirush", "src", "bin.js"),
    path.join(dir, "..", "lib", "node_modules", "omnirush", "src", "bin.js"),
    path.join(dir, "..", "omnirush", "src", "bin.js"),
  ];
  return candidates.find(exists) || null;
}

function launcherFor(foundPath) {
  const entry = entryFromShim(foundPath);
  if (entry) {
    const node = nodeLauncher();
    return { command: node.command, prefixArgs: [entry], display: entry, shellShim: false, env: node.env };
  }
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(foundPath)) {
    return { command: process.env.COMSPEC || "cmd.exe", prefixArgs: [], display: foundPath, shellShim: true, shim: foundPath, env: {} };
  }
  return { command: foundPath, prefixArgs: [], display: foundPath, shellShim: false, env: {} };
}

function resolveNative(config) {
  const explicit = (config.cliPath || "").trim();
  if (explicit) {
    if (exists(explicit)) {
      if (/\.(js|mjs|cjs)$/i.test(explicit)) {
        const node = nodeLauncher();
        return { command: node.command, prefixArgs: [explicit], display: explicit, shellShim: false, env: node.env };
      }
      return launcherFor(explicit);
    }
    const onPath = findOnPath(explicit);
    if (onPath) return launcherFor(onPath);
    return null;
  }
  const onPath = findOnPath("omnirush");
  if (onPath) return launcherFor(onPath);
  for (const root of npmGlobalRoots()) {
    const entry = path.join(root, "omnirush", "src", "bin.js");
    if (exists(entry)) {
      const node = nodeLauncher();
      return { command: node.command, prefixArgs: [entry], display: entry, shellShim: false, env: node.env };
    }
  }
  return null;
}

/** `C:\Users\alvin\code` -> `/mnt/c/Users/alvin/code` */
function toWslPath(winPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!match) return winPath.replace(/\\/g, "/");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function shq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quoteWin(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** The CLI arguments that put the agent in the headless JSON-RPC protocol. */
function cliFlags(config, mode = "native") {
  const flags = ["--mode", "rpc", "--no-session"];
  if (config.yolo) {
    // The Windows entry point rewrites --yolo into the core's --approve; the
    // Linux CLI has no --yolo flag at all ("Unknown option: --yolo"), so the
    // WSL launch has to ask the core directly.
    flags.push(mode === "wsl" ? "--approve" : "--yolo");
  }
  if ((config.model || "").trim()) flags.push("--model", config.model.trim());
  if ((config.thinking || "").trim()) flags.push("--thinking", config.thinking.trim());
  flags.push(...splitArgs(config.extraArgs));
  return flags;
}

function baseEnv(config) {
  const env = { ...process.env };
  if (config.staticModels) env.OMNIRUSH_STATIC_MODELS = "1";
  else delete env.OMNIRUSH_STATIC_MODELS;
  return env;
}

/**
 * @returns {{mode:string, command:string, args:string[], cwd?:string, env:object, display:string, workdir:string}|null}
 */
function buildLaunch(config, mode) {
  const flags = cliFlags(config, mode);
  const workdir = (config.workdir || "").trim() || os.homedir();

  if (mode === "wsl") {
    const distro = (config.wslDistro || "").trim();
    const cli = (config.cliPath || "").trim() || "omnirush";
    const linuxDir = toWslPath(workdir);
    const envPrefix = config.staticModels ? "OMNIRUSH_STATIC_MODELS=1 " : "";
    const script = `cd ${shq(linuxDir)} && ${envPrefix}exec ${cli} ${flags.map(shq).join(" ")}`;
    const args = [];
    if (distro) args.push("-d", distro);
    args.push("-e", "bash", "-lc", script);
    return {
      mode: "wsl",
      command: "wsl.exe",
      args,
      env: { ...process.env },
      display: `wsl${distro ? " -d " + distro : ""} → ${cli} --mode rpc`,
      workdir: linuxDir,
    };
  }

  const launcher = resolveNative(config);
  if (!launcher) return null;
  // A packaged build may need ELECTRON_RUN_AS_NODE to reuse Electron's own node.
  const env = { ...baseEnv(config), ...(launcher.env || {}) };
  if (launcher.shellShim) {
    const inner = [launcher.shim, ...flags].map(quoteWin).join(" ");
    return {
      mode: "native",
      command: launcher.command,
      args: ["/d", "/s", "/c", inner],
      env,
      display: launcher.display,
      workdir,
    };
  }
  return {
    mode: "native",
    command: launcher.command,
    args: [...launcher.prefixArgs, ...flags],
    cwd: workdir,
    env,
    display: launcher.display,
    workdir,
  };
}

function runCapture(command, args, timeoutMs, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    } catch (err) {
      resolve({ ok: false, stdout: "", stderr: String(err.message), code: null });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ok: false, stdout, stderr: stderr || `timed out after ${timeoutMs}ms`, code: null });
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(err.message), code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

async function probeWsl(config) {
  if (!IS_WINDOWS) {
    return { available: false, detail: "WSL is only used on Windows" };
  }
  const distro = (config.wslDistro || "").trim();
  const args = [];
  if (distro) args.push("-d", distro);
  // A Windows install is visible through /mnt and would answer `command -v`
  // while being unusable from inside the distro, so it is reported separately.
  const probe =
    'p=$(command -v omnirush); if [ -z "$p" ]; then echo __OMNIRUSH_MISSING__; ' +
    'elif [ "${p#/mnt/}" != "$p" ]; then echo __OMNIRUSH_WINDOWS__ "$p"; else echo "$p"; fi';
  args.push("-e", "bash", "-lc", probe);
  const res = await runCapture("wsl.exe", args, WSL_PROBE_TIMEOUT_MS);
  const out = res.stdout.trim();
  const err = res.stderr.trim();
  const noise = `${err}\n${out}`;

  // `wsl.exe` can exit 0 and still print nothing but a failure banner, so the
  // exit code alone is not evidence that the distro booted.
  if (/catastrophic failure|E_UNEXPECTED|CreateVm|CreateInstance|0x8007|WSL_E_/i.test(noise)) {
    const line = noise.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    return {
      available: false,
      detail: `WSL (${distro || "default"}) cannot start a VM: ${line.slice(0, 260)} — press Repair WSL in Settings, or see https://omnirush.ai/console/wsl`,
    };
  }
  if (!out) {
    // An empty answer after the full budget is inconclusive, not a verdict:
    // the distro may still be booting. Callers retry rather than cache it.
    const timedOut = /timed out/i.test(err) || res.code === null;
    return {
      available: false,
      inconclusive: timedOut,
      detail: timedOut
        ? `WSL (${distro || "default"}) did not answer within ${Math.round(WSL_PROBE_TIMEOUT_MS / 1000)}s — the distro is probably still booting`
        : `wsl.exe returned no output (exit ${res.code ?? "null"}): ${(err || "no stderr").slice(0, 200)}`,
    };
  }
  if (!res.ok && !out.includes("__OMNIRUSH_MISSING__")) {
    return { available: false, detail: `wsl.exe failed: ${(err || out || "no output").trim().slice(0, 300)}` };
  }
  if (out.includes("__OMNIRUSH_MISSING__")) {
    return {
      available: false,
      detail: `WSL (${distro || "default"}) is up but omnirush is not installed there — run: wsl -d ${distro || "Ubuntu"} -- bash -lc "npm i -g omnirush && omnirush login"`,
    };
  }
  if (out.includes("__OMNIRUSH_WINDOWS__")) {
    const path = out.replace("__OMNIRUSH_WINDOWS__", "").trim();
    return {
      available: false,
      detail: `only the Windows install is on PATH inside ${distro || "the distro"} (${path}) — install it in the distro: wsl -d ${distro || "Ubuntu"} -- bash -lc "npm i -g omnirush && omnirush login"`,
    };
  }
  if (!/^(\/|[A-Za-z]:)/.test(lastLine(out))) {
    return { available: false, detail: `unexpected answer from WSL: ${out.slice(0, 200)}` };
  }
  return { available: true, detail: `omnirush found in WSL (${distro || "default"}) at ${out.split("\n").pop()}` };
}

async function detect(config, options = {}) {
  const cacheKey = JSON.stringify([
    config.cliPath,
    config.wslDistro,
    config.model,
    config.thinking,
    config.extraArgs,
    config.yolo,
    config.staticModels,
    config.workdir,
    config.runner,
  ]);
  const now = Date.now();
  if (!options.force && detectionCache && detectionCache.key === cacheKey && now - detectionCache.at < DETECT_TTL_MS) {
    return detectionCache.results;
  }

  const results = [];

  const nativeLaunch = buildLaunch(config, "native");
  results.push({
    mode: "native",
    label: "Native CLI",
    available: !!nativeLaunch,
    detail: nativeLaunch ? nativeLaunch.display : "omnirush not found on PATH, in npm's global root, or at the configured path",
    launch: nativeLaunch,
  });

  const wantWslProbe = IS_WINDOWS && (options.force || (config.runner || "auto") !== "native");
  const wslProbe = wantWslProbe
    ? await probeWsl(config)
    : { available: false, detail: IS_WINDOWS ? "not probed (native runner selected)" : "WSL is only used on Windows" };
  const wslLaunch = buildLaunch(config, "wsl");
  results.push({
    mode: "wsl",
    label: "Windows Subsystem for Linux",
    available: wslProbe.available,
    inconclusive: !!wslProbe.inconclusive,
    detail: wslProbe.detail,
    launch: wslLaunch,
  });

  // Only a definite answer is worth caching; an inconclusive probe must be
  // re-tried, or one slow boot would pin the app to the wrong runner.
  detectionCache = wslProbe.inconclusive ? null : { key: cacheKey, at: now, results };
  return results;
}

/** Resolve the runner the app should actually use, honouring an explicit choice. */
async function resolveRunner(config) {
  let results = await detect(config);
  let byMode = Object.fromEntries(results.map((r) => [r.mode, r]));
  // A timed-out probe says nothing about WSL — the distro may just be booting.
  // Give it one more go before falling back to the runner the gateway refuses.
  if (byMode.wsl?.inconclusive) {
    results = await detect(config, { force: true });
    byMode = Object.fromEntries(results.map((r) => [r.mode, r]));
  }
  const wanted = (config.runner || "auto").trim();
  if (wanted !== "auto" && byMode[wanted]) {
    const chosen = byMode[wanted];
    if (!chosen.available) {
      return { ok: false, mode: wanted, results, error: `${chosen.label} is not usable: ${chosen.detail}` };
    }
    return { ok: true, mode: wanted, launch: chosen.launch, results };
  }
  const order = IS_WINDOWS ? ["wsl", "native"] : ["native", "wsl"];
  const ranked = [...order].sort((a, b) => Number(isFlaky(a)) - Number(isFlaky(b)));
  for (const mode of ranked) {
    if (byMode[mode]?.available) {
      return { ok: true, mode, launch: byMode[mode].launch, results };
    }
  }
  return {
    ok: false,
    mode: null,
    results,
    error: results.map((r) => `${r.label}: ${r.detail}`).join(" · "),
  };
}

/** One-shot `omnirush --version` through the chosen runner, for the UI's test button. */
async function versionThrough(config, mode) {
  if (mode === "wsl") {
    const distro = (config.wslDistro || "").trim();
    const cli = (config.cliPath || "").trim() || "omnirush";
    const args = [];
    if (distro) args.push("-d", distro);
    args.push("-e", "bash", "-lc", `${cli} --version 2>&1 || true`);
    const res = await runCapture("wsl.exe", args, 30000);
    return lastLine(res.stdout + res.stderr);
  }
  const launcher = resolveNative(config);
  if (!launcher) return "";
  const args = launcher.shellShim
    ? ["/d", "/s", "/c", [launcher.shim, "--version"].map(quoteWin).join(" ")]
    : [...launcher.prefixArgs, "--version"];
  const res = await runCapture(launcher.command, args, 30000, launcher.env);
  return lastLine(res.stdout + res.stderr);
}

function lastLine(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

module.exports = {
  IS_WINDOWS,
  splitArgs,
  toWslPath,
  cliFlags,
  buildLaunch,
  detect,
  resolveRunner,
  versionThrough,
  runCapture,
  markRunFailure,
  markRunSuccess,
  isFlaky,
  isProcessFailure,
};
