/**
 * lib/direct-mail/piece-type.ts
 *
 * THE ONE piece_type VOCABULARY for direct_mail_campaigns (CLAUDE.md §6).
 *
 * The column has no CHECK. Its readers compare against these literals:
 *   - app/api/cron/letter-audio-renderer drains `piece_type = 'letter'`
 *   - app/actions/campaign-bundles.ts and lib/agents/marketing-agent-actions.ts branch on
 *     `'postcard'` / `'letter'`
 *   - app/actions/ai-direct-mail.ts DirectMailPieceType declared the four below as "matches
 *     the piece_type column"
 * The voice webhook (lib/elevenlabs/conv-ai.ts tool schema) and the copilot tool
 * (app/api/internal/ai-chat) speak a second vocabulary: postcard_4x6 | postcard_6x9 |
 * postcard_6x11 | letter | handwritten | thank_you_note. Those spellings used to flow into
 * the column as-is (content-staging passed `pieceType as never`), so a spoken "letter" was
 * the only piece a reader could ever match. Every writer now folds through
 * canonicalCampaignPieceType, and the size is a print detail the campaign row does not
 * carry (direct_mail_presets.postcard_size is where a size lives).
 *
 * Client-safe: no STATIC imports. Wave 150 (lane 150R): the format router below shares this module — the
 * campaign's piece vocabulary and the PRINT format it mails as are one vocabulary family (§6).
 */

export const CAMPAIGN_PIECE_TYPES = ["postcard", "letter", "handwritten_letter", "thank_you_note"] as const
export type CampaignPieceType = (typeof CAMPAIGN_PIECE_TYPES)[number]

/** Fold any spoken or typed piece spelling onto the one column vocabulary. Unknown → null
 *  (the caller decides the default, and says so). */
export function canonicalCampaignPieceType(raw: string | null | undefined): CampaignPieceType | null {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!v) return null
  if ((CAMPAIGN_PIECE_TYPES as readonly string[]).includes(v)) return v as CampaignPieceType
  if (v.startsWith("postcard")) return "postcard"
  if (v === "handwritten" || v === "handwritten_note") return "handwritten_letter"
  if (v === "thank_you" || v === "thankyou_note" || v === "thank_you_card") return "thank_you_note"
  return null
}

/**
 * ─── THE ONE DIRECT-MAIL FORMAT ROUTER (wave 150, lane 150R; owner ruling R5, contract C40).
 *
 * Owner ruling (2026-11-06): Lob stays the default. The letter, the personal letter (a personal-note
 * DESIGN), the postcard FRONT and the postcard BACK are DISTINCT Lob template ids, held by NAME only:
 *
 *     LOB_LETTER_TEMPLATE_ID · LOB_PERSONAL_LETTER_TEMPLATE_ID
 *     LOB_POSTCARD_FRONT_TEMPLATE_ID · LOB_POSTCARD_BACK_TEMPLATE_ID
 *     (+ optional LOB_HANDWRITTEN_CARD_PROVIDER — the NAME of a genuine-handwriting provider)
 *
 * A small number of GLOBAL format templates; everything tenant / sending-user / office specific
 * (logo, front/back art, fonts, pictures, return address, legal brokerage identity, tagline, QR
 * destination, disclosures) is resolved at proof time from the ONE brand cascade
 * (lib/branding/resolve-brand-context.ts resolveBrandContext) and passed as Lob `merge_variables`
 * and hosted asset URLs. Per-tenant customisation is DATA, never a per-tenant template.
 *
 * What this module decides (deterministically — no vendor call is made to decide):
 *   1. which Lob template id(s) a format mails with, REFUSING two formats that share one id and a
 *      format with none (`lobTemplatesForFormat`);
 *   2. the honest name of a format — a typeface is never called handwriting; a genuine handwritten
 *      card exists only through a handwriting provider, which is DORMANT until rights + price proof
 *      (`routeMailFormat`, OPTIONAL_MAIL_PROVIDERS);
 *   3. what a Lob tracking event proves — a carrier scan is never household receipt
 *      (`mailOutcomeFromLobEvent`);
 *   4. the brand merge variables (`buildMailMergeVariables`, pure; `readMailBrandFacts`,
 *      the async reader over the cascade);
 *   5. the at-most-once key one mail piece is dispatched under (`mailPieceIdempotencyKey`) — the
 *      action ledger (lib/kernel/action-ledger.ts) refuses a second claim, so a retried send is never
 *      a second charge.
 *
 * Callers: app/actions/direct-mail.ts (sendCampaign, trackDelivery), app/actions/reputation-kernel.ts
 * (the card), lib/direct-mail/orchestrate-send.ts / orchestrate-preset-send.ts / campaign-drain.ts /
 * listing-lifecycle-mail-reactor.ts (the fallback template). Proof: scripts/direct-mail-formats-guard.ts.
 *
 * Folded INTO this module (not a new file) to hold app/crm/page.tsx at the 1300-module budget
 * (test:proxy-graph-budget). Still no static imports: the async brand reader imports its server readers lazily.
 */

