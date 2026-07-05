import { spawn, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { WebSocket } from "ws";

export const IMAGE_NAME = "uzcoder-sandbox:latest";
export const CONTAINER_PREFIX = "uzcoder-proj-";

// ─── Dockerfile (embedded) ────────────────────────────────────────────────────
const DOCKERFILE = `
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 python3-pip python3-venv \\
    git bash curl wget ca-certificates \\
    build-essential procps \\
    && rm -rf /var/lib/apt/lists/* \\
    && ln -sf /usr/bin/python3 /usr/bin/python \\
    && pip3 install --no-cache-dir --break-system-packages requests 2>/dev/null || true

RUN groupadd -g 1001 sandbox && \\
    useradd -u 1001 -g sandbox -m -s /bin/bash sandbox && \\
    mkdir -p /workspace && chown sandbox:sandbox /workspace

WORKDIR /workspace
USER sandbox
ENV HOME=/home/sandbox
ENV PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/sandbox/.local/bin"

CMD ["bash"]
`.trim();

// ─── Image build ──────────────────────────────────────────────────────────────
let imageBuildPromise: Promise<void> | null = null;

export async function ensureSandboxImage(): Promise<void> {
  if (imageBuildPromise) return imageBuildPromise;

  imageBuildPromise = (async () => {
    const check = await runDockerCmd(["images", "-q", IMAGE_NAME], 10_000);
    if (check.stdout.trim()) {
      return;
    }

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "uzcoder-build-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    await fsp.writeFile(dockerfilePath, DOCKERFILE, "utf-8");

    const build = await runDockerCmd(
      ["build", "-t", IMAGE_NAME, "-f", dockerfilePath, tmpDir],
      300_000
    );

    await fsp.rm(tmpDir, { recursive: true, force: true });

    if (build.exitCode !== 0) {
      imageBuildPromise = null;
      throw new Error(`Docker image build failed:\n${build.stderr}`);
    }
  })();

  return imageBuildPromise;
}

// ─── Low-level Docker helper ──────────────────────────────────────────────────
function runDockerCmd(
  args: string[],
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err
        ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1)
        : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
    });
  });
}

