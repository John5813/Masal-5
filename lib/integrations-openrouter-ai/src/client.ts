import OpenAI from "openai";

// Support both Replit AI Integrations proxy and a direct API key
const baseURL =
  process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL ??
  "https://openrouter.ai/api/v1";

const apiKey =
  process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY ??
  process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  throw new Error(
    "OpenRouter API key is not set. Provide OPENROUTER_API_KEY or provision the Replit AI Integration."
  );
}

export const openrouter = new OpenAI({ baseURL, apiKey });
