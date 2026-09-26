import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSourceStatus } from "../src/catalog.js";
import { loadConfig, resetConfigForTests } from "../src/config.js";
import { mask, readStoredCredentials, writeStoredCredentials } from "../src/credentials.js";
import { getValuation } from "../src/sources/datafordeler/registers.js";
import { checkDatafordelerKey } from "../src/setup.js";

const KEYS = ["DATAFORDELER_API_KEY", "EMODATA_USER", "EMODATA_PASSWORD", "DATAFORSYNINGEN_TOKEN", "ADRESSEVAELGER_TOKEN"];
let saved: Record<string, string | undefined>;
let file: string;

beforeEach(() => {
  saved = Object.fromEntries(["BOLIGMCP_CREDENTIALS_FILE", ...KEYS].map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  file = join(mkdtempSync(join(tmpdir(), "boligmcp-")), "credentials.json");
  process.env.BOLIGMCP_CREDENTIALS_FILE = file;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigForTests(undefined);
  vi.restoreAllMocks();
});

describe("credentials file", () => {
  it("is written readable by the owner only and keeps only known, non-empty keys", () => {
    writeStoredCredentials({ DATAFORDELER_API_KEY: " abc123456789 ", EMODATA_USER: "", ...({ OTHER: "x" } as object) });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ DATAFORDELER_API_KEY: "abc123456789" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("ignores a broken file instead of crashing", () => {
    writeFileSync(file, "{ not json");
    expect(readStoredCredentials()).toEqual({});
  });

  it("masks secrets", () => {
    expect(mask("abcdefghijkl")).toBe("ab••••kl");
    expect(mask("short")).toBe("••••");
    expect(mask(undefined)).toBe("(ikke sat)");
  });
});

describe("config precedence", () => {
  it("uses the file when the client sets no env, and env over the file", () => {
    writeStoredCredentials({ DATAFORDELER_API_KEY: "from-file-key", EMODATA_USER: "file-user" });
    process.env.EMODATA_USER = "env-user";
    const config = loadConfig();
    expect(config.datafordelerApiKey).toBe("from-file-key");
    expect(config.emodataUser).toBe("env-user");
    expect(config.credentialSources).toEqual({ DATAFORDELER_API_KEY: "credentials_file", EMODATA_USER: "env" });
  });

  it("treats unfilled MCP bundle placeholders and blanks as not set", () => {
    process.env.DATAFORDELER_API_KEY = "${user_config.datafordeler_api_key}";
    process.env.EMODATA_USER = "   ";
    const config = loadConfig();
    expect(config.datafordelerApiKey).toBeUndefined();
    expect(config.emodataUser).toBeUndefined();
    expect(config.adressevaelgerToken).toBe("adressevaelger123");
  });

  it("keeps the cache outside the working directory by default", () => {
    delete process.env.CACHE_PATH;
    expect(loadConfig().cachePath).toMatch(/boligmcp[\\/]cache\.db$/);
    expect(loadConfig().cachePath).not.toBe("./cache.db");
  });
});

describe("list_sources", () => {
  it("tells the user how to add their own key and never shows values", () => {
    const status = listSourceStatus(loadConfig());
    const bbr = status.find((item) => item.id === "bbr");
    expect(bbr?.configured).toBe(false);
    expect(bbr?.setup).toMatch(/datafordeler\.dk.*npx -y boligmcp setup/);

    process.env.DATAFORDELER_API_KEY = "secret-key-value-123";
    const configured = listSourceStatus(loadConfig());
    expect(configured.find((item) => item.id === "bbr")).toMatchObject({ configured: true, credentialSource: "env" });
    expect(configured.find((item) => item.id === "bbr")?.setup).toBeUndefined();
    // A key alone does not open EJF; it needs an approved agreement.
    expect(configured.find((item) => item.id === "ejf")).toMatchObject({ configured: false });
    expect(JSON.stringify(configured)).not.toContain("secret-key-value-123");
  });

  it("missing-credential results point to setup and forbid pasting keys into chat", async () => {
    resetConfigForTests(loadConfig());
    const result = await getValuation("3451459");
    expect(result.status === "unavailable" && result.detail).toMatch(/boligmcp setup.*Do not ask the user to paste/s);
  });
});

describe("setup key check", () => {
  it("explains a rejected key and accepts a working one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    expect(await checkDatafordelerKey("bad")).toMatch(/rejected the key/);
    fetchMock.mockResolvedValueOnce(new Response('{"data":{"DAR_Adresse":{"nodes":[]}}}', { status: 200 }));
    expect(await checkDatafordelerKey("good")).toBeUndefined();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("apiKey=good");
  });
});
