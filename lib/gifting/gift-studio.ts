/**
 * lib/gifting/gift-studio.ts
 *
 * THE GIFT STUDIO — "the AI knows the customer and chooses the gift"
 * (owner directive, EvaBot-inspired), with the unfair advantage no
 * gifting vendor has: WE HOLD THE DEAL. The best-converting real-estate
 * closing gifts are personalized to THE HOUSE (custom home-portrait
 * cutting boards, engraved address signs, house-portrait prints — the
 * whole closinggiftco/blackwood/realtyremembered category), and the OS
 * already knows the address, the close date, the family name, and the
 * persona. So the studio arrives with the ENGRAVING LINE ALREADY
 * WRITTEN — selection AND ordering inside one command-center window;
 * the only external hop is the final purchase click on a search
 * pre-scoped to the exact personalized item.
 *
 * PURE composer over a curated archetype catalog (deterministic — the
 * catalog is real-estate gifting domain knowledge, not scraped noise):
 * each selection carries WHY-THIS-FITS evidence from the contact's real
 * facts, the prefilled personalization payload, and the shoppable
 * search for that exact configured item. Dedupe vs past gifts (never
 * the same archetype twice for one client). NOT server-only.
 */

import { composeShoppableLinks } from "./shoppable-links"

export interface GiftFacts {
  occasion: "closing" | "anniversary" | "birthday" | "referral_thank_you" | "holiday" | "congratulations"
  familyName: string | null
  firstNames: string | null
  /** THE differentiator — the home the deal closed on. */
  homeAddress: string | null
  closeYear: number | null
  persona: string | null
  budgetMax: number | null
  /** archetype keys already gifted to this contact (dedupe). */
  pastGiftKeys: string[]
}

interface GiftArchetype {
  key: string
  title: string
  priceBand: [number, number]
  /** personalization the OS prefills — the studio's magic moment. */
  personalize: (f: GiftFacts) => string | null
  /** the buy search for the exact configured item. */
  searchQuery: (f: GiftFacts) => string
  occasions: GiftFacts["occasion"][]
  needsAddress: boolean
  fits: (f: GiftFacts) => string | null
}

const engravingLine = (f: GiftFacts): string | null => {
  const who = f.familyName ? `The ${f.familyName} Family` : f.firstNames
  const bits = [who, f.homeAddress, f.closeYear ? `Est. ${f.closeYear}` : null].filter(Boolean)
  return bits.length >= 2 ? bits.join(" · ") : null
}

const CATALOG: GiftArchetype[] = [
  {
    key: "home_portrait_cutting_board",
    title: "Custom home-portrait cutting board (engraved from a photo of their house)",
    priceBand: [45, 120],
    personalize: engravingLine,
    searchQuery: () => "custom home portrait cutting board engraved house",
    occasions: ["closing", "anniversary"],
    needsAddress: true,
    fits: (f) => f.homeAddress ? `Their home at ${f.homeAddress} becomes the artwork — the category's highest-keep-rate closing gift.` : null,
  },
  {
    key: "engraved_address_sign",
    title: "Engraved address establishment sign",
    priceBand: [40, 110],
    personalize: engravingLine,
    searchQuery: () => "personalized address sign established family wood",
    occasions: ["closing", "anniversary"],
    needsAddress: true,
    fits: (f) => f.homeAddress ? `Address + established year on the wall — a daily reminder of the day you handed them keys.` : null,
  },
  {
    key: "house_portrait_print",
    title: "Watercolor house-portrait print (from the listing photo)",
    priceBand: [35, 150],
    personalize: (f) => f.homeAddress ? `Portrait of ${f.homeAddress}${f.closeYear ? `, ${f.closeYear}` : ""}` : null,
    searchQuery: () => "custom watercolor house portrait from photo",
    occasions: ["closing", "anniversary"],
    needsAddress: true,
    fits: (f) => f.homeAddress ? `The listing photo you already have becomes a framed heirloom.` : null,
  },
  {
    key: "custom_doormat",
    title: "Personalized family doormat",
    priceBand: [25, 60],
    personalize: (f) => f.familyName ? `The ${f.familyName}s` : null,
    searchQuery: () => "personalized family name doormat housewarming",
    occasions: ["closing", "congratulations"],
    needsAddress: false,
    fits: (f) => f.familyName ? `First thing every guest sees — name on the door from day one.` : null,
  },
  {
    key: "local_gourmet_basket",
    title: "Local gourmet welcome basket",
    priceBand: [50, 150],
    personalize: (f) => f.firstNames ? `Welcome home, ${f.firstNames}!` : "Welcome home!",
    searchQuery: () => "local gourmet gift basket housewarming",
    occasions: ["closing", "holiday", "referral_thank_you", "birthday"],
    needsAddress: false,
    fits: () => `Universally right when the personal-item angle is thin — local beats generic.`,
  },
  {
    key: "engraved_keepsake_keychain",
    title: "Engraved 'first home' key keepsake",
    priceBand: [15, 45],
    personalize: (f) => f.closeYear && f.homeAddress ? `${f.homeAddress} · ${f.closeYear}` : null,
    searchQuery: () => "first home keychain engraved keepsake closing gift",
    occasions: ["closing", "congratulations"],
    needsAddress: true,
    fits: (f) => (f.persona ?? "").includes("first") ? `A first-time buyer's first key deserves a keepsake — small price, huge sentiment.` : null,
  },
]

export interface GiftSelection {
  key: string
  title: string
  whyThisFits: string
  /** the prefilled engraving/portrait line — copy-paste ready. */
  personalization: string | null
  priceBand: [number, number]
  etsyUrl: string
  amazonUrl: string
}

/** PURE: the AI-knows-the-customer selections — evidence-backed, address-
 *  personalized when the deal gives us the address, deduped vs past gifts,
 *  budget-respecting, best-fit first. Empty facts → the honest generic. */
export function composeGiftSelections(f: GiftFacts, limit = 3): GiftSelection[] {
  const out: GiftSelection[] = []
  for (const a of CATALOG) {
    if (!a.occasions.includes(f.occasion)) continue
    if (f.pastGiftKeys.includes(a.key)) continue
    if (a.needsAddress && !f.homeAddress) continue
    if (f.budgetMax != null && a.priceBand[0] > f.budgetMax) continue
    const fitLine = a.fits(f)
    if (!fitLine) continue
    const links = composeShoppableLinks(a.searchQuery(f), { budgetMax: f.budgetMax ?? a.priceBand[1] })
    out.push({
      key: a.key,
      title: a.title,
      whyThisFits: fitLine,
      personalization: a.personalize(f),
      priceBand: a.priceBand,
      etsyUrl: links.etsy,
      amazonUrl: links.amazon,
    })
  }
  // Personalized picks first (the studio's differentiator); WITHIN each
  // group the CATALOG order stands — it's authored flagship-first (the
  // home-portrait category leads; keepsakes are the budget tail).
  out.sort((x, y) => Number(!!y.personalization) - Number(!!x.personalization))
  return out.slice(0, limit)
}
