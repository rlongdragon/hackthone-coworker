import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

// Custom OpenAI-format provider (vLLM / gateway / any /chat/completions server).
const provider = createOpenAICompatible({
  name: "custom",
  baseURL: process.env.LLM_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: process.env.LLM_API_KEY ?? "not-needed",
});

export const model = provider(process.env.LLM_MODEL ?? "gpt-4o-mini");
export const MODEL_ID = process.env.LLM_MODEL ?? "gpt-4o-mini";
