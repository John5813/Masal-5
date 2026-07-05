import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  projectsTable,
  projectFilesTable,
  projectMessagesTable,
  projectSecretsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import OpenAI from "openai";
import { zipSync, strToU8, unzipSync } from "fflate";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  startProcess,
  stopProcess,
  getRunStatus,
  getProcessPort,
  getAssignedPort,
  subscribeToLogs,
  onStatusChange,
  PROJECTS_WORKDIR_ROOT as PM_WORKDIR_ROOT,
} from "../../lib/process-manager";
import { runCommandInDocker } from "../../lib/docker-sandbox";
import {
  CreateProjectBody,
  GetProjectParams,
  DeleteProjectParams,
  CreateFileParams,
  CreateFileBody,
  UpdateFileParams,
  UpdateFileBody,
  DeleteFileParams,
  SendProjectMessageParams,
  SendProjectMessageBody,
} from "@workspace/api-zod";

const router = Router();

// ─── Auth guard helpers ───────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response): string | null {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Kirish talab etiladi. Iltimos, tizimga kiring." });
    return null;
  }
  return req.user.id;
}

async function requireAuthAndOwnership(req: Request, res: Response, projectId: number): Promise<string | null> {
  const userId = requireAuth(req, res);
  if (!userId) return null;
  if (!Number.isInteger(projectId)) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  const [proj] = await db.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));
  if (!proj) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return userId;
}

// ─── Path traversal protection ───────────────────────────────────────────────
function safePath(base: string, filePath: string): string | null {
  const resolved = path.resolve(base, filePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  return resolved;
}

function getOpenRouter(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "missing";
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  });
}

const DEFAULT_MODEL = "anthropic/claude-opus-4-5";

const ALLOWED_MODELS = new Set([
  "anthropic/claude-opus-4-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4",
  "deepseek/deepseek-chat-v3-0324",
]);

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "create_file",
      description: "Create a new file or overwrite an existing file in the project",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, e.g. src/index.html" },
          content: { type: "string", description: "Full file content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_file",
      description: "Update an existing file's content",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to update" },
          content: { type: "string", description: "New full content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the project",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to delete" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the project",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the project's working directory to install dependencies (e.g. npm install, pip install -r requirements.txt) or execute/test the app (e.g. node index.js, python app.py). Allowed commands: npm, npx, pnpm, yarn, pip, pip3, python, python3, node. Long-running commands (like starting a server) are automatically stopped after 45 seconds so you can inspect the startup output.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The full command to run, e.g. 'npm install' or 'node index.js'" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_app",
      description:
        "Start the project as a persistent, long-running background process (e.g. a bot with polling, or a server). Unlike run_command, this does NOT time out after 45 seconds — it keeps running until stopped. Only one process can run per project at a time; call stop_app first if one is already running. Use this once the app has been installed and tested with run_command and is ready to run continuously. If the app needs a secret (e.g. a bot token), tell the user to add it via the secrets panel before starting.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The full command to run persistently, e.g. 'python bot.py' or 'node index.js'" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_app",
      description: "Stop the currently running persistent process started with start_app.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_run_status",
      description:
        "Check whether the project's persistent app (started with start_app) is currently running, crashed, or stopped. Returns status, the assigned preview port, and the last 20 log lines. Call this before start_app to avoid double-starting, or whenever you need to know the live run state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_secrets",
      description:
        "Open a modal dialog in the user's browser asking them to provide one or more secret values (API keys, tokens, passwords). The user fills them in and they are saved as project environment variables. Use this whenever your code needs an API key or token that the user hasn't provided yet. After calling this, proceed writing code using process.env.KEY_NAME — the secrets will be available when the app runs.",
      parameters: {
        type: "object",
        properties: {
          secrets: {
            type: "array",
            description: "List of secrets to request from the user",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "Environment variable name, e.g. BOT_TOKEN" },
                description: { type: "string", description: "Human-readable explanation of what this secret is and where to get it" },
              },
              required: ["key", "description"],
            },
          },
        },
        required: ["secrets"],
      },
    },
  },
];

const PROJECTS_WORKDIR_ROOT = PM_WORKDIR_ROOT;

