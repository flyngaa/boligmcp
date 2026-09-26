/**
 * Assertions for the live regression suite (docs/test-plan.md). Pure functions, so the rules themselves are unit tested
 * in tests/live-assertions.test.ts; scripts/live-regression.ts runs the cases against the real server.
 */

export interface Assertion {
  /** JSON path into the tool's result: "data.bfe", "data[0].designation", "data.length", "data[*].postalCode". */
  path?: string;
  equals?: unknown;
  /** Regex (string, case-insensitive) the value must match. Arrays and objects are matched as JSON. */
  matches?: string;
  /** Regex the value must not match. */
  notMatches?: string;
  oneOf?: unknown[];
  present?: boolean;
  absent?: boolean;
  range?: [number, number];
  /** An array value has an element equal to this, or matching it when it is a string regex. */
  contains?: unknown;
  /** "caseId:path": the same value as another case's result. */
  sameAs?: string;
  /** Output size of the whole result, ~4 characters per token. */
  maxTokens?: number;
  maxMs?: number;
  /** Overrides the case's `stable`: false makes a failure drift. */
  stable?: boolean;
  /** Shown with a failure, e.g. the severity and what it means. */
  why?: string;
}

export interface LiveCase {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  expect: Assertion[];
  /** Default true. False: a failed assertion is drift (a register changed), reported but not failing the run. */
  stable?: boolean;
  /** Run against a server without any credentials (test plan C5). */
  env?: "no_credentials";
  /**
   * Stateful cases (the watchlist): cases with the same sequence run one after another in file order, on their own
   * server with a temporary watchlist file. The file's content after the call is `$watchlist` in the result.
   */
  sequence?: string;
  /** Before the call: replace the watchlist file (a string is written as is), or set one JSON path in it. */
  setup?: { watchlist?: unknown; editWatchlist?: { path: string; value: unknown } };
  note?: string;
}

/** What one call returned. `$text` is the raw text and `$isError` the MCP error flag, for validation errors. */
export interface CallResult {
  root: Record<string, unknown>;
  text: string;
  ms: number;
}

export type Outcome = "pass" | "fail" | "drift";

export interface AssertionResult {
  outcome: Outcome;
  label: string;
  detail?: string;
}

const MISSING = Symbol("missing");

