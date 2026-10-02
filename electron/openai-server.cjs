"use strict";

/**
 * The OpenAI-compatible v1 API.
 *
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream + non-stream)
 *   POST /v1/completions        (legacy text completions)
 *
 * Every completion is served by one OmniRush CLI run, so the layer is thin on
 * purpose: translate the request into a prompt, stream the agent's text deltas
 * back as SSE chunks, translate the CLI's usage numbers into OpenAI's.
 */

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const { KNOWN_MODELS } = require("./config.cjs");
const { runPrompt, buildPrompt } = require("./session.cjs");
const { log } = require("./log.cjs");
const { resolveRunner, markRunFailure, markRunSuccess, isProcessFailure } = require("./runner.cjs");

const MAX_BODY_BYTES = 32 * 1024 * 1024;

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  setLimit(limit) {
    this.limit = Math.max(1, limit);
    while (this.active < this.limit && this.queue.length) {
      this.active += 1;
      this.queue.shift()();
    }
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function apiError(res, status, message, type = "invalid_request_error", code = null) {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

/**
 * A runner that cannot start is not the caller's fault, and generic clients
 * flatten every upstream failure into "check your key, model and network".
 * Naming the real cause gives a client something true to show.
 */
function errorCodeFor(message) {
  const text = String(message || "");
  if (/runs in WSL|WSL/i.test(text)) return "runner_unavailable";
  if (/timed out|timeout/i.test(text)) return "runner_timeout";
  return "omnirush_error";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { status: 413, type: "invalid_request_error" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON body: ${err.message}`), { status: 400, type: "invalid_request_error" }));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function usageFor(cliUsage, text) {
  if (cliUsage && (cliUsage.input || cliUsage.output)) {
    return {
      prompt_tokens: cliUsage.input || 0,
      completion_tokens: cliUsage.output || 0,
      total_tokens: cliUsage.totalTokens || (cliUsage.input || 0) + (cliUsage.output || 0),
    };
  }
  // Providers that only report usage at completion can leave it at zero; a
  // rough word count is more useful to clients than a hard zero.
  const approx = Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 0.75));
  return { prompt_tokens: 0, completion_tokens: approx, total_tokens: approx };
}

function finishReasonFor(cli) {
  if (cli.error) return "error";
  const stop = cli.stopReason || "stop";
  if (stop === "length" || stop === "max_tokens") return "length";
  if (stop === "stop" || stop === "endTurn" || stop === "end_turn") return "stop";
  return "stop";
}

class ApiServer {
  constructor({ getConfig, onStateChange }) {
    this.getConfig = getConfig;
    this.onStateChange = onStateChange;
    this.server = null;
    this.semaphore = new Semaphore(getConfig().maxConcurrency || 2);
    this.stats = { requests: 0, errors: 0, startedAt: null, lastError: null };
    this.inflight = new Set();
  }

  get running() {
    return !!this.server && this.server.listening;
  }

  status() {
    const cfg = this.getConfig();
    return {
      running: this.running,
      host: cfg.host,
      port: cfg.port,
      baseUrl: `http://${cfg.host}:${cfg.port}/v1`,
      active: this.semaphore.active,
      queued: this.semaphore.queue.length,
      maxConcurrency: this.semaphore.limit,
      stats: this.stats,
    };
  }

  async start() {
    if (this.running) return this.status();
    const cfg = this.getConfig();
    this.semaphore.setLimit(cfg.maxConcurrency || 2);

    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        log.error("api", `unhandled: ${err.stack || err.message}`);
        if (!res.headersSent) apiError(res, err.status || 500, err.message, err.type || "server_error");
        else res.end();
      });
    });
    // Long generations must not be cut off by Node's default request timeout.
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 120000;
    this.server.keepAliveTimeout = 65000;

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(cfg.port, cfg.host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });

    this.stats.startedAt = new Date().toISOString();
    log.success("api", `listening on http://${cfg.host}:${cfg.port}/v1`);
    this.onStateChange?.(this.status());
    return this.status();
  }

  async stop() {
    if (!this.server) return this.status();
    const server = this.server;
    this.server = null;
    for (const client of this.inflight) {
      try {
        client.abort();
      } catch {
        /* best effort */
      }
    }
    await new Promise((resolve) => server.close(() => resolve()));
    log.info("api", "stopped");
    this.onStateChange?.(this.status());
    return this.status();
  }

  _cors(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type, x-requested-with");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-max-age", "86400");
  }

  async _handle(req, res) {
    this._cors(res);
    const cfg = this.getConfig();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === "/health" || path === "/") {
      sendJson(res, 200, {
        status: "ok",
        service: "omnirush-studio",
        model: cfg.model,
        ...this.status(),
      });
      return;
    }

    if (cfg.apiKey && cfg.apiKey.trim()) {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (token !== cfg.apiKey.trim()) {
        apiError(res, 401, "Incorrect API key provided.", "invalid_request_error", "invalid_api_key");
        return;
      }
    }

    if (req.method === "GET" && path === "/v1/models") {
      const created = Math.floor(Date.now() / 1000);
      const ids = Array.from(new Set([...(cfg.model ? [cfg.model] : []), ...KNOWN_MODELS]));
      sendJson(res, 200, {
        object: "list",
        data: ids.map((id) => ({ id, object: "model", created, owned_by: "omnirush" })),
      });
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/completions")) {
      const body = await readBody(req);
      if (path === "/v1/completions") {
        const prompt = typeof body.prompt === "string" ? body.prompt : Array.isArray(body.prompt) ? body.prompt.join("\n") : "";
        body.messages = [{ role: "user", content: prompt }];
      }
      await this._completion(req, res, body);
      return;
    }

    apiError(res, 404, `Unknown route ${req.method} ${path}`, "invalid_request_error", "not_found");
  }

  async _completion(req, res, body) {
    const cfg = this.getConfig();
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      apiError(res, 400, "`messages` is required and must be a non-empty array", "invalid_request_error", "missing_messages");
      return;
    }

    let prompt;
    try {
      prompt = buildPrompt(body.messages, { agentic: cfg.agentic });
    } catch (err) {
      apiError(res, err.status || 400, err.message, err.type || "invalid_request_error");
      return;
    }

    const model = (body.model || cfg.model || "").trim() || cfg.model;
    const stream = body.stream === true;
    const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    const started = Date.now();

    this.stats.requests += 1;
    log.info("api", `POST ${stream ? "stream" : "json"} model=${model} chars=${prompt.length}`);

    const resolved = await resolveRunner(cfg);
    if (!resolved.ok) {
      this.stats.errors += 1;
      this.stats.lastError = resolved.error;
      apiError(
        res,
        503,
        `OmniRush CLI is not reachable. ${resolved.error}`,
        "upstream_unavailable",
        "runner_unavailable",
      );
      log.error("api", `503 runner unavailable: ${resolved.error}`);
      return;
    }

    await this.semaphore.acquire();

    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
    }

    const emitChunk = (delta, finishReason = null) => {
      const payload = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const heartbeat = stream
      ? setInterval(() => {
          if (!res.writableEnded) res.write(": keep-alive\n\n");
        }, 15000)
      : null;

    let firstTokenAt = null;
    const buffered = [];

    const onDelta = (delta) => {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      if (cfg.streamMode === "final") {
        buffered.push(delta);
        return;
      }
      if (stream && !res.writableEnded) emitChunk({ content: delta });
    };

    const result = await runPrompt({
      launch: resolved.launch,
      prompt,
      timeoutMs: Math.max(30, Number(cfg.requestTimeout) || 900) * 1000,
      onDelta,
    }).finally(() => {
      if (heartbeat) clearInterval(heartbeat);
    });

    const usage = usageFor(result.usage, result.text);
    const durationMs = Date.now() - started;

    // A runner that died at the process level is remembered as unhealthy, so
    // the next request is not sent down the same dead path.
    if (result.error && isProcessFailure(result.error)) {
      markRunFailure(resolved.mode);
    } else if (!result.error) {
      markRunSuccess(resolved.mode);
    }

    try {
      if (result.error && !result.text) {
        this.stats.errors += 1;
        this.stats.lastError = result.error;
        const code = errorCodeFor(result.error);
        log.error("api", `${id} failed after ${durationMs}ms: ${result.error}`);
        if (code === "runner_unavailable") {
          log.warn("api", "the CLI cannot serve models on native Windows — run it inside WSL (Settings → Runner → Repair WSL)");
        }
        if (stream) {
          res.write(`data: ${JSON.stringify({ error: { message: result.error, type: "upstream_error", code } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          apiError(res, 502, result.error, "upstream_error", code);
        }
        return;
      }

      if (stream) {
        if (cfg.streamMode === "final" && result.text) emitChunk({ content: result.text });
        emitChunk({}, "stop");
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: result.model || model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.text },
              finish_reason: finishReasonFor(result),
            },
          ],
          usage,
        });
      }
      log.success(
        "api",
        `${id} ok ${durationMs}ms, ${result.text.length} chars${firstTokenAt ? `, first token ${firstTokenAt - started}ms` : ""}`,
      );
    } finally {
      this.semaphore.release();
    }
  }
}

module.exports = { ApiServer, Semaphore };
