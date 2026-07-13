/**
 * lib/gifting/gift-studio.ts
 *
 * THE GIFT STUDIO — "the AI knows the customer and chooses the gift"
 * (owner directive, EvaBot-inspired), with the unfair advantage no
 * gifting vendor has: WE HOLD THE DEAL AND THE MEMORY. The deal gives us
 * the address, close date, and family name (the home-portrait category:
 * cutting boards, address signs, house prints). The CRM's memory —
 * contacts.tags, notes, occupation, ai_insights, life_events — gives us
 * the person: the dog, the garden, the book club, the new baby. Per the
 * service manifesto ("deep memory and personalization — every suggestion
 * feels individually relevant, not generic"), gifts are NOT limited to
 * the house category: memory-grounded picks carry a memoryHook (the
 * remembered fact that earned the pick) and outrank category defaults.
 * Selection AND ordering stay inside one command-center window; the only
 * external hop is the final purchase click on a search pre-scoped to the
 * exact personalized item.
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
  /** normalized interest keys mined from the file's memory (mineGiftInterests). */
  interests: string[]
  /** normalized recent life-event keys (mineLifeEvents): new_baby, marriage, retirement. */
  lifeEvents: string[]
}

/** Curated interest families — ONLY families a catalog archetype can serve
 *  (an interest nothing can act on is noise, not memory). Regexes run
 *  against the lowercased concatenation of tags/notes/occupation/insights. */
const INTEREST_FAMILIES: Array<{ key: string; pattern: RegExp }> = [
  { key: "pet", pattern: /\b(dog|dogs|puppy|puppies|cat\b|cats\b|kitten|pet\b|pets\b|doodle|retriever|labrador|terrier|rescue animal)/ },
  { key: "kids", pattern: /\b(kid\b|kids\b|children|child\b|toddler|teenager|daughter|son\b|sons\b|grandkid)/ },
  { key: "garden", pattern: /\b(garden|landscap|greenhouse|houseplant|orchid|succulent)/ },
  { key: "wine", pattern: /\b(wine|winery|vineyard|sommelier)/ },
  { key: "coffee", pattern: /\b(coffee|espresso|barista|latte)/ },
  { key: "tea", pattern: /\b(tea\b|teas\b|matcha|chai\b)/ },
  { key: "books", pattern: /\b(book\b|books\b|reading|reader|book club|novel|literature)/ },
  { key: "grilling", pattern: /\b(grill|bbq|barbecue|smoker)/ },
  { key: "golf", pattern: /\b(golf)/ },
  { key: "wellness", pattern: /\b(yoga|spa\b|wellness|meditat|pilates|self-care|massage)/ },
]

/** PURE: mine normalized interest keys from the contact's remembered facts.
 *  Word-boundary anchored so "joined the team" never becomes "tea". */
export function mineGiftInterests(raw: {
  tags?: string[] | null
  notes?: string | null
  occupation?: string | null
  aiInsights?: string | null
  contactType?: string | null
}): string[] {
  const hay = [
    ...(Array.isArray(raw.tags) ? raw.tags : []),
    raw.notes ?? "", raw.occupation ?? "", raw.aiInsights ?? "", raw.contactType ?? "",
  ].join(" ").toLowerCase()
  return INTEREST_FAMILIES.filter((fam) => fam.pattern.test(hay)).map((fam) => fam.key)
}

/** PURE: normalize contacts.life_events (jsonb array of objects or strings,
 *  or a bare string) into the event keys the catalog can act on. */
