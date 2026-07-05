import { db, paymentsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID
  ? Number(process.env.TELEGRAM_ADMIN_CHAT_ID)
  : null;
const BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

// In-memory state: waiting for admin to type a new amount for a specific payment
const awaitingAmount = new Map<number, number>(); // chatId -> paymentId

export function isTelegramConfigured(): boolean {
  return !!(BOT_TOKEN && ADMIN_CHAT_ID);
}

async function tg(method: string, body: Record<string, unknown>): Promise<unknown> {
  if (!BASE) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch (err) {
    logger.error({ err, method }, "Telegram API error");
    return null;
  }
}

function buildKeyboard(paymentId: number, status: string) {
  if (status === "confirmed") {
    return { inline_keyboard: [[{ text: "✅ Tasdiqlangan", callback_data: "noop" }]] };
  }
  if (status === "rejected") {
    return { inline_keyboard: [[{ text: "❌ Rad etilgan", callback_data: "noop" }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: "✅ Tasdiqlash", callback_data: `confirm:${paymentId}` },
        { text: "❌ Rad etish", callback_data: `reject:${paymentId}` },
      ],
      [{ text: "✏️ Summani o'zgartirish", callback_data: `setamount:${paymentId}` }],
    ],
  };
}

/** Send a new-payment notification to the admin. Returns Telegram message_id if sent. */
export async function notifyAdminNewPayment(
  paymentId: number,
  userName: string,
  declaredAmount: number,
  receiptMimeType: string,
  receiptData: string,
): Promise<number | null> {
  if (!BASE || !ADMIN_CHAT_ID) return null;

  const caption =
    `💰 *Yangi to'lov!*\n\n` +
    `👤 Foydalanuvchi: ${escapeMarkdown(userName)}\n` +
    `💵 E'lon qilingan summa: *${declaredAmount.toLocaleString()} so'm*\n` +
    `🆔 To'lov ID: \`${paymentId}\`\n` +
    `⏰ Vaqt: ${new Date().toLocaleString("uz-UZ")}`;

  const keyboard = buildKeyboard(paymentId, "pending");
  const buf = Buffer.from(receiptData, "base64");

  try {
    const isImage = receiptMimeType.startsWith("image/");
    const endpoint = isImage ? "sendPhoto" : "sendDocument";
    const fieldName = isImage ? "photo" : "document";
    const ext = receiptMimeType.split("/")[1] ?? "bin";
    const fileName = isImage ? "receipt.jpg" : `receipt.${ext}`;

    const form = new FormData();
    form.append("chat_id", String(ADMIN_CHAT_ID));
    form.append("caption", caption);
    form.append("parse_mode", "Markdown");
    form.append("reply_markup", JSON.stringify(keyboard));
    form.append(fieldName, new Blob([buf], { type: receiptMimeType }), fileName);

    const res = await fetch(`${BASE}/${endpoint}`, { method: "POST", body: form });
    const data = await res.json() as { ok: boolean; result?: { message_id: number } };
    if (data.ok && data.result) return data.result.message_id;
  } catch (err) {
    logger.error({ err }, "Telegram notify error");
  }
  return null;
}

async function editCaption(messageId: number, caption: string, paymentId: number, status: string) {
  await tg("editMessageCaption", {
    chat_id: ADMIN_CHAT_ID,
    message_id: messageId,
    caption,
    parse_mode: "Markdown",
    reply_markup: buildKeyboard(paymentId, status),
  });
}

async function handleCallback(cbq: Record<string, unknown>) {
  const from = cbq.from as { id: number };
  const data = cbq.data as string;
  const msg = cbq.message as { message_id: number; chat: { id: number } };
  const msgId = msg.message_id;
  const cbqId = cbq.id as string;

  // Authorization: check the chat the notification was sent to (works for DMs and groups)
  const senderChatId = msg.chat.id;
  if (senderChatId !== ADMIN_CHAT_ID) {
    await tg("answerCallbackQuery", { callback_query_id: cbqId, text: "Ruxsat yo'q.", show_alert: true });
    return;
  }

  if (data === "noop") {
    await tg("answerCallbackQuery", { callback_query_id: cbqId });
    return;
  }

  const [action, idStr] = data.split(":");
  const paymentId = Number(idStr);

  if (action === "confirm") {
    const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
    if (!payment) {
      await tg("answerCallbackQuery", { callback_query_id: cbqId, text: "To'lov topilmadi.", show_alert: true });
      return;
    }
    const amount = payment.confirmedAmount ?? payment.declaredAmount;
    await db.update(paymentsTable)
      .set({ status: "confirmed", confirmedAt: new Date(), confirmedAmount: amount })
      .where(eq(paymentsTable.id, paymentId));
    await db.update(usersTable).set({ plan: "paid" }).where(eq(usersTable.id, payment.userId));
    await tg("answerCallbackQuery", { callback_query_id: cbqId, text: "✅ Tasdiqlandi!" });
    await editCaption(
      msgId,
      `✅ *Tasdiqlandi!*\n\n🆔 To'lov ID: \`${paymentId}\`\n💵 Summa: *${amount.toLocaleString()} so'm*`,
      paymentId,
      "confirmed",
    );

  } else if (action === "reject") {
    await db.update(paymentsTable).set({ status: "rejected" }).where(eq(paymentsTable.id, paymentId));
    await tg("answerCallbackQuery", { callback_query_id: cbqId, text: "❌ Rad etildi." });
    await editCaption(
      msgId,
      `❌ *Rad etildi.*\n\n🆔 To'lov ID: \`${paymentId}\``,
      paymentId,
      "rejected",
    );

  } else if (action === "setamount") {
    awaitingAmount.set(from.id, paymentId);
    await tg("answerCallbackQuery", { callback_query_id: cbqId, text: "✏️ Yangi summani yozing" });
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `✏️ To'lov #${paymentId} uchun yangi summani kiriting. Faqat raqam (masalan: 25000):`,
    });
  }
}

