// lib/branding/platform-rights-notice.ts
//
// THE PLATFORM'S COPYRIGHT + LICENSING NOTICE (wave 144, lane 144H; owner ruling 18: "copyright/licensing prohibitions for
// this platform must be DISPLAYED (notice/terms) so no one can copy it"). PURE — the ONE text, rendered by app/legal/page.tsx.
//
// WHAT THIS IS, AND WHAT IT IS NOT. Standard rights language only: a copyright line, "all rights reserved", that access is
// licensed under the customer's agreement, and the ordinary prohibitions (copy, modify, reverse engineer, scrape, frame,
// resell, build a competitor). It deliberately makes NO claim the platform has not established: no registration number, no
// patent, no trademark registration, no designated copyright agent, no statement of damages or penalties, no statement about
// who owns what a customer uploads (that is the customer agreement's job). The holder's name is the platform's product brand
// (platform_settings.product_brand.name) until the owner records the legal entity name — WAITING_EXTERNAL (owner input).
// A lawyer should review the final wording before public release; this notice displays rights, it does not create them.

export const PLATFORM_RIGHTS_NOTICE_VERSION = "2026-10-25"

export interface PlatformRightsNotice {
  version: string
  title: string
  copyrightLine: string
  intro: string[]
  /** What nobody may do without a written agreement — the prohibition the owner asked to be displayed. */
  prohibited: string[]
  closing: string[]
  /** One line for a footer: the copyright line plus the prohibition in brief, pointing at the full notice. */
  footerLine: string
}

/** PURE. The notice for `holder` (the platform's name) and `product`, in `year`. */
export function platformRightsNotice(input: { holder: string; product?: string | null; year: number; noticePath?: string }): PlatformRightsNotice {
  const holder = (input.holder ?? "").trim() || "the platform owner"
  const product = (input.product ?? "").trim() || holder
  const path = input.noticePath ?? "/legal"
  const copyrightLine = `© ${input.year} ${holder}. All rights reserved.`
  return {
    version: PLATFORM_RIGHTS_NOTICE_VERSION,
    title: "Copyright and licensing notice",
    copyrightLine,
    intro: [
      `The ${product} platform — its software and source code, its interface and visual design, its workflows, text, graphics, templates and other content — is owned by ${holder} or its licensors and is protected by copyright and other intellectual-property laws.`,
      `Access to the platform is licensed, not sold. What you may do with it is set by your subscription agreement and the Terms of Service; nothing on this site grants any other right or licence, by implication or otherwise.`,
    ],
    prohibited: [
      "copy, reproduce, republish or redistribute any part of the platform;",
      "modify, translate or create derivative works of the platform or its content;",
      "reverse engineer, decompile or disassemble the platform's software, except to the extent applicable law expressly permits it despite this restriction;",
      "scrape, crawl, harvest or extract the platform's content, interface or data by automated means;",
      "frame or mirror the platform, or remove or obscure any copyright or proprietary notice in it;",
      "resell, sublicense, rent, lend or otherwise make the platform available to anyone else;",
      "use the platform, or anything learned from accessing it, to build a competing product or service.",
    ],
    closing: [
      `This notice concerns the platform itself. Material that you or your brokerage upload — listings, documents, form packets, brand assets — is governed by your agreement with ${holder} and is not claimed by this notice.`,
      `Permission for any use beyond your agreement must be given in writing by ${holder}.`,
    ],
    footerLine: `${copyrightLine} Copying, scraping, reverse engineering or reselling any part of this platform without written permission is prohibited — see ${path}.`,
  }
}
