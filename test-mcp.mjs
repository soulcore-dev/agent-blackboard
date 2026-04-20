#!/usr/bin/env node
/**
 * Test del MCP server wrapper.
 * Lanza el server, ejecuta una secuencia completa, y valida outputs.
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { unlinkSync, existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "mcp-server.mjs");
const BOARD = path.join(__dirname, ".test-board.json");

if (existsSync(BOARD)) unlinkSync(BOARD);

const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
let responseBuffer = "";
const responses = new Map();

proc.stdout.on("data", (chunk) => {
  responseBuffer += chunk.toString();
  let idx;
  while ((idx = responseBuffer.indexOf("\n")) !== -1) {
    const line = responseBuffer.slice(0, idx);
    responseBuffer = responseBuffer.slice(idx + 1);
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        if (msg.id != null) responses.set(msg.id, msg);
      } catch {}
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

let msgId = 1;
function send(method, params) {
  const id = msgId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  proc.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(poll);
        resolve(responses.get(id));
      } else if (Date.now() - start > 5000) {
        clearInterval(poll);
        reject(new Error(`Timeout waiting for id ${id}`));
      }
    }, 20);
  });
}

async function callTool(name, args) {
  const res = await send("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text || "";
  const err = res.result?.isError ? " [ERROR]" : "";
  return { text, isError: res.result?.isError, raw: res };
}

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("  pass:", msg);
}

(async () => {
  try {
    // 1. Initialize handshake
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    });

    // 2. List tools
    console.log("\n[1] ListTools:");
    const list = await send("tools/list", {});
    const tools = list.result?.tools || [];
    assert(tools.length === 12, `12 tools expected, got ${tools.length}`);
    const names = tools.map(t => t.name).sort();
    const expected = ["blackboard_claim","blackboard_done","blackboard_estimate","blackboard_fail","blackboard_init","blackboard_next","blackboard_note","blackboard_notes","blackboard_reset","blackboard_status","blackboard_validate","blackboard_wait"];
    assert(JSON.stringify(names) === JSON.stringify(expected), `all 12 tool names match`);

    // 3. Init board
    console.log("\n[2] Init board:");
    const init = await callTool("blackboard_init", {
      board: BOARD,
      tasks: ["interface.ts", "jest.ts:interface.ts", "index.ts:jest.ts,interface.ts"],
    });
    console.log("  output:", init.text.split("\n")[0]);
    assert(init.text.includes("3 tasks"), "init creates 3 tasks");
    assert(existsSync(BOARD), "board.json file was created");

    // 4. Agent1 claims → should get interface.ts (no deps)
    console.log("\n[3] Agent1 claims (no deps available):");
    const claim1 = await callTool("blackboard_claim", { board: BOARD, agent: "agent-1" });
    console.log("  output:", claim1.text);
    assert(claim1.text.includes("CLAIMED: interface.ts"), "agent-1 got interface.ts");

    // 5. Agent2 tries to claim jest.ts → should be BLOCKED
    console.log("\n[4] Agent2 tries jest.ts (blocked by interface.ts):");
    const claim2 = await callTool("blackboard_claim", { board: BOARD, agent: "agent-2", task: "jest.ts" });
    console.log("  output:", claim2.text);
    assert(claim2.text.includes("BLOCKED"), "jest.ts is blocked");

    // 6. Agent1 leaves a note
    console.log("\n[5] Agent1 leaves note:");
    const note = await callTool("blackboard_note", { board: BOARD, agent: "agent-1", message: "Defined 6 types" });
    assert(note.text.includes("NOTE:"), "note was added");

    // 7. Agent1 done
    console.log("\n[6] Agent1 done:");
    const done = await callTool("blackboard_done", { board: BOARD, agent: "agent-1", message: "6 types exported" });
    console.log("  output:", done.text);
    assert(done.text.includes("DONE: interface.ts"), "interface.ts marked done");
    assert(done.text.includes("UNBLOCKED: jest.ts"), "jest.ts now unblocked");

    // 8. Agent2 claims jest.ts
    console.log("\n[7] Agent2 claims jest.ts:");
    const claim3 = await callTool("blackboard_claim", { board: BOARD, agent: "agent-2" });
    console.log("  output:", claim3.text);
    assert(claim3.text.includes("CLAIMED: jest.ts"), "agent-2 got jest.ts");

    // 8b. Agent2 reads notes for interface.ts (context from agent-1)
    console.log("\n[7b] Agent2 reads notes:");
    const notes = await callTool("blackboard_notes", { board: BOARD, task: "interface.ts" });
    console.log("  output:", notes.text);
    assert(notes.text.includes("Defined 6 types"), "note from agent-1 retrievable via notes tool");

    // 9. Validate self → should fail
    console.log("\n[8] Agent1 tries to validate own task (should reject):");
    const selfVal = await callTool("blackboard_validate", { board: BOARD, agent: "agent-1", task: "interface.ts" });
    console.log("  output:", selfVal.text);
    assert(selfVal.text.includes("Cannot self-validate"), "self-validation blocked");

    // 10. Cross-validate
    console.log("\n[9] Agent2 validates agent1's task:");
    const val = await callTool("blackboard_validate", { board: BOARD, agent: "agent-2", task: "interface.ts" });
    console.log("  output:", val.text);
    assert(val.text.includes("VALIDATED"), "cross-validation works");

    // 11. Status
    console.log("\n[10] Status:");
    const status = await callTool("blackboard_status", { board: BOARD });
    console.log("  first 3 lines:");
    status.text.split("\n").slice(0, 5).forEach(l => console.log("    " + l));
    assert(status.text.includes("Progress:"), "status shows progress");

    // 12. Agent2 done
    console.log("\n[11] Agent2 done:");
    const done2 = await callTool("blackboard_done", { board: BOARD, agent: "agent-2" });
    assert(done2.text.includes("DONE: jest.ts"), "jest.ts done");
    assert(done2.text.includes("UNBLOCKED: index.ts"), "index.ts unblocked");

    // 13. Next
    console.log("\n[12] Next:");
    const next = await callTool("blackboard_next", { board: BOARD });
    console.log("  output:", next.text);
    assert(next.text.trim() === "index.ts", "next is index.ts");

    // 14. Wait (should show 1 remaining)
    console.log("\n[13] Wait:");
    const wait = await callTool("blackboard_wait", { board: BOARD });
    console.log("  output:", wait.text.split("\n")[0]);
    assert(wait.text.includes("WAITING"), "still waiting for 1");

    // 15. Estimate
    console.log("\n[14] Estimate:");
    const est = await callTool("blackboard_estimate", { board: BOARD });
    console.log("  output line1:", est.text.split("\n")[0]);
    // En tests rapidos las duraciones son 0 = no se puede estimar. Es comportamiento correcto del CLI.
    assert(
      est.text.includes("Avg task duration") || est.text.includes("cannot estimate"),
      "estimate tool runs without error"
    );

    // 16. Final cleanup
    unlinkSync(BOARD);
    console.log("\n✓ ALL 15 CHECKS PASSED");
    proc.kill();
    process.exit(0);
  } catch (e) {
    console.error("\n✗ TEST FAILED:", e.message);
    proc.kill();
    process.exit(1);
  }
})();
