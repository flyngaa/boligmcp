/**
 * Live regression suite (docs/test-plan.md). Runs tests/live/cases/<tool>.json through the real MCP server over stdio,
 * as a client would, against the live registers with the user's own credentials.
 *
 *   pnpm live                     every case
 *   pnpm live resolve_property    one tool or case file (several may be given)
 *   pnpm live --group resolution  one group (core = resolution + registers); --group may be repeated
 *   pnpm live --case typo_helerup one case, plus the cases it refers to with sameAs
 *   --verbose                     print every result's text; --concurrency n (default 4)
 *   --dist                        run the built dist/index.js with node, from a directory outside the repo (pnpm build first)
 *   --credentials-file            no .env: the server reads only the user's own credentials file, written by
 *                                 `boligmcp setup` (~/.config/boligmcp/credentials.json), as users run it
 *
 * By default the server gets .env (development) on top of that credentials file.
 *
 * Every result is written to tests/live/.last-run.json. Exit code 1 when a case fails; drift alone does not fail.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluate, setPath, toRoot, type AssertionResult, type CallResult, type LiveCase } from "./live/assertions.js";

const ROOT = join(import.meta.dirname, "..");
const CASES_DIR = join(ROOT, "tests", "live", "cases");

/** Groups as in the test plan. */
const GROUPS: Record<string, string[]> = {
  resolution: ["search_address", "resolve_property"],
  registers: ["get_buildings", "get_parcel", "get_valuation", "get_trades", "get_owners", "get_company", "get_property_location"],
  land: ["get_plans", "get_site_conditions", "get_environment", "get_heritage", "get_terrain"],
  area: [
    "get_admin_areas",
    "get_area_stats",
    "get_local_statistics",
    "get_nearby_services",
    "get_energy_label",
    "get_aerial_photo",
  ],
  combined: ["property_report", "screen_properties"],
  watchlist: ["watch_property", "check_watchlist", "list_watchlist", "unwatch_property", "list_sources"],
};
GROUPS.core = [...GROUPS.resolution!, ...GROUPS.registers!];

const CREDENTIAL_ENV = [
  "DATAFORDELER_API_KEY",
  "DATAFORDELER_OAUTH_CLIENT_ID",
  "DATAFORDELER_OAUTH_CLIENT_SECRET",
  "DATAFORSYNINGEN_TOKEN",
  "EMODATA_USER",
  "EMODATA_PASSWORD",
];

function parseArgs(argv: string[]) {
  const tools: string[] = [];
  const caseIds: string[] = [];
  const groups: string[] = [];
  let verbose = false;
  let concurrency = 4;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--group") groups.push(argv[++i]!);
    else if (arg === "--case") caseIds.push(argv[++i]!);
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--dist") SERVER.dist = true;
    else if (arg === "--credentials-file") SERVER.credentialsFile = true;
    else if (arg === "--concurrency") concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (arg !== "--") tools.push(arg);
  }
  for (const group of groups) {
    if (!GROUPS[group]) throw new Error(`Unknown group ${group}. Groups: ${Object.keys(GROUPS).join(", ")}`);
    tools.push(...GROUPS[group]!);
  }
  return { tools, caseIds, verbose, concurrency };
}

function loadCases(): Array<LiveCase & { file: string }> {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const cases = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8")) as LiveCase[];
      const tool = file.replace(/\.json$/, "");
      return cases.map((item) => ({ ...item, tool: item.tool ?? tool, file: tool }));
    });
}

/** Cases named with sameAs are run too, so a single case can be checked on its own. */
function withDependencies(selected: LiveCase[], all: LiveCase[]): LiveCase[] {
  const byId = new Map(all.map((item) => [item.id, item]));
  const out = new Map(selected.map((item) => [item.id, item]));
  const queue = [...selected];
  while (queue.length) {
    const item = queue.pop()!;
    for (const assertion of item.expect) {
      const dependency = assertion.sameAs ? byId.get(assertion.sameAs.split(":")[0]!) : undefined;
      if (dependency && !out.has(dependency.id)) {
        out.set(dependency.id, dependency);
        queue.push(dependency);
      }
    }
  }
  return [...out.values()];
}