export function mineLifeEvents(raw: unknown): string[] {
  const texts: string[] = []
  if (Array.isArray(raw)) for (const e of raw) texts.push(typeof e === "string" ? e : JSON.stringify(e ?? ""))
  else if (raw != null) texts.push(typeof raw === "string" ? raw : JSON.stringify(raw))
  const hay = texts.join(" ").toLowerCase()
  const out: string[] = []
  if (/\b(baby|birth|newborn|expecting|pregnan)/.test(hay)) out.push("new_baby")
  if (/\b(marri|wedding|engag|newlywed)/.test(hay)) out.push("marriage")
  if (/\bretir/.test(hay)) out.push("retirement")
  return out
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
  /** MEMORY GATE: the remembered fact (interest/life-event key) that earns
   *  this pick — null skips the archetype. Omit for universal archetypes. */
  hook?: (f: GiftFacts) => string | null
  fits: (f: GiftFacts) => string | null
}

const who = (f: GiftFacts): string | null =>
  f.familyName ? `The ${f.familyName} Family` : f.firstNames

const engravingLine = (f: GiftFacts): string | null => {
  const bits = [who(f), f.homeAddress, f.closeYear ? `Est. ${f.closeYear}` : null].filter(Boolean)
  return bits.length >= 2 ? bits.join(" · ") : null
}

/** engraving without the address — for keepsakes where the moment, not the
 *  house, is the subject (wine box, newlywed sign, retirement gift). */
const celebrationLine = (f: GiftFacts): string | null => {
  const bits = [who(f), f.closeYear ? `Est. ${f.closeYear}` : null].filter(Boolean)
  return bits.length >= 2 ? bits.join(" · ") : null
}

const interestHit = (f: GiftFacts, ...keys: string[]): string | null =>
  keys.find((k) => f.interests.includes(k)) ?? null
const eventHit = (f: GiftFacts, key: string): string | null =>
  f.lifeEvents.includes(key) ? key : null

