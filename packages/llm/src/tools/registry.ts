import { z } from 'zod';
import type { JsonSchema, ToolSpec } from '../types.js';

/**
 * read  - no side effects; runs immediately.
 * write - changes user data; needs explicit user confirmation first.
 */
export type ToolRisk = 'read' | 'write';

export interface ToolDefinition<Ctx, I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  risk: ToolRisk;
  /** One-line, human-readable description of what a call will do (shown on confirmation cards). */
  summarize: (input: I, ctx: Ctx) => string;
  /** Returns the string the model sees as the tool result. */
  handler: (input: I, ctx: Ctx) => Promise<string>;
}

export function defineTool<Ctx, I>(def: ToolDefinition<Ctx, I>): ToolDefinition<Ctx, I> {
  return def;
}

/** A tool of any input type. Inputs are zod-validated before handlers run, so erasing I here is safe. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool<Ctx> = ToolDefinition<Ctx, any>;

export type ParsedCall<Ctx> =
  | { ok: true; id: string; tool: ToolDefinition<Ctx>; input: unknown; summary: string }
  | { ok: false; id: string; name: string; error: string };

export class ToolRegistry<Ctx> {
  private readonly tools = new Map<string, ToolDefinition<Ctx>>();

  constructor(defs: AnyTool<Ctx>[] = []) {
    for (const d of defs) this.register(d);
  }

  register<I>(def: ToolDefinition<Ctx, I>): this {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(def.name)) throw new Error(`Invalid tool name "${def.name}"`);
    if (this.tools.has(def.name)) throw new Error(`Duplicate tool "${def.name}"`);
    this.tools.set(def.name, def as unknown as ToolDefinition<Ctx>);
    return this;
  }

  get(name: string): ToolDefinition<Ctx> | undefined {
    return this.tools.get(name);
  }

  /** Specs sorted by name: a stable tool list keeps the prompt cache warm. */
  specs(): ToolSpec[] {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, inputSchema: toInputSchema(t.input) }));
  }

  /**
   * Validate a model-proposed call. Model output is untrusted: unknown tools
   * and inputs that fail the schema (including truncated streamed inputs)
   * become error results the model can correct, never executions.
   */
  parse(call: { id: string; name: string; input: unknown }, ctx: Ctx): ParsedCall<Ctx> {
    const tool = this.tools.get(call.name);
    if (!tool) return { ok: false, id: call.id, name: call.name, error: `Unknown tool "${call.name}"` };
    const parsed = tool.input.safeParse(call.input ?? {});
    if (!parsed.success) {
      return { ok: false, id: call.id, name: call.name, error: `Invalid input: ${z.prettifyError(parsed.error)}` };
    }
    return { ok: true, id: call.id, tool, input: parsed.data, summary: safeSummary(tool, parsed.data, ctx) };
  }
}

export function toInputSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as JsonSchema;
  return json;
}

function safeSummary<Ctx>(tool: ToolDefinition<Ctx>, input: unknown, ctx: Ctx): string {
  try {
    return tool.summarize(input, ctx);
  } catch {
    return `${tool.name}(${JSON.stringify(input).slice(0, 200)})`;
  }
}
