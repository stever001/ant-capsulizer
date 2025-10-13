/**
 * ANT-Capsulizer Dev Runner
 * Starts Redis (if local), launches workers, then runs the seed script.
 * Usage:  npm run dev:seed
 */

import { spawn } from "child_process";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "../src");

const commands = [
  {
    name: "worker",
    cmd: "node",
    args: [`${SRC}/worker.js`],
    color: "\x1b[36m", // cyan
  },
  {
    name: "seed",
    cmd: "node",
    args: [`${SRC}/seed.js`],
    color: "\x1b[33m", // yellow
  },
];

function runCommand({ name, cmd, args, color }) {
  const proc = spawn(cmd, args, { stdio: "pipe", shell: true });
  proc.stdout.on("data", (data) =>
    console.log(`${color}[${name}]${"\x1b[0m"} ${data.toString().trim()}`)
  );
  proc.stderr.on("data", (data) =>
    console.error(`${color}[${name} ERR]${"\x1b[0m"} ${data.toString().trim()}`)
  );
  proc.on("exit", (code) =>
    console.log(`${color}[${name}]${"\x1b[0m"} exited with code ${code}`)
  );
}

// Optional: launch local Redis if you’re not using a remote instance
function startRedisIfLocal() {
  if (process.env.REDIS_HOST === "127.0.0.1" || process.env.REDIS_HOST === "localhost") {
    try {
      console.log("🔄 Starting local Redis...");
      spawn("redis-server", [], { stdio: "ignore", detached: true });
    } catch {
      console.warn("⚠️ Could not start local Redis automatically. Is it installed?");
    }
  }
}

(async () => {
  console.log("🚀 ANT-Capsulizer Dev+Seed runner");
  startRedisIfLocal();

  // Run worker and seed sequentially or in parallel as desired
  runCommand(commands[0]); // worker
  setTimeout(() => runCommand(commands[1]), 3000); // seed after 3s delay
})();
