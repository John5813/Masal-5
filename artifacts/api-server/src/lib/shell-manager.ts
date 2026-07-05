import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { db } from "@workspace/db";
import { projectFilesTable, projectSecretsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { WebSocket } from "ws";
import { handleDockerShell } from "./docker-sandbox";

const PROJECTS_WORKDIR_ROOT = path.join(os.tmpdir(), "uzcoder-projects");

async function materializeFiles(projectId: number, workDir: string): Promise<void> {
  const files = await db
    .select()
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  await fsp.mkdir(workDir, { recursive: true });
  for (const file of files) {
    const filePath = path.join(workDir, file.path);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, file.content, "utf-8");
  }
}

export async function handleShellConnection(ws: WebSocket, projectId: number): Promise<void> {
  const workDir = path.join(PROJECTS_WORKDIR_ROOT, String(projectId));

  try {
    await materializeFiles(projectId, workDir);
  } catch (err) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "output", data: `\r\nXato: shell papkasi tayyorlanmadi — ${err}\r\n` }));
    }
    ws.close();
    return;
  }

  const secrets = await db
    .select()
    .from(projectSecretsTable)
    .where(eq(projectSecretsTable.projectId, projectId));
  const secretEnv = Object.fromEntries(secrets.map((s) => [s.key, s.value]));

  await handleDockerShell(ws, projectId, workDir, secretEnv);
}