/** How the server is started: from source with .env (default), or as users run it. */
const SERVER = { dist: false, credentialsFile: false, cwd: ROOT };

/** The built server runs from an empty directory, as under npx, so nothing in the repo is picked up by accident. */
function prepareServer(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "boligmcp-live-server-"));
  if (SERVER.dist) SERVER.cwd = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}

async function startServer(
  kind: "credentials" | "no_credentials",
  cachePath: string,
  extraEnv: Record<string, string> = {},
): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CACHE_PATH = cachePath;
  Object.assign(env, extraEnv);
  for (const key of CREDENTIAL_ENV) delete env[key];
  delete env.BOLIGMCP_ENV_FILE;
  if (kind === "no_credentials") {
    env.BOLIGMCP_CREDENTIALS_FILE = join(tmpdir(), "boligmcp-live-no-credentials.json");
  } else if (!SERVER.credentialsFile && existsSync(join(ROOT, ".env"))) {
    env.BOLIGMCP_ENV_FILE = join(ROOT, ".env");
  }
  const transport = new StdioClientTransport({
    command: SERVER.dist ? process.execPath : join(ROOT, "node_modules", ".bin", "tsx"),
    args: [SERVER.dist ? join(ROOT, "dist", "index.js") : join(ROOT, "src", "index.ts")],
    cwd: SERVER.cwd,
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "boligmcp-live-regression", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, testCase: LiveCase): Promise<CallResult> {
  const started = Date.now();
  try {
    const response = await client.callTool({ name: testCase.tool, arguments: testCase.args }, undefined, {
      timeout: 180_000,
    });
    const content = (response.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    const root = toRoot(text, Boolean(response.isError));
    root.$images = content.filter((item) => item.type === "image").length;
    return { root, text, ms: Date.now() - started };
  } catch (error) {
    // Protocol errors (unknown tool, invalid arguments in some SDK versions) are results too.
    const text = error instanceof Error ? error.message : String(error);
    return { root: { $text: text, $isError: true, $protocolError: true }, text, ms: Date.now() - started };
  }
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (queue.length) await run(queue.shift()!);
    }),
  );
}

