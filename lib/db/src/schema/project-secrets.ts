import { pgTable, text, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectsTable } from "./projects";

export const projectSecretsTable = pgTable(
  "project_secrets",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "cascade" }).notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [unique().on(table.projectId, table.key)],
);

export const insertProjectSecretSchema = createInsertSchema(projectSecretsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProjectSecret = z.infer<typeof insertProjectSecretSchema>;
export type ProjectSecret = typeof projectSecretsTable.$inferSelect;
