#!/usr/bin/env node
"use strict";

/**
 * A stand-in for `omnirush --mode rpc` that answers locally.
 *
 * It speaks the same JSONL protocol (prompt in, text_delta events out) so the
 * bridge can be exercised on a machine where the real CLI cannot reach a model
 * — useful as a regression check and as living documentation of the protocol.
 *
 *   node test/fake-cli.cjs            # then pipe RPC commands at stdin
 */

const DELAY_MS = Number(process.env.FAKE_CLI_DELAY_MS || 25);

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function reply(text) {
  return `Echo: ${text.replace(/\s+/g, " ").trim().slice(0, 120)}`;
}

function answer(command) {
  const id = command.id;
  if (command.type === "abort") {
    emit({ id, type: "response", command: "abort", success: true });
    return;
  }
  if (command.type !== "prompt") {
    emit({ id, type: "response", command: command.type, success: false, error: "unsupported command" });
    return;
  }

  emit({ id, type: "response", command: "prompt", success: true });

  const text = reply(command.message || "");
  const words = text.split(" ");
  const message = { role: "assistant", content: [], model: "fake-model", usage: { input: 12, output: words.length, totalTokens: 12 + words.length } };

  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: { ...message, content: [] } });

  let index = 0;
  const step = () => {
    if (index < words.length) {
      const delta = (index === 0 ? "" : " ") + words[index];
      index += 1;
      emit({
        type: "message_update",
        usage: message.usage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
      setTimeout(step, DELAY_MS);
      return;
    }
    const full = { ...message, content: [{ type: "text", text }], stopReason: "stop" };
    emit({ type: "message_end", message: full });
    emit({ type: "turn_end", message: full, toolResults: [] });
    emit({ type: "agent_end", messages: [full] });
    emit({ type: "agent_settled" });
  };
  setTimeout(step, DELAY_MS);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      answer(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`fake-cli: bad command: ${err.message}\n`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
