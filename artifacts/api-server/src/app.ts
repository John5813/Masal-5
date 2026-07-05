import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { authMiddleware } from "./middlewares/authMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { ensureSandboxImage } from "./lib/docker-sandbox";
import { startTelegramPolling } from "./lib/telegram";

ensureSandboxImage()
  .then(() => logger.info("Docker sandbox image ready"))
  .catch((err) => logger.warn({ err }, "Docker sandbox image build failed — sandbox unavailable"));

startTelegramPolling();

const app: Express = express();

// Replit proxy orqali kelgan so'rovlar uchun X-Forwarded-For ishonchli
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

// Rate limiting: AI chat endpoint — max 30 req/min per IP
app.use(
  "/api/projects/:id/messages",
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Juda ko'p so'rov. 1 daqiqa kutib, qayta urinib ko'ring." },
  }),
);

// Rate limiting: general API — max 200 req/min per IP
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Juda ko'p so'rov. 1 daqiqa kutib, qayta urinib ko'ring." },
  }),
);

app.use("/api", router);

export default app;