// ─── 1. Formats and the Lob template slots ────────────────────────────────────

const MAIL_FORMATS = ["letter", "personal_letter", "postcard", "handwritten_card"] as const
export type MailFormat = (typeof MAIL_FORMATS)[number]

export type LobTemplateSlot = "letter" | "personal_letter" | "postcard_front" | "postcard_back"

/**
 * The env NAME (never a value) per slot. `legacy` names are the spellings that were configured before
 * R5 (operations-docs-data.ts ENV_META) — read AFTER the canonical name so nothing already configured
 * goes dark, and recorded with `legacy: true` in the provenance so the burn-down is visible (§6: one
 * vocabulary — the canonical name is the survivor; the legacy names are read, never written).
 */
export const LOB_TEMPLATE_ENV: Readonly<Record<LobTemplateSlot, { name: string; legacy: readonly string[] }>> = {
  letter:          { name: "LOB_LETTER_TEMPLATE_ID",          legacy: ["LOB_DEFAULT_LETTER_TEMPLATE_ID"] },
  personal_letter: { name: "LOB_PERSONAL_LETTER_TEMPLATE_ID", legacy: [] },
  postcard_front:  { name: "LOB_POSTCARD_FRONT_TEMPLATE_ID",  legacy: ["LOB_POSTCARD_FRONT_ID", "LOB_NOTECARD_ID", "LOB_DEFAULT_TEMPLATE_ID"] },
  postcard_back:   { name: "LOB_POSTCARD_BACK_TEMPLATE_ID",   legacy: ["LOB_POSTCARD_BACK_ID"] },
}

/** The env NAME of the optional genuine-handwriting provider (handwrytten | lettrlabs; see OPTIONAL_MAIL_PROVIDERS). */
export const HANDWRITTEN_CARD_PROVIDER_ENV = "LOB_HANDWRITTEN_CARD_PROVIDER"

/** Which slots a format prints with. */
const FORMAT_SLOTS: Readonly<Record<Exclude<MailFormat, "handwritten_card">, readonly LobTemplateSlot[]>> = {
  letter:          ["letter"],
  personal_letter: ["personal_letter"],
  postcard:        ["postcard_front", "postcard_back"],
}

/** Lob piece type per format (the dispatcher's vocabulary, lib/providers/dispatch.ts DirectMailPieceType). */
const FORMAT_PIECE_TYPE: Readonly<Record<Exclude<MailFormat, "handwritten_card">, "letter" | "postcard">> = {
  letter: "letter", personal_letter: "letter", postcard: "postcard",
}

/**
 * The honest name of each format. A personal letter is PRINTED: its note is set in a personal-note
 * typeface, and the word "handwritten" is reserved for a card a person or a pen robot actually writes
 * (owner ruling R5: "a font is never called handwriting").
 */
export const MAIL_FORMAT_LABELS: Readonly<Record<MailFormat, string>> = {
  letter:           "Letter (printed, in an envelope)",
  personal_letter:  "Personal note (printed letter in an envelope, set in a personal-note typeface)",
  postcard:         "Postcard (printed front and back)",
  handwritten_card: "Handwritten card (written with a pen by a handwriting provider)",
}

