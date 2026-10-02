"use strict";

/**
 * RTK (Rust Token Killer) integration.
 *
 * RTK is a CLI proxy that compresses command output before it reaches the
 * model's context window — the agent runs `git status`, RTK hands back a
 * compact form of it, and the tokens that would have been spent on the full
 * output are never spent. For OmniRush that matters because the CLI *is* the
 * `pi` coding agent, and in agentic mode most of a session's context is shell
 * output.
 *
 * RTK installs itself into an agent with `rtk init -g --agent pi`, which drops
 * a TypeScript extension into the agent's global extensions directory. That
 * directory is the whole integration, and on this stack it is not necessarily
 * the one RTK picks: OmniRush overrides the agent data dir with
 * OMNIRUSH_AGENT_DIR (default ~/.omnirush/agent), while `--agent pi` writes to
 * pi's own ~/.pi/agent. So "enable" here means: run RTK's installer, then
 * mirror the extension into every directory the CLI may read from, and report
 * where it landed.
 *
 * Everything runs in the environment the CLI actually runs in — native Windows
 * or a WSL distro — because an extension installed on the wrong side of the
 * WSL boundary is invisible to the agent.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { exec, firstLine, combined, shellQuote } = require("./proc.cjs");

const RTK_WINGET_ID = "rtk-ai.rtk";
const RTK_DOCS_URL = "https://www.rtk-ai.app";
const RTK_REPO_URL = "https://github.com/rtk-ai/rtk";
const INSTALL_SCRIPT =
  "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh";

/** Files that look like an agent extension hook. */
const EXTENSION_FILE = /\.(ts|mjs|cjs|js)$/i;
const RTK_FILE = /rtk/i;

// ---------------------------------------------------------------------------
// targets — where the agent runs, and therefore where RTK has to live
// ---------------------------------------------------------------------------