async function handleMessage(msg: Record<string, unknown>) {
  const from = msg.from as { id: number };
  const chat = msg.chat as { id: number };
  // Accept messages only from the configured admin chat (DM or group)
  if (chat.id !== ADMIN_CHAT_ID) return;

  const paymentId = awaitingAmount.get(from.id);
  if (!paymentId) return;

  const text = ((msg.text as string) ?? "").trim().replace(/\s/g, "");
  const amount = parseInt(text, 10);
  if (isNaN(amount) || amount <= 0) {
    await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: "❌ Noto'g'ri summa. Musbat son kiriting." });
    return;
  }

  awaitingAmount.delete(from.id);
  await db.update(paymentsTable).set({ confirmedAmount: amount }).where(eq(paymentsTable.id, paymentId));

  // Update original notification message caption to reflect new amount
  const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
  if (payment?.telegramMessageId) {
    const [user] = await db.select({ firstName: usersTable.firstName, lastName: usersTable.lastName }).from(usersTable).where(eq(usersTable.id, payment.userId));
    const userName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || payment.userId;
    await editCaption(
      payment.telegramMessageId,
      `💰 *Yangi to'lov!*\n\n` +
      `👤 Foydalanuvchi: ${escapeMarkdown(userName)}\n` +
      `💵 E'lon qilingan: *${payment.declaredAmount.toLocaleString()} so'm*\n` +
      `✏️ Admin summasi: *${amount.toLocaleString()} so'm*\n` +
      `🆔 To'lov ID: \`${paymentId}\`\n` +
      `📝 Holat: kutilmoqda`,
      paymentId,
      "pending",
    );
  }

  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `✅ To'lov #${paymentId} summasi *${amount.toLocaleString()} so'm* ga o'zgartirildi. Tasdiqlash tugmasini bosing.`,
    parse_mode: "Markdown",
  });
}

// ─── Polling loop ─────────────────────────────────────────────────────────────
let offset = 0;
let running = false;

export function startTelegramPolling(): void {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    logger.info("Telegram bot not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID missing).");
    return;
  }
  if (running) return;
  running = true;
  logger.info({ adminChatId: ADMIN_CHAT_ID }, "Telegram bot polling started.");
  void poll();
}

async function poll(): Promise<void> {
  while (running) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${offset}&timeout=25&allowed_updates=["message","callback_query"]`,
        { signal: AbortSignal.timeout(35_000) },
      );
      const body = await res.json() as { ok: boolean; result: Array<Record<string, unknown>> };
      if (!body.ok) { await sleep(5000); continue; }

      for (const update of body.result) {
        offset = (update.update_id as number) + 1;
        if (update.callback_query) await handleCallback(update.callback_query as Record<string, unknown>).catch((e) => logger.error({ e }, "callback error"));
        if (update.message)        await handleMessage(update.message as Record<string, unknown>).catch((e) => logger.error({ e }, "message error"));
      }
    } catch (err) {
      if ((err as Error)?.name !== "TimeoutError") logger.error({ err }, "Telegram poll error");
      await sleep(5000);
    }
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function escapeMarkdown(s: string) { return s.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&"); }