type Env = Readonly<Record<string, string | undefined>>

interface ResolvedSlot {
  id: string | null
  /** The env NAME the id was read from (never the value's source text). */
  envName: string | null
  legacy: boolean
}

interface ResolvedLobTemplates {
  slots: Record<LobTemplateSlot, ResolvedSlot>
  /** Every id configured on two or more slots — each is a refusal for every format it touches. */
  aliases: Array<{ id: string; slots: LobTemplateSlot[] }>
}

/** PURE — read the four slots from an env map (process.env by default). Values never leave this
 *  function except as the ids a caller hands to Lob. */
function resolveLobTemplates(env: Env = process.env): ResolvedLobTemplates {
  const slots = {} as Record<LobTemplateSlot, ResolvedSlot>
  for (const slot of Object.keys(LOB_TEMPLATE_ENV) as LobTemplateSlot[]) {
    const spec = LOB_TEMPLATE_ENV[slot]
    let found: ResolvedSlot = { id: null, envName: null, legacy: false }
    for (const [i, name] of [spec.name, ...spec.legacy].entries()) {
      const v = (env[name] ?? "").trim()
      if (v) { found = { id: v, envName: name, legacy: i > 0 }; break }
    }
    slots[slot] = found
  }
  const bySlot = new Map<string, LobTemplateSlot[]>()
  for (const slot of Object.keys(slots) as LobTemplateSlot[]) {
    const id = slots[slot].id
    if (!id) continue
    bySlot.set(id, [...(bySlot.get(id) ?? []), slot])
  }
  const aliases = [...bySlot.entries()].filter(([, s]) => s.length > 1).map(([id, s]) => ({ id, slots: s }))
  return { slots, aliases }
}

export type LobFormatTemplates =
  | {
      ok: true
      format: Exclude<MailFormat, "handwritten_card">
      pieceType: "letter" | "postcard"
      /** Letter: the document. Postcard: the FRONT. */
      templateId: string
      /** Postcard only: the BACK — always a different id from the front. */
      backTemplateId?: string
      provenance: { slots: Partial<Record<LobTemplateSlot, { envName: string; legacy: boolean }>>; source: "global_format_template" }
    }
  | { ok: false; format: MailFormat; reason: string; missing: string[]; aliased: LobTemplateSlot[] }

/**
 * PURE — the Lob template id(s) a format mails with. REFUSES (ok:false, nothing mailed):
 *   · a format whose slot has no id ("refuse a format with none"), naming the env var to set;
 *   · a format whose slot shares an id with ANY other slot ("refuse two formats sharing one id") —
 *     a postcard whose back is its front, or a personal letter that is the ordinary letter.
 * handwritten_card is never a Lob template: see routeMailFormat.
 */
function lobTemplatesForFormat(format: MailFormat, env: Env = process.env): LobFormatTemplates {
  if (format === "handwritten_card") {
    return { ok: false, format, reason: "a handwritten card is written by a handwriting provider, never a Lob template (routeMailFormat)", missing: [HANDWRITTEN_CARD_PROVIDER_ENV], aliased: [] }
  }
  const r = resolveLobTemplates(env)
  const need = FORMAT_SLOTS[format]
  const missing = need.filter((s) => !r.slots[s].id).map((s) => LOB_TEMPLATE_ENV[s].name)
  const aliased = need.filter((s) => r.aliases.some((a) => a.slots.includes(s)))
  if (missing.length) {
    return { ok: false, format, reason: `no Lob template configured for ${format}: set ${missing.join(" and ")}`, missing, aliased }
  }
  if (aliased.length) {
    const pairs = r.aliases.filter((a) => a.slots.some((s) => need.includes(s))).map((a) => a.slots.map((s) => LOB_TEMPLATE_ENV[s].name).join(" = "))
    return { ok: false, format, reason: `two formats share one Lob template id (${pairs.join("; ")}) — every format needs its own template`, missing, aliased }
  }
  const provenance: Partial<Record<LobTemplateSlot, { envName: string; legacy: boolean }>> = {}
  for (const s of need) provenance[s] = { envName: r.slots[s].envName as string, legacy: r.slots[s].legacy }
  return {
    ok: true,
    format,
    pieceType: FORMAT_PIECE_TYPE[format],
    templateId: r.slots[need[0]].id as string,
    ...(format === "postcard" ? { backTemplateId: r.slots.postcard_back.id as string } : {}),
    provenance: { slots: provenance, source: "global_format_template" },
  }
}

