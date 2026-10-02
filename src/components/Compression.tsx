import { useCallback, useEffect, useState } from "react";
import { bridge, previewBridge } from "../bridge";
import type { AppState, RtkActionResult, RtkGain, RtkMode, RtkStatus } from "../types";
import { Card, CopyRow, KV, Pill } from "./ui";

const MODES: { id: RtkMode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "native", label: "Native" },
  { id: "wsl", label: "WSL" },
];

type Note = { tone: "ok" | "error"; text: string } | null;

/**
 * RTK compression.
 *
 * RTK shrinks the shell output the agent reads back, so a long `git diff` or
 * test run costs a fraction of the tokens. It hooks the agent through an
 * extension file, which has to live in the same environment the CLI runs in —
 * so this page reports where the CLI actually runs, whether the hook is there,
 * and what it has saved so far.
 */
export function Compression({ state }: { state: AppState }) {
  const api = bridge ?? previewBridge;
  const [mode, setMode] = useState<RtkMode>("auto");
  const [status, setStatus] = useState<RtkStatus | null>(null);
  const [gain, setGain] = useState<RtkGain | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);

  const load = useCallback(
    async (which: RtkMode) => {
      setBusy("status");
      try {
        setStatus(await api.rtkStatus({ mode: which }));
      } finally {
        setBusy(null);
      }
    },
    [api],
  );

  useEffect(() => {
    void load(mode);
  }, [load, mode]);

  const run = async (
    label: string,
    action: () => Promise<RtkActionResult | RtkGain>,
    successText: (result: RtkActionResult | RtkGain) => string,
  ) => {
    setBusy(label);
    setNote(null);
    try {
      const result = await action();
      if (result.status) setStatus(result.status);
      if ("text" in result) setGain(result);
      setNote({
        tone: result.ok ? "ok" : "error",
        text: result.ok ? successText(result) : result.error || "The command failed — see Logs for its full output.",
      });
    } catch (err) {
      setNote({ tone: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const found = status?.cli.found ?? false;
  const hookFiles = status?.dirs.flatMap((dir) => dir.files) ?? [];

  return (
    <div className="stack">
      {note ? (
        <div className={`banner ${note.tone === "ok" ? "ok" : "error"}`}>
          <span>{note.tone === "ok" ? "✓" : "✕"}</span>
          <span>{note.text}</span>
        </div>
      ) : null}

      <Card
        title="RTK compression"
        actions={
          <div className="action-row">
            <div className="segmented">
              {MODES.map((item) => (
                <button
                  key={item.id}
                  className={item.id === mode ? "seg active" : "seg"}
                  onClick={() => setMode(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button className="btn small ghost" onClick={() => void load(mode)} disabled={busy !== null}>
              {busy === "status" ? "Checking…" : "Refresh"}
            </button>
          </div>
        }
      >
        <p className="muted" style={{ marginTop: 0 }}>
          RTK (Rust Token Killer) sits between the agent's shell commands and its context window: it compresses the output of
          the commands the CLI runs, so long diffs, test runs and log dumps cost a fraction of the tokens. It reaches the
          agent through an extension file, which only counts if it is in the environment the CLI actually runs in.
        </p>
        <div className="kv-list">
          <KV
            k="Agentic mode"
            v={
              state.config.agentic ? (
                <Pill tone="on">on — shell output is what RTK compresses</Pill>
              ) : (
                <Pill tone="warn">off — the agent runs no commands, so there is nothing to compress</Pill>
              )
            }
          />
          <KV k="Environment" v={status ? `${status.label} · home ${status.home}` : "checking…"} />
          <KV
            k="rtk binary"
            v={
              status?.cli.found ? (
                <>
                  <span className="mono">{status.cli.version || "installed"}</span>
                  <span className="muted"> · {status.cli.path}</span>
                </>
              ) : status ? (
                <Pill tone="off">not installed</Pill>
              ) : (
                "checking…"
              )
            }
          />
          <KV
            k="Compression"
            v={
              status ? (
                status.enabled ? (
                  <Pill tone="on">enabled</Pill>
                ) : (
                  <Pill tone="off">not enabled</Pill>
                )
              ) : (
                "checking…"
              )
            }
          />
        </div>
      </Card>

      <Card title="Hook location" actions={<span className="muted small-note">{hookFiles.length} file(s)</span>}>
        <p className="muted" style={{ marginTop: 0 }}>
          <code>rtk init -g --agent pi</code> writes to pi's own directory, but OmniRush reads its agent
          directory — so enabling here mirrors the hook into the CLI's agent directory. Your project folder is never
          written to.
        </p>
        <div className="dir-list">
          {(status?.dirs ?? []).map((dir) => (
            <div className="dir-row" key={dir.id}>
              <div className="dir-head">
                <strong>{dir.label}</strong>
                {dir.files.length ? <Pill tone="on">{dir.files.length} hook(s)</Pill> : <Pill tone="off">empty</Pill>}
              </div>
              <div className="mono muted dir-path">{dir.path}</div>
              {dir.files.map((file) => (
                <div className="file-row" key={file.path}>
                  <span className="mono">{file.name}</span>
                  <span className="muted">{file.bytes} bytes</span>
                </div>
              ))}
              {!dir.exists ? <div className="muted">directory does not exist yet</div> : null}
            </div>
          ))}
          {!status ? <div className="muted">checking…</div> : null}
        </div>
      </Card>

      <Card title="Actions">
        <div className="action-grid">
          <button
            className="btn"
            disabled={busy !== null || found}
            title={found ? "Already installed" : "winget on Windows, the install script inside WSL"}
            onClick={() =>
              void run("install", () => api.rtkInstall({ mode }), (result) => {
                const s = (result as RtkActionResult).status;
                return `RTK installed: ${s.cli.version || "ok"}`;
              })
            }
          >
            {busy === "install" ? "Installing…" : "Install RTK"}
          </button>
          <button
            className="btn primary"
            disabled={busy !== null || !found}
            onClick={() =>
              void run("enable", () => api.rtkEnable({ mode }), () => {
                const copied = hookFiles.length;
                return `Compression enabled — hook written${copied ? ` (${copied} file(s))` : ""}.`;
              })
            }
          >
            {busy === "enable" ? "Enabling…" : "Enable compression"}
          </button>
          <button
            className="btn ghost"
            disabled={busy !== null || !status?.enabled}
            title="Renames the hook file to .bak so the agent stops loading it"
            onClick={() =>
              void run("disable", () => api.rtkDisable({ mode }), (result) => {
                const moved = (result as RtkActionResult).moved ?? [];
                return `Disabled — ${moved.length} file(s) renamed to .bak.`;
              })
            }
          >
            {busy === "disable" ? "Disabling…" : "Disable"}
          </button>
          <button
            className="btn ghost"
            disabled={busy !== null || !found}
            onClick={() =>
              void run("gain", () => api.rtkGain({ mode }), () => "Savings refreshed.")
            }
          >
            {busy === "gain" ? "Reading…" : "Refresh savings"}
          </button>
        </div>
        <div style={{ marginTop: 14 }}>
          <CopyRow value={status?.install || "winget install --id rtk-ai.rtk -e"} label="Copy install command" />
        </div>
        <div className="hint" style={{ marginTop: 10 }}>
          Installing needs network access and may take a minute. Every command, its exit code and its output are written to
          the Logs page.
        </div>
      </Card>

      <Card
        title="Savings"
        actions={
          <span className="muted small-note">
            {gain?.savedTokens != null ? `${gain.savedTokens.toLocaleString()} tokens saved` : "run `rtk gain`"}
          </span>
        }
      >
        {gain?.savedTokens != null || gain?.percent != null ? (
          <div className="kv-list">
            {gain.savedTokens != null ? <KV k="Tokens saved" v={gain.savedTokens.toLocaleString()} /> : null}
            {gain.percent != null ? <KV k="Compression" v={`${gain.percent}%`} /> : null}
          </div>
        ) : null}
        {gain?.text ? (
          <pre className="code-block">{gain.text}</pre>
        ) : (
          <div className="empty">
            <span className="muted">
              {found
                ? "No numbers yet — press Refresh savings once the agent has run a few commands with compression on."
                : "Install RTK first."}
            </span>
          </div>
        )}
      </Card>

      <Card title="Worth knowing">
        <ul className="bullets">
          <li>
            The hook is per environment, not per run: it applies to every session the CLI starts, including the ones this
            app launches.
          </li>
          {status?.mode === "wsl" ? (
            <li>
              This target is WSL, so both <span className="mono">rtk</span> and the hook must live inside{" "}
              <span className="mono">{status.label}</span>. If the distro will not boot, the agent cannot run at all —
              Settings → Runner has a Repair WSL button.
            </li>
          ) : (
            <li>
              The CLI cannot serve model requests from native Windows — the gateway answers{" "}
              <span className="mono">OmniRush on Windows now runs in WSL</span>. Native is still the right target for
              installing the hook if that is where you run the CLI.
            </li>
          )}
          <li>
            RTK is a separate project:{" "}
            <a
              href={status?.docs || "https://www.rtk-ai.app"}
              onClick={(e) => {
                e.preventDefault();
                void api.openExternal(status?.docs || "https://www.rtk-ai.app");
              }}
            >
              {status?.docs || "https://www.rtk-ai.app"}
            </a>
            .
          </li>
        </ul>
      </Card>
    </div>
  );
}
