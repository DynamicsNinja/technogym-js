import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** One tool result may not exceed this; 1 Hz analytics of a long run reach megabytes. */
export const MAX_RESULT_CHARS = 200_000;

export function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${MAX_RESULT_CHARS} of ${text.length} characters; narrow the window or raise sample_every_seconds]`;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: truncate(text) }] };
}

/**
 * Pretty-printed JSON, except that the time-series arrays named in `rowKeys` keep one compact row
 * per line. Pretty-printing a `{t, Speed, Grade, ...}` sample costs ~8 lines; at 1 Hz that
 * triples the payload for no gain in readability.
 */
export function compactJson(value: Record<string, unknown>, rowKeys: readonly string[] = ["samples", "hr"]): string {
  const rows = new Map<string, unknown[]>();
  const shallow: Record<string, unknown> = { ...value };
  for (const key of rowKeys) {
    const v = shallow[key];
    if (Array.isArray(v) && v.length > 0) {
      const token = `__ROWS_${key}__`;
      rows.set(token, v);
      shallow[key] = token;
    }
  }
  let text = JSON.stringify(shallow, null, 2);
  for (const [token, list] of rows) {
    const body = list.map((r) => JSON.stringify(r)).join(",\n    ");
    text = text.replace(JSON.stringify(token), `[\n    ${body}\n  ]`);
  }
  return text;
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}
