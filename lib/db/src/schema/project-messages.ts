import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const projectMessagesTable = pgTable("project_messages", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "cascade" }).notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCalls: text("tool_calls"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProjectMessageSchema = createInsertSchema(projectMessagesTable).omit({ id: true, createdAt: true });
export type InsertProjectMessage = z.infer<typeof insertProjectMessageSchema>;
export type ProjectMessage = typeof projectMessagesTable.$inferSelect;
