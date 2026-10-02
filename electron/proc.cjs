"use strict";

/**
 * Small async process helper shared by the RTK and WSL modules.
 *
 * Everything here is deliberately non-blocking: `spawnSync` would freeze the
 * whole Electron window while `winget install` or `wsl --update` runs, which
 * can take minutes.
 */

const { spawn } = require("node:child_process");

/** POSIX single-quote a value so it survives `bash -lc`. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a command and collect its output.
 *
 * Resolves (never rejects) with `{ ok, code, stdout, stderr, error, timedOut }`
 * so callers can log the failure verbatim instead of catching.
 */
function exec(argv, { timeoutMs = 120000, cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env || process.env,
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      resolve({ ok: false, code: null, stdout: "", stderr: "", error: err.message, timedOut: false, durationMs: 0 });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !error,
        code,
        stdout,
        stderr,
        error: error || null,
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null, `timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** First non-empty line of a command's combined output, trimmed. */
function firstLine(result) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const line = text.split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim() : "";
}

/** Combined output, trimmed to `limit` characters for the UI and the log. */
function combined(result, limit = 4000) {
  const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;
}

module.exports = { exec, firstLine, combined, shellQuote };
