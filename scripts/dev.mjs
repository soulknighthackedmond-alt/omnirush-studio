import { spawn } from "node:child_process";
import { createServer } from "vite";
import electronPath from "electron";

// Vite's dev server is started in-process so the app needs no extra runner
// (no concurrently / wait-on) and Electron only launches once the URL is live.
const server = await createServer({ server: { port: 5173, strictPort: true } });
await server.listen();

const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:5173/";
console.log(`vite ready at ${url} — starting electron`);

const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

const shutdown = async (code = 0) => {
  await server.close();
  process.exit(code);
};

child.on("close", (code) => shutdown(code ?? 0));
process.on("SIGINT", () => {
  child.kill();
  shutdown(0);
});
