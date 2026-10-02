# Rules for agents working in this repo

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
