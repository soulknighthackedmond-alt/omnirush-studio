#!/usr/bin/env node
"use strict";

/**
 * Headless entry point: the same OpenAI-compatible server without the GUI.
 *
 *   node bin/serve.cjs
 *   node bin/serve.cjs --port 8123 --model gpt-6-sol
 *
 * It reads the same config file the desktop app writes; the flags above apply
 * to this run only and are never written back to that file.
 */

const configStore = require("../electron/config.cjs");
const logs = require("../electron/log.cjs");
const { ApiServer } = require("../electron/openai-server.cjs");

const overrides = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  const [key, inline] = arg.replace(/^--/, "").split("=");
  const value = inline !== undefined ? inline : process.argv[++i];
  if (key === "port") overrides.port = Number(value);
  else if (key === "host") overrides.host = value;
  else if (key === "model") overrides.model = value;
  else if (key === "api-key") overrides.apiKey = value;
  else if (key === "workdir") overrides.workdir = value;
  else if (key === "concurrency") overrides.maxConcurrency = Number(value);
  else if (key === "runner") overrides.runner = value;
  else if (key === "wsl-distro") overrides.wslDistro = value;
  else if (key === "agentic") overrides.agentic = value !== "false";
}

const config = { ...configStore.load(), ...overrides };

logs.subscribe((entry) => {
  process.stdout.write(`[${entry.at.slice(11, 19)}] ${entry.level.padEnd(7)} ${entry.scope.padEnd(6)} ${entry.message}\n`);
});

const server = new ApiServer({ getConfig: () => config });

server
  .start()
  .then((status) => {
    process.stdout.write(`OmniRush Studio API — ${status.baseUrl}\n`);
    process.stdout.write(`model ${config.model} · runner ${config.runner} · concurrency ${config.maxConcurrency}\n`);
    if (config.apiKey) process.stdout.write("bearer auth enabled\n");
  })
  .catch((err) => {
    process.stderr.write(`could not start: ${err.message}\n`);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