/**
 * PURE — the template(s) a RENDER FALLBACK mails with. The global format template is the survivor
 * (R5). A legacy per-tenant id (`brokerages.lob_fallback_template_id`, `direct_mail_presets.
 * fallback_template_id`, a lifecycle policy's `mail_template_id`) is read only when the global format
 * is not configured, and is recorded as `legacy_tenant_template` so its remaining use is measured.
 * A postcard NEVER mails with its front as its back: a legacy front with no distinct global back is a
 * refusal, not an alias.
 */
export function fallbackLobTemplates(
  pieceType: string,
  legacyTenantTemplateId: string | null | undefined,
  env: Env = process.env,
): { ok: true; templateId: string; backTemplateId?: string; source: "global_format_template" | "legacy_tenant_template"; format: MailFormat } | { ok: false; reason: string } {
  const format: MailFormat | null = pieceType === "postcard" ? "postcard" : pieceType === "letter" ? "letter" : null
  if (!format) return { ok: false, reason: `piece type ${pieceType} has no global format template` }
  const global = lobTemplatesForFormat(format, env)
  if (global.ok) return { ok: true, templateId: global.templateId, backTemplateId: global.backTemplateId, source: "global_format_template", format }
  const legacy = (legacyTenantTemplateId ?? "").trim()
  if (!legacy) return { ok: false, reason: global.reason }
  if (format === "letter") return { ok: true, templateId: legacy, source: "legacy_tenant_template", format }
  const back = resolveLobTemplates(env).slots.postcard_back.id
  if (!back || back === legacy) {
    return { ok: false, reason: `the postcard fallback has a front (the legacy tenant template) but no distinct back: set ${LOB_TEMPLATE_ENV.postcard_back.name}` }
  }
  return { ok: true, templateId: legacy, backTemplateId: back, source: "legacy_tenant_template", format }
}

// ─── 2. The optional providers, behind the router (DORMANT) ───────────────────

/**
 * Optional mail providers (owner ruling R5: "genuine handwritten cards (AMcards / Handwrytten) and bulk
 * providers (PostcardMania, LettrLabs, PCM) stay OPTIONAL behind the capability router with
 * price/licensing proof; no purchase"). NONE has an adapter: each is `dormant`, and the router never
 * returns one as a sender. The published prices and their dated URLs are in
 * docs/commercial/DIRECT-MAIL-PROVIDER-COMPARISON.md §12.
 */
// AMcards is NOT a handwriting provider under R5: its own home page says "You Click, We Print, Stuff, Stamp,
// and Mail" and signatures are drawn on a device (amcards.com, read 2026-11-06) — a printed greeting card in a
// handwriting-style FONT. Only Handwrytten ("robots that hold real pens") and LettrLabs ("write each card with
// a ball point pen") claim a pen (handwrytten.com, lettrlabs.com, read 2026-11-06).
export const OPTIONAL_MAIL_PROVIDERS = Object.freeze({
  amcards:       { capability: "printed_greeting_card", status: "dormant", needs: ["written platform authorization", "signed DPA", "owner pilot decision", "AMCARDS_ACCESS_TOKEN"] },
  handwrytten:   { capability: "handwritten_card", status: "dormant", needs: ["written platform authorization", "plan choice (monthly fee)", "owner pilot decision", "API key"] },
  lettrlabs:     { capability: "handwritten_card", status: "dormant", needs: ["written platform authorization", "plan choice", "owner pilot decision", "API key", "one checkout per order, keyed on the action ledger (a second checkout after a 200 charges again)"] },
  postcardmania: { capability: "bulk_postcard",    status: "dormant", needs: ["a written quote (no published all-in price)", "owner pilot decision"] },
  pcm:           { capability: "bulk_postcard",    status: "dormant", needs: ["a written quote (no published price)", "owner pilot decision"] },
} as const)

