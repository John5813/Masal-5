import { Router, type Request, type Response } from "express";
import { db, paymentsTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { notifyAdminNewPayment } from "../lib/telegram";
import { logger } from "../lib/logger";

const router = Router();

const MAX_B64_BYTES = 5 * 1024 * 1024 * 1.37; // ~5 MB file → base64 ~7 MB

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response): string | null {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Kirish talab etiladi." });
    return null;
  }
  return req.user.id;
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Kirish talab etiladi." }); return false; }
  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId || req.user.id !== adminId) { res.status(403).json({ error: "Ruxsat yo'q." }); return false; }
  return true;
}

// ─── Payment info (public) ────────────────────────────────────────────────────

router.get("/info", (_req, res) => {
  res.json({
    cardNumber: process.env.PAYMENT_CARD_NUMBER ?? "",
    cardOwner: process.env.PAYMENT_CARD_OWNER ?? "UzCoder",
  });
});

// ─── User: submit payment ─────────────────────────────────────────────────────

router.post("/", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;

  const { declaredAmount, receiptData, receiptMimeType, receiptFileName } = req.body as {
    declaredAmount?: number;
    receiptData?: string;
    receiptMimeType?: string;
    receiptFileName?: string;
  };

  if (!declaredAmount || declaredAmount <= 0) {
    res.status(400).json({ error: "To'lov summasi kiritilmagan." });
    return;
  }
  if (!receiptData || !receiptMimeType) {
    res.status(400).json({ error: "Chek fayli talab etiladi." });
    return;
  }
  if (receiptData.length > MAX_B64_BYTES) {
    res.status(400).json({ error: "Fayl hajmi 5 MB dan oshmasligi kerak." });
    return;
  }

  const [user] = await db
    .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  const userName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.email || "Noma'lum";

  const [payment] = await db
    .insert(paymentsTable)
    .values({ userId, declaredAmount, receiptData, receiptMimeType, receiptFileName, status: "pending" })
    .returning();

  // Notify admin via Telegram (non-blocking)
  notifyAdminNewPayment(payment.id, userName, declaredAmount, receiptMimeType, receiptData)
    .then(async (msgId) => {
      if (msgId) await db.update(paymentsTable).set({ telegramMessageId: msgId }).where(eq(paymentsTable.id, payment.id));
    })
    .catch((err) => logger.error({ err }, "Telegram notify failed"));

  res.status(201).json({ id: payment.id, status: "pending" });
});

// ─── User: my payments ────────────────────────────────────────────────────────

router.get("/my", async (req, res) => {
  const userId = requireAuth(req, res);
  if (!userId) return;

  const payments = await db
    .select({
      id: paymentsTable.id,
      declaredAmount: paymentsTable.declaredAmount,
      confirmedAmount: paymentsTable.confirmedAmount,
      status: paymentsTable.status,
      createdAt: paymentsTable.createdAt,
      confirmedAt: paymentsTable.confirmedAt,
    })
    .from(paymentsTable)
    .where(eq(paymentsTable.userId, userId))
    .orderBy(desc(paymentsTable.createdAt));

  res.json(payments);
});

// ─── Admin: list all ──────────────────────────────────────────────────────────

router.get("/admin", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const payments = await db
    .select({
      id: paymentsTable.id,
      userId: paymentsTable.userId,
      declaredAmount: paymentsTable.declaredAmount,
      confirmedAmount: paymentsTable.confirmedAmount,
      status: paymentsTable.status,
      receiptMimeType: paymentsTable.receiptMimeType,
      receiptFileName: paymentsTable.receiptFileName,
      note: paymentsTable.note,
      createdAt: paymentsTable.createdAt,
      confirmedAt: paymentsTable.confirmedAt,
    })
    .from(paymentsTable)
    .orderBy(desc(paymentsTable.createdAt));
  res.json(payments);
});

// ─── Admin: view receipt ──────────────────────────────────────────────────────

router.get("/admin/:id/receipt", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [p] = await db
    .select({ receiptData: paymentsTable.receiptData, receiptMimeType: paymentsTable.receiptMimeType, receiptFileName: paymentsTable.receiptFileName })
    .from(paymentsTable)
    .where(eq(paymentsTable.id, id));
  if (!p) { res.status(404).json({ error: "Not found" }); return; }
  const buf = Buffer.from(p.receiptData, "base64");
  res.setHeader("Content-Type", p.receiptMimeType);
  if (p.receiptFileName) res.setHeader("Content-Disposition", `inline; filename="${p.receiptFileName}"`);
  res.send(buf);
});

// ─── Admin: update confirmed amount ──────────────────────────────────────────

router.put("/admin/:id/amount", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { amount } = req.body as { amount?: number };
  if (!amount || amount <= 0) { res.status(400).json({ error: "amount required" }); return; }
  const [updated] = await db.update(paymentsTable).set({ confirmedAmount: amount }).where(eq(paymentsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

// ─── Admin: confirm ───────────────────────────────────────────────────────────

router.put("/admin/:id/confirm", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, id));
  if (!payment) { res.status(404).json({ error: "Not found" }); return; }
  const amount = payment.confirmedAmount ?? payment.declaredAmount;
  await db.update(paymentsTable).set({ status: "confirmed", confirmedAt: new Date(), confirmedAmount: amount }).where(eq(paymentsTable.id, id));
  await db.update(usersTable).set({ plan: "paid" }).where(eq(usersTable.id, payment.userId));
  res.json({ id, status: "confirmed", confirmedAmount: amount });
});

// ─── Admin: reject ────────────────────────────────────────────────────────────

router.put("/admin/:id/reject", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [updated] = await db.update(paymentsTable).set({ status: "rejected" }).where(eq(paymentsTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ id, status: "rejected" });
});

// ─── Admin: delete record ─────────────────────────────────────────────────────

router.delete("/admin/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
  res.status(204).send();
});

export default router;
