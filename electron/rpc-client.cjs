"use strict";

/**
 * A live connection to `omnirush --mode rpc`.
 *
 * The protocol is JSONL over stdin/stdout: commands go in as one JSON object
 * per line, agent events come back the same way. Framing is LF-only on purpose
 * (the CLI documents that a generic line reader would also split on U+2028 /
 * U+2029, which are legal inside JSON strings).
 */

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");

let nextId = 0;

class RpcClient extends EventEmitter {
  constructor(launch) {
    super();
    this.launch = launch;
    this.child = null;
    this.closed = false;
    this._buffer = "";
  }

  start() {
    if (this.child) return this;
    const { command, args, cwd, env } = this.launch;
    this.child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    this.child.on("error", (err) => {
      this.closed = true;
      this.emit("error", err);
    });
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.emit("close", { code, signal });
    });
    return this;
  }

  _onData(chunk) {
    this._buffer += chunk;
    let index;
    while ((index = this._buffer.indexOf("\n")) >= 0) {
      const line = this._buffer.slice(0, index).replace(/\r$/, "");
      this._buffer = this._buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        this.emit("noise", line);
        continue;
      }
      this.emit("event", event);
    }
  }

  send(command) {
    if (!this.child || this.closed) return false;
    try {
      this.child.stdin.write(JSON.stringify(command) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  prompt(text) {
    const id = `p${++nextId}`;
    this.send({ id, type: "prompt", message: text });
    return id;
  }

  abort() {
    this.send({ type: "abort" });
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    // On Windows the CLI runs the agent core as a grandchild; kill the tree so
    // a stopped request cannot leave an orphan behind.
    if (process.platform === "win32" && child.pid) {
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { windowsHide: true, stdio: "ignore" });
      } catch {
        /* best effort */
      }
    }
  }
}

module.exports = { RpcClient };
