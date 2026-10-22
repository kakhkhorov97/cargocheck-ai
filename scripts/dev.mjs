import { spawn } from "node:child_process";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const api = spawn(
  node,
  [
    "--watch",
    "--import",
    "tsx",
    "--env-file-if-exists=../../.env",
    "src/main.ts",
  ],
  {
    cwd: path.join(root, "apps/api"),
    stdio: "inherit",
    env: { ...process.env, PORT: process.env.API_PORT ?? "3001" },
  },
);
const web = spawn(
  node,
  [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "0.0.0.0"],
  { cwd: path.join(root, "apps/web"), stdio: "inherit", env: process.env },
);
function stop() {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", (code) => {
  web.kill();
  process.exitCode = code ?? 0;
});
web.on("exit", (code) => {
  api.kill();
  process.exitCode = code ?? 0;
});
