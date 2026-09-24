import { getConfig } from "../src/config.js";

const REGISTERS = ["DAR/3.0.0", "BBR/3.0.0", "MAT/3.0.0", "DAGI/3.0.0", "EJF/3.0.0", "VUR/1.0.0"];

const INTROSPECTION = `
  query {
    __schema {
      queryType {
        fields { name }
      }
    }
  }
`;

async function main(): Promise<void> {
  const key = getConfig().datafordelerApiKey;
  if (!key) {
    console.error("Set DATAFORDELER_API_KEY first.");
    process.exit(1);
  }
  for (const register of REGISTERS) {
    const url = `https://graphql.datafordeler.dk/${register}?apiKey=${encodeURIComponent(key)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: INTROSPECTION }),
    });
    const json = (await response.json()) as { data?: { __schema?: { queryType?: { fields?: Array<{ name: string }> } } }; errors?: unknown };
    const names = json.data?.__schema?.queryType?.fields?.map((field) => field.name) ?? [];
    console.log(`\n## ${register} (${response.status})`);
    console.log(names.join("\n") || JSON.stringify(json.errors ?? json, null, 2));
  }
}

void main();