const MARK: Record<string, string> = { pass: "✓", fail: "✗", drift: "~" };

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (SERVER.dist && !existsSync(join(ROOT, "dist", "index.js"))) throw new Error("No dist/index.js: run pnpm build first.");
  const cleanUpServer = prepareServer();
  process.on("exit", cleanUpServer);
  const all = loadCases();
  let selected = all;
  // A name selects a tool, or a case file by its name.
  if (options.tools.length) selected = selected.filter((item) => options.tools.includes(item.tool) || options.tools.includes(item.file));
  if (options.caseIds.length) selected = selected.filter((item) => options.caseIds.includes(item.id));
  if (!selected.length) {
    console.error("No cases selected.");
    process.exit(2);
  }
  const toRun = withDependencies(selected, all);

  const cacheDir = process.env.CACHE_PATH ? undefined : mkdtempSync(join(tmpdir(), "boligmcp-live-"));
  const cachePath = process.env.CACHE_PATH ?? join(cacheDir!, "cache.db");
  const clients = new Map<string, Promise<Client>>();
  const clientFor = (kind: "credentials" | "no_credentials") => {
    if (!clients.has(kind)) clients.set(kind, startServer(kind, kind === "credentials" ? cachePath : `${cachePath}.nocred`));
    return clients.get(kind)!;
  };

  const results = new Map<string, CallResult>();
  const started = Date.now();
  await pool(
    toRun.filter((testCase) => !testCase.sequence),
    options.concurrency,
    async (testCase) => {
      const client = await clientFor(testCase.env === "no_credentials" ? "no_credentials" : "credentials");
      results.set(testCase.id, await call(client, testCase));
    },
  );
  await Promise.all([...clients.values()].map(async (client) => (await client).close()));

  // Stateful sequences, each on its own server and watchlist file, one case at a time.
  const sequences = new Map<string, LiveCase[]>();
  for (const testCase of toRun.filter((item) => item.sequence)) {
    sequences.set(testCase.sequence!, [...(sequences.get(testCase.sequence!) ?? []), testCase]);
  }
  for (const [name, cases] of sequences) {
    const dir = mkdtempSync(join(tmpdir(), `boligmcp-live-${name}-`));
    const watchlist = join(dir, "watchlist.json");
    const servers = new Map<string, Client>();
    for (const testCase of cases) {
      const kind = testCase.env === "no_credentials" ? "no_credentials" : "credentials";
      if (!servers.has(kind)) {
        servers.set(kind, await startServer(kind, kind === "credentials" ? cachePath : `${cachePath}.nocred`, { BOLIGMCP_WATCHLIST_FILE: watchlist }));
      }
      if (testCase.setup?.watchlist !== undefined) {
        const content = testCase.setup.watchlist;
        writeFileSync(watchlist, typeof content === "string" ? content : JSON.stringify(content));
      }
      if (testCase.setup?.editWatchlist) {
        const json = JSON.parse(readFileSync(watchlist, "utf8")) as unknown;
        setPath(json, testCase.setup.editWatchlist.path, testCase.setup.editWatchlist.value);
        writeFileSync(watchlist, JSON.stringify(json));
      }
      const result = await call(servers.get(kind)!, testCase);
      result.root.$watchlist = existsSync(watchlist) ? readFileSync(watchlist, "utf8") : null;
      results.set(testCase.id, result);
    }
    await Promise.all([...servers.values()].map((client) => client.close()));
    rmSync(dir, { recursive: true, force: true });
  }

  const lookup = (id: string) => results.get(id);
  const counts = { pass: 0, fail: 0, drift: 0 };
  const report: Array<{ id: string; tool: string; outcome: string; ms: number; assertions: AssertionResult[]; text: string }> = [];
  const byTool = new Map<string, LiveCase[]>();
  for (const testCase of selected) byTool.set(testCase.tool, [...(byTool.get(testCase.tool) ?? []), testCase]);

  for (const [tool, cases] of byTool) {
    console.log(`\n${tool}`);
    for (const testCase of cases) {
      const result = results.get(testCase.id)!;
      const assertions = evaluate(testCase, result, lookup);
      const outcome = assertions.some((item) => item.outcome === "fail")
        ? "fail"
        : assertions.some((item) => item.outcome === "drift")
          ? "drift"
          : "pass";
      counts[outcome] += 1;
      report.push({ id: testCase.id, tool, outcome, ms: result.ms, assertions, text: result.text });
      console.log(`  ${MARK[outcome]} ${testCase.id} (${result.ms} ms)`);
      for (const item of assertions.filter((assertion) => assertion.outcome !== "pass")) {
        console.log(`      ${MARK[item.outcome]} ${item.label}: ${item.detail ?? ""}`);
      }
      if (options.verbose || outcome === "fail") console.log(`      ↳ ${result.text.slice(0, options.verbose ? 4000 : 600)}`);
    }
  }

  writeFileSync(join(ROOT, "tests", "live", ".last-run.json"), JSON.stringify(report, null, 1));
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `\nLIVE SUMMARY server=${SERVER.dist ? "dist" : "src"}${SERVER.credentialsFile ? "+credentials-file" : ""} cases=${selected.length} pass=${counts.pass} fail=${counts.fail} drift=${counts.drift} time=${seconds}s`,
  );
  process.exit(counts.fail ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
