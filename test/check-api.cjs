#!/usr/bin/env node
"use strict";

/**
 * End-to-end check of the OpenAI-compatible layer.
 *
 * Runs the real ApiServer against test/fake-cli.cjs, so it needs no OmniRush
 * account, no network and no model access:
 *
 *   npm run check
 */

const path = require("node:path");
const { ApiServer } = require("../electron/openai-server.cjs");
const { DEFAULTS } = require("../electron/config.cjs");

const PORT = 8123;
const config = {
  ...DEFAULTS,
  runner: "native",
  cliPath: path.join(__dirname, "fake-cli.cjs"),
  workdir: __dirname,
  host: "127.0.0.1",
  port: PORT,
  staticModels: false,
  apiKey: "",
  streamMode: "live",
};

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   ${detail}` : ""}`);
}

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let chunks = 0;
  let sawDone = false;
  let firstChunkAt = 0;
  const started = Date.now();
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
        if (payload === "[DONE]") {
          sawDone = true;
          continue;
        }
        if (!payload) continue;
        const event = JSON.parse(payload);
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          chunks += 1;
          if (!firstChunkAt) firstChunkAt = Date.now() - started;
          text += delta;
        }
      }
    }
  }
  return { text, chunks, sawDone, firstChunkAt };
}

(async () => {
  const server = new ApiServer({ getConfig: () => config });
  await server.start();
  const base = `http://127.0.0.1:${PORT}`;

  let response = await fetch(`${base}/health`);
  const health = await response.json();
  check("GET /health", response.status === 200 && health.status === "ok", `status ${response.status}`);

  response = await fetch(`${base}/v1/models`);
  const models = await response.json();
  check(
    "GET /v1/models lists the configured model",
    response.status === 200 && models.data.some((m) => m.id === config.model),
    `${models.data?.length} models`,
  );

  response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.model, messages: [{ role: "user", content: "hello there" }] }),
  });
  const completion = await response.json();
  check(
    "POST /v1/chat/completions (non-stream)",
    response.status === 200 && completion.object === "chat.completion" && completion.choices[0].message.content.length > 0,
    JSON.stringify(completion.choices?.[0]?.message?.content ?? completion.error?.message ?? "").slice(0, 90),
  );
  check("usage is reported", completion.usage?.completion_tokens > 0, JSON.stringify(completion.usage));
  check("finish_reason is stop", completion.choices?.[0]?.finish_reason === "stop");
  check("response echoes the model", completion.model === "fake-model", completion.model);

  response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
    }),
  });
  const stream = await readSse(response);
  check("stream returns SSE with text", stream.text.trim().length > 0, JSON.stringify(stream.text).slice(0, 80));
  check("stream is chunked, not one blob", stream.chunks > 3, `${stream.chunks} content chunks`);
  check("stream is incremental", stream.firstChunkAt > 0 && stream.firstChunkAt < 1000, `first chunk at ${stream.firstChunkAt} ms`);
  check("stream ends with [DONE]", stream.sawDone);

  response = await fetch(`${base}/v1/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.model, prompt: "legacy prompt" }),
  });
  const legacy = await response.json();
  check("POST /v1/completions (legacy)", response.status === 200 && legacy.choices[0].message.content.length > 0);

  response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  check("empty messages is a 400", response.status === 400);

  response = await fetch(`${base}/v1/nope`);
  check("unknown route is a 404", response.status === 404);

  config.apiKey = "test-key";
  response = await fetch(`${base}/v1/models`);
  const unauthorised = response.status;
  response = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer test-key" } });
  const authorised = response.status;
  check("bearer auth is enforced", unauthorised === 401 && authorised === 200, `no key ${unauthorised}, with key ${authorised}`);
  config.apiKey = "";

  await server.stop();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("check crashed:", err);
  process.exit(1);
});