async function materializeProjectFiles(projectId: number, workDir: string): Promise<void> {
  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  await fsp.mkdir(workDir, { recursive: true });

  const manifestPath = path.join(workDir, ".uzcoder-manifest.json");
  let prevPaths: string[] = [];
  try {
    prevPaths = JSON.parse(await fsp.readFile(manifestPath, "utf-8")) as string[];
  } catch {
    prevPaths = [];
  }

  const currentPaths = files.map((f) => f.path);
  for (const stalePath of prevPaths) {
    if (!currentPaths.includes(stalePath)) {
      try { await fsp.unlink(path.join(workDir, stalePath)); } catch {}
    }
  }

  for (const file of files) {
    const filePath = path.join(workDir, file.path);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, file.content, "utf-8");
  }

  await fsp.writeFile(manifestPath, JSON.stringify(currentPaths), "utf-8");
}


async function executeToolCall(
  projectId: number,
  toolName: string,
  args: Record<string, string>
): Promise<string> {
  if (toolName === "list_files") {
    const files = await db
      .select({ path: projectFilesTable.path })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));
    return JSON.stringify(files.map((f) => f.path));
  }

  if (toolName === "read_file") {
    const [file] = await db
      .select()
      .from(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          eq(projectFilesTable.path, args.path!)
        )
      );
    return file ? file.content : `File not found: ${args.path}`;
  }

  if (toolName === "create_file") {
    const [existing] = await db
      .select()
      .from(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          eq(projectFilesTable.path, args.path!)
        )
      );
    if (existing) {
      await db
        .update(projectFilesTable)
        .set({ content: args.content!, updatedAt: new Date() })
        .where(eq(projectFilesTable.id, existing.id));
      return `Updated: ${args.path}`;
    }
    await db
      .insert(projectFilesTable)
      .values({ projectId, path: args.path!, content: args.content! });
    return `Created: ${args.path}`;
  }

  if (toolName === "update_file") {
    const [existing] = await db
      .select()
      .from(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          eq(projectFilesTable.path, args.path!)
        )
      );
    if (!existing) return `File not found: ${args.path}`;
    await db
      .update(projectFilesTable)
      .set({ content: args.content!, updatedAt: new Date() })
      .where(eq(projectFilesTable.id, existing.id));
    return `Updated: ${args.path}`;
  }

  if (toolName === "delete_file") {
    await db
      .delete(projectFilesTable)
      .where(
        and(
          eq(projectFilesTable.projectId, projectId),
          eq(projectFilesTable.path, args.path!)
        )
      );
    return `Deleted: ${args.path}`;
  }

  if (toolName === "run_command") {
    const command = args.command?.trim();
    if (!command) return "Error: no command provided";

    const workDir = path.join(PROJECTS_WORKDIR_ROOT, String(projectId));
    try {
      await materializeProjectFiles(projectId, workDir);
    } catch (err) {
      return `Error preparing working directory: ${err instanceof Error ? err.message : "unknown error"}`;
    }

    const { stdout, stderr, exitCode, timedOut } = await runCommandInDocker(workDir, command);

    const success = !timedOut && exitCode === 0;
    let result = `[${timedOut ? "TIMEOUT" : success ? "SUCCESS" : `ERROR:exit=${exitCode}`}] $ ${command}\n`;
    if (stdout) result += `stdout:\n${stdout}\n`;
    if (stderr) result += `stderr:\n${stderr}\n`;
    result += timedOut
      ? `(45 soniyadan so'ng avtomatik to'xtatildi)`
      : `Exit code: ${exitCode}`;
    return result;
  }

  if (toolName === "start_app") {
    const command = args.command?.trim();
    if (!command) return "Error: no command provided";

    const workDir = path.join(PROJECTS_WORKDIR_ROOT, String(projectId));
    try {
      await materializeProjectFiles(projectId, workDir);
    } catch (err) {
      return `Error preparing working directory: ${err instanceof Error ? err.message : "unknown error"}`;
    }

    const secrets = await db
      .select()
      .from(projectSecretsTable)
      .where(eq(projectSecretsTable.projectId, projectId));
    const env = Object.fromEntries(secrets.map((s) => [s.key, s.value]));

    const result = await startProcess(projectId, command, workDir, env);
    if (!result.ok) return `Error: ${result.error}`;
    return `Started: ${command}\nJarayon "Run" panelida jonli konsolda ko'rinadi.`;
  }

  if (toolName === "stop_app") {
    const result = await stopProcess(projectId);
    if (!result.ok) return `Error: ${result.error}`;
    return "App to'xtatildi.";
  }

  if (toolName === "get_run_status") {
    const status = getRunStatus(projectId);
    const assignedPort = getAssignedPort(projectId);
    const recentLogs = status.logs.slice(-20).join("\n");
    return JSON.stringify({
      status: status.status,
      command: status.exitCode ?? null,
      assignedPort,
      exitCode: status.exitCode,
      recentLogs: recentLogs || "(no logs yet)",
    }, null, 2);
  }

  return "Unknown tool";
}

