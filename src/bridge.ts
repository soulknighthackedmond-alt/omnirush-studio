import type {
  AppState,
  Config,
  LogEntry,
  RtkActionResult,
  RtkGain,
  RtkMode,
  RtkStatus,
  RunnerInfo,
  ServerStatus,
  TestResult,
  WslRepair,
} from "./types";

export interface Bridge {
  state(): Promise<AppState>;
  saveConfig(patch: Partial<Config>): Promise<AppState>;
  startServer(): Promise<{ ok: boolean; error?: string; state: AppState }>;
  stopServer(): Promise<{ ok: boolean; state: AppState }>;
  detectRunners(): Promise<RunnerInfo[]>;
  testRunner(prompt?: string): Promise<TestResult>;
  rtkStatus(opts?: { mode?: RtkMode }): Promise<RtkStatus>;
  rtkEnable(opts?: { mode?: RtkMode }): Promise<RtkActionResult>;
  rtkDisable(opts?: { mode?: RtkMode }): Promise<RtkActionResult>;
  rtkInstall(opts?: { mode?: RtkMode }): Promise<RtkActionResult>;
  rtkGain(opts?: { mode?: RtkMode }): Promise<RtkGain>;
  repairWsl(): Promise<WslRepair>;
  listLogs(): Promise<LogEntry[]>;
  clearLogs(): Promise<LogEntry[]>;
  openExternal(url: string): Promise<void>;
  onServerState(fn: (status: ServerStatus) => void): () => void;
  onLogEntry(fn: (entry: LogEntry) => void): () => void;
}

declare global {
  interface Window {
    omnirush?: Bridge;
  }
}

/** Present only inside Electron; absent when the bundle is opened in a browser. */
export const bridge: Bridge | undefined = typeof window !== "undefined" ? window.omnirush : undefined;

export const isDesktop = Boolean(bridge);

const noop = () => () => {};

/** Lets the UI render (and the playground still work) outside Electron. */
export const fallbackState: AppState = {
  config: {
    runner: "auto",
    cliPath: "",
    wslDistro: "Ubuntu",
    model: "gpt-6-astra",
    thinking: "",
    workdir: "",
    extraArgs: "",
    yolo: true,
    staticModels: true,
    agentic: false,
    host: "127.0.0.1",
    port: 8787,
    apiKey: "",
    maxConcurrency: 2,
    requestTimeout: 900,
    streamMode: "live",
    autoStart: true,
    playgroundPrompt: "Say hello in one short sentence.",
  },
  paths: { config: "", appDir: "" },
  models: ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "meta-muse-spark", "muse-spark-1.1"],
  thinkingLevels: ["", "minimal", "low", "medium", "high", "xhigh", "max"],
  server: {
    running: false,
    host: "127.0.0.1",
    port: 8787,
    baseUrl: "http://127.0.0.1:8787/v1",
    active: 0,
    queued: 0,
    maxConcurrency: 2,
    stats: { requests: 0, errors: 0, startedAt: null, lastError: null },
  },
  versions: { app: "0.1.0", electron: "—", chrome: "—", node: "—", platform: "—" },
};

const previewRtkStatus: RtkStatus = {
  mode: "native",
  label: "preview",
  home: "—",
  cli: { found: false, path: null, version: null },
  dirs: [],
  enabled: false,
  install: "winget install --id rtk-ai.rtk -e",
  docs: "https://www.rtk-ai.app",
  repo: "https://github.com/rtk-ai/rtk",
};

export const previewBridge: Bridge = {
  state: async () => fallbackState,
  saveConfig: async (patch) => ({ ...fallbackState, config: { ...fallbackState.config, ...patch } }),
  startServer: async () => ({ ok: false, error: "Not running inside Electron.", state: fallbackState }),
  stopServer: async () => ({ ok: false, state: fallbackState }),
  detectRunners: async () => [
    { mode: "native", label: "Native CLI", available: false, detail: "Only available inside the desktop app.", launch: null },
  ],
  testRunner: async () => ({ ok: false, runner: null, error: "Only available inside the desktop app." }),
  rtkStatus: async () => previewRtkStatus,
  rtkEnable: async () => ({ ok: false, error: "Only available inside the desktop app.", status: previewRtkStatus }),
  rtkDisable: async () => ({ ok: false, error: "Only available inside the desktop app.", status: previewRtkStatus }),
  rtkInstall: async () => ({ ok: false, error: "Only available inside the desktop app.", status: previewRtkStatus }),
  rtkGain: async () => ({ ok: false, error: "Only available inside the desktop app.", text: "", status: previewRtkStatus }),
  repairWsl: async () => ({
    ok: false,
    distro: "—",
    steps: [],
    detail: "Only available inside the desktop app.",
    guidance: null,
  }),
  listLogs: async () => [],
  clearLogs: async () => [],
  openExternal: async () => {},
  onServerState: noop,
  onLogEntry: noop,
};
