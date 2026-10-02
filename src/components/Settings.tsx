import { useEffect, useMemo, useState } from "react";
import { bridge, previewBridge } from "../bridge";
import type { AppState, Config, RunnerInfo, TestResult, WslRepair } from "../types";
import { Card, Field, Pill, Switch } from "./ui";

export function Settings({
  state,
  runners,
  onSave,
  onDetect,
  onTest,
}: {
  state: AppState;
  runners: RunnerInfo[];
  onSave: (patch: Partial<Config>) => Promise<void>;
  onDetect: () => Promise<void>;
  onTest: (prompt?: string) => Promise<TestResult>;
}) {
  const [draft, setDraft] = useState<Config>(state.config);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repair, setRepair] = useState<WslRepair | null>(null);
  const api = bridge ?? previewBridge;

  useEffect(() => {
    setDraft(state.config);
  }, [state.config]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(state.config),
    [draft, state.config],
  );

  const set = <K extends keyof Config>(key: K, value: Config[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <Card
        title="Runner"
        actions={
          <div className="action-row">
            <button
              className="btn small ghost"
              disabled={repairing}
              title="wsl --update, then wsl --shutdown, then re-check the distro"
              onClick={async () => {
                setRepairing(true);
                setRepair(null);
                try {
                  setRepair(await api.repairWsl());
                  await onDetect();
                } finally {
                  setRepairing(false);
                }
              }}
            >
              {repairing ? <span className="spin" /> : null}
              Repair WSL
            </button>
            <button
              className="btn small"
              disabled={detecting}
              onClick={async () => {
                setDetecting(true);
                try {
                  await onDetect();
                } finally {
                  setDetecting(false);
                }
              }}
            >
              {detecting ? <span className="spin" /> : null}
              Detect
            </button>
          </div>
        }
      >
        <div className="stack" style={{ gap: 18 }}>
          <div className="form-grid">
            <Field label="How to launch the CLI" hint="auto picks the first runner that works on this machine.">
              <select value={draft.runner} onChange={(e) => set("runner", e.target.value as Config["runner"])}>
                <option value="auto">auto</option>
                <option value="native">native</option>
                <option value="wsl">wsl</option>
              </select>
            </Field>
            <Field label="CLI path" hint="Leave empty to auto-detect. Accepts the omnirush entry script or an executable.">
              <input
                type="text"
                value={draft.cliPath}
                placeholder="auto-detected"
                onChange={(e) => set("cliPath", e.target.value)}
              />
            </Field>
            <Field label="WSL distro" hint="Used only by the wsl runner.">
              <input type="text" value={draft.wslDistro} onChange={(e) => set("wslDistro", e.target.value)} />
            </Field>
            <Field label="Working directory" hint="The folder the agent runs in.">
              <input type="text" value={draft.workdir} onChange={(e) => set("workdir", e.target.value)} />
            </Field>
            <Field label="Model" hint="Any model your OmniRush account can serve.">
              <input
                type="text"
                list="omnirush-models"
                value={draft.model}
                onChange={(e) => set("model", e.target.value)}
              />
              <datalist id="omnirush-models">
                {state.models.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </Field>
            <Field label="Thinking level" hint="Maps to the CLI's --thinking flag.">
              <select value={draft.thinking} onChange={(e) => set("thinking", e.target.value)}>
                {state.thinkingLevels.map((level) => (
                  <option key={level || "default"} value={level}>
                    {level || "CLI default"}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="form-grid">
            <Switch
              checked={draft.yolo}
              onChange={(v) => set("yolo", v)}
              title="Yolo mode"
              hint="Runs the CLI with --yolo: no approval prompts. Required for headless use, but the agent may then run commands without asking."
            />
            <Switch
              checked={draft.staticModels}
              onChange={(v) => set("staticModels", v)}
              title="Skip the remote model list"
              hint="Sets OMNIRUSH_STATIC_MODELS=1 so every run does not fetch the model list first. Faster cold starts."
            />
            <Switch
              checked={draft.agentic}
              onChange={(v) => set("agentic", v)}
              title="Agentic mode"
              hint="Off: the model answers directly, like a chat API. On: the full coding agent with tools may act in the working directory."
            />
          </div>

          <Field label="Extra CLI arguments" hint="Appended verbatim to every launch.">
            <input type="text" value={draft.extraArgs} onChange={(e) => set("extraArgs", e.target.value)} placeholder="--no-context-files" />
          </Field>

          <div className="kv-list">
            {runners.map((runner) => (
              <div className="kv-row" key={runner.mode}>
                <span className="k">
                  {runner.label}{" "}
                  <Pill tone={runner.available ? "on" : "off"}>{runner.available ? "ready" : "unavailable"}</Pill>
                </span>
                <span className="v" style={{ maxWidth: "58%", fontFamily: "var(--sans)", fontSize: 12 }}>
                  {runner.detail}
                </span>
              </div>
            ))}
            {runners.length === 0 ? <div className="kv-row"><span className="k">Not detected yet — press Detect.</span></div> : null}
          </div>

          {repair ? (
            <div className={`banner ${repair.ok ? "ok" : "error"}`}>
              <span>{repair.ok ? "✓" : "!"}</span>
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ marginBottom: 4 }}>
                  {repair.distro} · {repair.ok ? "running" : "still not starting"}
                </div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {repair.ok ? "WSL answers again — press Test CLI to send a real prompt." : `${repair.detail}\n${repair.guidance || ""}`}
                </div>
                {repair.steps.map((step) => (
                  <div key={step.label} className="muted mono" style={{ fontSize: 11 }}>
                    {step.label} → {step.ok ? "ok" : "failed"}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              className="btn small"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                setTest(null);
                try {
                  setTest(await onTest("Reply with exactly: OK"));
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? <span className="spin" /> : null}
              Test CLI
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              Saves settings first if needed, then sends one real prompt.
            </span>
          </div>

          {test ? (
            <div className={`banner ${test.ok ? "ok" : "error"}`}>
              <span>{test.ok ? "✓" : "!"}</span>
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ marginBottom: 4 }}>
                  {test.runner || "no runner"} {test.version ? `· ${test.version}` : ""}
                  {test.durationMs ? ` · ${test.durationMs} ms` : ""}
                </div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{test.ok ? test.text : test.error}</div>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="Server">
        <div className="form-grid">
          <Field label="Host" hint="127.0.0.1 keeps it local. 0.0.0.0 exposes it to your network.">
            <input type="text" value={draft.host} onChange={(e) => set("host", e.target.value)} />
          </Field>
          <Field label="Port">
            <input type="number" value={draft.port} onChange={(e) => set("port", Number(e.target.value))} />
          </Field>
          <Field label="API key" hint="Empty disables auth. Clients send it as a Bearer token.">
            <input type="password" value={draft.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder="none" />
          </Field>
          <Field label="Max concurrency" hint="How many CLI runs may be in flight at once.">
            <input
              type="number"
              min={1}
              max={16}
              value={draft.maxConcurrency}
              onChange={(e) => set("maxConcurrency", Number(e.target.value))}
            />
          </Field>
          <Field label="Request timeout (seconds)">
            <input
              type="number"
              min={30}
              value={draft.requestTimeout}
              onChange={(e) => set("requestTimeout", Number(e.target.value))}
            />
          </Field>
          <Field label="Streaming style" hint="live streams the agent's deltas as they arrive; final buffers the run and sends it in one chunk.">
            <select value={draft.streamMode} onChange={(e) => set("streamMode", e.target.value as Config["streamMode"])}>
              <option value="live">live deltas</option>
              <option value="final">final message only</option>
            </select>
          </Field>
        </div>
        <div style={{ marginTop: 18 }}>
          <Switch
            checked={draft.autoStart}
            onChange={(v) => set("autoStart", v)}
            title="Start the server when the app opens"
          />
        </div>
      </Card>

      <div className="save-bar">
        <span className="state">
          {dirty
            ? "Unsaved changes"
            : savedAt
              ? `Saved ${new Date(savedAt).toLocaleTimeString()}`
              : `Settings file: ${state.paths.config}`}
        </span>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn" onClick={() => setDraft(state.config)} disabled={!dirty || saving}>
            Revert
          </button>
          <button className="btn primary" onClick={save} disabled={!dirty || saving}>
            {saving ? <span className="spin" /> : null}
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
