#!/usr/bin/env node

/**
 * Sistema de Coordinacion Multi-Agente — Agent Blackboard v2.0
 * SOUL CORE — 2026
 *
 * Commands:
 *   node board.mjs init <board> <task1:dep1,dep2> <task2> ...  — Create board (with optional dependencies)
 *   node board.mjs claim <board> <agent> [task]                — Claim next available task
 *   node board.mjs done <board> <agent> [message]              — Mark current task as done
 *   node board.mjs fail <board> <agent> <message>              — Report failure (auto-retry if retries left)
 *   node board.mjs note <board> <agent> <message>              — Leave a note for other agents
 *   node board.mjs notes <board> [task]                        — Read notes (all or for specific task)
 *   node board.mjs validate <board> <agent> <task>             — Validate a completed task
 *   node board.mjs status <board>                              — Show full board status
 *   node board.mjs next <board>                                — Show next available task
 *   node board.mjs wait <board>                                — Check if all tasks done
 *   node board.mjs estimate <board>                            — Estimate time remaining
 *   node board.mjs reset <board> <task>                        — Reset a failed task to pending
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const [,, command, boardPath, ...args] = process.argv;

if (!command || !boardPath) {
  console.log("Sistema de Coordinacion Multi-Agente v2.0");
  console.log("Usage: node board.mjs <command> <board.json> [args...]");
  console.log("Commands: init, claim, done, fail, note, notes, validate, status, next, wait, estimate, reset");
  process.exit(1);
}

function readBoard() {
  if (!existsSync(boardPath)) { console.error(`Board not found: ${boardPath}`); process.exit(1); }
  return JSON.parse(readFileSync(boardPath, "utf-8"));
}

function writeBoard(board) {
  writeFileSync(boardPath, JSON.stringify(board, null, 2), "utf-8");
}

function ts() {
  return new Date().toISOString().substring(11, 19);
}

function depsReady(task, board) {
  if (!task.depends || task.depends.length === 0) return true;
  return task.depends.every(dep => {
    const depTask = board.tasks.find(t => t.name === dep);
    return depTask && depTask.status === "done";
  });
}

function getAvailable(board) {
  return board.tasks.filter(t => t.status === "pending" && depsReady(t, board));
}

// ═══════════════════════════════════════════════════════
// INIT — Create board with tasks and optional dependencies
// Format: task:dep1,dep2 (dependencies after colon)
// ═══════════════════════════════════════════════════════
if (command === "init") {
  if (args.length === 0) {
    console.error("Usage: init <board> <task1:dep1,dep2> <task2> ...");
    process.exit(1);
  }

  const maxRetries = parseInt(process.env.MAX_RETRIES || "2");

  const board = {
    created: new Date().toISOString(),
    version: "2.0",
    config: { maxRetries },
    tasks: args.map(arg => {
      const [name, depStr] = arg.split(":");
      return {
        name,
        depends: depStr ? depStr.split(",").filter(Boolean) : [],
        agent: null,
        status: "pending",
        claimedAt: null,
        doneAt: null,
        duration: null,
        message: null,
        retries: 0,
        validated: false,
        validatedBy: null,
      };
    }),
    notes: [],
    logs: [],
    agents: {},
  };

  writeBoard(board);
  console.log(`Board created: ${board.tasks.length} tasks (max retries: ${maxRetries})`);
  for (const t of board.tasks) {
    const deps = t.depends.length > 0 ? ` (needs: ${t.depends.join(", ")})` : "";
    console.log(`  [ ] ${t.name}${deps}`);
  }
}

// ═══════════════════════════════════════════════════════
// CLAIM — Take next available task (respects dependencies)
// ═══════════════════════════════════════════════════════
else if (command === "claim") {
  const [agent, specificTask] = args;
  if (!agent) { console.error("Usage: claim <agent> [task]"); process.exit(1); }

  const board = readBoard();

  const current = board.tasks.find(t => t.agent === agent && t.status === "working");
  if (current) {
    console.log(`BUSY: ${agent} already working on: ${current.name}`);
    process.exit(0);
  }

  let task;
  if (specificTask) {
    task = board.tasks.find(t => t.name === specificTask && t.status === "pending");
    if (!task) { console.log(`UNAVAILABLE: ${specificTask}`); process.exit(0); }
    if (!depsReady(task, board)) {
      const pending = task.depends.filter(d => {
        const dt = board.tasks.find(t => t.name === d);
        return !dt || dt.status !== "done";
      });
      console.log(`BLOCKED: ${specificTask} waiting for: ${pending.join(", ")}`);
      process.exit(0);
    }
  } else {
    const available = getAvailable(board);
    if (available.length === 0) {
      const blocked = board.tasks.filter(t => t.status === "pending" && !depsReady(t, board));
      if (blocked.length > 0) {
        console.log(`BLOCKED: ${blocked.length} tasks waiting for dependencies`);
      } else {
        console.log("NONE: No pending tasks");
      }
      process.exit(0);
    }
    task = available[0];
  }

  task.agent = agent;
  task.status = "working";
  task.claimedAt = new Date().toISOString();

  if (!board.agents[agent]) board.agents[agent] = { claimed: 0, done: 0, failed: 0, totalTime: 0 };
  board.agents[agent].claimed++;

  // Show relevant notes
  const taskNotes = board.notes.filter(n => n.task === task.name || !n.task);
  if (taskNotes.length > 0) {
    console.log(`NOTES for ${task.name}:`);
    taskNotes.forEach(n => console.log(`  [${n.agent}] ${n.message}`));
  }

  board.logs.push({ time: ts(), agent, action: "claim", task: task.name });
  writeBoard(board);
  console.log(`CLAIMED: ${task.name} -> ${agent}`);
}

// ═══════════════════════════════════════════════════════
// DONE — Mark task as done (with time tracking)
// ═══════════════════════════════════════════════════════
else if (command === "done") {
  const [agent, ...msgParts] = args;
  if (!agent) { console.error("Usage: done <agent> [message]"); process.exit(1); }

  const board = readBoard();
  const task = board.tasks.find(t => t.agent === agent && t.status === "working");
  if (!task) { console.log(`No active task for ${agent}`); process.exit(0); }

  const now = new Date();
  task.status = "done";
  task.doneAt = now.toISOString();
  task.duration = task.claimedAt ? Math.round((now.getTime() - new Date(task.claimedAt).getTime()) / 1000) : 0;
  task.message = msgParts.join(" ") || "completed";

  if (board.agents[agent]) {
    board.agents[agent].done++;
    board.agents[agent].totalTime += task.duration;
  }

  board.logs.push({ time: ts(), agent, action: "done", task: task.name, message: task.message, duration: task.duration });
  writeBoard(board);

  const total = board.tasks.length;
  const done = board.tasks.filter(t => t.status === "done").length;
  console.log(`DONE: ${task.name} (${task.duration}s)`);
  console.log(`Progress: ${done}/${total} (${Math.round(done / total * 100)}%)`);

  // Show newly unblocked tasks
  const unblocked = board.tasks.filter(t => t.status === "pending" && t.depends.includes(task.name) && depsReady(t, board));
  if (unblocked.length > 0) {
    console.log(`UNBLOCKED: ${unblocked.map(t => t.name).join(", ")}`);
  }
}

// ═══════════════════════════════════════════════════════
// FAIL — Report failure (auto-retry if retries available)
// ═══════════════════════════════════════════════════════
else if (command === "fail") {
  const [agent, ...msgParts] = args;
  if (!agent) { console.error("Usage: fail <agent> <message>"); process.exit(1); }

  const board = readBoard();
  const task = board.tasks.find(t => t.agent === agent && t.status === "working");
  if (!task) { console.log(`No active task for ${agent}`); process.exit(0); }

  task.retries++;
  const maxRetries = board.config?.maxRetries || 2;

  if (task.retries < maxRetries) {
    // Auto-retry: reset to pending so another agent can pick it up
    task.status = "pending";
    task.agent = null;
    task.claimedAt = null;
    task.message = `retry ${task.retries}/${maxRetries}: ${msgParts.join(" ")}`;

    board.logs.push({ time: ts(), agent, action: "retry", task: task.name, message: task.message });
    writeBoard(board);
    console.log(`RETRY: ${task.name} (${task.retries}/${maxRetries}) — returned to queue`);
  } else {
    // Max retries exhausted
    task.status = "failed";
    task.doneAt = new Date().toISOString();
    task.message = msgParts.join(" ") || "failed";

    if (board.agents[agent]) board.agents[agent].failed++;

    board.logs.push({ time: ts(), agent, action: "fail", task: task.name, message: task.message });
    writeBoard(board);
    console.log(`FAILED: ${task.name} (${task.retries} retries exhausted)`);
  }
}

// ═══════════════════════════════════════════════════════
// NOTE — Leave a note for other agents
// ═══════════════════════════════════════════════════════
else if (command === "note") {
  const [agent, ...msgParts] = args;
  if (!agent || msgParts.length === 0) { console.error("Usage: note <agent> <message>"); process.exit(1); }

  const board = readBoard();

  // Check if agent has a current task — attach note to it
  const current = board.tasks.find(t => t.agent === agent && (t.status === "working" || t.status === "done"));
  const taskName = current?.name || null;

  board.notes.push({
    time: ts(),
    agent,
    task: taskName,
    message: msgParts.join(" "),
  });

  board.logs.push({ time: ts(), agent, action: "note", task: taskName, message: msgParts.join(" ") });
  writeBoard(board);
  console.log(`NOTE: [${agent}${taskName ? " @ " + taskName : ""}] ${msgParts.join(" ")}`);
}

// ═══════════════════════════════════════════════════════
// NOTES — Read all notes or notes for a specific task
// ═══════════════════════════════════════════════════════
else if (command === "notes") {
  const [taskFilter] = args;
  const board = readBoard();

  const filtered = taskFilter
    ? board.notes.filter(n => n.task === taskFilter || !n.task)
    : board.notes;

  if (filtered.length === 0) {
    console.log("No notes.");
  } else {
    console.log(`Notes${taskFilter ? " for " + taskFilter : ""}:`);
    for (const n of filtered) {
      console.log(`  [${n.time}] ${n.agent}${n.task ? " @ " + n.task : ""}: ${n.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════
// VALIDATE — Cross-validate a completed task
// ═══════════════════════════════════════════════════════
else if (command === "validate") {
  const [agent, taskName] = args;
  if (!agent || !taskName) { console.error("Usage: validate <agent> <task>"); process.exit(1); }

  const board = readBoard();
  const task = board.tasks.find(t => t.name === taskName);

  if (!task) { console.log(`Task not found: ${taskName}`); process.exit(0); }
  if (task.status !== "done") { console.log(`Task ${taskName} is not done (status: ${task.status})`); process.exit(0); }
  if (task.agent === agent) { console.log(`Cannot self-validate: ${agent} wrote ${taskName}`); process.exit(0); }

  task.validated = true;
  task.validatedBy = agent;

  board.logs.push({ time: ts(), agent, action: "validate", task: taskName });
  writeBoard(board);
  console.log(`VALIDATED: ${taskName} (by ${agent}, written by ${task.agent})`);
}

// ═══════════════════════════════════════════════════════
// STATUS — Full board overview
// ═══════════════════════════════════════════════════════
else if (command === "status") {
  const board = readBoard();
  const total = board.tasks.length;
  const done = board.tasks.filter(t => t.status === "done").length;
  const working = board.tasks.filter(t => t.status === "working").length;
  const pending = board.tasks.filter(t => t.status === "pending").length;
  const failed = board.tasks.filter(t => t.status === "failed").length;
  const validated = board.tasks.filter(t => t.validated).length;

  console.log(`Sistema de Coordinacion Multi-Agente v2.0`);
  console.log(`${"=".repeat(50)}`);
  console.log(`Progress: ${done}/${total} (${Math.round(done / total * 100)}%) | Validated: ${validated}/${done}`);
  console.log(`Pending: ${pending} | Working: ${working} | Done: ${done} | Failed: ${failed}`);
  console.log();

  for (const t of board.tasks) {
    const icon = t.validated ? "V" : t.status === "done" ? "+" : t.status === "working" ? ">" : t.status === "failed" ? "X" : " ";
    const agent = t.agent ? ` [${t.agent}]` : "";
    const deps = t.depends?.length > 0 ? ` (needs: ${t.depends.join(",")})` : "";
    const dur = t.duration ? ` ${t.duration}s` : "";
    const msg = t.message ? ` -- ${t.message}` : "";
    const val = t.validated ? ` [validated by ${t.validatedBy}]` : "";
    const blocked = t.status === "pending" && !depsReady(t, board) ? " BLOCKED" : "";
    console.log(`  [${icon}] ${t.name}${agent}${deps}${dur}${blocked}${msg}${val}`);
  }

  if (Object.keys(board.agents).length > 0) {
    console.log();
    console.log(`Agents:`);
    for (const [name, stats] of Object.entries(board.agents)) {
      const avg = stats.done > 0 ? Math.round(stats.totalTime / stats.done) : 0;
      console.log(`  ${name}: ${stats.done} done, ${stats.claimed - stats.done - stats.failed} active, ${stats.failed} failed, avg ${avg}s/task`);
    }
  }

  if (board.notes.length > 0) {
    console.log();
    console.log(`Notes:`);
    for (const n of board.notes.slice(-5)) {
      console.log(`  [${n.agent}${n.task ? " @ " + n.task : ""}] ${n.message}`);
    }
  }

  if (board.logs.length > 0) {
    console.log();
    console.log(`Recent activity:`);
    for (const log of board.logs.slice(-10)) {
      console.log(`  [${log.time}] ${log.agent}: ${log.action} ${log.task || ""}${log.message ? " -- " + log.message : ""}${log.duration ? " (" + log.duration + "s)" : ""}`);
    }
  }
}

// ═══════════════════════════════════════════════════════
// ESTIMATE — Time remaining based on average task duration
// ═══════════════════════════════════════════════════════
else if (command === "estimate") {
  const board = readBoard();
  const doneTasks = board.tasks.filter(t => t.status === "done" && t.duration);
  const remaining = board.tasks.filter(t => t.status === "pending" || t.status === "working").length;
  const activeAgents = Object.values(board.agents).filter(a => a.claimed - a.done - a.failed > 0).length || 1;

  if (doneTasks.length === 0) {
    console.log("No completed tasks yet — cannot estimate.");
    process.exit(0);
  }

  const avgDuration = Math.round(doneTasks.reduce((s, t) => s + t.duration, 0) / doneTasks.length);
  const estimatedTotal = avgDuration * remaining;
  const parallelEstimate = Math.round(estimatedTotal / activeAgents);

  console.log(`Time Estimate`);
  console.log(`${"=".repeat(40)}`);
  console.log(`Avg task duration: ${avgDuration}s`);
  console.log(`Remaining tasks: ${remaining}`);
  console.log(`Active agents: ${activeAgents}`);
  console.log(`Estimated time: ~${parallelEstimate}s (${Math.round(parallelEstimate / 60)}min)`);
}

// ═══════════════════════════════════════════════════════
// NEXT — Show next available task
// ═══════════════════════════════════════════════════════
else if (command === "next") {
  const board = readBoard();
  const available = getAvailable(board);
  if (available.length > 0) {
    console.log(available[0].name);
  } else {
    const blocked = board.tasks.filter(t => t.status === "pending" && !depsReady(t, board));
    console.log(blocked.length > 0 ? `BLOCKED: waiting for dependencies` : "NONE");
  }
}

// ═══════════════════════════════════════════════════════
// WAIT — Check completion
// ═══════════════════════════════════════════════════════
else if (command === "wait") {
  const board = readBoard();
  const remaining = board.tasks.filter(t => t.status === "pending" || t.status === "working");
  if (remaining.length === 0) {
    const done = board.tasks.filter(t => t.status === "done").length;
    const failed = board.tasks.filter(t => t.status === "failed").length;
    const validated = board.tasks.filter(t => t.validated).length;
    console.log(`ALL DONE: ${done} completed, ${failed} failed, ${validated} validated`);
  } else {
    console.log(`WAITING: ${remaining.length} tasks remaining`);
    remaining.forEach(t => console.log(`  ${t.status === "working" ? ">" : " "} ${t.name} ${t.agent ? "[" + t.agent + "]" : ""}`));
  }
}

// ═══════════════════════════════════════════════════════
// RESET — Reset a failed task to pending
// ═══════════════════════════════════════════════════════
else if (command === "reset") {
  const [taskName] = args;
  if (!taskName) { console.error("Usage: reset <task>"); process.exit(1); }

  const board = readBoard();
  const task = board.tasks.find(t => t.name === taskName);
  if (!task) { console.log(`Task not found: ${taskName}`); process.exit(0); }

  task.status = "pending";
  task.agent = null;
  task.claimedAt = null;
  task.doneAt = null;
  task.duration = null;
  task.message = null;
  task.retries = 0;
  task.validated = false;
  task.validatedBy = null;

  board.logs.push({ time: ts(), agent: "system", action: "reset", task: taskName });
  writeBoard(board);
  console.log(`RESET: ${taskName} -> pending`);
}

else {
  console.error(`Unknown command: ${command}`);
  console.log("Commands: init, claim, done, fail, note, notes, validate, status, next, wait, estimate, reset");
  process.exit(1);
}