// ─── One-shot command (run_command tool) ─────────────────────────────────────
export async function runCommandInDocker(
  workDir: string,
  command: string,
  timeoutMs = 45_000
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  await ensureSandboxImage();

  const containerName = `uzcoder-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  return new Promise((resolve) => {
    const child = execFile(
      "docker",
      [
        "run", "--rm",
        "--name", containerName,
        "--memory=512m",
        "--memory-swap=512m",
        "--cpus=0.75",
        "--pids-limit=150",
        "--security-opt", "no-new-privileges",
        `-v`, `${workDir}:/workspace:rw`,
        "-w", "/workspace",
        IMAGE_NAME,
        "bash", "-c", command,
      ],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const killed = !!(err as (NodeJS.ErrnoException & { killed?: boolean }) | null)?.killed;
        const exitCode = err
          ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? null)
          : 0;
        resolve({
          stdout: stdout?.slice(0, 8000) ?? "",
          stderr: stderr?.slice(0, 4000) ?? "",
          exitCode: typeof exitCode === "number" ? exitCode : null,
          timedOut: killed,
        });
      }
    );
    void child;
  });
}

// ─── Persistent process (start_app tool) ─────────────────────────────────────

interface DockerProcessState {
  status: "idle" | "starting" | "running" | "stopping" | "stopped" | "crashed";
  logs: string[];
  command: string | null;
  exitCode: number | null;
  assignedPort: number;
  emitter: EventEmitter;
  logsChild: ReturnType<typeof spawn> | null;
}

const dockerStates = new Map<number, DockerProcessState>();
const BASE_PORT = 9000;
const MAX_LOGS = 500;

function containerName(projectId: number) {
  return `${CONTAINER_PREFIX}${projectId}`;
}

function getOrCreateDockerState(projectId: number): DockerProcessState {
  if (!dockerStates.has(projectId)) {
    dockerStates.set(projectId, {
      status: "idle",
      logs: [],
      command: null,
      exitCode: null,
      assignedPort: BASE_PORT + (projectId % 1000),
      emitter: new EventEmitter(),
      logsChild: null,
    });
  }
  return dockerStates.get(projectId)!;
}

function pushDockerLog(state: DockerProcessState, line: string) {
  state.logs.push(line);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  state.emitter.emit("log", line);
}

function setDockerStatus(state: DockerProcessState, status: DockerProcessState["status"]) {
  state.status = status;
  state.emitter.emit("status", status);
}

export function getDockerRunStatus(projectId: number) {
  const state = dockerStates.get(projectId);
  if (!state) return { status: "idle" as const, logs: [], exitCode: null, port: null };
  return {
    status: state.status,
    logs: [...state.logs],
    exitCode: state.exitCode,
    port: state.assignedPort,
  };
}

export function getDockerAssignedPort(projectId: number): number {
  return getOrCreateDockerState(projectId).assignedPort;
}

export function subscribeDockerLogs(projectId: number, cb: (line: string) => void): () => void {
  const state = getOrCreateDockerState(projectId);
  state.emitter.on("log", cb);
  return () => state.emitter.off("log", cb);
}

export function onDockerStatusChange(
  projectId: number,
  cb: (status: DockerProcessState["status"]) => void
): () => void {
  const state = getOrCreateDockerState(projectId);
  state.emitter.on("status", cb);
  return () => state.emitter.off("status", cb);
}

export async function startDockerProcess(
  projectId: number,
  command: string,
  workDir: string,
  env: Record<string, string>
): Promise<{ ok: boolean; error?: string }> {
  const state = getOrCreateDockerState(projectId);

  if (state.status === "running" || state.status === "starting") {
    return { ok: false, error: "Jarayon allaqachon ishlayapti. Avval to'xtating." };
  }

  try {
    await ensureSandboxImage();
  } catch (e) {
    return { ok: false, error: `Sandbox tayyorlanmadi: ${e instanceof Error ? e.message : e}` };
  }

  const name = containerName(projectId);
  await runDockerCmd(["rm", "-f", name], 10_000);

  const assignedPort = state.assignedPort;
  state.logs = [];
  state.command = command;
  state.exitCode = null;
  setDockerStatus(state, "starting");
  pushDockerLog(state, `$ ${command}`);

  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envFlags.push("-e", `${k}=${v}`);
  }

  const { exitCode: runExit } = await runDockerCmd(
    [
      "run", "-d",
      "--name", name,
      "--memory=512m",
      "--memory-swap=512m",
      "--cpus=1",
      "--pids-limit=200",
      "--security-opt", "no-new-privileges",
      `-p`, `${assignedPort}:${assignedPort}`,
      ...envFlags,
      "-e", `PORT=${assignedPort}`,
      "-e", "CI=true",
      "-e", "PYTHONUNBUFFERED=1",
      `-v`, `${workDir}:/workspace:rw`,
      "-w", "/workspace",
      IMAGE_NAME,
      "bash", "-c", command,
    ],
    15_000
  );

  if (runExit !== 0) {
    setDockerStatus(state, "crashed");
    return { ok: false, error: "Docker container ishga tushmadi." };
  }

  setDockerStatus(state, "running");

  const logsChild = spawn("docker", ["logs", "-f", "--tail=0", name]);
  state.logsChild = logsChild;

  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) pushDockerLog(state, line);
    }
  };

  logsChild.stdout.on("data", onData);
  logsChild.stderr.on("data", onData);

  logsChild.on("exit", async () => {
    state.logsChild = null;
    const { stdout } = await runDockerCmd(["inspect", "-f", "{{.State.ExitCode}}", name], 5_000);
    const code = parseInt(stdout.trim(), 10);
    state.exitCode = isNaN(code) ? null : code;
    if (state.status !== "stopping" && state.status !== "stopped") {
      setDockerStatus(state, code === 0 ? "stopped" : "crashed");
    }
  });

  return { ok: true };
}

export async function stopDockerProcess(projectId: number): Promise<{ ok: boolean; error?: string }> {
  const state = dockerStates.get(projectId);
  if (!state || (state.status !== "running" && state.status !== "starting")) {
    return { ok: false, error: "Ishlab turgan jarayon topilmadi." };
  }

  setDockerStatus(state, "stopping");

  try { state.logsChild?.kill(); } catch {}

  await runDockerCmd(["stop", "-t", "5", containerName(projectId)], 15_000);
  await runDockerCmd(["rm", "-f", containerName(projectId)], 10_000);

  state.exitCode = 0;
  setDockerStatus(state, "stopped");
  pushDockerLog(state, "Jarayon to'xtatildi.");
  return { ok: true };
}

// ─── Interactive Docker shell (WebSocket) ─────────────────────────────────────

function wsSend(ws: WebSocket, type: string, data: string) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

export async function handleDockerShell(
  ws: WebSocket,
  projectId: number,
  workDir: string,
  secretEnv: Record<string, string>
): Promise<void> {
  try {
    await ensureSandboxImage();
  } catch (e) {
    wsSend(ws, "output", `\r\nSandbox tayyor emas: ${e}\r\n`);
    ws.close();
    return;
  }

  const envFlags: string[] = [];
  for (const [k, v] of Object.entries(secretEnv)) {
    envFlags.push("-e", `${k}=${v}`);
  }

  // python3 pty.spawn creates a real PTY inside Docker without needing -t on
  // the docker run call itself (which fails when stdin is a pipe, not a TTY).
  // pty.spawn makes bash fully interactive: stty works, prompts appear.
  const PTY_CMD = [
    "python3", "-c",
    [
      "import pty, os, signal",
      "os.environ['TERM']='xterm-256color'",
      "os.environ['COLORTERM']='truecolor'",
      "os.environ['LANG']='en_US.UTF-8'",
      "signal.signal(signal.SIGCHLD, signal.SIG_DFL)",
      "pty.spawn(['/bin/bash'])",
    ].join(";"),
  ];

  const shell = spawn(
    "docker",
    [
      "run", "--rm", "-i",
      "--memory=256m",
      "--memory-swap=256m",
      "--cpus=0.5",
      "--pids-limit=100",
      "--security-opt", "no-new-privileges",
      ...envFlags,
      `-v`, `${workDir}:/workspace:rw`,
      "-w", "/workspace",
      IMAGE_NAME,
      ...PTY_CMD,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  shell.stdout.on("data", (d: Buffer) => wsSend(ws, "output", d.toString("binary")));
  shell.stderr.on("data", (d: Buffer) => wsSend(ws, "output", d.toString("binary")));

  shell.on("exit", (code) => {
    wsSend(ws, "exit", String(code ?? 0));
    ws.close();
  });

  shell.on("error", (err) => {
    wsSend(ws, "output", `\r\nShell xatosi: ${err.message}\r\n`);
    ws.close();
  });

  // Set a nice prompt once bash is ready (PTY is real, so this works)
  setTimeout(() => {
    if (!shell.stdin || shell.stdin.destroyed) return;
    shell.stdin.write(
      `export PS1='\\[\\033[01;32m\\]uzcoder\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '\n`
    );
  }, 300);

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
      if (msg.type === "input" && msg.data != null && shell.stdin && !shell.stdin.destroyed) {
        shell.stdin.write(msg.data, "binary");
      } else if (msg.type === "resize" && msg.cols && msg.rows && shell.stdin && !shell.stdin.destroyed) {
        // stty works because python pty.spawn gives bash a real PTY
        shell.stdin.write(`stty cols ${msg.cols} rows ${msg.rows}\n`);
      }
    } catch {}
  });

  ws.on("close", () => {
    try { shell.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { shell.kill("SIGKILL"); } catch {} }, 2000);
  });
  ws.on("error", () => { try { shell.kill("SIGTERM"); } catch {} });
}
