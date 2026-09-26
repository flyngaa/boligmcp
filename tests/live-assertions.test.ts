import { describe, expect, it } from "vitest";
import { evaluate, getPath, setPath, toRoot, type CallResult, type LiveCase } from "../scripts/live/assertions.js";

const result = (value: unknown, ms = 10): CallResult => {
  const text = JSON.stringify(value);
  return { root: toRoot(text, false), text, ms };
};

const run = (expect: LiveCase["expect"], value: unknown, extra: Partial<LiveCase> = {}, others: Record<string, CallResult> = {}) =>
  evaluate({ id: "c", tool: "t", args: {}, expect, ...extra }, result(value), (id) => others[id]);

describe("live regression assertions", () => {
  it("reads paths with indexes, length and wildcards", () => {
    const root = { data: [{ bfe: "1", floors: [1, 2] }, { bfe: "2" }] };
    expect(getPath(root, "data[0].bfe")).toBe("1");
    expect(getPath(root, "data.length")).toBe(2);
    expect(getPath(root, "data[*].bfe")).toEqual(["1", "2"]);
    expect(getPath(root, "data[5].bfe")).toBeTypeOf("symbol");
  });

  it("passes, fails and reports drift", () => {
    const value = { data: { bfe: "3451459", area: 811, warning: undefined, list: ["Vestergade 1B, 8000 Aarhus C"] } };
    expect(run([{ path: "data.bfe", equals: "3451459" }], value)[0]?.outcome).toBe("pass");
    expect(run([{ path: "data.area", range: [800, 820] }], value)[0]?.outcome).toBe("pass");
    expect(run([{ path: "data.warning", absent: true }], value)[0]?.outcome).toBe("pass");
    expect(run([{ path: "data.list", contains: "^Vestergade 1B" }], value)[0]?.outcome).toBe("pass");
    expect(run([{ path: "data.bfe", matches: "^34" }], value)[0]?.outcome).toBe("pass");
    expect(run([{ path: "data.bfe", equals: "1" }], value)[0]?.outcome).toBe("fail");
    expect(run([{ path: "data.bfe", equals: "1" }], value, { stable: false })[0]?.outcome).toBe("drift");
    expect(run([{ path: "data.bfe", equals: "1", stable: false }], value)[0]?.outcome).toBe("drift");
    expect(run([{ maxTokens: 1 }], value)[0]?.outcome).toBe("fail");
  });

  it("compares with another case", () => {
    const other = result({ data: { bfe: "3451459" } });
    expect(run([{ path: "data.bfe", sameAs: "o:data.bfe" }], { data: { bfe: "3451459" } }, {}, { o: other })[0]?.outcome).toBe("pass");
    expect(run([{ path: "data.bfe", sameAs: "o" }], { data: { bfe: "1" } }, {}, { o: other })[0]?.outcome).toBe("fail");
    expect(run([{ path: "data.bfe", sameAs: "missing:data.bfe" }], { data: { bfe: "1" } })[0]?.outcome).toBe("fail");
  });

  it("edits a watchlist path for a setup step", () => {
    const json = { entries: [{ snapshot: { valuation: { propertyValue: 2419000 } } }] };
    setPath(json, "entries.0.snapshot.valuation.propertyValue", 1);
    setPath(json, "entries[0].note", "x");
    expect(json.entries[0]).toMatchObject({ note: "x", snapshot: { valuation: { propertyValue: 1 } } });
  });

  it("keeps plain-text errors readable", () => {
    const root = toRoot("MCP error -32602: Input validation error", true);
    expect(root.$isError).toBe(true);
    expect(root.$text).toMatch(/validation/);
  });
});
