/** Compact JSON: indentation adds about a third to every response's token count and helps no model read it. */
export function asText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}