function parseGithubUrl(url: string): { owner: string; repo: string; branch: string } | null {
  try {
    const u = new URL(url.trim());
    if (!u.hostname.includes("github.com")) return null;
    const parts = u.pathname.replace(/^\//, "").split("/");
    if (parts.length < 2) return null;
    const owner = parts[0]!;
    const repo = parts[1]!.replace(/\.git$/, "");
    const branch = parts[2] === "tree" && parts[3] ? parts[3] : "main";
    return { owner, repo, branch };
  } catch {
    return null;
  }
}

const TEXT_EXTS = new Set([
  "html","css","js","jsx","ts","tsx","json","md","txt","yml","yaml",
  "sh","py","rb","go","rs","java","c","cpp","h","hpp","sql","env",
  "toml","ini","conf","xml","svg","gitignore","eslintrc","prettierrc",
  "babelrc","editorconfig","npmrc","nvmrc","lock","mjs","cjs",
]);

function isTextFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const base = filePath.split("/").pop() ?? "";
  if (base.startsWith(".") && !base.includes(".", 1)) return true;
  return TEXT_EXTS.has(ext);
}

router.post("/clone", async (req, res) => {
  const { githubUrl, name } = req.body as { githubUrl?: string; name?: string };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (!githubUrl?.trim()) {
    send({ type: "error", message: "githubUrl required" });
    res.end(); return;
  }

  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) {
    send({ type: "error", message: "Invalid GitHub URL" });
    res.end(); return;
  }

  const { owner, repo, branch } = parsed;
  const projectName = name?.trim() || repo;

  send({ type: "status", step: 1, message: `Connecting to GitHub: ${owner}/${repo}` });

  const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
  let zipBuffer: Uint8Array;
  try {
    send({ type: "status", step: 2, message: "Downloading ZIP archive..." });
    let response = await fetch(zipUrl);
    if (!response.ok) {
      send({ type: "status", step: 2, message: "Trying master branch..." });
      const fallback = await fetch(`https://github.com/${owner}/${repo}/archive/refs/heads/master.zip`);
      if (!fallback.ok) {
        send({ type: "error", message: "Could not download repository. Check the URL is correct and public." });
        res.end(); return;
      }
      response = fallback;
    }
    const buf = await response.arrayBuffer();
    zipBuffer = new Uint8Array(buf);
    const sizeMB = (buf.byteLength / 1024 / 1024).toFixed(1);
    send({ type: "status", step: 3, message: `Downloaded (${sizeMB} MB). Extracting files...` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    send({ type: "error", message: `Download failed: ${msg}` });
    res.end(); return;
  }

  let unzipped: ReturnType<typeof unzipSync>;
  try {
    unzipped = unzipSync(zipBuffer);
  } catch {
    send({ type: "error", message: "Failed to extract ZIP archive" });
    res.end(); return;
  }

  if (!req.isAuthenticated()) {
    send({ type: "error", message: "Kirish talab etiladi." });
    res.end(); return;
  }
  const userId = req.user.id;

  const [project] = await db
    .insert(projectsTable)
    .values({ userId, name: projectName, description: `Cloned from github.com/${owner}/${repo}` })
    .returning();

  const rootPrefix = `${repo}-${branch}/`;
  const rootPrefixMaster = `${repo}-master/`;
  let filesImported = 0;
  const skipped = ["node_modules/", ".git/", "dist/", "build/", ".next/", "__pycache__/"];
  const toImport: { path: string; content: string }[] = [];

  for (const [zipPath, data] of Object.entries(unzipped)) {
    let filePath = zipPath;
    if (filePath.startsWith(rootPrefix)) filePath = filePath.slice(rootPrefix.length);
    else if (filePath.startsWith(rootPrefixMaster)) filePath = filePath.slice(rootPrefixMaster.length);

    if (!filePath || filePath.endsWith("/")) continue;
    if (skipped.some((s) => filePath.includes(s))) continue;
    if (!isTextFile(filePath)) continue;
    if (data.length > 500_000) continue;

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      continue;
    }
    toImport.push({ path: filePath, content });
  }

  send({ type: "status", step: 4, message: `Found ${toImport.length} files. Writing to database...` });

  const BATCH = 20;
  for (let i = 0; i < toImport.length; i += BATCH) {
    const batch = toImport.slice(i, i + BATCH);
    await db.insert(projectFilesTable).values(
      batch.map((f) => ({ projectId: project!.id, path: f.path, content: f.content }))
    );
    filesImported += batch.length;
    send({ type: "progress", imported: filesImported, total: toImport.length, message: `${filesImported} / ${toImport.length} files imported...` });
  }

  send({ type: "done", projectId: project!.id, filesImported, name: projectName, repo: `github.com/${owner}/${repo}` });
  res.end();
});