function nativeTarget() {
  const isWin = process.platform === "win32";
  const label = isWin ? "Windows (native)" : process.platform === "darwin" ? "macOS (native)" : "Linux (native)";
  return {
    mode: "native",
    label,
    isWindows: isWin,
    async home() {
      return os.homedir();
    },
    join: (...parts) => path.join(...parts),
    dirname: (p) => path.dirname(p),
    exec: (argv, opts) => exec(argv, opts),
    async which(name) {
      const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
      const exts = isWin ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
      for (const dir of dirs) {
        for (const ext of exts) {
          const candidate = path.join(dir, name + ext);
          try {
            if (fs.statSync(candidate).isFile()) return candidate;
          } catch {
            /* keep looking */
          }
        }
      }
      return null;
    },
    async listDir(dir) {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
      } catch {
        return null;
      }
    },
    async readFile(file) {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    },
    async copyFile(from, to) {
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        return true;
      } catch {
        return false;
      }
    },
    async backupFile(file) {
      try {
        fs.renameSync(file, `${file}.bak`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The same view, seen from inside a WSL distro. File operations go through
 * `bash -lc`; every interpolated value is single-quoted, and no user input is
 * ever spliced into a command unquoted.
 */
function wslTarget(distro) {
  const name = distro || "Ubuntu";
  const sh = (script, opts) => exec(["wsl.exe", "-d", name, "-e", "bash", "-lc", script], opts);
  let homeCache = null;
  return {
    mode: "wsl",
    label: `WSL · ${name}`,
    isWindows: true,
    distro: name,
    async home() {
      if (homeCache) return homeCache;
      const result = await sh('printf %s "$HOME"', { timeoutMs: 30000 });
      homeCache = result.stdout.trim() || "/root";
      return homeCache;
    },
    join: (...parts) => parts.filter(Boolean).join("/").replace(/\/{2,}/g, "/"),
    dirname: (p) => p.replace(/\/[^/]*$/, "") || "/",
    /** A Windows path as the distro sees it (C:\x -> /mnt/c/x). */
    toPath: (p) => {
      const text = String(p || "");
      if (!/^[A-Za-z]:[\\/]/.test(text)) return text;
      return `/mnt/${text[0].toLowerCase()}${text.slice(2).replace(/\\/g, "/")}`;
    },
    exec: (argv, opts) => sh(argv.map(shellQuote).join(" "), opts),
    async which(binary) {
      const result = await sh(`command -v ${shellQuote(binary)}`, { timeoutMs: 30000 });
      return result.ok ? firstLine(result) || null : null;
    },
    async listDir(dir) {
      const result = await sh(
        `if [ -d ${shellQuote(dir)} ]; then ls -1p ${shellQuote(dir)}; else echo __missing__; fi`,
        { timeoutMs: 30000 },
      );
      if (!result.ok) return null;
      const out = result.stdout.trim();
      if (!out || out === "__missing__") return out === "__missing__" ? null : [];
      return out.split("\n").map((line) => ({ name: line.replace(/\/$/, ""), dir: line.endsWith("/") }));
    },
    async readFile(file) {
      const result = await sh(`cat ${shellQuote(file)} 2>/dev/null || true`, { timeoutMs: 30000 });
      return result.ok ? result.stdout : null;
    },
    async copyFile(from, to) {
      const result = await sh(`mkdir -p ${shellQuote(path.posix.dirname(to))} && cp -f ${shellQuote(from)} ${shellQuote(to)}`, {
        timeoutMs: 30000,
      });
      return result.ok;
    },
    async backupFile(file) {
      const result = await sh(`mv -f ${shellQuote(file)} ${shellQuote(`${file}.bak`)}`, { timeoutMs: 30000 });
      return result.ok;
    },
  };
}

/** Pick the environment to install into: explicit mode wins, else the runner. */
async function resolveTarget(config = {}, mode) {
  const wanted = mode || config.runner || "auto";
  if (wanted === "wsl") return wslTarget(config.wslDistro);
  if (wanted === "native") return nativeTarget();
  if (process.platform === "win32") {
    const candidate = wslTarget(config.wslDistro);
    const probe = await candidate.exec(["true"], { timeoutMs: 20000 });
    if (probe.ok) return candidate;
  }
  return nativeTarget();
}

// ---------------------------------------------------------------------------
// inspection
// ---------------------------------------------------------------------------

/** Every directory the CLI might load extensions from, most likely first. */
async function extensionDirs(target, config = {}) {
  const home = await target.home();
  const agentDir = process.env.OMNIRUSH_AGENT_DIR || target.join(home, ".omnirush", "agent");
  const dirs = [
    // The CLI's own agent directory is the one it certainly loads from, so it
    // is the mirror target. The others are reported, not written to: dropping
    // files into the user's project folder is their call, not the app's.
    { id: "omnirush", label: "OmniRush agent", path: target.join(agentDir, "extensions"), primary: true },
    { id: "pi", label: "pi agent (what `rtk init` writes)", path: target.join(home, ".pi", "agent", "extensions") },
  ];
  const workdir = (config.workdir || "").trim();
  if (workdir) dirs.push({ id: "project", label: "Project", path: target.join(target.toPath ? target.toPath(workdir) : workdir, ".pi", "extensions") });
  return dirs;
}

async function inspectDir(target, dir) {
  const entries = await target.listDir(dir.path);
  if (entries === null) return { ...dir, exists: false, files: [] };
  const files = [];
  for (const entry of entries) {
    if (entry.dir || !EXTENSION_FILE.test(entry.name) || !RTK_FILE.test(entry.name)) continue;
    const file = target.join(dir.path, entry.name);
    const text = await target.readFile(file);
    files.push({ name: entry.name, path: file, bytes: text ? text.length : 0 });
  }
  return { ...dir, exists: true, files };
}

function installCommand(target) {
  if (target.mode === "wsl") return INSTALL_SCRIPT;
  if (target.isWindows) return `winget install --id ${RTK_WINGET_ID} -e`;
  if (process.platform === "darwin") return "brew install rtk";
  return INSTALL_SCRIPT;
}

/**
 * What is installed, where, and whether the agent would see it.
 */
async function status(config = {}, { mode, target } = {}) {
  const t = target || (await resolveTarget(config, mode));
  const home = await t.home();
  const info = {
    mode: t.mode,
    label: t.label,
    home,
    cli: { found: false, path: null, version: null },
    dirs: [],
    enabled: false,
    install: installCommand(t),
    docs: RTK_DOCS_URL,
    repo: RTK_REPO_URL,
  };

  const binary = await t.which("rtk");
  if (binary) {
    const version = await t.exec([binary, "--version"], { timeoutMs: 30000 });
    info.cli = {
      found: true,
      path: binary,
      version: firstLine(version) || (version.ok ? "installed" : null),
      error: version.ok ? null : combined(version, 400),
    };
  }

  const dirs = await extensionDirs(t, config);
  info.dirs = [];
  for (const dir of dirs) info.dirs.push(await inspectDir(t, dir));
  info.enabled = info.dirs.some((dir) => dir.files.length > 0);
  return info;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function enable(config = {}, opts = {}) {
  const t = opts.target || (await resolveTarget(config, opts.mode));
  const before = await status(config, { target: t });

  if (!before.cli.found) {
    return {
      ok: false,
      error: `rtk is not installed in ${t.label}. Install it first: ${before.install}`,
      output: "",
      copied: [],
      status: before,
    };
  }

  const home = await t.home();
  // `cwd` has to be a path the *host* process can chdir into: a Linux path is
  // meaningless to wsl.exe, and `-g` writes to the global agent dir anyway.
  const run = await t.exec([before.cli.path, "init", "-g", "--agent", "pi"], {
    cwd: t.mode === "native" ? home : undefined,
    timeoutMs: 180000,
  });
  const after = await status(config, { target: t });

  // `--agent pi` writes to pi's directory. OmniRush reads its own, so mirror
  // the hook into the CLI's agent directory before claiming the feature is on.
  const copied = [];
  const source = after.dirs.find((dir) => dir.files.length > 0);
  if (source) {
    for (const dir of after.dirs) {
      if (!dir.primary || dir.path === source.path) continue;
      for (const file of source.files) {
        if (dir.files.some((existing) => existing.name === file.name)) continue;
        if (await t.copyFile(file.path, t.join(dir.path, file.name))) copied.push(t.join(dir.path, file.name));
      }
    }
  }

  const final = copied.length ? await status(config, { target: t }) : after;
  const output = combined(run, 4000);
  return {
    ok: final.enabled,
    error: final.enabled ? null : run.error || output || `rtk init exited with code ${run.code} and wrote no extension`,
    output,
    copied,
    status: final,
  };
}

async function disable(config = {}, opts = {}) {
  const t = opts.target || (await resolveTarget(config, opts.mode));
  const before = await status(config, { target: t });
  const moved = [];
  for (const dir of before.dirs) {
    for (const file of dir.files) {
      if (await t.backupFile(file.path)) moved.push(file.path);
    }
  }
  return {
    ok: moved.length > 0,
    error: moved.length ? null : "No RTK extension was found, so there was nothing to disable.",
    output: "",
    moved,
    status: await status(config, { target: t }),
  };
}

/** Best-effort numbers out of `rtk gain`'s human-readable table. */
function parseSavings(text) {
  const saved = /(?:saved|savings)[^\d]{0,24}([\d.,]+)\s*(k|m)?\s*tokens?/i.exec(text);
  const percent = /([\d.]+)\s*%/.exec(text);
  const scale = saved && saved[2] ? (saved[2].toLowerCase() === "m" ? 1e6 : 1e3) : 1;
  return {
    savedTokens: saved ? Math.round(Number(saved[1].replace(/,/g, "")) * scale) : null,
    percent: percent ? Number(percent[1]) : null,
  };
}

async function gain(config = {}, opts = {}) {
  const t = opts.target || (await resolveTarget(config, opts.mode));
  const info = await status(config, { target: t });
  if (!info.cli.found) {
    return { ok: false, error: `rtk is not installed in ${t.label}.`, text: "", status: info };
  }

  const text = await t.exec([info.cli.path, "gain"], { timeoutMs: 60000 });
  const json = await t.exec([info.cli.path, "gain", "--all", "--format", "json"], { timeoutMs: 60000 });
  let parsed = null;
  try {
    parsed = JSON.parse(json.stdout);
  } catch {
    parsed = null;
  }

  const readable = combined(text, 6000) || combined(json, 2000);
  const savings = parseSavings(readable);
  return {
    ok: text.ok || Boolean(parsed),
    error: text.ok ? null : combined(text, 400) || "rtk gain failed",
    text: readable,
    json: parsed,
    ...savings,
    status: info,
  };
}

async function install(config = {}, opts = {}) {
  const t = opts.target || (await resolveTarget(config, opts.mode));
  if (t.mode === "native" && !t.isWindows) {
    return { ok: false, error: `Install RTK by hand, then press Refresh: ${installCommand(t)}`, output: "", status: await status(config, { target: t }) };
  }
  const argv =
    t.mode === "native"
      ? ["winget", "install", "--id", RTK_WINGET_ID, "-e", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"]
      : ["bash", "-lc", INSTALL_SCRIPT];
  const run = await t.exec(argv, { timeoutMs: 600000 });
  const after = await status(config, { target: t });
  return {
    ok: after.cli.found,
    error: after.cli.found ? null : run.error || combined(run, 600) || "rtk still not found on PATH after installing",
    output: combined(run, 6000),
    status: after,
  };
}

module.exports = {
  RTK_WINGET_ID,
  RTK_DOCS_URL,
  RTK_REPO_URL,
  INSTALL_SCRIPT,
  nativeTarget,
  wslTarget,
  resolveTarget,
  extensionDirs,
  installCommand,
  status,
  enable,
  disable,
  gain,
  install,
  parseSavings,
};
