# Fable 5 IDE

AI yordamida kod yozuvchi to'liq muhit — loyihalar yarating, fayllar boshqaring, AI bilan muloqot qiling va ilovalarni to'g'ridan-to'g'ri brauzerda ishga tushiring.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server ishga tushirish (port 8080)
- `pnpm --filter @workspace/code-assistant run dev` — Frontend ishga tushirish (port 23878)
- `pnpm run typecheck` — Barcha paketlarni typecheck qilish
- `pnpm run build` — Typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — API hooks va Zod schemalarini qayta generatsiya qilish
- `pnpm --filter @workspace/db run push` — DB schema o'zgarishlarini push qilish (faqat dev)
- Kerakli env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Auth: Replit Auth (OpenID Connect, express-session, connect-pg-simple)
- AI: OpenRouter (OpenAI-compatible)
- Frontend: React + Vite + Tailwind CSS v4 + shadcn/ui
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth)
- `lib/db/src/schema/` — Drizzle schema (projects, files, messages, secrets, auth)
- `artifacts/api-server/src/routes/projects/index.ts` — Asosiy API routes
- `artifacts/api-server/src/lib/auth.ts` — Replit Auth setup
- `artifacts/api-server/src/lib/process-manager.ts` — Background process management
- `artifacts/api-server/src/lib/shell-manager.ts` — Shell WebSocket handler
- `artifacts/code-assistant/src/pages/workspace.tsx` — Asosiy IDE sahifasi
- `lib/replit-auth-web/` — Frontend uchun auth hook

## Architecture decisions

- Replit Auth orqali foydalanuvchi autentifikatsiyasi (OpenID Connect)
- Loyiha fayllari PostgreSQL'da saqlanadi (fayl tizimi emas)
- AI javoblari SSE (Server-Sent Events) orqali stream qilinadi
- Ilovalar /tmp papkasiga materializatsiya qilinib, subprocess sifatida ishga tushiriladi
- GitHub repo'lardan fayllar ZIP orqali import qilinadi

## Product

- Loyihalar yaratish va boshqarish
- Fayllarni yaratish, tahrirlash, o'chirish
- AI bilan muloqot (kod yozish, tuzatish)
- GitHub repo klonlash
- Ilovalarni to'g'ridan-to'g'ri brauzerda preview qilish
- Shell orqali buyruqlar bajarish

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- node-pty bu workspace'da ishlamaydi (Python yo'q) — shell-manager.ts `script` buyrug'idan foydalanadi
- OPENROUTER_API_KEY yoki OPENAI_API_KEY env o'zgaruvchisi AI funksionalligi uchun kerak

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
