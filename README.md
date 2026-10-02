# OmniRush Studio

A desktop app that drives the **OmniRush CLI** and serves it as an
**OpenAI-compatible `v1` API** on your own machine.

The window is an Electron shell around a React UI; the API server runs in the
same process, so the whole thing is one app with no external services.

```
OpenAI client  ──HTTP──▶  /v1/chat/completions  ──RPC──▶  omnirush --mode rpc
     ▲                                                        │
     └────────────── SSE text deltas ◀─────────────────────────┘
```

## Requirements

- Node.js 20+ (tested on 22.14)
- The OmniRush CLI installed and signed in (`omnirush login`, `omnirush whoami`)

## Run it

```bash
npm install          # once
npm run dev          # Vite dev server + Electron, hot reload
# or
npm start            # production build, then Electron
```

The server starts with the app if **Settings → Start the server when the app
opens** is on, and listens on `http://127.0.0.1:8787/v1` by default. (It was
8000 in the first release; a stored `8000` is migrated to 8787 on load.)

Headless — the same API without the window:

```bash
npm run api
npm run api -- --port 8123 --model gpt-6-sol --api-key secret
```

Flags apply to that run only; they are never written back to the config file.

## Endpoints

| Method | Path                   | Notes                                        |
| ------ | ---------------------- | -------------------------------------------- |
| GET    | `/health`              | status, model, counters — no auth            |
| GET    | `/v1/models`           | the configured model plus the CLI's list     |
| POST   | `/v1/chat/completions` | `stream: true` or a single JSON response     |
| POST   | `/v1/completions`      | legacy `prompt` form                         |

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"hello"}]}'
```

Streaming is real: the CLI's `text_delta` events are forwarded as SSE chunks as
they arrive, not buffered and replayed.

## Runners — how the CLI is started

Two runners, chosen in **Settings → Runner** (`auto` picks the first that works):

- **native** — spawns the installed CLI directly. Used on Linux and macOS, and
  on Windows installs that still serve model traffic.
- **wsl** — `wsl.exe -d <distro> -e bash -lc "omnirush --mode rpc ..."`.

`auto` prefers **wsl** on Windows, because the OmniRush gateway currently
answers Windows-native model calls with:

> OmniRush on Windows now runs in WSL. Your tokens are kept for you there.
> Set it up in a few minutes: https://omnirush.ai/console/wsl

That message comes from the server, not from this app. To use the app on
Windows, install and sign in to the CLI **inside WSL**:

```powershell
wsl -d Ubuntu -- bash -lc "npm i -g omnirush && omnirush login"
```

Three WSL details cost real time to find, so they are written down here:

- **The grant is tied to the device.** Copying `~/.omnirush/auth.json` from
  Windows into the distro makes `omnirush whoami` work, but the gateway still
  refuses model calls, because the device behind that token is a Windows one.
  Sign in **inside the distro** (`omnirush login`, device flow) and the linux
  device gets its own grant.
- **`command -v omnirush` can lie.** WSL puts the Windows `PATH` on the Linux
  `PATH`, so an install that lives at `/mnt/c/...` answers `command -v` while
  being unusable. Detection reports that case separately instead of calling the
  runner healthy.
- **`--yolo` is a Windows-only flag.** The Windows entry point rewrites it into
  the core's `--approve`; the Linux CLI rejects it outright
  (`Unknown option: --yolo`). The WSL launch therefore passes `--approve`.

Then press **Detect** in Settings — the WSL row should read `omnirush found in
WSL`, and the **Test CLI** button should return a real answer. If the distro
itself will not boot (`CreateVm` / `0x8007274c` / `E_UNEXPECTED`), **Repair
WSL** runs `wsl --update` and `wsl --shutdown` and re-checks. Two more causes
worth checking before blaming the app: a `%USERPROFILE%\.wslconfig` with
`processors=1` (WSL2 cannot start its VM with a single processor — use 2), and
virtualization being off in the BIOS/UEFI.

A runner that dies at the process level is remembered as unhealthy for five
minutes, so one dead WSL distro does not make every request fail: the next
request falls back to the other runner.

## Compression — RTK

The **Compression** page drives [RTK](https://www.rtk-ai.app) (Rust Token
Killer), which compresses the output of the commands the agent runs before it
reaches the model's context — long diffs, test runs and log dumps cost a
fraction of the tokens. It matters most in agentic mode, where shell output is
most of what the model reads.

RTK hooks an agent by installing a TypeScript extension, and the extension only
counts if it is in the directory the CLI loads from. `rtk init -g --agent pi`
writes to pi's directory; OmniRush sets its own agent directory
(`OMNIRUSH_AGENT_DIR`, default `~/.omnirush/agent`). The page therefore:

- reports which environment the CLI runs in (native or a WSL distro) and
  whether `rtk` is on that environment's `PATH`;
- runs `rtk init -g --agent pi` and then mirrors the hook into the CLI's agent
  directory (your project folder is never written to);
- renames the hook to `.bak` to disable it;
- shows `rtk gain` — the tokens saved so far — and its parsed numbers.

Installing RTK itself is one button: `winget install --id rtk-ai.rtk -e` on
Windows, the project's install script inside WSL. Installing needs the network
and can take a minute; the command, its exit code and its output all land in
**Logs**. The app never writes the hook into your working directory.

Verified against RTK 0.50.0 on Windows: `rtk init -g --agent pi` writes
`~/.pi/agent/extensions/rtk.ts`, and the mirror step copies it to
`~/.omnirush/agent/extensions/rtk.ts` — the directory the CLI actually loads.

## Settings

Stored at `%APPDATA%\omnirush-studio\config.json` (Windows) or
`~/.config/omnirush-studio/config.json`. The GUI and `npm run api` share it.

Notable options:

- **Model / Thinking** — passed through as `--model` and `--thinking`.
- **Yolo mode** — `--yolo`, so the headless CLI never stops to ask. Required
  for unattended use; the agent may run commands in the working directory.
- **Agentic mode** — off (default) keeps the model answering directly, like a
  chat API. On lets the full coding agent use its tools.
- **Streaming style** — `live` forwards deltas; `final` buffers a run and sends
  one chunk.
- **API key** — when set, every `/v1/*` call needs `Authorization: Bearer …`.

## Verify

```bash
npm run check       # 14 API checks + 24 RTK checks
npm run typecheck   # renderer types
npm run build       # production bundle
```

`npm run check` runs the real server against `test/fake-cli.cjs`, a stand-in
that speaks the same JSONL protocol, and the RTK integration against
`test/fake-rtk.cjs`, a stand-in binary. Neither needs an account, the network or
model access, so the suite works even when the CLI cannot reach a model — useful
as a regression check and as documentation of the RPC protocol.

## Layout

```
electron/
  main.cjs           window, IPC, lifecycle
  preload.cjs        contextBridge surface (no node in the renderer)
  config.cjs         settings, shared by GUI and headless (with migrations)
  runner.cjs         native/wsl launch planning, detection, health memory
  rpc-client.cjs     JSONL transport to `omnirush --mode rpc`
  session.cjs        one request = one CLI run; prompt building, deltas
  openai-server.cjs  the v1 API (routes, SSE, auth, concurrency)
  rtk.cjs            RTK compression: detect, enable, mirror, savings
  wsl.cjs            WSL probe and repair
  proc.cjs           shared async process helper
  log.cjs            in-memory log ring buffer
src/                 React renderer (Overview, Playground, Compression, Settings, Logs)
bin/serve.cjs        headless entry point
test/                fake CLI + fake RTK + API/RTK checks
```

## Notes

- The renderer talks to the API over HTTP for the Playground, so the Playground
  is a genuine client of the endpoint rather than a shortcut.
- One request = one CLI process. Concurrency is capped by **Max concurrency**;
  extra requests queue rather than interleave inside a single agent session.
- No tool/`--no-tools` flag exists in the CLI, so "answer directly" is done with
  a short instruction preamble on the prompt (`electron/session.cjs`).