function tokenize(path: string): string[] {
  return path
    .replace(/\[(\*|\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

/** Sets a value at a dotted path ("entries[0].snapshot.valuation.propertyValue"), creating objects on the way. */
export function setPath(root: unknown, path: string, value: unknown): void {
  const keys = tokenize(path);
  let node = root as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    if (node[key] === null || typeof node[key] !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys.at(-1)!] = value;
}

/** Reads a path; `*` maps over an array. Missing values give MISSING, never throw. */
export function getPath(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  let values: unknown[] = [root];
  let spread = false;
  for (const key of tokenize(path)) {
    if (key === "*") {
      spread = true;
      values = values.flatMap((value) => (Array.isArray(value) ? value : []));
      continue;
    }
    values = values.map((value) => {
      if (value === MISSING || value === null || value === undefined) return MISSING;
      if (key === "length" && (Array.isArray(value) || typeof value === "string")) return value.length;
      if (typeof value !== "object") return MISSING;
      const record = value as Record<string, unknown>;
      return key in record ? record[key] : MISSING;
    });
  }
  if (spread) return values.filter((value) => value !== MISSING);
  return values[0];
}

const show = (value: unknown) =>
  value === MISSING ? "(missing)" : (JSON.stringify(value) ?? String(value)).slice(0, 300);

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value) ?? "");

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function elementMatches(element: unknown, wanted: unknown): boolean {
  if (typeof wanted === "string" && typeof element === "string") return new RegExp(wanted, "iu").test(element);
  return deepEqual(element, wanted);
}

export function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Checks one assertion. `lookup` gives another case's result for sameAs. */
export function check(
  assertion: Assertion,
  result: CallResult,
  lookup: (caseId: string) => CallResult | undefined,
): { ok: boolean; label: string; detail?: string } {
  const path = assertion.path ?? "";
  const value = getPath(result.root, assertion.path);
  if (assertion.maxTokens !== undefined) {
    const tokens = tokensOf(result.text);
    return { ok: tokens <= assertion.maxTokens, label: `tokens ≤ ${assertion.maxTokens}`, detail: `got ${tokens}` };
  }
  if (assertion.maxMs !== undefined) {
    return { ok: result.ms <= assertion.maxMs, label: `ms ≤ ${assertion.maxMs}`, detail: `got ${result.ms}` };
  }
  if (assertion.present) {
    const ok = value !== MISSING && value !== null && value !== undefined && !(Array.isArray(value) && !value.length);
    return { ok, label: `${path} present`, detail: `got ${show(value)}` };
  }
  if (assertion.absent) {
    const ok = value === MISSING || value === null || value === undefined || (Array.isArray(value) && !value.length);
    return { ok, label: `${path} absent`, detail: `got ${show(value)}` };
  }
  if ("equals" in assertion) {
    return { ok: deepEqual(value, assertion.equals), label: `${path} = ${show(assertion.equals)}`, detail: `got ${show(value)}` };
  }
  if (assertion.matches !== undefined) {
    const ok = value !== MISSING && new RegExp(assertion.matches, "iu").test(asText(value));
    return { ok, label: `${path} ~ /${assertion.matches}/`, detail: `got ${show(value)}` };
  }
  if (assertion.notMatches !== undefined) {
    const ok = value === MISSING || !new RegExp(assertion.notMatches, "iu").test(asText(value));
    return { ok, label: `${path} !~ /${assertion.notMatches}/`, detail: `got ${show(value)}` };
  }
  if (assertion.oneOf) {
    const ok = assertion.oneOf.some((option) => deepEqual(option, value));
    return { ok, label: `${path} in ${show(assertion.oneOf)}`, detail: `got ${show(value)}` };
  }
  if (assertion.range) {
    const [min, max] = assertion.range;
    const ok = typeof value === "number" && value >= min && value <= max;
    return { ok, label: `${path} in ${min}–${max}`, detail: `got ${show(value)}` };
  }
  if ("contains" in assertion) {
    const ok = Array.isArray(value) && value.some((element) => elementMatches(element, assertion.contains));
    return { ok, label: `${path} contains ${show(assertion.contains)}`, detail: `got ${show(value)}` };
  }
  if (assertion.sameAs) {
    const [caseId, otherPath] = assertion.sameAs.split(":");
    const other = caseId ? lookup(caseId) : undefined;
    if (!other) return { ok: false, label: `${path} sameAs ${assertion.sameAs}`, detail: `no result for case ${caseId}` };
    const otherValue = getPath(other.root, otherPath || path);
    const ok = value !== MISSING && deepEqual(value, otherValue);
    return { ok, label: `${path} sameAs ${assertion.sameAs}`, detail: `got ${show(value)} vs ${show(otherValue)}` };
  }
  return { ok: false, label: `${path} (no assertion)`, detail: "assertion has no check" };
}

export function evaluate(
  testCase: LiveCase,
  result: CallResult,
  lookup: (caseId: string) => CallResult | undefined,
): AssertionResult[] {
  return testCase.expect.map((assertion) => {
    const { ok, label, detail } = check(assertion, result, lookup);
    if (ok) return { outcome: "pass", label };
    const stable = assertion.stable ?? testCase.stable ?? true;
    const why = assertion.why ? ` (${assertion.why})` : "";
    return { outcome: stable ? "fail" : "drift", label, detail: `${detail ?? ""}${why}` };
  });
}

/** The tool's text parsed as JSON, or `{}` for a plain-text error; `$text` and `$isError` are always set. */
export function toRoot(text: string, isError: boolean): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const base = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  return { ...base, $text: text, $isError: isError };
}
