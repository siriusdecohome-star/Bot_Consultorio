import { config, type ProviderName } from "../config.js";
import type { LlmProvider } from "./types.js";
import { MockProvider } from "./mock.js";

const KEY_VAR: Record<string, string> = { claude: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

/**
 * Elige el proveedor según LLM_PROVIDER. Los SDK se cargan solo si se usan.
 * Si se pide claude u openai y falta la clave, pasa al mock (respuestas guionadas)
 * en vez de fallar: el demo y la grabación siguen funcionando, y el aviso queda
 * en la consola y en el encabezado del simulador.
 */
export async function createProvider(name: ProviderName = config.llmProvider): Promise<LlmProvider> {
  const keyVar = KEY_VAR[name];
  if (keyVar && !process.env[keyVar]?.trim()) {
    console.warn(`⚠ LLM_PROVIDER=${name} pero falta ${keyVar} en el .env: se usa el modo sin IA (mock).`);
    return new MockProvider(`falta ${keyVar}`);
  }
  switch (name) {
    case "claude": {
      const { ClaudeProvider } = await import("./claude.js");
      return new ClaudeProvider();
    }
    case "openai": {
      const { OpenAIProvider } = await import("./openai.js");
      return new OpenAIProvider();
    }
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`LLM_PROVIDER desconocido: ${name} (use claude, openai o mock)`);
  }
}
