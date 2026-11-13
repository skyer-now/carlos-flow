import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";

const PORT = parseInt(process.argv[2] || process.env.BRIDGE_PORT || "19099", 10);
const TOKEN = process.env.CARLOS_BRIDGE_TOKEN || "test-token";
const MCP_SERVER = process.env.CARLOS_FLOW_MCP_ROOT + "/src/index.js";
const REQUEST_TIMEOUT = Number(process.env.CARLOS_BRIDGE_TIMEOUT_MS) || 180000;

if (!TOKEN) {
  process.stderr.write("[bridge] ❌ CARLOS_BRIDGE_TOKEN 未设置\n");
  process.exit(1);
}

const child = spawn(process.execPath, [MCP_SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
  windowsHide: true,
});

let childStdout = "";
child.stdout.on("data", (data) => { childStdout += data.toString("utf8"); });
console.log(`Bridge started with PID: ${child.pid}`);
