import { useState } from "react";
import type { AppState, RunnerInfo, TestResult } from "../types";
import { Card, CopyRow, Endpoint, KV, Pill } from "./ui";

export function Overview({
  state,
  runners,
  busy,
  onToggleServer,
  onDetect,
  onTest,
}: {
  state: AppState;
  runners: RunnerInfo[];
  busy: boolean;
  onToggleServer: () => void;
  onDetect: () => void;
  onTest: () => Promise<TestResult>;
}) {
  const { config, server } = state;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [copied, setCopied] = useState(false);

  const usable = runners.filter((r) => r.available);
  const best = usable[0];

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await onTest());
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="stack">
      <Card>
        <div className="hero">
          <div>
            <h2>{server.running ? "Your endpoint is live" : "Endpoint is stopped"}</h2>
            <p>
              {server.running
                ? `Point any OpenAI client at ${server.baseUrl} — every request runs the OmniRush CLI and streams the answer back.`
                : "Start the server to expose an OpenAI-compatible v1 API backed by the OmniRush CLI."}
            </p>
          </div>
          <div className="hero-actions">
            <Pill tone={server.running ? "on" : "off"}>
              <span className={server.running ? "dot pulse" : "dot"} />
              {server.running ? `listening :${server.port}` : "offline"}
            </Pill>
            <button className="btn primary" onClick={onToggleServer} disabled={busy}>
              {busy ? <span className="spin" /> : null}
              {server.running ? "Stop server" : "Start server"}
            </button>
          </div>
        </div>
      </Card>

      {!best ? (
        <div className="banner">
          <span>⚠</span>
          <span>
            No usable OmniRush CLI runner found. Open <b>Settings → Runner</b> and press <b>Detect</b> to see why, then fix the
            reported problem.
          </span>
        </div>
      ) : null}

      <div className="grid">
        <Card title="Base URL" tight>
          <div className="stack" style={{ gap: 10 }}>
            <CopyRow value={server.baseUrl} label={copied ? "Copied" : "Copy"} />
            <div className="hint muted">
              {config.apiKey ? "Bearer auth is on — send Authorization: Bearer <your key>." : "No API key set; anyone who can reach the port may use it."}
            </div>
            <button
              className="btn small ghost"
              style={{ alignSelf: "flex-start" }}
              onClick={() => {
                navigator.clipboard?.writeText(server.baseUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              Copy base URL
            </button>
          </div>
        </Card>

        <Card title="Connection" tight>
          <div className="kv-list">
            <KV k="Model" v={config.model} />
            <KV k="Runner" v={best ? `${best.mode}${best.launch ? " · " + shortPath(best.launch) : ""}` : "none available"} />
            <KV k="Working dir" v={config.workdir} />
            <KV k="Concurrency" v={`${server.active} active · ${server.queued} queued · limit ${server.maxConcurrency}`} />
            <KV k="Thinking" v={config.thinking || "default"} />
          </div>
        </Card>

        <Card title="Traffic" tight>
          <div className="kv-list">
            <KV k="Requests" v={String(server.stats.requests)} />
            <KV k="Errors" v={String(server.stats.errors)} />
            <KV k="Since" v={server.stats.startedAt ? new Date(server.stats.startedAt).toLocaleTimeString() : "—"} />
          </div>
          {server.stats.lastError ? (
            <div className="banner error" style={{ marginTop: 12 }}>
              <span>!</span>
              <span className="mono">{server.stats.lastError}</span>
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Endpoints" tight>
          <Endpoint method="GET" path="/v1/models" note="available models" />
          <Endpoint method="POST" path="/v1/chat/completions" note="stream + non-stream" />
          <Endpoint method="POST" path="/v1/completions" note="legacy prompt" />
          <Endpoint method="GET" path="/health" note="no auth required" />
        </Card>

        <Card
          title="CLI check"
          actions={
            <button className="btn small" onClick={runTest} disabled={testing}>
              {testing ? <span className="spin" /> : null}
              {testing ? "Running" : "Run probe"}
            </button>
          }
        >
          <p className="muted" style={{ margin: "0 0 12px", fontSize: 12.5 }}>
            Sends one prompt through the CLI and shows exactly what comes back — the fastest way to tell a broken runner from a
            broken client.
          </p>
          {result ? (
            <div className={`banner ${result.ok ? "ok" : "error"}`}>
              <span>{result.ok ? "✓" : "!"}</span>
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ marginBottom: 4 }}>
                  {result.runner || "no runner"} {result.version ? `· ${result.version}` : ""}{" "}
                  {result.durationMs ? `· ${result.durationMs} ms` : ""}
                </div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {result.ok ? result.text : result.error}
                </div>
              </div>
            </div>
          ) : (
            <div className="hint muted">No probe run yet.</div>
          )}
          <button className="btn small ghost" style={{ marginTop: 10 }} onClick={onDetect}>
            Re-detect runners
          </button>
        </Card>
      </div>
    </div>
  );
}

function shortPath(value: string) {
  const cleaned = value.replace(/^wsl[^→]*→\s*/, "wsl → ");
  if (cleaned.length <= 44) return cleaned;
  const parts = cleaned.split(/[\\/]/);
  return "…/" + parts.slice(-2).join("/");
}
