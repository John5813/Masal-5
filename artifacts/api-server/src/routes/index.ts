import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import projectsRouter from "./projects/index";
import paymentsRouter from "./payments";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use("/projects", projectsRouter);
router.use("/payments", paymentsRouter);
router.use("/payment-info", (_req, res, next) => { _req.url = "/info"; next(); }, paymentsRouter);

export default router;