export type OptionalMailProvider = keyof typeof OPTIONAL_MAIL_PROVIDERS

export type MailFormatRoute =
  | { ok: true; provider: "lob"; format: Exclude<MailFormat, "handwritten_card">; label: string; templates: Extract<LobFormatTemplates, { ok: true }> }
  | { ok: false; format: MailFormat; label: string; reason: string; waitingExternal: string[]; downgrade: null }

/**
 * PURE — THE FORMAT ROUTER. A caller names a FORMAT (never a vendor, LAW 3); the router answers which
 * provider and which templates, or refuses saying why. A handwritten card is routed to the provider
 * named in LOB_HANDWRITTEN_CARD_PROVIDER only once that provider has an active adapter — none does, so
 * it is refused WAITING_EXTERNAL. It is NEVER silently downgraded to a typeset letter: a caller that
 * wants the personal letter asks for `personal_letter` and the piece is labelled as printed.
 */
export function routeMailFormat(format: MailFormat, env: Env = process.env): MailFormatRoute {
  const label = MAIL_FORMAT_LABELS[format]
  if (format === "handwritten_card") {
    const named = (env[HANDWRITTEN_CARD_PROVIDER_ENV] ?? "").trim().toLowerCase()
    const known = (Object.keys(OPTIONAL_MAIL_PROVIDERS) as OptionalMailProvider[]).find((p) => p === named && OPTIONAL_MAIL_PROVIDERS[p].capability === "handwritten_card")
    const waiting = known ? [...OPTIONAL_MAIL_PROVIDERS[known].needs] : [`${HANDWRITTEN_CARD_PROVIDER_ENV} (handwrytten | lettrlabs — pen-written; amcards prints a font)`]
    return {
      ok: false, format, label, downgrade: null,
      reason: known
        ? `the handwriting provider ${known} is dormant — no adapter is active until its rights, price and the owner's pilot decision are in hand`
        : "no genuine-handwriting provider is configured; a printed personal note is the personal_letter format, labelled as printed",
      waitingExternal: waiting,
    }
  }
  const templates = lobTemplatesForFormat(format, env)
  if (!templates.ok) return { ok: false, format, label, reason: templates.reason, waitingExternal: templates.missing, downgrade: null }
  return { ok: true, provider: "lob", format, label, templates }
}

/** Fold the campaign column's piece vocabulary (lib/direct-mail/piece-type.ts) onto a FORMAT. A
 *  `handwritten_letter` / `thank_you_note` campaign row is a PERSONAL NOTE: printed, and said so. */
export function formatForCampaignPieceType(pieceType: string | null | undefined): MailFormat {
  const v = String(pieceType ?? "").trim().toLowerCase()
  if (v.startsWith("postcard")) return "postcard"
  if (v === "handwritten_letter" || v === "thank_you_note" || v === "personal_letter") return "personal_letter"
  return "letter"
}

// ─── 3. What a Lob tracking event proves ──────────────────────────────────────

/** The per-piece outcome vocabulary on direct_mail_recipients.delivery_outcome (m985 CHECK). There is
 *  deliberately NO "received" / "read": a carrier scan is evidence about the PIECE, never about the
 *  household (owner: "never treat mail scanner data as proof of household receipt"). */
export const MAIL_DELIVERY_OUTCOMES = [
  "accepted", "rendered", "mailed", "in_transit", "in_local_area", "processed_for_delivery",
  "delivered_per_carrier_scan", "re_routed", "returned_to_sender", "cancelled", "unknown",
] as const
export type MailDeliveryOutcome = (typeof MAIL_DELIVERY_OUTCOMES)[number]

export interface MailOutcomeReading {
  outcome: MailDeliveryOutcome
  /** Terminal for this piece (no later event is expected to change it). */
  terminal: boolean
  /** Always false: no Lob / USPS event proves a person received or read the piece. */
  householdReceiptProven: false
  /** The direct_mail_recipients.delivery_status (live CHECK: pending | mailed | delivered | returned | failed)
   *  this outcome supports, or null to leave the row's status alone. */
  deliveryStatus: "mailed" | "delivered" | "returned" | "failed" | null
}

