# Rules for agents working in this repo

## Setting Bolig-MCP up for a user

When the user wants to use Bolig-MCP rather than change it, guide them through these steps one at a time. Check each
step worked before the next, and explain what each key unlocks so they can skip what they do not need.

**Never ask for a key, token, password or secret in the chat, and never put one in a command, file or tool
argument yourself.** The user enters every credential in their own terminal with the setup command, which hides the
input and saves it to `~/.config/boligmcp/credentials.json`.

1. **Build.** Check that Node.js 20 or newer and pnpm are installed, then run `pnpm install` and `pnpm build` in the
   clone.
2. **Datafordeleren API key (free, required).** It unlocks addresses to BFE, BBR, valuations, cadastre,
   administrative areas, terrain, nearby services and CVR company data. The user creates a web user at
   [datafordeler.dk](https://datafordeler.dk), opens Selvbetjening, creates an IT-system and adds the
   authentication method **API-key** (not username/password). A new key can take 15 minutes to work.
3. **Optional keys.** Ask which they want:
   - **Dataforsyningen token (free):** aerial and oblique photos. Create a user at
     [dataforsyningen.dk](https://dataforsyningen.dk) and mint a token.
   - **Google Maps API key:** the 3D map. Needs a Google Cloud project with billing and the **Maps JavaScript API**
     enabled. Google's monthly free usage covers most people. If the key is restricted to websites, allow
     `http://127.0.0.1:47321/*`.
   - **EMOData login:** energy labels. Needs an agreement with Energistyrelsen, so most people skip it.
4. **Enter the keys.** Ask the user to run `node dist/index.js setup` in their own terminal, in the clone. It asks for
   each key with hidden input and checks the Datafordeleren key. `node dist/index.js setup --show` shows what is set,
   masked.
5. **Connect the client.** Use the full path to the clone:
   - Claude Code: `claude mcp add --scope user boligmcp -- node <clone>/dist/index.js`
   - Claude Desktop, Cursor and others: add
     `{ "mcpServers": { "boligmcp": { "command": "node", "args": ["<clone>/dist/index.js"] } } }` to the client's MCP
     config.

   Then restart the client or start a new session.
6. **Check.** Call `list_sources`: the configured sources show `configured: true`. Then try an address, e.g.
   "Lav en rapport om Egeskovvej 41, 8800 Viborg".
7. **Sale prices and company owners (optional, takes an application).** These come from Ejerfortegnelsen (EJF) and
   need the user's own approved access. It needs a CVR number and MitID Erhverv:
   1. In Datafordeler Selvbetjening, create an IT-system with **OAuth** authentication.
   2. In Datafordeler Administration, apply to Geodatastyrelsen with the form "Bilag Anmodning om adgang til
      Ejerfortegnelsen". Ask for `EJF_Ejerskifte` and `EJF_Handelsoplysninger` (sale prices), and for
      `CustomEjerskabBegraenset` as well if they want company owners. Never ask for `EJF_Ejerskab`: it carries CPR
      numbers and private actors are refused.
   3. Once approved, the user runs `node dist/index.js setup` again and enters the IT-system's **OAuth Client ID**
      and **Shared Secret** (not the API key).

   Until it is approved, `get_trades` and `get_owners` answer `requires_agreement`; everything else works.

Details and troubleshooting are in [docs/credentials.md](docs/credentials.md).

## Never query data about private people

Bolig-MCP shows public property data. It never reads names, CPR numbers or other details of private people, not
even to filter them out afterwards. This holds for code you add, scripts you write and queries you try out against
the live APIs.

Never query:

- `CVRPerson` in CVR. A person in CVR may be counted, never looked up.
- `EJF_Ejerskab`. It carries CPR numbers and is for public authorities. Owners come from
  `EJFCustom_EjerskabBegraenset`, and only `ejendeVirksomhedCVRNr`, `ejerforholdskode` and the share are read.
- `EJF_PersonVirksomhedsoplys`, `ejendePerson…` fields or owner details (`Ejeroplys…`).
- Any CPR or person number field.

`graphql()` in `src/sources/datafordeler/client.ts` refuses these before anything is sent (`assertNoPersonData`).
Do not weaken that check, and do not call Datafordeleren around it.

When you add a query or a tool:

1. Ask only for the fields the tool returns.
2. If it can return people as well as companies (an address in CVR, an owner in EJF), decide what it is from the
   entity type and drop people without looking them up.
3. Add a test that the query does not mention person data, as in `tests/cvr.test.ts` and `tests/ejf.test.ts`. If a new
   register has its own person entities, add them to `PERSON_DATA` and `tests/privacy.test.ts`.

## Only legal sources

Before adding a data source, check its terms and licence, and credit it wherever its data is shown.