router.get("/", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, userId))
    .orderBy(projectsTable.updatedAt);
  res.json(projects);
});

router.post("/", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const [project] = await db
    .insert(projectsTable)
    .values({ userId, name: parsed.data.name, description: parsed.data.description ?? "" })
    .returning();
  res.status(201).json(project);
});

router.get("/:id", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const params = GetProjectParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.userId, userId)));
  if (!project) { res.status(404).json({ error: "Not found" }); return; }
  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, params.data.id))
    .orderBy(projectFilesTable.path);
  const messages = await db
    .select()
    .from(projectMessagesTable)
    .where(eq(projectMessagesTable.projectId, params.data.id))
    .orderBy(projectMessagesTable.createdAt);
  res.json({ ...project, files, messages });
});

router.get("/:id/serve/{*filePath}", async (req, res) => {
  const projectId = Number(req.params.id);
  const userId = await requireAuthAndOwnership(req, res, projectId);
  if (!userId) return;

  const rawPath = req.params.filePath;
  const filePath = Array.isArray(rawPath)
    ? rawPath.join("/")
    : (rawPath || "index.html");

  const { status } = getRunStatus(projectId);
  if (status === "running" || status === "starting") {
    const port = getProcessPort(projectId);
    if (port) {
      const proxyPath = filePath === "index.html" ? "/" : `/${filePath}`;
      const qs = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      const target = `http://127.0.0.1:${port}${proxyPath}${qs}`;
      try {
        const proxyRes = await fetch(target, {
          headers: { host: `localhost:${port}`, "user-agent": "uzcoder-preview/1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (proxyRes.ok) {
          res.status(proxyRes.status);
          const ct = proxyRes.headers.get("content-type");
          if (ct) res.setHeader("Content-Type", ct);
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          const buf = await proxyRes.arrayBuffer();
          res.send(Buffer.from(buf));
          return;
        }
      } catch {}
    }
  }

  const [file] = await db
    .select()
    .from(projectFilesTable)
    .where(
      and(
        eq(projectFilesTable.projectId, projectId),
        eq(projectFilesTable.path, filePath)
      )
    );

  const allFiles = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  if (!file) {
    if (filePath === "index.html") {
      const candidates = [
        "index.html", "public/index.html", "client/index.html",
        "src/index.html", "dist/index.html", "app/index.html", "web/index.html",
      ];
      const found = candidates
        .map((c) => allFiles.find((f) => f.path === c))
        .find(Boolean);

      if (found) {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.redirect(302, `/api/projects/${projectId}/serve/${found.path}`);
        return;
      }

      const htmlFiles = allFiles.filter((f) => f.path.endsWith(".html"));
      const listing = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Project Preview</title>
<style>*{box-sizing:border-box}body{font-family:monospace;background:#0a0a14;color:#c0caf5;padding:32px;margin:0}
h2{color:#7aa2f7;margin:0 0 8px}p{color:#565f89;font-size:13px;margin:0 0 24px}
a{display:block;padding:6px 10px;border-radius:6px;color:#7aa2f7;text-decoration:none;font-size:13px;border:1px solid #1e1e2e;margin-bottom:4px}
a:hover{background:#7aa2f7;color:#0a0a14;border-color:#7aa2f7}</style>
</head><body>
<h2>&#9670; Project Preview</h2>
<p>No index.html found. ${htmlFiles.length > 0 ? "Pick an HTML file:" : "Ask UzCoder to create an index.html."}</p>
${htmlFiles.map((f) => `<a href="/api/projects/${projectId}/serve/${f.path}">${f.path}</a>`).join("")}
</body></html>`;
      res.setHeader("Content-Type", "text/html");
      res.send(listing);
      return;
    }
    res.status(404).send("File not found: " + filePath);
    return;
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mimeTypes: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    ts: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    md: "text/plain; charset=utf-8",
    py: "text/plain; charset=utf-8",
  };

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (ext === "html") {
    const dir = filePath.includes("/") ? filePath.split("/").slice(0, -1).join("/") + "/" : "";
    const baseHref = `/api/projects/${projectId}/serve/${dir}`;
    const baseTag = `<base href="${baseHref}">`;
    let html = file.content;
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head>\n  ${baseTag}`);
    } else if (html.includes("<Head>")) {
      html = html.replace("<Head>", `<Head>\n  ${baseTag}`);
    } else {
      html = baseTag + "\n" + html;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
    return;
  }

  res.setHeader("Content-Type", mimeTypes[ext] ?? "text/plain; charset=utf-8");
  res.send(file.content);
});

router.get("/:id/download", async (req, res) => {
  const params = GetProjectParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const userId = await requireAuthAndOwnership(req, res, params.data.id);
  if (!userId) return;

  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.userId, userId)));
  if (!project) { res.status(404).json({ error: "Not found" }); return; }

  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, params.data.id));

  const safeName = project.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  const zipEntries: Record<string, Uint8Array> = {};
  for (const file of files) {
    zipEntries[file.path] = strToU8(file.content);
  }
  const zipped = zipSync(zipEntries, { level: 9 });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.zip"`);
  res.send(Buffer.from(zipped));
});

router.delete("/:id", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const params = DeleteProjectParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(projectsTable).where(and(eq(projectsTable.id, params.data.id), eq(projectsTable.userId, userId)));
  res.status(204).send();
});

