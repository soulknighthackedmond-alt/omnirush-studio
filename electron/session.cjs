"use strict";

/**
 * One request = one RPC session.
 *
 * The CLI is a one-shot agent process, so a request starts it, sends a single
 * `prompt`, streams the assistant text deltas, and stops it again. That keeps
 * concurrent API calls independent (no shared session state to interleave) at
 * the cost of process startup per request.
 */

const { RpcClient } = require("./rpc-client.cjs");
const { log } = require("./log.cjs");

const CHAT_PREAMBLE = [
  "You are answering through an OpenAI-compatible chat completions API.",
  "Reply with the answer itself, as plain text.",
  "Do not call tools, do not run shell commands, do not edit files, and do not",
  "narrate what you are doing or mention being a coding agent.",
].join(" ");

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text") return part.text || "";
        if (part.type === "image") return "[image]";
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

/**
 * Flatten an OpenAI `messages` array into the single prompt string the CLI
 * takes. System/developer messages become instructions, earlier turns become
 * transcript context, and the final user message stays the instruction.
 */
function buildPrompt(messages, options = {}) {
  const system = [];
  const turns = [];
  for (const message of messages || []) {
    const text = textOf(message?.content).trim();
    if (!text) continue;
    if (message.role === "system" || message.role === "developer") system.push(text);
    else turns.push({ role: message.role, text });
  }
  if (turns.length === 0 && system.length === 0) {
    throw Object.assign(new Error("`messages` must contain at least one message with text content"), {
      status: 400,
      type: "invalid_request_error",
    });
  }

  const last = turns.length ? turns[turns.length - 1] : null;
  const history = turns.slice(0, -1);
  const sections = [];

  if (!options.agentic) sections.push(`[API instructions]\n${CHAT_PREAMBLE}`);
  if (system.length) sections.push(`[System instructions]\n${system.join("\n\n")}`);
  if (history.length) {
    const lines = history.map((turn) => `${turn.role[0].toUpperCase()}${turn.role.slice(1)}: ${turn.text}`);
    sections.push(`[Earlier conversation]\n${lines.join("\n\n")}`);
  }
  if (last) {
    sections.push(history.length || system.length ? `[Current message]\n${last.text}` : last.text);
  }
  return sections.join("\n\n");
}

function lastAssistant(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return null;
}

/**
 * Run one prompt to completion.
 *
 * @returns {Promise<{text:string, model:string, usage:object|null, error:string|null, durationMs:number, aborted:boolean}>}
 */
function runPrompt({ launch, prompt, timeoutMs = 900000, onDelta, onEvent, onStderr, onSpawn }) {
  return new Promise((resolve) => {
    const client = new RpcClient(launch);
    const started = Date.now();
    let deltas = [];
    let final = null;
    let usage = null;
    let model = "";
    let error = null;
    let aborted = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.stop();
      const text = deltas.join("") || (final ? textOf(final.content) : "");
      resolve({
        text,
        model: model || final?.model || "",
        usage,
        error,
        aborted,
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      error = `OmniRush CLI timed out after ${Math.round(timeoutMs / 1000)}s`;
      log.warn("cli", error);
      aborted = true;
      client.abort();
      setTimeout(finish, 1500);
    }, timeoutMs);

    // Kept so a bare exit code can be reported with the reason the CLI gave.
    let lastStderr = "";

    client.on("stderr", (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      lastStderr = text;
      for (const line of text.split("\n")) log.info("cli", line.trim());
      onStderr?.(text);
    });
    client.on("noise", (line) => log.warn("cli", `non-JSON output: ${line.slice(0, 200)}`));
    client.on("error", (err) => {
      error = `could not start the OmniRush CLI: ${err.message}`;
      log.error("cli", error);
      finish();
    });
    client.on("close", ({ code }) => {
      if (!settled) {
        const tail = lastStderr.split("\n").map((line) => line.trim()).filter(Boolean).pop() || "";
        error = error || `OmniRush CLI exited with code ${code} before finishing${tail ? `: ${tail.slice(0, 300)}` : ""}`;
        log.warn("cli", error);
        finish();
      }
    });
    client.on("event", (event) => {
      onEvent?.(event);
      switch (event.type) {
        case "response":
          if (event.success === false) {
            error = event.error || `the CLI rejected the prompt (${event.command})`;
            log.error("cli", error);
            finish();
          }
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update?.type === "text_delta" && update.delta) {
            deltas.push(update.delta);
            onDelta?.(update.delta);
          }
          if (update?.type === "error") {
            error = update.error?.message || String(update.error || "provider error");
          }
          break;
        }
        case "message_end": {
          const message = event.message;
          if (message?.role === "assistant") {
            final = message;
            if (message.model) model = message.model;
            if (message.usage) usage = message.usage;
            if (message.stopReason === "error") error = message.errorMessage || "the model call failed";
            if (message.errorMessage && !error) error = message.errorMessage;
          }
          break;
        }
        case "agent_end": {
          const assistant = lastAssistant(event.messages);
          if (assistant) {
            final = assistant;
            if (assistant.model) model = assistant.model;
            if (assistant.usage) usage = assistant.usage;
            if (assistant.stopReason === "error") error = assistant.errorMessage || error || "the model call failed";
          }
          if (!deltas.length && final) deltas = [textOf(final.content)];
          finish();
          break;
        }
        default:
          break;
      }
    });

    client.start();
    onSpawn?.(client);
    const id = client.prompt(prompt);
    log.info("cli", `prompt ${id} → ${launch.display}`);
  });
}

module.exports = { runPrompt, buildPrompt, textOf, CHAT_PREAMBLE };
