import type { SourceResult } from "../types.js";

export function asText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function missingIds(result: SourceResult<unknown>, need: string): ReturnType<typeof asText> {
  return asText({
    error: need,
    resolve: result,
  });
}
