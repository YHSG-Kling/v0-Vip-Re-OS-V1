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
 * (test:proxy-graph-budget). Still no static RUNTIME imports: the async readers import their server modules lazily;
 * the one static import below is TYPE-ONLY (erased at build).
 *
 * WAVE 151 (lane 151H — owner: "the direct mail templates should be blank templates with just layout"; "the rendered pieces
 * should not use the platform return address"; "handwritten font by computer can be a substitute"): §1b the blank layout
 * library + the handwriting-style printed typeface; §4b the tenant's sender address (resolveTenantSenderAddress — the one
 * place the dispatcher, every mail door and Settings ask; the platform's address is never a step); §4c delivery truth (six
 * separate states; an API 200 is only `apiAccepted`); §4d the campaign send gate (approval + whole-batch spend);
 * §4e returned-mail handling. Proof: scripts/direct-mail-rendering-guard.ts.
 */
import type { SenderAddress, SenderAddressSource, ReturnedMailRecipient, ReturnedMailPlan } from "@/lib/providers/mailing-cass-gate"
// The PURE rules live in the client-safe sibling (mail-piece-rules.ts). This file forwards the ones its own server callers
// read beside the routing/sender functions below; the delivery-truth pair (mailOutcomeFromLobEvent, mailPieceTruth) and
// its types are imported from mail-piece-rules DIRECTLY by every reader (app/actions/direct-mail.ts, the tracking tab,
// the guards) — a forward nobody read was a hidden wire (test:hidden-wires, wave 151).
import { MAIL_FORMAT_LABELS, HANDWRITING_STYLE_TYPEFACE, type MailFormat, type LobTemplateSlot } from "./mail-piece-rules"
export { MAIL_FORMATS, MAIL_FORMAT_LABELS, MAIL_LAYOUT_LIBRARY, HANDWRITING_STYLE_TYPEFACE, layoutContentViolations, MAIL_DELIVERY_OUTCOMES } from "./mail-piece-rules"
export type { MailFormat, LobTemplateSlot, MailDeliveryOutcome } from "./mail-piece-rules"

// ─── 1. Formats and the Lob template slots ────────────────────────────────────

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


// ─── 1b. THE BLANK LAYOUT LIBRARY (wave 151, lane 151H) ──────────────────────
//
// Owner (verbatim): "the direct mail templates should be blank templates with just layout". A GLOBAL template is a
// FORMAT-SPECIFIC blank layout: trim, bleed, the address window, the indicia zone, the typographic grid, and the
// NAMES of the merge variables it prints. It carries no brand, no logo, no address, no name — not the platform's,
// not any tenant's. Everything on a rendered piece comes from the authorized tenant / sending user at proof time
// (buildMailMergeVariables below), which is why one small library serves every tenant and no Lob template is made
// per tenant (cost strategy: a handful of Lob templates, dynamic branding).

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
  // Wave 151 (151H): a campaign row's personal-note vocabulary (handwritten_letter / thank_you_note / personal_letter) falls
  // back to the GLOBAL personal-note layout — before this it had "no global format template" and an approved note never mailed.
  const pt = String(pieceType ?? "").trim().toLowerCase()
  const format: MailFormat | null = pt.startsWith("postcard") ? "postcard" : pt === "letter" ? "letter"
    : (pt === "personal_letter" || pt === "handwritten_letter" || pt === "thank_you_note") ? "personal_letter" : null
  if (!format) return { ok: false, reason: `piece type ${pieceType} has no global format template` }
  const global = lobTemplatesForFormat(format, env)
  if (global.ok) return { ok: true, templateId: global.templateId, backTemplateId: global.backTemplateId, source: "global_format_template", format }
  const legacy = (legacyTenantTemplateId ?? "").trim()
  if (!legacy) return { ok: false, reason: global.reason }
  if (format === "personal_letter") return { ok: false, reason: `${global.reason} (a legacy tenant template is never used for the handwriting-style note — its layout is the global one)` }
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
  /** THE SENDER'S return address (wave 151, lane 151H): the tenant's configured / approved address with its CASS evidence
   *  (lib/providers/mailing-cass-gate.ts SenderAddress) — never the platform's. null = none resolved (the gate refuses). */
  returnAddress?: SenderAddress | null
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
    // Wave 151 (151H): the sender's legal / business identity and the creator attribution are DATA on the blank layout,
    // the Contact's appropriate identity is the recipient's own name, and the personal-note layout's typeface is the
    // handwriting-style PRINTED one (a layout constant, not a brand value).
    sender_legal_identity: [brand.legalBrokerageName, brand.dba ? `dba ${brand.dba}` : "", brand.agentLicenseLine ?? ""].filter(Boolean).join(" · "),
    creator_attribution:  brand.agentName ? `Prepared by ${brand.agentName}${brand.teamName ? `, ${brand.teamName}` : ""} — ${brand.legalBrokerageName}` : `Prepared by ${brand.displayName} — ${brand.legalBrokerageName}`,
    note_font_family:     HANDWRITING_STYLE_TYPEFACE.family,
    note_font_css_url:    HANDWRITING_STYLE_TYPEFACE.cssUrl,
    recipient_name:       piece.recipientName ?? "",
    recipient_first_name: (piece.recipientName ?? "").trim().split(/\s+/)[0] ?? "",
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
  /** Where the sender's office came from — THE one office rule (lib/kernel/resolve-user-office.ts resolveUserOffice). */
  office: "user" | "agent" | "none"
  /** Which tenant source the return address came from (mailing-cass-gate.ts SenderAddressSource), or none. Never "platform". */
  returnAddress: SenderAddressSource | "none"
  /** Why no sender address resolved (said, so the refusal can name it). */
  returnAddressRefusal?: string | null
  readErrors: string[]
}

