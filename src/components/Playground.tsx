import { useEffect, useRef, useState } from "react";
import type { AppState } from "../types";
import { Card } from "./ui";

interface Turn {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  streaming?: boolean;
}

export function Playground({ state }: { state: AppState }) {
  const { config, server } = state;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState(config.playgroundPrompt);
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setDraft((current) => (current ? current : config.playgroundPrompt));
  }, [config.playgroundPrompt]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const history: Turn[] = [...turns, { role: "user", content: text }];
    setTurns([...history, { role: "assistant", content: "", streaming: true }]);
    setDraft("");
    setSending(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const update = (fn: (last: Turn) => Turn) =>
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = fn(next[next.length - 1]);
        return next;
      });

    try {
      const response = await fetch(`${server.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          stream: true,
          messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        let message = `HTTP ${response.status}`;
        try {
          message = JSON.parse(detail).error?.message || message;
        } catch {
          if (detail) message = detail.slice(0, 400);
        }
        throw new Error(message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let event: any;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }
            if (event.error) throw new Error(event.error.message || "upstream error");
            const delta = event.choices?.[0]?.delta?.content;
            if (delta) update((last) => ({ ...last, content: last.content + delta }));
          }
        }
      }
      update((last) => ({ ...last, streaming: false, content: last.content || "(empty response)" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      update((last) => ({
        role: "assistant",
        content: controller.signal.aborted ? "Cancelled." : message,
        error: true,
        streaming: false,
      }));
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  };

  return (
    <Card
      title="Playground"
      actions={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {server.running ? `via ${server.baseUrl}` : "server is stopped"}
          </span>
          {turns.length ? (
            <button className="btn small ghost" onClick={() => setTurns([])} disabled={sending}>
              Clear
            </button>
          ) : null}
        </div>
      }
    >
      <div className="chat" style={{ margin: "-16px" }}>
        <div className="chat-log" ref={logRef}>
          {turns.length === 0 ? (
            <div className="empty">
              Send a message to call your own endpoint the way any OpenAI client would — same HTTP, same SSE stream.
            </div>
          ) : null}
          {turns.map((turn, index) => (
            <div key={index} className={`msg ${turn.role}${turn.error ? " error" : ""}`}>
              <div className="who">{turn.role === "user" ? "You" : "OR"}</div>
              <div className={`bubble${turn.streaming && !turn.content ? " caret" : ""}`}>
                {turn.content || (turn.streaming ? "" : "")}
                {turn.streaming && turn.content ? <span className="caret" /> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="composer">
          <textarea
            value={draft}
            placeholder="Ask anything…  (Enter to send, Shift+Enter for a new line)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {sending ? (
            <button
              className="btn danger"
              onClick={() => {
                abortRef.current?.abort();
              }}
            >
              Stop
            </button>
          ) : (
            <button className="btn primary" onClick={send} disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
