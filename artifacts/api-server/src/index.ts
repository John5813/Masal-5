import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { handleShellConnection } from "./lib/shell-manager";
import { getSession } from "./lib/auth";
import { db } from "@workspace/db";
import { projectsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

function parseSessionId(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:^|;\s*)sid=([^;]+)/);
  return match?.[1];
}

const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://localhost`);
  const match = url.pathname.match(/^\/api\/shell\/(\d+)$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const projectId = Number(match[1]);
  const sid = parseSessionId(request.headers.cookie);

  if (!sid) {
    socket.destroy();
    return;
  }

  getSession(sid)
    .then(async (session) => {
      if (!session?.user?.id) {
        socket.destroy();
        return;
      }
      const [proj] = await db
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(and(eq(projectsTable.id, projectId), eq(projectsTable.userId, session.user.id)));
      if (!proj) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket as never, head, (ws) => {
        handleShellConnection(ws, projectId).catch((err) => {
          logger.error({ err }, "Shell connection error");
          ws.close();
        });
      });
    })
    .catch((err) => {
      logger.error({ err }, "Shell WebSocket auth error");
      socket.destroy();
    });
});

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
