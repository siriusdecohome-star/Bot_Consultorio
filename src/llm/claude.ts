import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import {
  emptyUsage,
  MAX_TOOL_ROUNDS,
  type LlmProvider,
  type ToolCallLog,
  type TurnInput,
  type TurnResult,
} from "./types.js";

type Msg = Anthropic.Beta.BetaMessageParam;

/** Modelos que aceptan el reintento del servidor con otro modelo si un clasificador rechaza (Haiku no). */
const SUPPORTS_FALLBACK = /^claude-(opus-5|sonnet-5-5|fable-5)/;

/**
 * Proveedor Claude (Messages API + herramientas, bucle manual).
 * - Bucle manual (no Tool Runner) porque necesitamos medir cada herramienta,
 *   guardar el historial por conversación en la base y mantener el mismo
 *   contrato que el proveedor de OpenAI.
 * - La clave se toma de ANTHROPIC_API_KEY (el SDK la lee solo).
 */
export class ClaudeProvider implements LlmProvider {
  readonly name = "claude";
  readonly model = config.claude.model;
  private client = new Anthropic();

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const tools: Anthropic.Beta.BetaTool[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    }));

    const added: Msg[] = [
      { role: "user", content: `${input.turnContext}\n\n---\nMensaje del paciente:\n${input.userText}` },
    ];
    const usage = emptyUsage();
    const toolCalls: ToolCallLog[] = [];
    let modelCalls = 0;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 4000,
        // Prompt de sistema estable y cacheado: baja costo y latencia en cada turno.
        system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages: [...(input.state as Msg[]), ...added],
        output_config: { effort: config.claude.effort },
        // Si un clasificador de seguridad rechaza, el servidor reintenta con otro modelo.
        ...(SUPPORTS_FALLBACK.test(this.model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      });
      modelCalls++;

      const u = response.usage;
      usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;

      // Se guarda el contenido completo (incluye bloques de razonamiento) sin modificarlo.
      added.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

      if (response.stop_reason === "refusal") {
        return this.finish(input, added, usage, toolCalls, modelCalls,
          "Disculpe, no puedo ayudarle con eso por este medio. Si lo desea, le comunico con una persona del consultorio.");
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use",
      );
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return this.finish(input, added, usage, toolCalls, modelCalls, text);
      }

      // Todas las respuestas de herramientas van juntas en un único mensaje.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const t0 = performance.now();
        let output: unknown;
        let isError = false;
        try {
          output = await input.executeTool(tu.name, tu.input as Record<string, unknown>);
        } catch (err) {
          output = { error: (err as Error).message };
          isError = true;
        }
        toolCalls.push({ name: tu.name, input: tu.input as Record<string, unknown>, output, ms: performance.now() - t0 });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(output), is_error: isError });
      }
      added.push({ role: "user", content: results });
    }

    return this.finish(input, added, usage, toolCalls, modelCalls,
      "Disculpe, tuve un inconveniente al procesar su pedido. Le comunico con una persona del consultorio.");
  }

  private finish(input: TurnInput, added: Msg[], usage: ReturnType<typeof emptyUsage>,
    toolCalls: ToolCallLog[], modelCalls: number, text: string): TurnResult {
    const p = config.claude;
    usage.costUsd =
      (usage.inputTokens * p.priceIn + usage.outputTokens * p.priceOut + usage.cacheReadTokens * p.priceCacheRead) / 1e6;
    return { text, state: [...input.state, ...added], usage, toolCalls, modelCalls };
  }
}
