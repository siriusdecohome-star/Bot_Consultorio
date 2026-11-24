/**
 * Contrato neutral entre el motor del bot y cualquier proveedor de LLM.
 * El motor no sabe si habla con Claude, OpenAI o el simulador "mock".
 */

/** Definición de herramienta en JSON Schema (la traduce cada proveedor). */
export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

/** Ejecuta una herramienta y devuelve el resultado serializable. */
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<unknown>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface ToolCallLog {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  ms: number;
}

export interface TurnResult {
  /** Texto final para el paciente */
  text: string;
  /**
   * Historial nativo del proveedor, solo se agrega al final (append-only).
   * Se guarda tal cual por conversación: así se respetan los bloques internos
   * (por ejemplo, los de razonamiento de Claude) que deben reenviarse sin cambios.
   */
  state: unknown[];
  usage: Usage;
  toolCalls: ToolCallLog[];
  /** Llamadas al modelo dentro del turno (1 + rondas de herramientas) */
  modelCalls: number;
}

export interface TurnInput {
  system: string;
  /** Historial nativo previo de esta conversación (lo que devolvió el turno anterior). */
  state: unknown[];
  userText: string;
  /** Nota de sistema efímera para este turno (fecha/hora actual, canal, etc.). */
  turnContext: string;
  tools: ToolDef[];
  executeTool: ToolExecutor;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  runTurn(input: TurnInput): Promise<TurnResult>;
}

export const MAX_TOOL_ROUNDS = 6;

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}