const CATALOG: GiftArchetype[] = [
  // ————— THE DEAL: house-personalized flagships (the OS holds the address) —————
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
    key: "engraved_keepsake_keychain",
    title: "Engraved 'first home' key keepsake",
    priceBand: [15, 45],
    personalize: (f) => f.closeYear && f.homeAddress ? `${f.homeAddress} · ${f.closeYear}` : null,
    searchQuery: () => "first home keychain engraved keepsake closing gift",
    occasions: ["closing", "congratulations"],
    needsAddress: true,
    fits: (f) => (f.persona ?? "").includes("first") ? `A first-time buyer's first key deserves a keepsake — small price, huge sentiment.` : null,
  },
  // ————— THE MEMORY: interest-grounded picks (the file remembers who they are) —————
  {
    key: "custom_pet_portrait",
    title: "Custom pet portrait (their dog or cat, illustrated from a photo)",
    priceBand: [30, 90],
    personalize: () => null,
    searchQuery: () => "custom pet portrait from photo illustrated",
    occasions: ["closing", "birthday", "holiday", "congratulations"],
    needsAddress: false,
    hook: (f) => interestHit(f, "pet"),
    fits: () => `The file remembers a pet in the household — a portrait of the four-legged family member says "we see the whole family."`,
  },
  {
    key: "family_game_night_basket",
    title: "Family game-night basket (games + treats in an engraved crate)",
    priceBand: [40, 90],
    personalize: (f) => f.familyName ? `The ${f.familyName} Family Game Night` : null,
    searchQuery: () => "family game night gift basket personalized crate",
    occasions: ["closing", "holiday", "congratulations"],
    needsAddress: false,
    hook: (f) => interestHit(f, "kids"),
    fits: () => `Kids in the story — make the first night in the new place a game night they'll remember.`,
  },
  {
    key: "garden_welcome_kit",
    title: "Garden welcome kit (engraved marker + heirloom herb starter)",
    priceBand: [30, 80],
    personalize: (f) => f.familyName ? `The ${f.familyName} Garden` : null,
    searchQuery: () => "personalized garden marker herb garden starter kit",
    occasions: ["closing", "anniversary", "birthday"],
    needsAddress: false,
    hook: (f) => interestHit(f, "garden"),
    fits: () => `They talked about the garden — help them put down literal roots at the new place.`,
  },
  {
    key: "wine_celebration_set",
    title: "Engraved wine box with a bottle for the milestone",
    priceBand: [40, 110],
    personalize: celebrationLine,
    searchQuery: () => "personalized wine box engraved housewarming gift",
    occasions: ["closing", "anniversary", "holiday", "referral_thank_you"],
    needsAddress: false,
    hook: (f) => interestHit(f, "wine"),
    fits: () => `Wine is in their story — an engraved box marks the milestone and keeps their name on the shelf.`,
  },
  {
    key: "morning_ritual_set",
    title: "Morning-ritual set (their coffee or tea, with a personalized mug)",
    priceBand: [25, 70],
    personalize: (f) => f.firstNames ? `Mug engraving: ${f.firstNames}` : null,
    searchQuery: (f) => interestHit(f, "tea") === "tea"
      ? "personalized mug artisan tea sampler gift set"
      : "personalized mug local roaster coffee sampler gift",
    occasions: ["closing", "birthday", "holiday", "referral_thank_you"],
    needsAddress: false,
    hook: (f) => interestHit(f, "coffee", "tea"),
    fits: (f) => `Their ${interestHit(f, "tea") === "tea" ? "tea" : "coffee"} ritual is in the file — the first quiet morning in the new place, covered.`,
  },
  {
    key: "book_lovers_embosser",
    title: "Personalized library embosser (from-the-library-of stamp)",
    priceBand: [25, 60],
    personalize: (f) => who(f) ? `From the library of ${who(f)}` : null,
    searchQuery: () => "personalized book embosser library stamp",
    occasions: ["closing", "birthday", "holiday"],
    needsAddress: false,
    hook: (f) => interestHit(f, "books"),
    fits: () => `A reader's shelves move with them — every book in the new house gets their name in it.`,
  },
  {
    key: "grill_master_set",
    title: "Engraved grill set (tools with their name on the handle)",
    priceBand: [35, 100],
    personalize: (f) => f.familyName ? `The ${f.familyName} Grill` : null,
    searchQuery: () => "engraved bbq grill tool set personalized",
    occasions: ["closing", "birthday", "holiday", "congratulations"],
    needsAddress: false,
    hook: (f) => interestHit(f, "grilling"),
    fits: () => `The grill came up — christen the new backyard with their name on the tools.`,
  },
  {
    key: "golf_thank_you_set",
    title: "Monogrammed golf balls + towel set",
    priceBand: [25, 60],
    personalize: (f) => f.firstNames ? `Monogram for ${f.firstNames}` : null,
    searchQuery: () => "personalized golf balls monogram gift set",
    occasions: ["referral_thank_you", "birthday", "holiday"],
    needsAddress: false,
    hook: (f) => interestHit(f, "golf"),
    fits: () => `Golf is in their story — the thank-you that comes out of the bag every weekend.`,
  },
  {
    key: "spa_reset_box",
    title: "Spa reset box (self-care after the move)",
    priceBand: [35, 90],
    personalize: (f) => f.firstNames ? `Card: "${f.firstNames} — breathe. You're home."` : null,
    searchQuery: () => "spa gift box self care personalized",
    occasions: ["closing", "birthday", "referral_thank_you", "holiday", "congratulations"],
    needsAddress: false,
    hook: (f) => interestHit(f, "wellness"),
    fits: () => `Wellness is in their file — moving is the stress; this is the exhale.`,
  },
  // ————— THE MOMENT: life-event picks (the file remembers what just changed) —————
  {
    key: "new_baby_keepsake",
    title: "New-baby keepsake (nursery print or milestone blanket)",
    priceBand: [30, 80],
    personalize: (f) => f.familyName ? `The ${f.familyName} Family, plus one` : null,
    searchQuery: () => "new baby keepsake gift personalized nursery",
    occasions: ["congratulations", "closing", "holiday"],
    needsAddress: false,
    hook: (f) => eventHit(f, "new_baby"),
    fits: () => `The file remembers a new baby — two new beginnings deserve one thoughtful gift.`,
  },
  {
    key: "newlywed_keepsake",
    title: "Engraved newlywed keepsake sign",
    priceBand: [30, 90],
    personalize: celebrationLine,
    searchQuery: () => "personalized newlywed gift engraved sign",
    occasions: ["congratulations", "closing", "anniversary"],
    needsAddress: false,
    hook: (f) => eventHit(f, "marriage"),
    fits: () => `A wedding is in their story — first home, new name, one keepsake that marks both.`,
  },
  {
    key: "retirement_next_chapter",
    title: "Engraved 'next chapter' retirement keepsake",
    priceBand: [30, 80],
    personalize: (f) => who(f) ? `${who(f)} · The Next Chapter` : null,
    searchQuery: () => "retirement gift personalized engraved keepsake",
    occasions: ["congratulations", "closing"],
    needsAddress: false,
    hook: (f) => eventHit(f, "retirement"),
    fits: () => `Retirement is in their story — this move is the next chapter, and the gift should say so.`,
  },
  // ————— THE UNIVERSALS: honest fallbacks when the personal angle is thin —————
  {
    key: "cozy_monogram_throw",
    title: "Monogrammed throw blanket",
    priceBand: [30, 80],
    personalize: (f) => f.familyName ? `Monogram: ${f.familyName[0]!.toUpperCase()}` : null,
    searchQuery: () => "monogrammed throw blanket personalized gift",
    occasions: ["closing", "anniversary", "birthday", "holiday"],
    needsAddress: false,
    fits: () => `The classic that always lands — a monogram makes the new house feel like theirs.`,
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
]