// ─── 4b. THE TENANT'S SENDER ADDRESS (wave 151, lane 151H) ────────────────────

export interface SenderAddressRow {
  id: string
  brokerage_id: string
  scope_type: "brokerage" | "team" | "user"
  scope_id: string
  label: string | null
  name: string
  line1: string
  line2: string | null
  city: string
  state: string
  zip: string
  cass_deliverability: string | null
  cass_verified_at: string | null
  /** Which verifier ruled (lob_cass) — shown beside the verdict so an admin knows what "verified" means. */
  cass_source?: string | null
  approved_by_user_id: string | null
  approved_at: string | null
  is_default: boolean
  status: "active" | "retired"
  /** Who added the address (users.id) — the audit line the settings page prints. */
  created_by_user_id?: string | null
}

interface ResolvedSenderAddress {
  address: SenderAddress | null
  /** Why nothing resolved (the gate's refusal names it). */
  refusal: string | null
  readErrors: string[]
  /** A Lob verification was bought at resolve time (brokerage-of-record path with no approved row). */
  verifiedNow: boolean
}

type SenderClient = { from: (table: string) => any }

/** PURE — pick the approved row for a sender: the user's own approved address, else the team's, else the tenant's
 *  default return address. Defaults first within a scope; the newest approval breaks a tie. */
export function pickSenderAddressRow(rows: SenderAddressRow[], scope: { brokerageId: string; teamId?: string | null; agentUserId?: string | null }): { row: SenderAddressRow; source: SenderAddressSource } | null {
  const active = rows.filter((r) => r.status === "active" && r.brokerage_id === scope.brokerageId && r.approved_at)
  const order = (a: SenderAddressRow, b: SenderAddressRow) => Number(b.is_default) - Number(a.is_default) || String(b.approved_at ?? "").localeCompare(String(a.approved_at ?? ""))
  const pick = (type: SenderAddressRow["scope_type"], id: string | null | undefined, source: SenderAddressSource) => {
    if (!id) return null
    const r = active.filter((x) => x.scope_type === type && x.scope_id === id).sort(order)[0]
    return r ? { row: r, source } : null
  }
  return pick("user", scope.agentUserId, "sender_approved_address")
    ?? pick("team", scope.teamId, "team_approved_address")
    ?? pick("brokerage", scope.brokerageId, "tenant_return_address")
}

