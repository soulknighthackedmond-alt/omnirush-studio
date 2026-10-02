import { useCallback, useEffect, useState } from "react";
import { bridge, fallbackState, isDesktop, previewBridge } from "./bridge";
import type { AppState, Config, LogEntry, RunnerInfo, TestResult } from "./types";
import { Overview } from "./components/Overview";
import { Playground } from "./components/Playground";
import { Settings } from "./components/Settings";
import { Compression } from "./components/Compression";
import { Logs } from "./components/Logs";

type Page = "overview" | "playground" | "compression" | "settings" | "logs";

const PAGES: { id: Page; label: string; glyph: string; title: string; blurb: string }[] = [
  {
    id: "overview",
    label: "Overview",
    glyph: "◎",
    title: "Overview",
    blurb: "Status of the local gateway, the CLI it drives, and the endpoints it serves.",
  },
  {
    id: "playground",
    label: "Playground",
    glyph: "✦",
    title: "Playground",
    blurb: "Talk to your own /v1/chat/completions endpoint exactly as another app would.",
  },
  {
    id: "compression",
    label: "Compression",
    glyph: "⇩",
    title: "Compression",
    blurb: "Cut the tokens the agent spends on shell output with RTK, and see what it saved.",
  },
  {
    id: "settings",
    label: "Settings",
    glyph: "⚙",
    title: "Settings",
    blurb: "Choose how the CLI is launched and how the API behaves.",
  },
  {
    id: "logs",
    label: "Logs",
    glyph: "≡",
    title: "Logs",
    blurb: "Every CLI line and every API request, newest last.",
  },
];

export default function App() {
  const api = bridge ?? previewBridge;
  const [state, setState] = useState<AppState>(fallbackState);
  const [ready, setReady] = useState(false);
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [page, setPage] = useState<Page>("overview");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api.state();
    setState(next);
    return next;
  }, [api]);

  const detect = useCallback(async () => {
    const found = await api.detectRunners();
    setRunners(found);
  }, [api]);

  useEffect(() => {
    (async () => {
      await refresh();
      setLogs(await api.listLogs());
      await detect();
      setReady(true);
    })();
  }, [api, refresh, detect]);

  useEffect(
    () => api.onServerState((server) => setState((current) => ({ ...current, server }))),
    [api],
  );

  useEffect(
    () =>
      api.onLogEntry((entry) =>
        setLogs((current) => [...current.slice(-799), entry]),
      ),
    [api],
  );

  const toggleServer = async () => {
    setBusy(true);
    try {
      if (state.server.running) await api.stopServer();
      else await api.startServer();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async (patch: Partial<Config>) => {
    const next = await api.saveConfig(patch);
    setState(next);
    await detect();
  };

  const test = (prompt?: string): Promise<TestResult> => api.testRunner(prompt);

  const current = PAGES.find((p) => p.id === page)!;

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">OR</div>
          <div className="brand-text">
            <strong>OmniRush Studio</strong>
            <span>CLI → OpenAI v1</span>
          </div>
        </div>

        <nav className="nav">
          {PAGES.map((item) => (
            <button
              key={item.id}
              className={item.id === page ? "nav-item active" : "nav-item"}
              onClick={() => setPage(item.id)}
            >
              <span className="glyph">{item.glyph}</span>
              {item.label}
              {item.id === "logs" && logs.length ? (
                <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
                  {logs.length}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <div className="kv">
            <span>Server</span>
            <b style={{ color: state.server.running ? "var(--green)" : "var(--muted)" }}>
              {state.server.running ? `:${state.server.port}` : "offline"}
            </b>
          </div>
          <div className="kv">
            <span>Model</span>
            <b>{state.config.model}</b>
          </div>
          <div className="kv">
            <span>Runner</span>
            <b>{state.config.runner}</b>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="page-head">
          <div>
            <h1>{current.title}</h1>
            <p>{current.blurb}</p>
          </div>
        </div>

        {!isDesktop ? (
          <div className="banner" style={{ marginBottom: 16 }}>
            <span>⚠</span>
            <span>
              Preview mode — this window is not running inside Electron, so server controls are disabled. The playground still
              talks to whatever is listening on the configured port.
            </span>
          </div>
        ) : null}

        {!ready ? (
          <div className="card">
            <div className="card-body" style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span className="spin" />
              <span className="muted">Loading settings…</span>
            </div>
          </div>
        ) : page === "overview" ? (
          <Overview
            state={state}
            runners={runners}
            busy={busy}
            onToggleServer={toggleServer}
            onDetect={detect}
            onTest={() => test(state.config.playgroundPrompt)}
          />
        ) : page === "playground" ? (
          <Playground state={state} />
        ) : page === "compression" ? (
          <Compression state={state} />
        ) : page === "settings" ? (
          <Settings state={state} runners={runners} onSave={saveConfig} onDetect={detect} onTest={test} />
        ) : (
          <Logs
            entries={logs}
            onClear={async () => {
              setLogs(await api.clearLogs());
            }}
          />
        )}
      </main>
    </div>
  );
}