export interface GiftSelection {
  key: string
  title: string
  whyThisFits: string
  /** the remembered fact (interest/life-event) that earned this pick — the
   *  manifesto's "I see you" made visible. Null for deal/universal picks. */
  memoryHook: string | null
  /** the prefilled engraving/portrait line — copy-paste ready. */
  personalization: string | null
  priceBand: [number, number]
  etsyUrl: string
  amazonUrl: string
}

/** PURE: the AI-knows-the-customer selections — evidence-backed, memory-
 *  grounded picks first (the file's remembered interests and life events),
 *  address-personalized when the deal gives us the address, deduped vs past
 *  gifts, budget-respecting. Empty facts → the honest generic. */
export function composeGiftSelections(f: GiftFacts, limit = 3): GiftSelection[] {
  const out: GiftSelection[] = []
  for (const a of CATALOG) {
    if (!a.occasions.includes(f.occasion)) continue
    if (f.pastGiftKeys.includes(a.key)) continue
    if (a.needsAddress && !f.homeAddress) continue
    if (f.budgetMax != null && a.priceBand[0] > f.budgetMax) continue
    let memoryHook: string | null = null
    if (a.hook) {
      memoryHook = a.hook(f)
      if (!memoryHook) continue
    }
    const fitLine = a.fits(f)
    if (!fitLine) continue
    const links = composeShoppableLinks(a.searchQuery(f), { budgetMax: f.budgetMax ?? a.priceBand[1] })
    out.push({
      key: a.key,
      title: a.title,
      whyThisFits: fitLine,
      memoryHook,
      personalization: a.personalize(f),
      priceBand: a.priceBand,
      etsyUrl: links.etsy,
      amazonUrl: links.amazon,
    })
  }
  // Memory-grounded picks lead (the manifesto's "individually relevant, not
  // generic"), then personalized, then universal; WITHIN each score the
  // CATALOG order stands — it's authored flagship-first per section.
  const score = (s: GiftSelection) => (s.memoryHook ? 2 : 0) + (s.personalization ? 1 : 0)
  out.sort((x, y) => score(y) - score(x))
  return out.slice(0, limit)
}
