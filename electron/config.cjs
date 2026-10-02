"use strict";

/**
 * Settings for OmniRush Studio.
 *
 * Deliberately free of any `electron` import so the same file (and therefore
 * the same settings) is used by the GUI and by `npm run api`, the headless
 * server entry point.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_DIR_NAME = "omnirush-studio";

// Models the CLI advertises (`omnirush --help`). The live list comes from the
// manager, so the UI treats this as suggestions rather than a closed set.
const KNOWN_MODELS = [
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-5.6-sol",
  "meta-muse-spark",
  "muse-spark-1.1",
];

const THINKING_LEVELS = ["", "minimal", "low", "medium", "high", "xhigh", "max"];

// Bumped when a stored setting has to be rewritten; see `migrate` below.
const CONFIG_VERSION = 2;

const DEFAULTS = {
  configVersion: CONFIG_VERSION,
  // --- how the CLI is launched -----------------------------------------
  runner: "auto", // auto | native | wsl
  cliPath: "", // empty = auto-detect
  wslDistro: "Ubuntu",
  model: "gpt-6-astra",
  thinking: "",
  workdir: "", // empty = the OS home directory
  extraArgs: "",
  yolo: true,
  staticModels: true,
  agentic: false, // false = answer directly, true = let the coding agent use tools

  // --- the OpenAI-compatible server ------------------------------------
  host: "127.0.0.1",
  port: 8787,
  apiKey: "",
  maxConcurrency: 2,
  requestTimeout: 900,
  streamMode: "live", // live = stream the agent's deltas, final = one chunk at the end
  autoStart: true,

  // --- UI ---------------------------------------------------------------
  playgroundPrompt: "Say hello in one short sentence.",
};

function configDir() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, APP_DIR_NAME);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, APP_DIR_NAME);
}

function configPath() {
  return path.join(configDir(), "config.json");
}

/**
 * v1 shipped port 8000, which collides with the default port of too many
 * other local tools. Anything still sitting on the old default is moved to
 * the new one; a port the user typed themselves is left alone.
 */
function migrate(raw, cfg) {
  const version = Number(raw.configVersion) || 1;
  if (version < 2) {
    if (raw.port === undefined || Number(raw.port) === 8000) cfg.port = DEFAULTS.port;
    cfg.configVersion = CONFIG_VERSION;
  }
  return cfg;
}

function load() {
  const defaults = { ...DEFAULTS, workdir: DEFAULTS.workdir || os.homedir() };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return defaults;
  }
  const cfg = { ...defaults };
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined) cfg[key] = raw[key];
  }
  migrate(raw, cfg);
  if (!cfg.workdir) cfg.workdir = os.homedir();
  return cfg;
}

function save(cfg) {
  const merged = { ...DEFAULTS, ...cfg, configVersion: CONFIG_VERSION };
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

module.exports = {
  APP_DIR_NAME,
  CONFIG_VERSION,
  KNOWN_MODELS,
  THINKING_LEVELS,
  DEFAULTS,
  configDir,
  configPath,
  load,
  migrate,
  save,
};
