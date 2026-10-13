import type { EvalScenario, EvalStep } from "./scenarios";

/** Minimal client surface (an `@modelcontextprotocol/client` Client satisfies it). */
export interface EvalClient {
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  listTools(): Promise<{ tools: { name: string }[] }>;
}

export interface StepOutcome {
  step: number;
  tool: string;
  ok: boolean;
  message?: string;
  result?: Record<string, unknown>;
}

function get(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((cur, k) => (cur == null ? undefined : (cur as Record<string, unknown>)[k]), obj);
}

/** `"$2.contact.id"` → value from the structured result of step 2 (recursively in objects and arrays). */
export function resolveRefs(value: unknown, results: readonly (Record<string, unknown> | undefined)[]): unknown {
  if (typeof value === "string") {
    const m = /^\$(\d+)\.(.+)$/.exec(value);
    return m ? get(results[Number(m[1])], m[2] as string) : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results)]));
  }
  return value;
}

function check(
  step: EvalStep,
  r: { isError?: boolean; structuredContent?: Record<string, unknown> },
  results: readonly (Record<string, unknown> | undefined)[],
): string | undefined {
  const wantError = step.expect?.isError ?? false;
  if (Boolean(r.isError) !== wantError) return `isError=${Boolean(r.isError)}, erwartet ${wantError}`;
  for (const [path, expected] of Object.entries(step.expect?.equals ?? {})) {
    const want = resolveRefs(expected, results);
    const got = get(r.structuredContent, path);
    if (JSON.stringify(got) !== JSON.stringify(want))
      return `${path} = ${JSON.stringify(got)}, erwartet ${JSON.stringify(want)}`;
  }
  return undefined;
}

/**
 * Replays the reference calls of a scenario. Results are indexed by step for `$n` references; setup steps count too.
 * Also verifies that every referenced tool is listed for the key and no forbidden tool appears in the reference.
 */
export async function runScenario(client: EvalClient, s: EvalScenario): Promise<StepOutcome[]> {
  const listed = new Set((await client.listTools()).tools.map((t) => t.name));
  const outcomes: StepOutcome[] = [];
  const results: (Record<string, unknown> | undefined)[] = [];
  for (const [i, step] of s.steps.entries()) {
    if (s.forbidden?.includes(step.tool)) {
      outcomes.push({ step: i, tool: step.tool, ok: false, message: "verbotenes Werkzeug in der Referenz" });
      break;
    }
    if (!listed.has(step.tool)) {
      outcomes.push({ step: i, tool: step.tool, ok: false, message: "Werkzeug für diesen Schlüssel nicht gelistet" });
      break;
    }
    const r = (await client.callTool({
      name: step.tool,
      arguments: resolveRefs(step.args, results) as Record<string, unknown>,
    })) as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] };
    results.push(r.structuredContent);
    const message = check(step, r, results) ?? undefined;
    outcomes.push({
      step: i,
      tool: step.tool,
      ok: message === undefined,
      ...(message ? { message: `${message}${r.isError ? ` – ${r.content?.[0]?.text ?? ""}` : ""}` } : {}),
      ...(r.structuredContent ? { result: r.structuredContent } : {}),
    });
    if (message) break;
  }
  return outcomes;
}
