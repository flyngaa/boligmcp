import { createInterface } from "node:readline";
import {
  credentialsPath,
  mask,
  readStoredCredentials,
  writeStoredCredentials,
  type CredentialKey,
  type StoredCredentials,
} from "./credentials.js";

interface Field {
  key: CredentialKey;
  label: string;
  help: string;
  secret: boolean;
  validate?: (value: string) => Promise<string | undefined>;
}

/** Returns an error message, or undefined when Datafordeleren issues a token for the client. */
export async function checkOAuthClient(clientId: string, secret: string): Promise<string | undefined> {
  try {
    const response = await fetch("https://auth.datafordeler.dk/realms/distribution/protocol/openid-connect/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
    });
    if (response.status === 400 || response.status === 401) {
      return "Datafordeleren rejected the Client ID or Shared Secret (401). Copy both from the IT-system's OAuth Shared Secret in Datafordeler Administration.";
    }
    if (!response.ok) return `Datafordeleren answered HTTP ${response.status}. Saved anyway; try again later.`;
    return undefined;
  } catch (error) {
    return `Could not reach Datafordeleren (${error instanceof Error ? error.message : String(error)}). Saved anyway.`;
  }
}

/** Returns an error message, or undefined when Datafordeleren accepts the key. */
export async function checkDatafordelerKey(key: string): Promise<string | undefined> {
  const now = new Date().toISOString();
  const query = `query { DAR_Adresse(first: 1, virkningstid: "${now}", registreringstid: "${now}", where: { id_lokalId: { eq: "00000000-0000-0000-0000-000000000000" } }) { nodes { id_lokalId } } }`;
  try {
    const response = await fetch(`https://graphql.datafordeler.dk/DAR/v3?apiKey=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (response.status === 401) {
      return "Datafordeleren rejected the key (401). Use the API key of an IT-system, not the ClientId. New keys can take 15 minutes to activate.";
    }
    if (response.status === 403) return "The key works but has no access to DAR (403).";
    if (!response.ok) return `Datafordeleren answered HTTP ${response.status}. The key was saved anyway; try again later.`;
    return undefined;
  } catch (error) {
    return `Could not reach Datafordeleren (${error instanceof Error ? error.message : String(error)}). The key was saved anyway.`;
  }
}

const FIELDS: Field[] = [
  {
    key: "DATAFORDELER_API_KEY",
    label: "Datafordeleren API key",
    help: "Free. datafordeler.dk → create a web user → Selvbetjening → IT-system → authentication method API-key. Unlocks BBR, Matriklen, VUR, DAR and DAGI.",
    secret: true,
    validate: checkDatafordelerKey,
  },
  {
    key: "DATAFORDELER_OAUTH_CLIENT_ID",
    label: "Datafordeler OAuth Client ID",
    help: "Optional. Only for sale prices (EJF), after Geodatastyrelsen approves your request. Datafordeler Administration → IT-system → OAuth Shared Secret.",
    secret: false,
  },
  {
    key: "DATAFORDELER_OAUTH_CLIENT_SECRET",
    label: "Datafordeler OAuth Shared Secret",
    help: "Optional, together with the Client ID. Never an API key.",
    secret: true,
  },
  {
    key: "EMODATA_USER",
    label: "EMOData username",
    help: "Optional. Needs an agreement with Energistyrelsen (emoweb.dk). Unlocks energy labels.",
    secret: false,
  },
  {
    key: "EMODATA_PASSWORD",
    label: "EMOData password",
    help: "Optional, together with the EMOData username.",
    secret: true,
  },
  {
    key: "DATAFORSYNINGEN_TOKEN",
    label: "Dataforsyningen token",
    help: "dataforsyningen.dk → create a user → token. Used by get_aerial_photo.",
    secret: true,
  },
];

function prompt(question: string, secret: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    // Hide what is typed for secrets; readline has no public option for this.
    const internal = rl as unknown as { _writeToOutput: (text: string) => void };
    internal._writeToOutput = (text: string) => {
      if (!muted) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = secret;
  });
}

function printStatus(values: StoredCredentials): void {
  console.log(`Credentials file: ${credentialsPath()}`);
  for (const field of FIELDS) {
    const value = values[field.key];
    console.log(`  ${field.label.padEnd(26)} ${field.secret ? mask(value) : (value ?? "(ikke sat)")}`);
  }
  const fromEnv = FIELDS.filter((field) => process.env[field.key]?.trim()).map((field) => field.key);
  if (fromEnv.length) {
    console.log(`\nSet in this shell's environment, which overrides the file: ${fromEnv.join(", ")}`);
  }
}

export async function runSetup(args: string[]): Promise<void> {
  const current = readStoredCredentials();
  if (args.includes("--show")) {
    printStatus(current);
    return;
  }
  if (!process.stdin.isTTY) {
    console.error(
      "boligmcp setup needs an interactive terminal. Alternatively set the variables in your MCP client config, e.g.\n" +
        "  claude mcp add --scope user boligmcp -e DATAFORDELER_API_KEY=<your key> -- npx -y boligmcp",
    );
    process.exitCode = 1;
    return;
  }

  console.log("boligmcp setup\n");
  console.log("Use your own keys. They are saved only on this machine, readable by your user only,");
  console.log(`in ${credentialsPath()}.`);
  console.log("Press Enter to keep the current value, or type - to remove it.\n");

  // Only the fields the user types in change; everything else is re-read at save time,
  // so a value saved elsewhere while this prompt was open is never lost.
  const changes: StoredCredentials = {};
  const removed = new Set<CredentialKey>();
  for (const field of FIELDS) {
    console.log(`${field.label}\n  ${field.help}`);
    const shown = field.secret ? mask(current[field.key]) : (current[field.key] ?? "(ikke sat)");
    const answer = await prompt(`  Value [${shown}]: `, field.secret);
    if (answer === "-") {
      removed.add(field.key);
    } else if (answer) {
      changes[field.key] = answer;
      if (field.validate) {
        process.stdout.write("  Checking… ");
        const problem = await field.validate(answer);
        console.log(problem ?? "OK");
        // A key Datafordeleren refuses is never saved; network trouble is not held against it.
        if (problem && /\((401|403)\)/.test(problem)) {
          delete changes[field.key];
          console.log("  Not saved. The current value is kept.");
        }
      }
    }
    console.log("");
  }

  const next: StoredCredentials = { ...readStoredCredentials(), ...changes };
  if (changes.DATAFORDELER_OAUTH_CLIENT_ID || changes.DATAFORDELER_OAUTH_CLIENT_SECRET) {
    const id = next.DATAFORDELER_OAUTH_CLIENT_ID;
    const secret = next.DATAFORDELER_OAUTH_CLIENT_SECRET;
    if (id && secret) {
      process.stdout.write("Checking OAuth client… ");
      const problem = await checkOAuthClient(id, secret);
      console.log(problem ?? "OK (EJF data also needs Geodatastyrelsen's approval)");
      if (problem && /\(401\)/.test(problem)) {
        delete changes.DATAFORDELER_OAUTH_CLIENT_ID;
        delete changes.DATAFORDELER_OAUTH_CLIENT_SECRET;
        const stored = readStoredCredentials();
        next.DATAFORDELER_OAUTH_CLIENT_ID = stored.DATAFORDELER_OAUTH_CLIENT_ID;
        next.DATAFORDELER_OAUTH_CLIENT_SECRET = stored.DATAFORDELER_OAUTH_CLIENT_SECRET;
        console.log("OAuth values not saved. The current values are kept.");
      }
      console.log("");
    }
  }
  for (const key of removed) delete next[key];
  if (Object.keys(changes).length === 0 && removed.size === 0) {
    console.log("Nothing changed.\n");
    printStatus(next);
    return;
  }
  writeStoredCredentials(next);
  console.log("Saved.\n");
  printStatus(next);
  console.log("\nRestart your MCP client (or start a new session) so the server picks up the new values.");
  console.log("Claude Code, if not added yet:\n  claude mcp add --scope user boligmcp -- npx -y boligmcp");
}
