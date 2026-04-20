#!/usr/bin/env node
/**
 * agent-blackboard — MCP Server Wrapper
 * SOUL CORE — 2026
 *
 * Expone los 12 comandos del board.mjs CLI como tools MCP:
 *   mcp__blackboard__init       — crear pizarra con tareas y dependencias
 *   mcp__blackboard__claim      — tomar siguiente tarea disponible
 *   mcp__blackboard__done       — marcar tarea completada
 *   mcp__blackboard__fail       — reportar fallo (retry auto)
 *   mcp__blackboard__note       — dejar nota para otros agentes
 *   mcp__blackboard__notes      — leer notas
 *   mcp__blackboard__validate   — validacion cruzada
 *   mcp__blackboard__status     — vista completa del board
 *   mcp__blackboard__next       — siguiente tarea disponible
 *   mcp__blackboard__wait       — chequeo de completitud
 *   mcp__blackboard__estimate   — tiempo restante estimado
 *   mcp__blackboard__reset      — resetear tarea fallida
 *
 * Approach: subprocess wrapper — invoca board.mjs v sin duplicar logica.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD_SCRIPT = path.join(__dirname, "board.mjs");

function runBoard(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [BOARD_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      });
    });
    proc.on("error", reject);
  });
}

const TOOLS = [
  {
    name: "blackboard_init",
    description:
      "Crear pizarra nueva con tareas y dependencias. Cada tarea puede tener dependencias via formato 'nombre:dep1,dep2'. Ejemplo tasks: ['interface.ts', 'jest.ts:interface.ts', 'index.ts:jest.ts,interface.ts'].",
    inputSchema: {
      type: "object",
      properties: {
        board: {
          type: "string",
          description: "Path absoluto del archivo board.json",
        },
        tasks: {
          type: "array",
          items: { type: "string" },
          description:
            "Lista de tareas. Formato 'nombre' o 'nombre:dep1,dep2' para dependencias.",
        },
      },
      required: ["board", "tasks"],
    },
  },
  {
    name: "blackboard_claim",
    description:
      "Tomar la siguiente tarea disponible (respeta dependencias). Si specifica 'task', intenta tomar esa en particular. Devuelve CLAIMED/BUSY/BLOCKED/UNAVAILABLE/NONE y notas relevantes.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
        agent: {
          type: "string",
          description: "Identificador unico del agente",
        },
        task: {
          type: "string",
          description: "Opcional: tarea especifica a reclamar",
        },
      },
      required: ["board", "agent"],
    },
  },
  {
    name: "blackboard_done",
    description:
      "Marcar como completada la tarea activa del agente. Calcula duracion, reporta progreso global, y lista tareas desbloqueadas.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
        agent: { type: "string", description: "Identificador del agente" },
        message: {
          type: "string",
          description: "Mensaje breve del resultado (opcional)",
        },
      },
      required: ["board", "agent"],
    },
  },
  {
    name: "blackboard_fail",
    description:
      "Reportar fallo. Si hay retries disponibles, la tarea vuelve a pending para otro agente. Si se agotaron, se marca failed.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
        agent: { type: "string", description: "Identificador del agente" },
        message: { type: "string", description: "Descripcion del error" },
      },
      required: ["board", "agent", "message"],
    },
  },
  {
    name: "blackboard_note",
    description:
      "Dejar nota persistente para los demas agentes. Si el agente tiene tarea activa, la nota queda asociada. Sirve para pasar contexto entre tareas dependientes.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
        agent: { type: "string", description: "Identificador del agente" },
        message: { type: "string", description: "Nota a registrar" },
      },
      required: ["board", "agent", "message"],
    },
  },
  {
    name: "blackboard_notes",
    description:
      "Leer notas del board. Sin task lee todas; con task filtra las asociadas a esa tarea + las globales.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
        task: {
          type: "string",
          description: "Opcional: filtrar por tarea",
        },
      },
      required: ["board"],
    },
  },
  {
    name: "blackboard_validate",
    description:
      "Validacion cruzada: un agente marca como validada la tarea de OTRO agente (nunca la propia). Registra quien valido.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
        agent: {
          type: "string",
          description: "Agente validador (distinto al que escribio)",
        },
        task: { type: "string", description: "Tarea a validar" },
      },
      required: ["board", "agent", "task"],
    },
  },
  {
    name: "blackboard_status",
    description:
      "Vista completa del board: progreso, estados por tarea, dependencias, agentes, notas recientes, log de actividad.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
      },
      required: ["board"],
    },
  },
  {
    name: "blackboard_next",
    description:
      "Mostrar nombre de la siguiente tarea disponible (sin reclamarla). Util para planear.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
      },
      required: ["board"],
    },
  },
  {
    name: "blackboard_wait",
    description:
      "Chequeo rapido: ALL DONE o WAITING con la lista de tareas pendientes/working.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
      },
      required: ["board"],
    },
  },
  {
    name: "blackboard_estimate",
    description:
      "Estimar tiempo restante basado en duracion promedio de tareas ya completadas y cantidad de agentes activos.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
      },
      required: ["board"],
    },
  },
  {
    name: "blackboard_reset",
    description:
      "Resetear una tarea fallida (o cualquier tarea) de vuelta a pending. Limpia agent, retries, validacion.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Path del board.json" },
        task: { type: "string", description: "Nombre de la tarea a resetear" },
      },
      required: ["board", "task"],
    },
  },
];

const ARG_BUILDERS = {
  blackboard_init: (a) => ["init", a.board, ...a.tasks],
  blackboard_claim: (a) => ["claim", a.board, a.agent, ...(a.task ? [a.task] : [])],
  blackboard_done: (a) => ["done", a.board, a.agent, ...(a.message ? [a.message] : [])],
  blackboard_fail: (a) => ["fail", a.board, a.agent, a.message],
  blackboard_note: (a) => ["note", a.board, a.agent, a.message],
  blackboard_notes: (a) => ["notes", a.board, ...(a.task ? [a.task] : [])],
  blackboard_validate: (a) => ["validate", a.board, a.agent, a.task],
  blackboard_status: (a) => ["status", a.board],
  blackboard_next: (a) => ["next", a.board],
  blackboard_wait: (a) => ["wait", a.board],
  blackboard_estimate: (a) => ["estimate", a.board],
  blackboard_reset: (a) => ["reset", a.board, a.task],
};

const server = new Server(
  { name: "agent-blackboard", version: "2.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const builder = ARG_BUILDERS[name];
  if (!builder) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const cliArgs = builder(args || {});
    const { stdout, stderr, exitCode } = await runBoard(cliArgs);
    const text = stdout || stderr || "(empty)";
    return {
      content: [{ type: "text", text }],
      isError: exitCode !== 0,
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
