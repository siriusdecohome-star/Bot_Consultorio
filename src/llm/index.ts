import { config, type ProviderName } from "../config.js";
import type { LlmProvider } from "./types.js";
import { MockProvider } from "./mock.js";

/** Elige el proveedor según LLM_PROVIDER. Los SDK se cargan solo si se usan. */
export async function createProvider(name: ProviderName = config.llmProvider): Promise<LlmProvider> {
  switch (name) {
    case "claude": {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY en el archivo .env");
      const { ClaudeProvider } = await import("./claude.js");
      return new ClaudeProvider();
    }
    case "openai": {
      if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY en el archivo .env");
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider();
    }
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`LLM_PROVIDER desconocido: ${name} (use claude, openai o mock)`);
  }
}
