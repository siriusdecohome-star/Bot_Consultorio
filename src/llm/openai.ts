import OpenAI from "openai";
import { config } from "../config.js";
import {
  emptyUsage,
  MAX_TOOL_ROUNDS,
  type LlmProvider,
  type ToolCallLog,
  type TurnInput,
  type TurnResult,
} from "./types.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Proveedor OpenAI (Chat Completions + function calling).
 * La clave se toma de OPENAI_API_KEY (el SDK la lee solo).
 */
export class OpenAIProvider implements LlmProvider {
  readonly name = "openai";
  readonly model = config.openai.model;
  private client = new OpenAI();

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = input.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters, strict: true },
    }));

    const added: Msg[] = [
      { role: "user", content: `${input.turnContext}\n\n---\nMensaje del paciente:\n${input.userText}` },
    ];
    const usage = emptyUsage();
    const toolCalls: ToolCallLog[] = [];
    let modelCalls = 0;
    let text = "Disculpe, tuve un inconveniente al procesar su pedido. Le comunico con una persona del consultorio.";

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "system", content: input.system }, ...(input.state as Msg[]), ...added],
        tools,
      });
      modelCalls++;
      usage.inputTokens += completion.usage?.prompt_tokens ?? 0;
      usage.outputTokens += completion.usage?.completion_tokens ?? 0;
      usage.cacheReadTokens += completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;

      const msg = completion.choices[0]!.message;
      added.push(msg as Msg);

      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
      if (calls.length === 0) {
        text = (msg.content ?? "").trim();
        break;
      }
      for (const call of calls) {
        const t0 = performance.now();
        let parsed: Record<string, unknown> = {};
        let output: unknown;
        try {
          parsed = JSON.parse(call.function.arguments || "{}");
          output = await input.executeTool(call.function.name, parsed);
        } catch (err) {
          output = { error: (err as Error).message };
        }
        toolCalls.push({ name: call.function.name, input: parsed, output, ms: performance.now() - t0 });
        added.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }

    const p = config.openai;
    usage.costUsd = (usage.inputTokens * p.priceIn + usage.outputTokens * p.priceOut) / 1e6;
    return { text, state: [...input.state, ...added], usage, toolCalls, modelCalls };
  }
}