router.post("/:id/files", async (req, res) => {
  const params = CreateFileParams.safeParse({ id: Number(req.params.id) });
  const body = CreateFileBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid" }); return; }
  const userId = await requireAuthAndOwnership(req, res, params.data.id);
  if (!userId) return;
  await executeToolCall(params.data.id, "create_file", { path: body.data.path, content: body.data.content });
  const [file] = await db
    .select()
    .from(projectFilesTable)
    .where(
      and(
        eq(projectFilesTable.projectId, params.data.id),
        eq(projectFilesTable.path, body.data.path)
      )
    );
  res.status(201).json(file);
});

router.put("/:id/files/:fileId", async (req, res) => {
  const params = UpdateFileParams.safeParse({ id: Number(req.params.id), fileId: Number(req.params.fileId) });
  const body = UpdateFileBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid" }); return; }
  const userId = await requireAuthAndOwnership(req, res, params.data.id);
  if (!userId) return;
  const [updated] = await db
    .update(projectFilesTable)
    .set({ content: body.data.content, updatedAt: new Date() })
    .where(
      and(
        eq(projectFilesTable.id, params.data.fileId),
        eq(projectFilesTable.projectId, params.data.id)
      )
    )
    .returning();
  res.json(updated);
});

router.patch("/:id/files/:fileId", async (req, res) => {
  const params = UpdateFileParams.safeParse({ id: Number(req.params.id), fileId: Number(req.params.fileId) });
  if (!params.success) { res.status(400).json({ error: "Invalid" }); return; }
  const userId = await requireAuthAndOwnership(req, res, params.data.id);
  if (!userId) return;
  const { path: newPath } = req.body as { path?: string };
  if (!newPath?.trim()) { res.status(400).json({ error: "path required" }); return; }
  const [updated] = await db
    .update(projectFilesTable)
    .set({ path: newPath.trim(), updatedAt: new Date() })
    .where(and(eq(projectFilesTable.id, params.data.fileId), eq(projectFilesTable.projectId, params.data.id)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/:id/files/:fileId", async (req, res) => {
  const params = DeleteFileParams.safeParse({ id: Number(req.params.id), fileId: Number(req.params.fileId) });
  if (!params.success) { res.status(400).json({ error: "Invalid" }); return; }
  const userId = await requireAuthAndOwnership(req, res, params.data.id);
  if (!userId) return;
  await db
    .delete(projectFilesTable)
    .where(
      and(
        eq(projectFilesTable.id, params.data.fileId),
        eq(projectFilesTable.projectId, params.data.id)
      )
    );
  res.status(204).send();
});

router.get("/:id/secrets", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  // Ownership check
  const [proj] = await db.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)));
  if (!proj) { res.status(404).json({ error: "Not found" }); return; }
  const secrets = await db
    .select({ id: projectSecretsTable.id, key: projectSecretsTable.key, updatedAt: projectSecretsTable.updatedAt })
    .from(projectSecretsTable)
    .where(eq(projectSecretsTable.projectId, id));
  res.json(secrets);
});