/**
 * PURE — map a Lob webhook event type ("postcard.in_transit", "letter.delivered", …) to what it proves.
 * Lob's own help page (help.lob.com …/tracking-your-mail, read 2026-11-06): "Delivered" is generated
 * "when the carrier's GPS unit leaves the delivery area" and "USPS does not guarantee every event";
 * "Processed for Delivery is more reliable". So `delivered` reads as delivered PER CARRIER SCAN.
 */
export function mailOutcomeFromLobEvent(eventType: string): MailOutcomeReading {
  const e = String(eventType ?? "").toLowerCase().split(".").pop() ?? ""
  const read = (outcome: MailDeliveryOutcome, terminal: boolean, deliveryStatus: MailOutcomeReading["deliveryStatus"]): MailOutcomeReading =>
    ({ outcome, terminal, householdReceiptProven: false, deliveryStatus })
  switch (e) {
    case "created":                return read("accepted", false, null)
    case "rendered_pdf":
    case "rendered_thumbnails":    return read("rendered", false, null)
    case "mailed":                 return read("mailed", false, "mailed")
    case "in_transit":             return read("in_transit", false, "mailed")
    case "in_local_area":          return read("in_local_area", false, "mailed")
    case "processed_for_delivery": return read("processed_for_delivery", false, "mailed")
    case "delivered":              return read("delivered_per_carrier_scan", true, "delivered")
    case "re-routed":
    case "re_routed":              return read("re_routed", false, "mailed")
    case "returned_to_sender":     return read("returned_to_sender", true, "returned")
    case "deleted":                return read("cancelled", true, "failed")
    default:                       return read("unknown", false, null)
  }
}

// ─── 4. Brand merge variables ─────────────────────────────────────────────────

/** Lob: merge_variables is a JSON object of at most 25,000 characters; names carry no whitespace or
 *  special characters (help.lob.com dynamic-personalization, read 2026-11-06). */
const LOB_MERGE_VARIABLES_MAX_CHARS = 25000

/** The brand facts a piece needs — the shape readMailBrandFacts reads from the cascade. */
export interface MailBrandFacts {
  displayName: string
  legalBrokerageName: string
  dba?: string | null
  teamName?: string | null
  officeName?: string | null
  agentName?: string | null
  agentLicenseLine?: string | null
  agentPhotoUrl?: string | null
  logoUrl?: string | null
  primaryColor: string
  secondaryColor: string
  accentColor: string
  fontFamily?: string | null
  tagline?: string | null
  website?: string | null
  phone?: string | null
  returnAddress?: { name: string; line1: string; line2?: string | null; city: string; state: string; zip: string } | null
  /** Legal text — passed VERBATIM, never rewritten. */
  disclosureShort: string
  disclosureLong: string
}

export interface MailPieceFacts {
  recipientName?: string | null
  qrDestinationUrl?: string | null
  frontArtUrl?: string | null
  backArtUrl?: string | null
  pictureUrl?: string | null
  /** Copy bodies keyed by the template's variable name (copy_text, note_body …): the agent's or the
   *  humanized writer's words, never altered here. */
  bodies?: Record<string, string | null | undefined>
}

/** A hosted @font-face stylesheet for a font family (Lob renders Google web fonts and hosted TTF; OTF and
 *  Typekit are refused). Built from the family NAME; that the family exists on Google Fonts is unverified. */