/** The SenderAddress a stored row stands for (its CASS evidence travels with it). */
export function senderAddressFromRow(row: SenderAddressRow, source: SenderAddressSource): SenderAddress {
  return {
    name: row.name, line1: row.line1, line2: row.line2, city: row.city, state: row.state, zip: row.zip, source,
    verification: row.cass_verified_at ? { method: "lob_cass", deliverability: row.cass_deliverability, verifiedAt: row.cass_verified_at } : null,
    addressId: row.id, approvedByUserId: row.approved_by_user_id,
  }
}

/**
 * Resolve THE TENANT's sender (return) address for one sending user — the one place every mail door and the
 * dispatcher ask. Order (directive 151H: "the tenant's configured return mailing address, or another address expressly
 * approved for the actual sender"):
 *   1. an approved direct_mail_sender_addresses row for the USER, else the TEAM, else the tenant's default (m980);
 *   2. the brokerage of record's own business address (brokerages.address/city/state/zip — configured by the tenant),
 *      CASS-verified NOW when LOB_API_KEY is present (one verification, metered), REFUSED when it cannot be verified.
 * The platform's address is never a step. The tenant is the caller's session / verified-row tenant, never a request body.
 * `client` is injectable so the proof drives it on the in-memory client.
 */
export async function resolveTenantSenderAddress(args: { brokerageId: string; teamId?: string | null; agentUserId?: string | null; client?: SenderClient; verifyNow?: boolean }): Promise<ResolvedSenderAddress> {
  const readErrors: string[] = []
  const svc: SenderClient = args.client ?? (await import("@/lib/supabase/service")).createServiceClient()
  const { data: rows, error: rowsErr } = await svc
    .from("direct_mail_sender_addresses")
    .select("id, brokerage_id, scope_type, scope_id, label, name, line1, line2, city, state, zip, cass_deliverability, cass_verified_at, cass_source, approved_by_user_id, approved_at, is_default, status, created_by_user_id")
    .eq("brokerage_id", args.brokerageId)
    .eq("status", "active")
  if (rowsErr) readErrors.push(`direct_mail_sender_addresses: ${rowsErr.message}`)
  const picked = pickSenderAddressRow(((rows ?? []) as SenderAddressRow[]), args)
  if (picked) return { address: senderAddressFromRow(picked.row, picked.source), refusal: null, readErrors, verifiedNow: false }

  const { data: brk, error: brkErr } = await svc
    .from("brokerages")
    .select("name, dba, address, address_line2, city, state, zip")
    .eq("id", args.brokerageId)
    .maybeSingle()
  if (brkErr) readErrors.push(`brokerages(address): ${brkErr.message}`)
  const b = (brk ?? {}) as { name?: string | null; dba?: string | null; address?: string | null; address_line2?: string | null; city?: string | null; state?: string | null; zip?: string | null }
  if (!(b.address && b.city && b.state && b.zip && b.name)) {
    return { address: null, refusal: "no approved sender address and the brokerage of record has no complete business address — configure the return address in Settings → Direct mail → Return address", readErrors, verifiedNow: false }
  }
  const candidate: SenderAddress = { name: b.name, line1: b.address, line2: b.address_line2 ?? null, city: b.city, state: b.state, zip: b.zip, source: "brokerage_of_record", verification: null }
  if (args.verifyNow === false) return { address: candidate, refusal: null, readErrors, verifiedNow: false }
  // One CASS verification for the brokerage of record's address (the recipient gate's own adapter; same price; metered).
  try {
    const { verifyAddressViaLob } = await import("@/lib/external/lob-address-verify")
    const { data: lob, cost } = await verifyAddressViaLob({ primary_line: b.address, secondary_line: b.address_line2 ?? undefined, city: b.city, state: b.state, zip_code: b.zip, recipient: b.name })
    if (cost > 0) {
      try {
        const { meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
        await meterVendorSpend({ vendorName: "lob", usageType: "address_verify", cost, brokerageId: args.brokerageId, systemSource: "direct_mail_sender_gate", metadata: { purpose: "sender_return_address", result: lob?.deliverability ?? "unavailable" } })
      } catch { /* metering never breaks the resolution */ }
    }
    if (lob) {
      candidate.verification = { method: "lob_cass", deliverability: lob.deliverability, verifiedAt: new Date().toISOString() }
      if (lob.standardized?.primary_line) candidate.line1 = lob.standardized.primary_line
      if (lob.standardized?.city) candidate.city = lob.standardized.city
      if (lob.standardized?.state) candidate.state = lob.standardized.state
      if (lob.standardized?.zip_code) candidate.zip = lob.standardized.zip_code
      return { address: candidate, refusal: null, readErrors, verifiedNow: true }
    }
  } catch (err) {
    readErrors.push(`lob address verification: ${(err as Error)?.message ?? String(err)}`)
  }
  // Unverified: returned as-is so the gate refuses it BY NAME (unverified), never silently.
  return { address: candidate, refusal: null, readErrors, verifiedNow: false }
}

// ─── 4d. THE CAMPAIGN SEND GATE (wave 151, lane 151H) ─────────────────────────

/** approval_status spellings that mean "a human has NOT yet approved" — the Send button cannot step over them. */
const UNAPPROVED_APPROVAL_STATUSES = new Set(["pending", "pending_review", "rejected", "needs_changes"])

interface CampaignSendGateInput {
  approvalStatus: string | null | undefined
  status: string | null | undefined
  pieces: number
  /** The one Lob price for the piece type (lib/vendor-governance/cost-normalizer.ts DIRECT_MAIL_PIECE_COST_USD). */
  unitCostUsd: number | null | undefined
  /** The billing resolver's verdict for the whole batch (lib/billing/billing-access.ts mayUseAndAfford, estCostUsd = pieces × unit). */
  budget: { allowed: boolean; reason: string; remainingBudget: number | null; budgetDegraded?: boolean; softWarning?: boolean } | null
}

type CampaignSendGate =
  | { ok: true; estimatedCostUsd: number; warning: string | null; spendPreview: Record<string, unknown> }
  | { ok: false; reason: string; code: "not_approved" | "already_mailed" | "no_pieces" | "no_price" | "budget" }

/** PURE — tenant approval before send, and the spend guard over the whole batch (not piece by piece, so a 500-piece
 *  campaign is refused at piece 0, not piece 300). A degraded budget read proceeds with a warning (the dispatcher's
 *  documented fail-open for the budget half); an AFFIRMATIVE refusal stops the send. */
export function campaignSendGate(input: CampaignSendGateInput): CampaignSendGate {
  const approval = String(input.approvalStatus ?? "").trim().toLowerCase()
  if (UNAPPROVED_APPROVAL_STATUSES.has(approval)) {
    return { ok: false, code: "not_approved", reason: `the campaign is awaiting approval (approval_status ${approval}) — a tenant approver clears it before anything is printed` }
  }
  if (String(input.status ?? "") === "mailed") return { ok: false, code: "already_mailed", reason: "the campaign is already mailed" }
  if (!(input.pieces > 0)) return { ok: false, code: "no_pieces", reason: "no pending recipients to mail" }
  if (typeof input.unitCostUsd !== "number" || !(input.unitCostUsd > 0)) {
    return { ok: false, code: "no_price", reason: "no documented per-piece price for this format — nothing is mailed at an unknown price" }
  }
  const est = Math.round(input.pieces * input.unitCostUsd * 100) / 100
  const b = input.budget
  if (b && !b.allowed && !b.budgetDegraded) {
    return { ok: false, code: "budget", reason: `the tenant's mail budget refuses ${input.pieces} piece(s) at $${input.unitCostUsd} = $${est} (${b.reason}${typeof b.remainingBudget === "number" ? `; $${b.remainingBudget.toFixed(2)} left this period` : ""})` }
  }
  const warning = !b ? "the budget could not be consulted (no verdict) — the per-piece dispatcher gate still applies"
    : b.budgetDegraded ? "the budget ledger could not be read (fail-open, recorded) — the per-piece dispatcher gate still applies"
    : b.softWarning ? `soft budget warning: $${est} of ${typeof b.remainingBudget === "number" ? `$${b.remainingBudget.toFixed(2)}` : "the remaining budget"}` : null
  return {
    ok: true, estimatedCostUsd: est, warning,
    spendPreview: { pieces: input.pieces, unit_cost_usd: input.unitCostUsd, estimated_cost_usd: est, budget_reason: b?.reason ?? "no_verdict", remaining_budget_usd: b?.remainingBudget ?? null, budget_degraded: b?.budgetDegraded === true, previewed_at: new Date().toISOString() },
  }
}

// ─── 4e. RETURNED MAIL (wave 151, lane 151H) ─────────────────────────────────

export interface ReturnedMailResult {
  plan: ReturnedMailPlan
  entityRowsPatched: number
  siblingsStopped: number
  addressSuppressed: boolean
  errors: string[]
}

/**
 * Apply a returned piece's plan (mailing-cass-gate.ts planReturnedMailHandling) on the ONE ledger + the entity records:
 * the lead / contact's mailing address is un-verified with source lob_returned_to_sender (the CASS gate re-verifies a
 * corrected address instead of trusting the old flag), pending siblings to the same mailbox in the campaign are
 * stopped, an address-only recipient's mailbox is suppressed for mail, and the handling is written beside the piece
 * (direct_mail_recipients.return_handling, m981 — a SEPARATE write, so a pending migration cannot take the outcome down).
 * Every UPDATE is .select()ed and COUNTED (CLAUDE.md §3).
 */
export async function applyReturnedMailHandling(svc: SenderClient, args: { brokerageId: string; recipient: ReturnedMailRecipient }): Promise<ReturnedMailResult> {
  const errors: string[] = []
  const { planReturnedMailHandling } = await import("@/lib/providers/mailing-cass-gate")
  const { data: siblings, error: sibErr } = await svc
    .from("direct_mail_recipients")
    .select("id, campaign_id, lead_id, contact_id, address_line1, zip, delivery_status")
    .eq("brokerage_id", args.brokerageId)
    .eq("campaign_id", args.recipient.campaign_id)
  if (sibErr) errors.push(`siblings read: ${sibErr.message}`)
  const plan = planReturnedMailHandling(args.recipient, ((siblings ?? []) as ReturnedMailRecipient[]))

  let entityRowsPatched = 0
  for (const [table, id] of [["leads", plan.leadId], ["contacts", plan.contactId]] as const) {
    if (!id) continue
    const { data, error } = await svc.from(table).update({ ...plan.entityPatch, updated_at: new Date().toISOString() }).eq("id", id).eq("brokerage_id", args.brokerageId).select("id")
    if (error) errors.push(`${table} address record: ${error.message}`)
    else entityRowsPatched += Array.isArray(data) ? data.length : 0
  }

  let siblingsStopped = 0
  if (plan.stopRecipientIds.length) {
    const { data, error } = await svc.from("direct_mail_recipients").update({ delivery_status: "failed" }).in("id", plan.stopRecipientIds).eq("brokerage_id", args.brokerageId).select("id")
    if (error) errors.push(`siblings stop: ${error.message}`)
    else siblingsStopped = Array.isArray(data) ? data.length : 0
  }

  let addressSuppressed = false
  if (plan.suppressAddress) {
    try {
      const { addAddressSuppression } = await import("@/lib/direct-mail/address-suppression")
      const r = await addAddressSuppression(svc, { brokerageId: args.brokerageId, street: args.recipient.address_line1, zip: args.recipient.zip, reason: "returned_to_sender", source: "lob_tracking" })
      addressSuppressed = r.suppressed
      if (r.error) errors.push(`address suppression: ${r.error}`)
    } catch (err) { errors.push(`address suppression: ${(err as Error)?.message ?? String(err)}`) }
  }

  const { error: handlingErr } = await svc.from("direct_mail_recipients")
    .update({ return_handling: { ...plan, entity_rows_patched: entityRowsPatched, siblings_stopped: siblingsStopped, address_suppressed: addressSuppressed, handled_at: new Date().toISOString(), errors } })
    .eq("id", args.recipient.id).eq("brokerage_id", args.brokerageId)
  if (handlingErr) errors.push(`return_handling (m981 pending?): ${handlingErr.message}`)

  return { plan, entityRowsPatched, siblingsStopped, addressSuppressed, errors }
}

/**
 * Read the brand FACTS for ONE sending user at proof time (callers then build the piece's merge variables
 * with buildMailMergeVariables): tenant (brokerage of record), team, the agent's license / photo, and the
 * return address of the brokerage of record.
 *
 * THE SENDER'S OFFICE (wave 150, lane 150Z — lane 150R Outside-lane 3): read through THE one office rule
 * (lib/kernel/resolve-user-office.ts resolveUserOffice — the person's office of record, else their agent row's), then the
 * office's own name from `locations`, pinned to this tenant. The module was already in app/crm/page.tsx's graph when
 * this was wired (measured 1300 → 1300; the earlier +2 was before 150C put it there). `locations` carries no ZIP, so the
 * return address stays the brokerage of record's. The tenant is the CALLER's session tenant (passed in by a gated server
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
    .select("dba")
    .eq("id", args.brokerageId)
    .maybeSingle()
  if (brkErr) readErrors.push(`brokerages(dba): ${brkErr.message}`)
  const b = (brk ?? {}) as { dba?: string | null }
  // THE SENDER'S RETURN ADDRESS (wave 151, 151H): the tenant's approved / configured address with its CASS evidence — the
  // ONE resolver, so this reader, the dispatcher and the Settings page agree. Never the platform's.
  const sender = await resolveTenantSenderAddress({ brokerageId: args.brokerageId, teamId: args.teamId ?? null, agentUserId: args.agentUserId ?? null, client: svc })
  readErrors.push(...sender.readErrors)
  const returnAddress = sender.address

  let agentPhotoUrl: string | null = null
  if (args.agentUserId) {
    const { data: ag, error: agErr } = await svc.from("agents").select("photo_url").eq("user_id", args.agentUserId).eq("brokerage_id", args.brokerageId).maybeSingle()
    if (agErr) readErrors.push(`agents(photo): ${agErr.message}`)
    agentPhotoUrl = ((ag as { photo_url?: string | null } | null)?.photo_url ?? "").trim() || null
  }

  let officeName: string | null = null
  let officeSource: MailBrandProvenance["office"] = "none"
  if (args.agentUserId) {
    const { resolveUserOffice } = await import("@/lib/kernel/resolve-user-office")
    const office = await resolveUserOffice(svc as never, args.agentUserId)
    if (office.locationId) {
      const { data: loc, error: locErr } = await svc.from("locations").select("name").eq("id", office.locationId).eq("brokerage_id", args.brokerageId).maybeSingle()
      if (locErr) readErrors.push(`locations(name): ${locErr.message}`)
      officeName = ((loc as { name?: string | null } | null)?.name ?? "").trim() || null
      if (officeName) officeSource = office.source
    }
  }

  const facts: MailBrandFacts = {
    displayName: brand.displayName,
    legalBrokerageName: brand.brokerageName,
    dba: b.dba ?? null,
    teamName: brand.teamName ?? null,
    officeName,
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
      office: officeSource, returnAddress: returnAddress ? returnAddress.source : "none", returnAddressRefusal: sender.refusal, readErrors,
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
    // Wave 151 (151H): which TENANT source the return address came from; "platform" is not a value this can take.
    sender_address_source: brand?.provenance.returnAddress ?? "none",
    layout: route.ok ? (route.format === "postcard" ? ["postcard_front", "postcard_back"] : [route.format]) : [],
    household_receipt_claimed: false,
  }
}
