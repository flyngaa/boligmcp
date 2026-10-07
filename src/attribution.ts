import type { SourceId } from "./types.js";

/**
 * Credit for every source, added to each ok result. The licences require crediting the register wherever its data is
 * shown (see "Data sources and licences" in the README, verified 4 October 2026).
 */
export const ATTRIBUTION: Record<SourceId, string> = {
  adressevaelger: "Kilde: Danmarks Adresseregister (DAR), Klimadatastyrelsen (CC BY 4.0)",
  dar: "Kilde: Danmarks Adresseregister (DAR), Klimadatastyrelsen (CC BY 4.0)",
  ebr: "Kilde: Ejendomsbeliggenhedsregistret (EBR), Geodatastyrelsen (CC BY 4.0)",
  matrikel: "Kilde: Matriklen, Geodatastyrelsen (CC BY 4.0)",
  bbr: "Kilde: Bygnings- og Boligregistret (BBR) (CC BY 4.0)",
  dagi: "Kilde: Danmarks Administrative Geografiske Inddeling (DAGI), Klimadatastyrelsen (CC BY 4.0)",
  vur: "Kilde: Ejendomsvurdering, Vurderingsstyrelsen (CC BY 4.0)",
  ejf: "Kilde: Ejerfortegnelsen, Geodatastyrelsen (CC BY 4.0)",
  plandata: "Kilde: Plandata.dk, Erhvervsstyrelsen",
  miljoportal:
    "Kilde: Danmarks Miljøportal og Plandata.dk. Indeholder data, som benyttes i henhold til vilkår for brug af danske offentlige data",
  dst: "Kilde: Danmarks Statistik, statistikbanken.dk (CC BY 4.0)",
  dhm: "Kilde: Danmarks Højdemodel (DHM), Klimadatastyrelsen (CC BY 4.0)",
  geodanmark: "Kilde: GeoDanmark, Klimadatastyrelsen (CC BY 4.0)",
  emodata: "Kilde: Energimærkning, Energistyrelsen (EMOData)",
  dataforsyningen: "Ortofoto: GeoDanmark. Skråfoto: Klimadatastyrelsen (CC BY 4.0)",
  fbb: "Kilde: Fredede og bevaringsværdige bygninger (FBB), Slots- og Kulturstyrelsen",
  cvr: "Kilde: Det Centrale Virksomhedsregister (CVR), Erhvervsstyrelsen (CC BY 4.0)",
  google_maps: "Kort: Google",
};
