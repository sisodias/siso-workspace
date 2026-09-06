import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Express } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

type NodeConfig = { id: string; aliases: string[]; token: string; roots: string[]; enabled?: boolean };
type Profile = { node: string; title: string };
type Task = { id: string; node: string; kind: string; args: string; status: string; result: string | null; created: number; updated: number };
const terminal = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/** One owner, explicitly enrolled nodes. Node credentials cannot call MCP or impersonate another node. */
export function createFleet(app: Express, configPath: string, stateDir: string) {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { nodes: NodeConfig[]; profiles?: Record<string, Profile> };
  const nodes = new Map<string, NodeConfig>();
  const aliases = new Map<string, string>();
  for (const n of config.nodes) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(n.id) || n.token.length < 43 || nodes.has(n.id)) throw new Error("Invalid fleet enrollment");
    nodes.set(n.id, n);
    for (const alias of [n.id, ...n.aliases]) {
      if (aliases.has(alias)) throw new Error("Duplicate node alias");
      aliases.set(alias, n.id);
    }
  }
  const profiles = config.profiles ?? {};
  for (const [name, profile] of Object.entries(profiles)) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name) || !nodes.has(profile.node) || !profile.title) throw new Error("Invalid fleet app profile");
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dbPath = join(stateDir, "fleet.sqlite");
  const db = new Database(dbPath);
  chmodSync(dbPath, 0o600);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, node TEXT NOT NULL, kind TEXT NOT NULL, args TEXT NOT NULL,
    status TEXT NOT NULL, result TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, seen INTEGER NOT NULL, info TEXT NOT NULL);`);
  const get = (id: string) => db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Task | undefined;
  const snapshot = (t: Task) => ({ job_id: t.id, node: t.node, operation: t.kind, status: t.status,
    created: new Date(t.created).toISOString(), updated: new Date(t.updated).toISOString(),
    ...(t.result ? { result: JSON.parse(t.result) } : {}) });
  const resolveNode = (name: string) => {
    const id = aliases.get(name);
    if (!id) throw new Error(`Unknown node: ${name}. Use nodes_list.`);
    return id;
  };
  const enqueue = (node: string, kind: string, args: unknown) => {
    const id = resolveNode(node);
    if (nodes.get(id)?.enabled === false) throw new Error("This node is reserved but not enabled for execution");
    const queued = db.prepare("SELECT count(*) AS n FROM tasks WHERE node=? AND status IN ('queued','dispatched')").get(id) as { n: number };
    if (queued.n >= 100) throw new Error("Node queue is full; inspect outstanding operations");
    const taskId = randomUUID();
    const now = Date.now();
    db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,NULL,?,?)").run(taskId, id, kind, JSON.stringify(args), "queued", now, now);
    return taskId;
  };
  const wait = async (id: string) => {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const task = get(id)!;
      if (terminal.has(task.status)) return snapshot(task);
      await new Promise(r => setTimeout(r, 200));
    }
    return { ...snapshot(get(id)!), message: "Still pending. Query job_status with this job_id; do not resubmit mutations." };
  };

  const reportSchema = z.object({ id: z.uuid(), status: z.enum(["running", "completed", "failed", "cancelled", "timed_out", "interrupted"]), result: z.unknown() });
  const pollSchema = z.object({ info: z.object({ hostname: z.string().max(120), roots: z.array(z.string()).max(8), agent_version: z.string().max(80).optional() }),
    reports: z.array(reportSchema).max(8), capacity: z.number().int().min(0).max(4) });
  app.post("/fleet/poll/:node", (req, res) => {
    const n = nodes.get(String(req.params.node));
    const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const digest = (s: string) => createHash("sha256").update(s).digest();
    if (!n || n.enabled === false || !timingSafeEqual(digest(supplied), digest(n.token))) { res.status(401).json({ error: "Unauthorized" }); return; }
    const parsed = pollSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid poll" }); return; }
    const { info, reports, capacity } = parsed.data;
    // Roots are operator-owned, never granted by a registering agent.
    if (JSON.stringify(info.roots) !== JSON.stringify(n.roots)) { res.status(403).json({ error: "Node roots differ from enrollment" }); return; }
    const ack: string[] = [];
    const tasks = db.transaction(() => {
      db.prepare("INSERT INTO nodes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen,info=excluded.info").run(n.id, Date.now(), JSON.stringify(info));
      for (const r of reports) {
        const t = get(r.id);
        if (!t || t.node !== n.id || t.status === "queued") continue;
        if (!terminal.has(t.status)) db.prepare("UPDATE tasks SET status=?,result=?,updated=? WHERE id=?").run(r.status, JSON.stringify(r.result), Date.now(), r.id);
        if (terminal.has(r.status)) ack.push(r.id);
      }
      // Control/file requests must still run when all compute slots are occupied,
      // especially cancellation and log retrieval.
      const pending = capacity > 0
        ? db.prepare("SELECT * FROM tasks WHERE node=? AND status='queued' ORDER BY created LIMIT ?").all(n.id, capacity) as Task[]
        : db.prepare("SELECT * FROM tasks WHERE node=? AND status='queued' AND kind NOT IN ('job_start','shell_exec') ORDER BY created LIMIT 1").all(n.id) as Task[];
      for (const t of pending) db.prepare("UPDATE tasks SET status='dispatched',updated=? WHERE id=?").run(Date.now(), t.id);
      // At-most-once dispatch: no blind replay after an ambiguous network disconnect.
      return pending.map(t => ({ id: t.id, kind: t.kind, args: JSON.parse(t.args) }));
    })();
    res.json({ tasks, ack });
  });

  const server = (boundNode?: string, title = "SISO Workspace") => {
    if (boundNode && !nodes.has(boundNode)) throw new Error("Unknown profile node");
    const scopedJob = (jobId: string) => { const task = get(jobId); return task && (!boundNode || task.node === boundNode) ? task : undefined; };
    const mcp = new McpServer({ name: "siso-workspace", version: "1.1.0", title }, {
      instructions: "One-owner execution fleet. Always choose an explicit node or alias. Use nodes_list first. File tools are root-contained and deny common secret paths. Shell runs with the node user's full OS authority, not a sandbox: do not read credentials or make unrelated/destructive changes. job_start is durable and asynchronous; use returned job_id across conversations. Pending operations must not be resubmitted. job_status is centrally stored; job_logs fetches bounded pages from the execution node. Only completed with exit_code=0 proves shell success. Never claim a mathematical proof from a computation alone.",
    });
    const nodeName = z.string().min(1).max(80);
    const node = boundNode ? nodeName.default(boundNode) : nodeName;
    const path = z.string().min(1).max(4096);
    const id = z.uuid();
    const tool = (name: string, description: string, schema: z.ZodRawShape, readOnly: boolean, fn: (a: any) => unknown) => {
      mcp.registerTool(name, { description, inputSchema: schema,
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: true },
        _meta: { securitySchemes: [{ type: "oauth2", scopes: ["devspace"] }] },
      }, async a => { try {
        if (boundNode && a.node && resolveNode(String(a.node)) !== boundNode) throw new Error("This app is restricted to its enrolled machine");
        return reply(await fn(a));
      } catch (e) { return { ...reply({ error: e instanceof Error ? e.message : "Operation failed" }), isError: true }; } });
    };
    tool("workspace_help", "Read the bundled SISO Workspace usage skill and its safety, metrics and durable-job contract.", {}, true,
      () => ({ guide: readFileSync(new URL("../SKILL.md", import.meta.url), "utf8") }));
    tool("nodes_list", "List machines accessible to this app, aliases, roots, versions and heartbeat. Offline nodes do not imply completed work.", {}, true, () => [...nodes.values()].filter(n => !boundNode || n.id === boundNode).map(n => {
      const live = db.prepare("SELECT seen,info FROM nodes WHERE id=?").get(n.id) as { seen: number; info: string } | undefined;
      return { node: n.id, aliases: n.aliases, roots: n.roots, enabled: n.enabled !== false, online: n.enabled !== false && !!live && Date.now() - live.seen < 20_000, last_seen: live ? new Date(live.seen).toISOString() : null, agent_version: live ? JSON.parse(live.info).agent_version ?? "legacy" : null, capabilities: ["filesystem", "shell", "python", "git", "durable_jobs", "metrics"] };
    }));
    const dispatch = (kind: string) => async (a: { node: string }) => wait(enqueue(a.node, kind, a));
    tool("node_metrics", "Sample CPU utilization, logical cores/load averages, RAM/swap, uptime and approved-root disk space. Returns timestamps and measurement method; do not treat cached or pending results as live metrics.", { node }, true, dispatch("node_metrics"));
    tool("fs_list", "List a directory on an execution node (bounded to 500 entries).", { node, path }, true, dispatch("fs_list"));
    tool("fs_stat", "Stat a root-contained path; symlinks and secret paths are refused.", { node, path }, true, dispatch("fs_stat"));
    tool("fs_read", "Read a bounded UTF-8 file page. Secret paths are refused.", { node, path, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32768).default(16000) }, true, dispatch("fs_read"));
    tool("fs_write", "Create text; existing files are not overwritten unless overwrite=true. Parent directory must exist.", { node, path, text: z.string().max(32768), overwrite: z.boolean().default(false) }, false, dispatch("fs_write"));
    tool("fs_edit", "Replace exactly one occurrence of old_text, failing if absent or ambiguous.", { node, path, old_text: z.string().min(1).max(16384), new_text: z.string().max(16384) }, false, dispatch("fs_edit"));
    tool("fs_search", "Search filenames or UTF-8 content below a directory, excluding secrets, symlinks, .git and dependencies; bounded traversal.", { node, path, query: z.string().min(1).max(256), content: z.boolean().default(false) }, true, dispatch("fs_search"));
    const command = { node, cwd: path, command: z.string().min(1).max(16384), timeout_seconds: z.number().int().min(1).max(604800).default(3600) };
    tool("shell_exec", "Run shell/Python/git with explicit cwd; captures exit code and bounded stdout/stderr. May return pending job_id. OS-user authority, not a sandbox.", { ...command, timeout_seconds: z.number().int().min(1).max(120).default(30) }, false, dispatch("shell_exec"));
    tool("job_start", "Queue a durable detached shell job. Returns immediately; query status and logs, never assume completion. Jobs survive gateway/agent restarts but not machine reboot.", command, false, a => snapshot(get(enqueue(a.node, "job_start", a))!));
    tool("job_status", "Read centrally persisted operation/job state by ID, across conversations.", { job_id: id }, true, a => {
      const t = scopedJob(a.job_id); if (!t) throw new Error("Unknown job_id"); return snapshot(t);
    });
    tool("job_list", "List the most recent 50 central jobs/operations, optionally restricted to a node.", { node: node.optional() }, true, a => {
      const selected = boundNode ?? (a.node ? resolveNode(a.node) : undefined);
      const rows = (selected ? db.prepare("SELECT * FROM tasks WHERE node=? ORDER BY created DESC LIMIT 50").all(selected) : db.prepare("SELECT * FROM tasks ORDER BY created DESC LIMIT 50").all()) as Task[];
      // Listing must not replay dozens of file contents or shell outputs into a chat.
      return rows.map(t => snapshot({ ...t, result: null }));
    });
    tool("job_logs", "Fetch a durable stdout/stderr byte page from the owning node; full logs stay on that node and the response is cached centrally.", { job_id: id, stream: z.enum(["stdout", "stderr"]).default("stdout"), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32768).default(16000) }, true, async a => {
      const t = scopedJob(a.job_id); if (!t || !["job_start", "shell_exec"].includes(t.kind)) throw new Error("Unknown shell job");
      return wait(enqueue(t.node, "job_logs", a));
    });
    tool("job_cancel", "Request cancellation of an exact job; verify its terminal status afterward. Never signals an arbitrary PID.", { job_id: id }, false, async a => {
      const t = scopedJob(a.job_id); if (!t || !["job_start", "shell_exec"].includes(t.kind)) throw new Error("Unknown shell job");
      if (terminal.has(t.status)) return snapshot(t);
      if (t.status === "queued") { db.prepare("UPDATE tasks SET status='cancelled',updated=? WHERE id=?").run(Date.now(), t.id); return snapshot(get(t.id)!); }
      return wait(enqueue(t.node, "job_cancel", a));
    });
    return mcp;
  };
  return { server, profiles, close: () => db.close() };
}