function hostedFontCssUrl(fontFamily: string | null | undefined): string {
  const f = String(fontFamily ?? "").trim()
  if (!f || /[^A-Za-z0-9 \-]/.test(f)) return ""
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, "+")}&display=swap`
}

const httpsOnly = (u: string | null | undefined): string => (/^https:\/\//i.test(String(u ?? "").trim()) ? String(u).trim() : "")

/**
 * PURE — the Lob merge_variables for one piece. Every key is snake_case; every value a string (""
 * when the cascade has nothing, which the provenance reports). Asset URLs must be https (Lob must be
 * able to fetch them). The disclosures are copied byte-for-byte. Throws nothing: an over-size object
 * is returned with `oversize: true` for the caller to refuse.
 */
export function buildMailMergeVariables(brand: MailBrandFacts, piece: MailPieceFacts = {}): { mergeVars: Record<string, string>; missing: string[]; oversize: boolean } {
  const ra = brand.returnAddress ?? null
  const v: Record<string, string> = {
    brand_display_name:   brand.displayName,
    brand_legal_name:     brand.legalBrokerageName,
    brand_dba:            brand.dba ?? "",
    team_name:            brand.teamName ?? "",
    office_name:          brand.officeName ?? "",
    agent_name:           brand.agentName ?? "",
    agent_license_line:   brand.agentLicenseLine ?? "",
    agent_photo_url:      httpsOnly(brand.agentPhotoUrl),
    brand_logo_url:       httpsOnly(brand.logoUrl),
    brand_primary_color:  brand.primaryColor,
    brand_secondary_color: brand.secondaryColor,
    brand_accent_color:   brand.accentColor,
    brand_font_family:    brand.fontFamily ?? "",
    brand_font_css_url:   hostedFontCssUrl(brand.fontFamily),
    brand_tagline:        brand.tagline ?? "",
    brand_website:        brand.website ?? "",
    brand_phone:          brand.phone ?? "",
    return_name:          ra?.name ?? "",
    return_address_line1: ra?.line1 ?? "",
    return_address_line2: ra?.line2 ?? "",
    return_city:          ra?.city ?? "",
    return_state:         ra?.state ?? "",
    return_zip:           ra?.zip ?? "",
    recipient_name:       piece.recipientName ?? "",
    qr_destination_url:   httpsOnly(piece.qrDestinationUrl),
    front_art_url:        httpsOnly(piece.frontArtUrl),
    back_art_url:         httpsOnly(piece.backArtUrl),
    picture_url:          httpsOnly(piece.pictureUrl),
    disclosure_short:     brand.disclosureShort,
    disclosure_long:      brand.disclosureLong,
  }
  for (const [k, body] of Object.entries(piece.bodies ?? {})) {
    const key = k.replace(/[^a-z0-9_]/gi, "_").toLowerCase()
    if (key && !(key in v)) v[key] = String(body ?? "")
  }
  const missing = ["brand_logo_url", "return_address_line1", "agent_license_line", "brand_tagline"].filter((k) => !v[k])
  return { mergeVars: v, missing, oversize: JSON.stringify(v).length > LOB_MERGE_VARIABLES_MAX_CHARS }
}

/** Where each brand tier came from (resolveBrandContext.source) + office / return-address provenance. */
export interface MailBrandProvenance {
  logo: string; color: string; tagline: string; license: string
  office: "not_in_brand_cascade"; returnAddress: "brokerage_of_record" | "none"
  readErrors: string[]
}

/**
 * Read the brand FACTS for ONE sending user at proof time (callers then build the piece's merge variables
 * with buildMailMergeVariables): tenant (brokerage of record), team, the agent's license / photo, and the
 * return address of the brokerage of record.
 *
 * THE OFFICE IS NOT READ HERE, and that is said, not hidden: the one office rule is
 * lib/kernel/resolve-user-office.ts, and importing it from this module pushed app/crm/page.tsx to 1302
 * first-party modules (test:proxy-graph-budget, cap 1300). The office belongs in the ONE brand cascade
 * (resolveBrandContext) — Outside-lane for its owner (lane 150R notes); until then `office_name` prints
 * empty and provenance.office reads "not_in_brand_cascade". `locations` carries no ZIP, so the return
 * address stays the brokerage of record's either way. The tenant is the CALLER's session tenant (passed in by a gated server
 * caller, never a request body). Every refused read is SAID in readErrors and falls through.
 */
export async function readMailBrandFacts(args: {
  brokerageId: string
  teamId?: string | null
  agentUserId?: string | null
}): Promise<{ facts: MailBrandFacts; provenance: MailBrandProvenance }> {
  const [{ resolveBrandContext }, { createServiceClient }] = await Promise.all([
    import("@/lib/branding/resolve-brand-context"),
    import("@/lib/supabase/service"),
  ])
  const brand = await resolveBrandContext({ brokerageId: args.brokerageId, teamId: args.teamId ?? null, agentUserId: args.agentUserId ?? null })
  const svc = createServiceClient()
  const readErrors = [...(brand.readErrors ?? [])]

  const { data: brk, error: brkErr } = await svc
    .from("brokerages")
    .select("name, dba, address, address_line2, city, state, zip")
    .eq("id", args.brokerageId)
    .maybeSingle()
  if (brkErr) readErrors.push(`brokerages(address): ${brkErr.message}`)
  const b = (brk ?? {}) as { name?: string | null; dba?: string | null; address?: string | null; address_line2?: string | null; city?: string | null; state?: string | null; zip?: string | null }
  const returnAddress = b.address && b.city && b.state && b.zip
    ? { name: brand.brokerageName, line1: b.address, line2: b.address_line2 ?? null, city: b.city, state: b.state, zip: b.zip }
    : null

  let agentPhotoUrl: string | null = null
  if (args.agentUserId) {
    const { data: ag, error: agErr } = await svc.from("agents").select("photo_url").eq("user_id", args.agentUserId).eq("brokerage_id", args.brokerageId).maybeSingle()
    if (agErr) readErrors.push(`agents(photo): ${agErr.message}`)
    agentPhotoUrl = ((ag as { photo_url?: string | null } | null)?.photo_url ?? "").trim() || null
  }

  const facts: MailBrandFacts = {
    displayName: brand.displayName,
    legalBrokerageName: brand.brokerageName,
    dba: b.dba ?? null,
    teamName: brand.teamName ?? null,
    officeName: null,
    agentName: brand.agentName ?? null,
    agentLicenseLine: brand.display.licenseLine,
    agentPhotoUrl,
    logoUrl: brand.visual.logoUrl,
    primaryColor: brand.visual.primaryColor,
    secondaryColor: brand.visual.secondaryColor,
    accentColor: brand.visual.accentColor,
    fontFamily: brand.visual.fontFamily,
    tagline: brand.display.tagline,
    website: brand.display.websiteWordmark,
    phone: brand.display.phone,
    returnAddress,
    disclosureShort: brand.fairHousing.shortDisclosure,
    disclosureLong: brand.fairHousing.longDisclosure,
  }
  return {
    facts,
    provenance: {
      logo: brand.source.logo, color: brand.source.color, tagline: brand.source.tagline, license: brand.source.license,
      office: "not_in_brand_cascade", returnAddress: returnAddress ? "brokerage_of_record" : "none", readErrors,
    },
  }
}

// ─── 5. At-most-once per piece ────────────────────────────────────────────────

/** The action-ledger idempotency key ONE mail piece is dispatched under. The ledger's unique key turns a
 *  retried or concurrent send of the same piece into a replay of the first (lib/kernel/action-ledger.ts
 *  rereadWinner) — the second Lob charge cannot happen. */
export function mailPieceIdempotencyKey(kind: "campaign_recipient" | "drain_campaign" | "lifecycle" | "thank_you_note", ...parts: Array<string | null | undefined>): string {
  return `direct_mail:${kind}:${parts.map((p) => String(p ?? "-")).join(":")}`
}

/** The ledger provenance written beside a piece (direct_mail_campaigns.template_provenance, m985). */
export function mailTemplateProvenance(route: MailFormatRoute, brand: { provenance: MailBrandProvenance; missing: string[] } | null): Record<string, unknown> {
  return {
    format: route.format,
    label: route.label,
    provider: route.ok ? route.provider : null,
    template_env_names: route.ok ? Object.fromEntries(Object.entries(route.templates.provenance.slots).map(([s, p]) => [s, p?.envName ?? null])) : {},
    legacy_env: route.ok ? Object.values(route.templates.provenance.slots).some((p) => p?.legacy) : false,
    refusal: route.ok ? null : route.reason,
    brand_sources: brand?.provenance ?? null,
    brand_missing: brand?.missing ?? [],
    household_receipt_claimed: false,
  }
}
