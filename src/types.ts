export type RunnerMode = "auto" | "native" | "wsl";

export interface Config {
  runner: RunnerMode;
  cliPath: string;
  wslDistro: string;
  model: string;
  thinking: string;
  workdir: string;
  extraArgs: string;
  yolo: boolean;
  staticModels: boolean;
  agentic: boolean;
  host: string;
  port: number;
  apiKey: string;
  maxConcurrency: number;
  requestTimeout: number;
  streamMode: "live" | "final";
  autoStart: boolean;
  playgroundPrompt: string;
}

export interface ServerStatus {
  running: boolean;
  host: string;
  port: number;
  baseUrl: string;
  active: number;
  queued: number;
  maxConcurrency: number;
  stats: {
    requests: number;
    errors: number;
    startedAt: string | null;
    lastError: string | null;
  };
}

export interface AppState {
  config: Config;
  paths: { config: string; appDir: string };
  models: string[];
  thinkingLevels: string[];
  server: ServerStatus;
  versions: {
    app: string;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
  };
}

export interface LogEntry {
  id: number;
  at: string;
  level: "info" | "warn" | "error" | "success";
  scope: string;
  message: string;
}

export interface RunnerInfo {
  mode: "native" | "wsl";
  label: string;
  available: boolean;
  detail: string;
  launch: string | null;
}

export interface TestResult {
  ok: boolean;
  runner: string | null;
  mode?: string;
  version?: string;
  text?: string;
  error?: string | null;
  durationMs?: number;
  usage?: { input?: number; output?: number; totalTokens?: number } | null;
}

/** RTK compression (see electron/rtk.cjs). */
export type RtkMode = "auto" | "native" | "wsl";

export interface RtkExtensionDir {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  files: { name: string; path: string; bytes: number }[];
}

export interface RtkStatus {
  mode: "native" | "wsl";
  label: string;
  home: string;
  cli: { found: boolean; path: string | null; version: string | null; error?: string | null };
  dirs: RtkExtensionDir[];
  enabled: boolean;
  install: string;
  docs: string;
  repo: string;
}

export interface RtkActionResult {
  ok: boolean;
  error?: string | null;
  output?: string;
  copied?: string[];
  moved?: string[];
  status: RtkStatus;
}

export interface RtkGain {
  ok: boolean;
  error?: string | null;
  text: string;
  json?: unknown;
  savedTokens?: number | null;
  percent?: number | null;
  status: RtkStatus;
}

export interface WslRepair {
  ok: boolean;
  distro: string;
  steps: { label: string; ok: boolean; output: string }[];
  detail: string;
  guidance?: string | null;
}