router.post("/:id/secrets", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const id = Number(req.params.id);
  const { key, value } = req.body as { key?: string; value?: string };
  if (!Number.isInteger(id) || !key?.trim() || value === undefined) {
    res.status(400).json({ error: "key and value are required" });
    return;
  }
  const [proj] = await db.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)));
  if (!proj) { res.status(404).json({ error: "Not found" }); return; }
  const trimmedKey = key.trim();
  const [existing] = await db
    .select()
    .from(projectSecretsTable)
    .where(and(eq(projectSecretsTable.projectId, id), eq(projectSecretsTable.key, trimmedKey)));
  if (existing) {
    await db
      .update(projectSecretsTable)
      .set({ value, updatedAt: new Date() })
      .where(eq(projectSecretsTable.id, existing.id));
  } else {
    await db.insert(projectSecretsTable).values({ projectId: id, key: trimmedKey, value });
  }
  res.status(201).json({ key: trimmedKey });
});

router.delete("/:id/secrets/:key", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const id = Number(req.params.id);
  const key = req.params.key;
  if (!Number.isInteger(id) || !key) { res.status(400).json({ error: "Invalid" }); return; }
  const [proj] = await db.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)));
  if (!proj) { res.status(404).json({ error: "Not found" }); return; }
  await db
    .delete(projectSecretsTable)
    .where(and(eq(projectSecretsTable.projectId, id), eq(projectSecretsTable.key, key)));
  res.status(204).send();
});

router.get("/:id/run/status", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [proj] = await db.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)));
  if (!proj) { res.status(404).json({ error: "Not found" }); return; }
  const runStatus = getRunStatus(id);
  res.json({ ...runStatus, running: runStatus.status === "running" || runStatus.status === "starting" });
});

router.post("/:id/run/start", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyCommand = (req.body as Record<string, unknown> | undefined)?.command;
  const providedCommand = typeof bodyCommand === "string" ? bodyCommand.trim() : "";

  const [proj] = await db.select({ id: projectsTable.id }).from(projectsTable).where(and(eq(projectsTable.id, id), eq(projectsTable.userId, userId)));
  if (!proj) { res.status(404).json({ error: "Not found" }); return; }

  const workDir = path.join(PROJECTS_WORKDIR_ROOT, String(id));
  try {
    await materializeProjectFiles(id, workDir);
  } catch (err) {
    res.status(500).json({ error: `Working directory error: ${err instanceof Error ? err.message : "unknown"}` });
    return;
  }

  // Auto-detect run command if not provided
  let command = providedCommand;
  if (!command) {
    const files = await db.select({ path: projectFilesTable.path, content: projectFilesTable.content })
      .from(projectFilesTable).where(eq(projectFilesTable.projectId, id));
    const fileNames = files.map((f) => f.path);
    const pkgFile = files.find((f) => f.path === "package.json");
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content) as { scripts?: Record<string, string> };
        command = pkg.scripts?.["start"] ?? pkg.scripts?.["dev"] ?? pkg.scripts?.["serve"] ?? "";
        if (command) command = `npm run ${Object.keys(pkg.scripts ?? {}).find((k) => pkg.scripts![k] === command) ?? "start"}`;
      } catch { /* ignore */ }
    }
    if (!command) {
      if (fileNames.includes("main.py"))      command = "python3 main.py";
      else if (fileNames.includes("app.py"))  command = "python3 app.py";
      else if (fileNames.includes("index.py")) command = "python3 index.py";
      else if (fileNames.includes("index.js")) command = "node index.js";
      else if (fileNames.includes("main.js"))  command = "node main.js";
      else if (fileNames.includes("server.js")) command = "node server.js";
      else if (fileNames.includes("app.js"))  command = "node app.js";
      else command = "npm start";
    }
  }

  const secrets = await db.select().from(projectSecretsTable).where(eq(projectSecretsTable.projectId, id));
  const env = Object.fromEntries(secrets.map((s) => [s.key, s.value]));

  const result = await startProcess(id, command, workDir, env);
  if (!result.ok) { res.status(409).json({ error: result.error }); return; }
  res.status(202).json({ status: "starting", command });
});

