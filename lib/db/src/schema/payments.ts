import { integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  declaredAmount: integer("declared_amount").notNull(),
  confirmedAmount: integer("confirmed_amount"),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | confirmed | rejected
  receiptData: text("receipt_data").notNull(),           // base64 encoded file
  receiptMimeType: varchar("receipt_mime_type", { length: 100 }).notNull(),
  receiptFileName: varchar("receipt_file_name", { length: 255 }),
  note: text("note"),
  telegramMessageId: integer("telegram_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

export type Payment = typeof paymentsTable.$inferSelect;
export type InsertPayment = typeof paymentsTable.$inferInsert;
