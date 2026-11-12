// lib/lead-magnets/public-text.ts
//
// WHAT A VISITOR READS ON A LEAD-MAGNET PAGE, as one text (wave 145, lane 145G). The SAME composition the human's publish
// scans for fair housing (lib/kernel/lead-magnets.ts publishLeadMagnet — name, thank-you line, headline, subhead, CTA, bullets,
// FAQ) is the version the AI draft's final personalization phase records (lib/lead-magnets/ai-draft.ts → distribution_finals),
// so the publication door can prove the page it activates is the version a person approved — or record the person's edit as its
// own. One composition, never two spellings of "the page's public words". Pure; no import of the kernel (no cycle).

export interface LeadMagnetPageCopy {
  name?: string | null
  thank_you_message?: string | null
  landing_content?: Record<string, unknown> | null
}

/** PURE. The page's public words in the publish gate's order (empty lines dropped). */
export function leadMagnetPublicText(row: LeadMagnetPageCopy | null | undefined): string {
  const lc = (row?.landing_content ?? {}) as Record<string, unknown>
  const faq = Array.isArray(lc.faq) ? (lc.faq as Array<{ question?: unknown; answer?: unknown }>) : []
  return [
    row?.name, row?.thank_you_message,
    lc.headline, lc.subhead, lc.cta, ...(Array.isArray(lc.bullets) ? lc.bullets : []), ...faq.flatMap((f) => [f?.question, f?.answer]),
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0).join("\n")
}
