"use strict";

/** Tiny in-memory log ring buffer shared by the server, the CLI runner and the UI. */

const MAX_ENTRIES = 800;

const entries = [];
const listeners = new Set();
let seq = 0;

function push(level, scope, message) {
  const entry = {
    id: ++seq,
    at: new Date().toISOString(),
    level,
    scope,
    message: String(message).replace(/\s+$/, ""),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* a broken listener must not break logging */
    }
  }
  return entry;
}

const log = {
  info: (scope, msg) => push("info", scope, msg),
  warn: (scope, msg) => push("warn", scope, msg),
  error: (scope, msg) => push("error", scope, msg),
  success: (scope, msg) => push("success", scope, msg),
};

function list() {
  return entries.slice();
}

function clear() {
  entries.length = 0;
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { log, list, clear, subscribe };