router.post("/:id/run/stop", async (req, res) => {
  const id = Number(req.params.id);
  const userId = await requireAuthAndOwnership(req, res, id);
  if (!userId) return;
  const result = await stopProcess(id);
  if (!result.ok) { res.status(409).json({ error: result.error }); return; }
  res.status(202).json({ status: "stopping" });
});

router.get("/:id/run/logs", async (req, res) => {
  const id = Number(req.params.id);
  const userId = await requireAuthAndOwnership(req, res, id);
  if (!userId) return;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const initial = getRunStatus(id);
  res.write(`data: ${JSON.stringify({ type: "status", status: initial.status, exitCode: initial.exitCode })}\n\n`);
  for (const line of initial.logs) {
    res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
  }

  const unsubLog = subscribeToLogs(id, (line) => {
    res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
  });
  const unsubStatus = onStatusChange(id, (status) => {
    const current = getRunStatus(id);
    res.write(`data: ${JSON.stringify({ type: "status", status, exitCode: current.exitCode })}\n\n`);
  });

  req.on("close", () => {
    unsubLog();
    unsubStatus();
  });
});

router.post("/:id/messages", async (req, res) => {
  const params = SendProjectMessageParams.safeParse({ id: Number(req.params.id) });
  const body = SendProjectMessageBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid" }); return; }

  const rawModel = (req.body as { model?: string }).model;
  const model = rawModel && ALLOWED_MODELS.has(rawModel) ? rawModel : DEFAULT_MODEL;

  const projectId = params.data.id;
  const userId = await requireAuthAndOwnership(req, res, projectId);
  if (!userId) return;

  // ─── Usage limit check ───────────────────────────────────────────────────────
  const FREE_MODEL = "deepseek/deepseek-chat-v3-0324";
  const FREE_LIMIT = 3;
  const [userData] = await db
    .select({ plan: usersTable.plan })
    .from(usersTable).where(eq(usersTable.id, userId));
  if (userData?.plan !== "paid") {
    if (model !== FREE_MODEL) {
      res.status(402).json({ error: "payment_required", message: "Bu model uchun to'lov kerak." });
      return;
    }
    // Atomic conditional increment — prevents race conditions; 0 rows → limit reached
    const incremented = await db.update(usersTable)
      .set({ freeMessagesUsed: sql`free_messages_used + 1` })
      .where(and(eq(usersTable.id, userId), sql`free_messages_used < ${FREE_LIMIT}`))
      .returning({ id: usersTable.id });
    if (incremented.length === 0) {
      res.status(402).json({ error: "payment_required", message: "Bepul xabarlar limitiga yetdingiz." });
      return;
    }
  }

  const [project] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, userId)));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }

  await db.insert(projectMessagesTable).values({ projectId, role: "user", content: body.data.content });

  const history = await db
    .select()
    .from(projectMessagesTable)
    .where(eq(projectMessagesTable.projectId, projectId))
    .orderBy(projectMessagesTable.createdAt);

  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const currentRunStatus = getRunStatus(projectId);
    const assignedPort = getAssignedPort(projectId);

    const systemPrompt = `═══════════════════════════════════════
ENVIRONMENT: UzCoder IDE
═══════════════════════════════════════
You are the AI assistant built into UzCoder — a web-based code editor similar to Replit. You are NOT a generic assistant; you are operating INSIDE this IDE with full ability to create files, run commands, and launch apps directly in the user's project.

IDE LAYOUT (3 panels the user sees):
• Chat — where you and the user talk (here)
• Editor — code editor on the left + live preview iframe on the right (split view)
• Run — full-screen live preview iframe that shows the running app

HOW THE PREVIEW WORKS:
• Static HTML/CSS/JS projects: files served at /api/projects/${projectId}/serve/
• Server apps (Node.js, Python, etc.): start_app launches on port ${assignedPort}. Run panel proxies to that port automatically.
• After start_app succeeds, tell the user: "✅ Ilova ishga tushdi — Run panelidagi oynada ko'rishingiz mumkin"

CURRENT PROJECT: "${project.name}"
Description: ${project.description || "No description"}
Files: ${files.length > 0 ? files.map((f) => f.path).join(", ") : "None"}

CURRENT RUN STATUS: ${currentRunStatus.status} | port: ${assignedPort} | exitCode: ${currentRunStatus.exitCode ?? "n/a"}

TOOLS AVAILABLE:
• create_file / update_file / delete_file / read_file / list_files — manage project files
• run_command — run a shell command with FULL terminal access: npm, npx, node, python, pip, git, bash, curl, ls, cat, grep, sed, mv, cp, rm, mkdir, find, tar, env, and more. Times out after 45 s.
• start_app — start a persistent background process (bot, server). Shows live in Run panel.
• stop_app — kill the running process.
• get_run_status — check status and recent logs.
• request_secrets — open a dialog in the user's browser asking them to fill in API keys/tokens. Call this as soon as you know what secrets are needed, BEFORE writing code. The user fills them in interactively and they become available as process.env.KEY_NAME.

AUTO-RUN RULE: After creating code files, immediately run the project with run_command to verify it works.

FIX LOOP: If a run returns [ERROR:exit=N]:
1. Fix the broken file(s) with update_file
2. Re-run with run_command
3. Repeat until [SUCCESS] (max 5 attempts)

PORT RULE: Server apps MUST listen on process.env.PORT (Node.js) or int(os.environ.get("PORT", ${assignedPort})) (Python).

SECRETS WORKFLOW: When the user asks for something that needs an API key/token:
1. Call request_secrets immediately with all the keys you'll need and clear descriptions of where to get each one
2. Write the full code using process.env.KEY_NAME
3. Install dependencies with run_command
4. Then call start_app to launch the app

CRITICAL: Always write code into real files using tools. Never put source code only in chat markdown.`;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...history.slice(0, -1).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user", content: body.data.content },
    ];

    let fullResponse = "";
    let continueLoop = true;

    while (continueLoop) {
      const stream = await getOpenRouter().chat.completions.create({
        model,
        max_tokens: 8192,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        stream: true,
      });

      let chunkContent = "";
      const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          chunkContent += delta.content;
          sendEvent({ content: delta.content });
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallMap.has(tc.index)) {
              toolCallMap.set(tc.index, { id: "", name: "", args: "" });
            }
            const acc = toolCallMap.get(tc.index)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      fullResponse += chunkContent;

      if (finishReason === "tool_calls" && toolCallMap.size > 0) {
        const toolCalls = Array.from(toolCallMap.values());

        messages.push({
          role: "assistant",
          content: chunkContent || "",
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args },
          })),
        });

        const toolResults: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

        for (const tc of toolCalls) {
          let parsedArgs: unknown = {};
          try { parsedArgs = JSON.parse(tc.args); } catch { parsedArgs = {}; }

          // request_secrets — maxsus holat: foydalanuvchidan secret so'rash modali
          if (tc.name === "request_secrets") {
            const typedArgs = parsedArgs as { secrets?: { key: string; description: string }[] };
            const secretsList = typedArgs.secrets ?? [];
            sendEvent({ tool_call: { name: tc.name, args: parsedArgs as Record<string, string> } });
            sendEvent({ request_secrets: { secrets: secretsList } });
            const keyNames = secretsList.map((s) => s.key).join(", ");
            const toolMsg = `✅ Foydalanuvchiga secrets so'rash oynasi ochildi. So'ralgan kalitlar: ${keyNames || "(none)"}. Ular to'ldirilgandan so'ng process.env.KEY_NAME orqali mavjud bo'ladi. Kod yozishni davom eting.`;
            sendEvent({ tool_result: { name: tc.name, result: toolMsg } });
            toolResults.push({ role: "tool", tool_call_id: tc.id, content: toolMsg });
            continue;
          }

          const args = parsedArgs as Record<string, string>;
          sendEvent({ tool_call: { name: tc.name, args } });
          const result = await executeToolCall(projectId, tc.name, args);
          sendEvent({ tool_result: { name: tc.name, result } });
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: result });
        }

        messages.push(...toolResults);
      } else {
        continueLoop = false;
      }
    }

    await db.insert(projectMessagesTable).values({
      projectId,
      role: "assistant",
      content: fullResponse,
    });

    await db
      .update(projectsTable)
      .set({ updatedAt: new Date() })
      .where(eq(projectsTable.id, projectId));

    sendEvent({ done: true });
    res.end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    sendEvent({ error: message });
    res.end();
  }
});

export default router;
