/** UTF-8 read as Latin-1: "Ã¥" for "å", "Ã¸" for "ø", "Ã¦" for "æ". */
const MOJIBAKE = /[ÃÂ][\u0080-¿]/;

/**
 * Some municipalities upload plan texts that were already double-encoded ("OmrÃ¥de" for "Område").
 * Decodes them once more; text that does not decode cleanly is returned unchanged.
 */
export function repairMojibake(text: string): string {
  if (!MOJIBAKE.test(text)) return text;
  const repaired = Buffer.from(text, "latin1").toString("utf8");
  return repaired.includes("�") ? text : repaired;
}
