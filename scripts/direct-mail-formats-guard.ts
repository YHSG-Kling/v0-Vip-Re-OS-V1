/**
 * scripts/direct-mail-formats-guard.ts — test:direct-mail-formats (wave 150, lane 150R; owner ruling R5,
 * contract C40, directive canary 13).
 *
 * Canary 13: "Lob letter, postcard front/back, personal-note and optional special card IDs never alias;
 * correct tenant office logo/brand/address/font/QR; preview and delivery status, accurate price; no live
 * spend in canary, no mistaken double LettrLabs checkout."
 *
 * Sections (each absence assertion carries a POSITIVE CONTROL — CLAUDE.md §2):
 *   A. the four template ids by NAME, distinct; aliasing refused; a format with none refused; the render
 *      fallback never prints a postcard front on both sides
 *   B. honesty — a typeface is never called handwriting; handwritten_card only through a pen provider
 *      (all dormant), never silently downgraded; AMcards is classed as printed
 *   C. delivery outcomes — no Lob event proves household receipt; the migration CHECK equals the vocabulary
 *   D. brand as DATA — two tenants / offices / senders produce different logo, address, office, font, QR;
 *      disclosures byte-for-byte; non-https assets dropped; oversize flagged
 *   E. no double charge — the per-piece idempotency key on the REAL action ledger over memSupabase
 *      (UNIQUE on idempotency_key): the second send of one piece replays, never runs
 *   F. one ledger vocabulary — no writer stamps a status the live CHECK refuses
 *   G. wiring — sendCampaign / reputation card / fallbacks route through the format router; preview is a
 *      TEST-key Lob proof (a live key refused with no network); delivery settles per piece
 *   H. no live spend, no LettrLabs checkout — no optional-provider host or checkout call in code
 *   I. the price comparison is sourced (dated URLs, "unconfirmed" where unpublished); migration stamp
 *
 * Reads STRIPPED source for code-token scans (scripts/strip-comments.ts). No network, no Lob key.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  LOB_TEMPLATE_ENV, HANDWRITTEN_CARD_PROVIDER_ENV, MAIL_FORMAT_LABELS, MAIL_DELIVERY_OUTCOMES, OPTIONAL_MAIL_PROVIDERS,
  fallbackLobTemplates, routeMailFormat, buildMailMergeVariables,
  mailPieceIdempotencyKey, formatForCampaignPieceType, type MailBrandFacts,
} from "../lib/direct-mail/piece-type"
import { mailOutcomeFromLobEvent } from "../lib/direct-mail/mail-piece-rules"
import { createLobProof } from "../lib/providers/lob/client"
import { withActionLedger, settleDispatchResult, replayDispatchResult, type DispatchLike } from "../lib/kernel/action-ledger"

// NO LIVE SPEND: the canary runs with no Lob key at all.
delete process.env.LOB_API_KEY
delete process.env.LOB_TEST_API_KEY

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const root = process.cwd()
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => blankStrings(stripComments(read(rel)))
const noComments = (rel: string) => stripComments(read(rel))

// The router's template answer (lobTemplatesForFormat is module-private; routeMailFormat is the product surface).
type T = { ok: true; templateId: string; backTemplateId?: string; pieceType: string; provenance: { slots: Record<string, { envName: string; legacy: boolean } | undefined> } } | { ok: false; reason: string; missing: string[] }
function lobTemplatesForFormat(format: "letter" | "personal_letter" | "postcard", env: Record<string, string>): T {
  const r = routeMailFormat(format, env)
  return r.ok ? { ok: true, templateId: r.templates.templateId, backTemplateId: r.templates.backTemplateId, pieceType: r.templates.pieceType, provenance: r.templates.provenance } : { ok: false, reason: r.reason, missing: r.waitingExternal }
}

const FOUR = { LOB_LETTER_TEMPLATE_ID: "tmpl_letter", LOB_PERSONAL_LETTER_TEMPLATE_ID: "tmpl_personal", LOB_POSTCARD_FRONT_TEMPLATE_ID: "tmpl_front", LOB_POSTCARD_BACK_TEMPLATE_ID: "tmpl_back" }

async function main() {
  console.log("\n[A · four distinct template ids, by NAME]")
  {
    check("the canonical env names are exactly the owner's four", LOB_TEMPLATE_ENV.letter.name === "LOB_LETTER_TEMPLATE_ID" && LOB_TEMPLATE_ENV.personal_letter.name === "LOB_PERSONAL_LETTER_TEMPLATE_ID" && LOB_TEMPLATE_ENV.postcard_front.name === "LOB_POSTCARD_FRONT_TEMPLATE_ID" && LOB_TEMPLATE_ENV.postcard_back.name === "LOB_POSTCARD_BACK_TEMPLATE_ID")
    check("the optional handwriting provider is a NAME (LOB_HANDWRITTEN_CARD_PROVIDER)", HANDWRITTEN_CARD_PROVIDER_ENV === "LOB_HANDWRITTEN_CARD_PROVIDER")
    const L = lobTemplatesForFormat("letter", FOUR), P = lobTemplatesForFormat("personal_letter", FOUR), C = lobTemplatesForFormat("postcard", FOUR)
    check("all four distinct → letter, personal letter and postcard each resolve", L.ok && P.ok && C.ok)
    check("the postcard's back is a DIFFERENT id from its front", C.ok && C.templateId === "tmpl_front" && C.backTemplateId === "tmpl_back")
    check("the personal letter is its own template (not the ordinary letter)", L.ok && P.ok && L.templateId !== P.templateId && P.pieceType === "letter")
    const backIsFront = lobTemplatesForFormat("postcard", { ...FOUR, LOB_POSTCARD_BACK_TEMPLATE_ID: "tmpl_front" })
    check("REFUSED: a postcard whose back id equals its front id", !backIsFront.ok && /share one Lob template id/.test(backIsFront.ok ? "" : backIsFront.reason))
    check("CONTROL: the same env with a distinct back resolves (the refusal is the alias, not the postcard)", lobTemplatesForFormat("postcard", FOUR).ok)
    const personalIsLetter = { ...FOUR, LOB_PERSONAL_LETTER_TEMPLATE_ID: "tmpl_letter" }
    check("REFUSED: personal letter sharing the letter's id refuses BOTH formats", !lobTemplatesForFormat("letter", personalIsLetter).ok && !lobTemplatesForFormat("personal_letter", personalIsLetter).ok)
    check("…while the untouched postcard still resolves", lobTemplatesForFormat("postcard", personalIsLetter).ok)
    const legacyDefaults = { LOB_DEFAULT_TEMPLATE_ID: "tmpl_x", LOB_DEFAULT_LETTER_TEMPLATE_ID: "tmpl_x", LOB_POSTCARD_BACK_ID: "tmpl_b" }
    check("REFUSED: the legacy default ids aliasing letter and postcard front (the direct-mail-trigger default) are caught", !lobTemplatesForFormat("letter", legacyDefaults).ok && !lobTemplatesForFormat("postcard", legacyDefaults).ok)
    const legacyOk = lobTemplatesForFormat("postcard", { LOB_POSTCARD_FRONT_ID: "old_f", LOB_POSTCARD_BACK_ID: "old_b" })
    check("legacy names still resolve (nothing configured goes dark) and are flagged legacy", legacyOk.ok && legacyOk.provenance.slots.postcard_front?.legacy === true && legacyOk.provenance.slots.postcard_front?.envName === "LOB_POSTCARD_FRONT_ID")
    const none = lobTemplatesForFormat("personal_letter", {})
    check("REFUSED: a format with no id, naming the env var to set", !none.ok && none.missing.includes("LOB_PERSONAL_LETTER_TEMPLATE_ID"))
    const halfPostcard = lobTemplatesForFormat("postcard", { LOB_POSTCARD_FRONT_TEMPLATE_ID: "f" })
    check("REFUSED: a postcard with a front and no back", !halfPostcard.ok && halfPostcard.missing.includes("LOB_POSTCARD_BACK_TEMPLATE_ID"))
    const fbGlobal = fallbackLobTemplates("postcard", "tenant_tmpl", FOUR)
    check("render fallback: the GLOBAL format template wins over a per-tenant id (R5)", fbGlobal.ok && fbGlobal.source === "global_format_template" && fbGlobal.templateId === "tmpl_front" && fbGlobal.backTemplateId === "tmpl_back")
    const fbLegacyNoBack = fallbackLobTemplates("postcard", "tenant_tmpl", {})
    check("render fallback REFUSES a legacy postcard front with no distinct back (no front-on-both-sides)", !fbLegacyNoBack.ok)
    const fbLegacySameBack = fallbackLobTemplates("postcard", "tenant_tmpl", { LOB_POSTCARD_BACK_TEMPLATE_ID: "tenant_tmpl" })
    check("render fallback REFUSES a legacy front equal to the global back", !fbLegacySameBack.ok)
    const fbLegacy = fallbackLobTemplates("postcard", "tenant_tmpl", { LOB_POSTCARD_BACK_TEMPLATE_ID: "tmpl_back" })
    check("render fallback: a legacy front + distinct global back is allowed and labelled legacy_tenant_template", fbLegacy.ok && fbLegacy.source === "legacy_tenant_template" && fbLegacy.backTemplateId === "tmpl_back")
  }

  console.log("\n[B · a typeface is never called handwriting]")
  {
    // Re-asserted to the RULE (wave 151, lane 151H — owner: "handwritten font by computer can be a substitute", described as
    // handwriting-STYLE PRINTED mail): the label says PRINTED and handwriting-STYLE, and never "handwritten". The wave-150
    // check pinned the absence of "handwrit" entirely, which the owner's own wave-151 term contradicts.
    check("the personal letter's label says PRINTED and handwriting-STYLE, never 'handwritten'", /printed/i.test(MAIL_FORMAT_LABELS.personal_letter) && /handwriting-style/i.test(MAIL_FORMAT_LABELS.personal_letter) && !/handwritten/i.test(MAIL_FORMAT_LABELS.personal_letter))
    check("only the handwritten_card label uses the word 'handwritten', and it names a pen", Object.entries(MAIL_FORMAT_LABELS).filter(([, l]) => /handwritten/i.test(l)).map(([k]) => k).join() === "handwritten_card" && /pen/i.test(MAIL_FORMAT_LABELS.handwritten_card))
    const hwNone = routeMailFormat("handwritten_card", FOUR)
    check("handwritten_card is refused with no provider configured — and NOT downgraded to a typeset letter", !hwNone.ok && hwNone.downgrade === null)
    const hwLettr = routeMailFormat("handwritten_card", { ...FOUR, LOB_HANDWRITTEN_CARD_PROVIDER: "lettrlabs" })
    check("handwritten_card naming lettrlabs is still refused: the provider is DORMANT (WAITING_EXTERNAL)", !hwLettr.ok && /dormant/.test(hwLettr.ok ? "" : hwLettr.reason) && hwLettr.waitingExternal.some((n) => /checkout/.test(n)))
    const hwAm = routeMailFormat("handwritten_card", { LOB_HANDWRITTEN_CARD_PROVIDER: "amcards" })
    check("AMcards is not accepted as a handwriting provider (its own page: 'We Print')", !hwAm.ok && OPTIONAL_MAIL_PROVIDERS.amcards.capability === "printed_greeting_card")
    check("every optional provider is dormant (no adapter, no purchase)", Object.values(OPTIONAL_MAIL_PROVIDERS).every((p) => p.status === "dormant"))
    check("a campaign 'handwritten_letter' / 'thank_you_note' row is the PRINTED personal letter", formatForCampaignPieceType("handwritten_letter") === "personal_letter" && formatForCampaignPieceType("thank_you_note") === "personal_letter" && formatForCampaignPieceType("postcard_6x9") === "postcard")
    const keys = Object.keys(buildMailMergeVariables(brandA()).mergeVars)
    check("no merge variable is named handwritten (the note's typeface variables are note_font_*)", keys.every((k) => !/handwritten/i.test(k)))
    const rep = code("app/actions/reputation-kernel.ts")
    const repStr = noComments("app/actions/reputation-kernel.ts")
    check("the mailed card's refusal text no longer calls the printed card handwritten", !/a handwritten card needs/.test(repStr) && /a mailed card needs/.test(repStr))
    check("CONTROL: the finder sees the old phrase in a specimen", /a handwritten card needs/.test(`error: "a handwritten card needs street"`))
    check("the card routes personal_letter → postcard through routeMailFormat; no direct LOB_ env read remains", /routeMailFormat\(/.test(rep) && !/process\.env\.LOB_/.test(rep))
  }

  console.log("\n[C · a carrier scan is never household receipt]")
  {
    const events = ["postcard.created", "letter.rendered_pdf", "postcard.mailed", "letter.in_transit", "postcard.in_local_area", "letter.processed_for_delivery", "postcard.delivered", "letter.re-routed", "postcard.returned_to_sender", "letter.deleted", "letter.something_new"]
    const readings = events.map(mailOutcomeFromLobEvent)
    check("no Lob event proves household receipt (householdReceiptProven is false for every event)", readings.every((r) => r.householdReceiptProven === false))
    check("'delivered' reads delivered_per_carrier_scan", mailOutcomeFromLobEvent("postcard.delivered").outcome === "delivered_per_carrier_scan")
    check("returned_to_sender is terminal and maps to delivery_status 'returned'", (() => { const r = mailOutcomeFromLobEvent("letter.returned_to_sender"); return r.terminal && r.deliveryStatus === "returned" })())
    check("an unknown event is 'unknown', never a success", mailOutcomeFromLobEvent("letter.something_new").outcome === "unknown")
    check("the outcome vocabulary has no received / read / opened value", !MAIL_DELIVERY_OUTCOMES.some((o) => /receiv|read|open/.test(o)))
    check("CONTROL: the finder would catch a 'received' value", ["accepted", "received_by_household"].some((o) => /receiv|read|open/.test(o)))
    const mig = read("supabase/migrations/m985-direct-mail-format-provenance-and-piece-outcomes.sql")
    const m = /delivery_outcome in \(([^)]*)\)/s.exec(mig)
    const migVals = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : []
    check("m985's delivery_outcome CHECK equals MAIL_DELIVERY_OUTCOMES (derived, not pinned)", JSON.stringify(migVals) === JSON.stringify([...MAIL_DELIVERY_OUTCOMES].sort()), `${migVals.length} vs ${MAIL_DELIVERY_OUTCOMES.length}`)
    const fm = /mail_format in \(([^)]*)\)/s.exec(mig)
    check("m985's mail_format CHECK equals MAIL_FORMATS", fm != null && [...fm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort().join() === Object.keys(MAIL_FORMAT_LABELS).sort().join())
  }

  console.log("\n[D · per-tenant customisation is DATA (two tenants, two offices, two senders)]")
  {
    const a = buildMailMergeVariables(brandA(), { recipientName: "Rosa Diaz", qrDestinationUrl: "https://a.example/api/qr/scan?slug=aaa", frontArtUrl: "https://cdn.a.example/front.png", bodies: { note_body: "Thank you for trusting us with the move." } })
    const b = buildMailMergeVariables(brandB(), { recipientName: "Rosa Diaz", qrDestinationUrl: "https://b.example/api/qr/scan?slug=bbb" })
    for (const k of ["brand_logo_url", "brand_legal_name", "office_name", "return_address_line1", "brand_font_css_url", "qr_destination_url", "agent_license_line", "brand_tagline"]) {
      check(`same global template, different tenant data: ${k} differs`, a.mergeVars[k] !== b.mergeVars[k], `${a.mergeVars[k]} / ${b.mergeVars[k]}`)
    }
    check("the builder prints an office when the brand facts carry one", a.mergeVars.office_name === "Riverside Office" && b.mergeVars.office_name === "Harbor Office")
    const pt = noComments("lib/direct-mail/piece-type.ts")
    check("…and the async reader resolves the sender's office through THE one office rule (resolveUserOffice), reads its name pinned to the tenant, and records where it came from",
      /resolveUserOffice\(svc as never, args\.agentUserId\)/.test(pt) && /from\("locations"\)\.select\("name"\)\.eq\("id", office\.locationId\)\.eq\("brokerage_id", args\.brokerageId\)/.test(pt) && /office: officeSource/.test(pt) && !/officeName: null,/.test(pt))
    check("the legal brokerage identity is the brokerage of record (not the team display name)", a.mergeVars.brand_legal_name === "Alder Realty LLC" && a.mergeVars.brand_display_name === "The Alder Team")
    check("the hosted @font-face stylesheet is built from the tenant's font family", a.mergeVars.brand_font_css_url === "https://fonts.googleapis.com/css2?family=Libre+Baskerville&display=swap")
    check("disclosures pass VERBATIM (legal text never rewritten)", a.mergeVars.disclosure_long === brandA().disclosureLong && a.mergeVars.disclosure_short === brandA().disclosureShort)
    check("the agent's own words pass through untouched", a.mergeVars.note_body === "Thank you for trusting us with the move.")
    const insecure = buildMailMergeVariables({ ...brandA(), logoUrl: "http://insecure/logo.png" }, { frontArtUrl: "javascript:alert(1)" })
    check("a non-https asset is dropped (Lob must fetch it; nothing else is printed)", insecure.mergeVars.brand_logo_url === "" && insecure.mergeVars.front_art_url === "" && insecure.missing.includes("brand_logo_url"))
    check("every merge variable name is snake_case (Lob: no whitespace / special characters)", Object.keys(a.mergeVars).every((k) => /^[a-z0-9_]+$/.test(k)))
    check("every value is a string", Object.values(a.mergeVars).every((v) => typeof v === "string"))
    check("an over-size object is flagged for refusal (Lob's 25,000-character cap)", buildMailMergeVariables(brandA(), { bodies: { copy_text: "x".repeat(26000) } }).oversize === true && a.oversize === false)
    check("no merge variable carries the platform's name on a tenant piece", !Object.values(a.mergeVars).some((v) => /vipagents/i.test(v)))
  }

  console.log("\n[E · no double charge — the real action ledger on memSupabase]")
  {
    const svc = memSupabase({ agent_action_ledger: [] }, { unique: { agent_action_ledger: [["idempotency_key"]] }, uuidIds: true })
    let charges = 0
    const lobCharge = async (): Promise<DispatchLike> => { charges++; return { success: true, providerKey: "lob", messageId: `psc_${charges}` } }
    const hooks = { settle: (r: DispatchLike) => settleDispatchResult(r, 0.909), replay: replayDispatchResult }
    const ctx = (key: string) => ({ brokerageId: "b-1", action: "comms.direct_mail.send", channel: "direct_mail", actor: { type: "user" as const, userId: "u-1" }, subject: { type: "recipient" as const, id: null, ref: "1 Elm St, 30301" }, idempotencyKey: key, riskClass: "COMMUNICATION" as const })
    const k1 = mailPieceIdempotencyKey("campaign_recipient", "camp-1", "rec-1")
    const first = await withActionLedger(ctx(k1), lobCharge, hooks, { client: svc })
    const second = await withActionLedger(ctx(k1), lobCharge, hooks, { client: svc })
    check("the same piece sent twice charges Lob ONCE", charges === 1, `charges=${charges}`)
    check("the retry is a REPLAY of the first (same Lob piece id, reported success)", first.success && second.success && second.messageId === first.messageId)
    await withActionLedger(ctx(mailPieceIdempotencyKey("campaign_recipient", "camp-1", "rec-2")), lobCharge, hooks, { client: svc })
    check("CONTROL: a different recipient is a different piece and IS charged", charges === 2)
    const thank = mailPieceIdempotencyKey("thank_you_note", "note-9")
    await withActionLedger(ctx(thank), lobCharge, hooks, { client: svc })
    await withActionLedger(ctx(thank), lobCharge, hooks, { client: svc })
    check("a double-clicked thank-you card is charged once", charges === 3)
    check("keys differ by kind (a drain piece never collides with a campaign recipient)", mailPieceIdempotencyKey("drain_campaign", "x") !== mailPieceIdempotencyKey("campaign_recipient", "x"))
  }

  console.log("\n[F · one ledger vocabulary — the live status CHECK]")
  {
    const vocab = read("scripts/check-vocabularies.ts")
    // The cache lists a table's columns in NAME order (m985 added mail_format / proof_status ahead of status), so the
    // status row is found INSIDE the table's block, wherever it sits — pinning it as the first key read a live CHECK as absent.
    const block = /direct_mail_campaigns:\s*\{([^}]*)\}/.exec(vocab)
    const cm = block ? /\bstatus:\s*\[([^\]]*)\]/.exec(block[1]) : null
    const allowed = new Set(cm ? [...cm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [])
    check("POSITIVE CONTROL: the status row is read wherever it sits in the table block (a block whose first key is another column still yields it)",
      (() => { const b = /direct_mail_campaigns:\s*\{([^}]*)\}/.exec('direct_mail_campaigns: {\n    mail_format: ["letter"],\n    status: ["mailed", "failed"],\n  },'); const m = b ? /\bstatus:\s*\[([^\]]*)\]/.exec(b[1]) : null; return !!m && /mailed/.test(m[1]) })())
    check("the generated vocabulary cache carries the direct_mail_campaigns status CHECK", allowed.has("mailed") && allowed.has("failed"))
    const writers = ["lib/direct-mail/campaign-drain.ts", "lib/direct-mail/listing-lifecycle-mail-reactor.ts", "app/actions/direct-mail.ts"]
    const statusLiteral = /\bstatus:\s*(?:[^,\n]*\?\s*)?"([a-z_]+)"(?:\s*:\s*"([a-z_]+)")?/g
    const bad: string[] = []
    // Only the WRITE windows on direct_mail_campaigns are judged (a function's own result-object status —
    // "dispatched", "already_sent" — is not a column write): from("direct_mail_campaigns") to the next from(.
    const campaignWindows = (s: string): string[] => {
      const out: string[] = []
      for (const mm of s.matchAll(/from\("direct_mail_campaigns"\)/g)) {
        const start = mm.index ?? 0
        const head = s.slice(start, start + 160)
        const w = /\.\s*(update|insert)\(\{/.exec(head)
        if (!w) continue
        const body = s.slice(start + w.index, start + w.index + 2000)
        const end = body.indexOf("})")
        out.push(end === -1 ? body : body.slice(0, end + 2))
      }
      return out
    }
    let windows = 0
    for (const f of writers) {
      const s = noComments(f)
      for (const seg of campaignWindows(s)) { windows++; for (const mm of seg.matchAll(statusLiteral)) for (const v of [mm[1], mm[2]].filter(Boolean)) if (!allowed.has(v)) bad.push(`${f}: ${v}`) }
      for (const mm of s.matchAll(/campaignStatus\s*=\s*[^\n]*/g)) for (const v of mm[0].matchAll(/"([a-z_]+)"/g)) if (!allowed.has(v[1])) bad.push(`${f}: campaignStatus ${v[1]}`)
    }
    check(`no mail writer stamps a campaign status the live CHECK refuses ('sent' / 'partial') — ${windows} write windows judged`, bad.length === 0 && windows >= 6, bad.join("; "))
    const specimen = `svc.from("direct_mail_campaigns").update({ status: result.success ? "sent" : "failed" })`
    check("CONTROL: the finder catches the old 'sent' stamp in a specimen", campaignWindows(specimen).some((seg) => [...seg.matchAll(statusLiteral)].some((mm) => mm[1] === "sent" && !allowed.has("sent"))))
    const reactor = code("lib/direct-mail/listing-lifecycle-mail-reactor.ts")
    check("the lifecycle sentinel no longer writes a LISTING id into the marketing_campaigns FK", !/marketing_campaign_id\s*:\s*args\.listingId/.test(reactor) && !/\.eq\("marketing_campaign_id", args\.listingId\)/.test(noComments("lib/direct-mail/listing-lifecycle-mail-reactor.ts")))
    check("the lifecycle sentinel insert reads its error", /const \{ error: sentinelErr \} = await svc\.from\("direct_mail_campaigns"\)\.insert/.test(noComments("lib/direct-mail/listing-lifecycle-mail-reactor.ts")))
  }

  console.log("\n[G · wiring]")
  {
    const dm = noComments("app/actions/direct-mail.ts")
    check("sendCampaign never hands a campaign UUID to Lob as a template", !/campaign\.design_url \?\? campaign\.id/.test(dm))
    check("sendCampaign routes the campaign's format through routeMailFormat", /routeMailFormat\(formatForCampaignPieceType\(/.test(dm))
    check("sendCampaign passes the format's back template and piece type", /backTemplateId: route\.templates\.backTemplateId/.test(dm) && /pieceType: route\.templates\.pieceType/.test(dm))
    check("sendCampaign resolves brand merge variables at proof time (sending user + team)", /readMailBrandFacts\(\{[^}]*agentUserId: params\.actorUserId/.test(dm) && /buildMailMergeVariables\(brandRead\.facts/.test(dm))
    check("sendCampaign stays session-gated, stamps its initiator, and dispatches under the per-piece ledger key", /const actor = await getAgentContext\(\)/.test(dm) && /approved_by_user_id: params\.actorUserId/.test(dm) && /mailPieceIdempotencyKey\("campaign_recipient", params\.campaignId, recipient\.id\)/.test(dm))
    check("preview is a Lob TEST-key proof and returns before any dispatch", /if \(params\.previewOnly\)[\s\S]*createLobProof\(process\.env\.LOB_TEST_API_KEY/.test(dm) && dm.indexOf("if (params.previewOnly)") < dm.indexOf("const lobResult = await dispatchDirectMail("))
    check("trackDelivery settles each Lob event onto the recipient's provider piece id and COUNTS the match", /\.eq\("provider_piece_id", pieceId\)\s*\.select\("id"\)/.test(dm) && /mailOutcomeFromLobEvent\(lobEvent\)/.test(dm))
    // Wave 151 (151H): the fallback names the piece's FORMAT (the personal note takes its own global layout) — the rule is
    // "through fallbackLobTemplates, with the tenant's legacy id as the measured fallback", not the exact argument text.
    check("orchestrate-send's fallback goes through fallbackLobTemplates with brand merge variables", /fallbackLobTemplates\((?:format === "personal_letter" \? "personal_letter" : )?args\.pieceType, args\.fallbackTemplateId\)/.test(noComments("lib/direct-mail/orchestrate-send.ts")) && /mergeVars: fallbackMergeVars/.test(noComments("lib/direct-mail/orchestrate-send.ts")))
    check("orchestrate-preset-send's fallback goes through fallbackLobTemplates", /fallbackLobTemplates\(preset\.piece_type, preset\.fallback_template_id\)/.test(noComments("lib/direct-mail/orchestrate-preset-send.ts")))
    check("the drain and the lifecycle reactor dispatch under a per-piece idempotency key", /mailPieceIdempotencyKey\("drain_campaign", row\.id\)/.test(noComments("lib/direct-mail/campaign-drain.ts")) && /mailPieceIdempotencyKey\("lifecycle", args\.listingId, args\.eventType, contactId\)/.test(noComments("lib/direct-mail/listing-lifecycle-mail-reactor.ts")))
    const live = await createLobProof("live_abc123", { pieceType: "letter", to: { name: "A", address_line1: "1 Elm", address_city: "X", address_state: "GA", address_zip: "30301" }, templateId: "tmpl_letter", mergeVariables: {} })
    check("NO LIVE SPEND: a live key is refused by the proof adapter before the SDK is touched", !live.ok && /TEST key/.test(live.error ?? ""))
    const alias = await createLobProof("test_abc123", { pieceType: "postcard", to: { name: "A", address_line1: "1 Elm", address_city: "X", address_state: "GA", address_zip: "30301" }, templateId: "same", backTemplateId: "same", mergeVariables: {} })
    check("a postcard proof with front = back is refused before any call", !alias.ok && /distinct/.test(alias.error ?? ""))
    const none = await createLobProof("", { pieceType: "letter", to: { name: "A", address_line1: "1", address_city: "X", address_state: "GA", address_zip: "1" }, templateId: "t", mergeVariables: {} })
    check("no test key → 'unconfigured', said (the preview is unavailable, never faked)", !none.ok && /^unconfigured/.test(none.error ?? ""))
  }

  console.log("\n[H · no live spend, no LettrLabs double checkout]")
  {
    const files: string[] = []
    const walk = (dir: string) => { for (const n of readdirSync(join(root, dir))) { const p = join(dir, n); if (n === "node_modules" || n.startsWith(".")) continue; const st = statSync(join(root, p)); if (st.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(n)) files.push(p) } }
    walk("lib"); walk("app")
    const HOSTS = /api\.lettrlabs\.com|lettrlabs\.com\/v1|\/v1\/order\/[^"'`]*\/checkout|api\.handwrytten\.com|amcards\.com\/\.api|pcmintegrations\.com\/api|postcardmania\.com\/api/i
    const hits = files.filter((f) => HOSTS.test(stripComments(read(f))))
    check("no optional mail provider is called from lib/ or app/ (no adapter, no checkout, no purchase)", hits.length === 0, hits.join(", "))
    check("CONTROL: the finder recognises a LettrLabs checkout call in a specimen", HOSTS.test(`await fetch("https://api.lettrlabs.com/v1/order/" + id + "/checkout")`))
    check(`scanned ${files.length} source files (denominator)`, files.length > 1000)
    check("the canary ran with no Lob key in the environment", !process.env.LOB_API_KEY && !process.env.LOB_TEST_API_KEY)
  }

  console.log("\n[I · the price comparison is sourced; migration stamp]")
  {
    const doc = read("docs/commercial/DIRECT-MAIL-PROVIDER-COMPARISON.md")
    const s12 = doc.slice(doc.indexOf("## 12."))
    check("§12 exists", doc.includes("## 12."))
    for (const p of ["Lob", "LettrLabs", "Handwrytten", "AMcards", "PostcardMania", "PCM"]) check(`§12 cost table has a ${p} row`, new RegExp(`\\|\\s*\\*\\*${p}`).test(s12))
    check("§12 compares printed + postage + minimum + platform fee (column headers)", /Printed[^|]*\|\s*Postage\s*\|[^|]*\|\s*Minimum\s*\|[^|]*platform fee/i.test(s12))
    check("§12 cites official URLs with a read date", (s12.match(/<https:\/\/[^>]+>/g) ?? []).length >= 10 && /read 2026-11-06/.test(s12))
    check("§12 says 'unconfirmed' where a vendor publishes no price", (s12.match(/unconfirmed/gi) ?? []).length >= 5)
    // Re-asserted to the RULE (wave 151, lane 151H): the owner's own term is "handwriting-style printed"; what the doc must never
    // do is call a printed note handwritten.
    check("the doc never calls the printed personal note handwritten", !/handwritten (personal )?(letter|note)\b(?! only| cards? come)/i.test(doc.replace(/handwritten card provider|handwritten-card provider|handwritten cards? \(/gi, "")))
    const mig = read("supabase/migrations/m985-direct-mail-format-provenance-and-piece-outcomes.sql").split("\n")[0]
    check("m985 line 1 is the lane stamp or the APPLIED stamp", mig.startsWith("-- WRITTEN, NOT APPLIED (wave 150, lane 150R)") || mig.startsWith("-- ── APPLIED LIVE "))
  }

  // ── wave 150, lane 150Z convergence: the dispatcher and every Lob-id caller go through the ONE router ──
  {
    const disp = noComments("lib/providers/dispatch.ts")
    // Wave 151 (151H): the inline `from` is now the ONE sender gate's answer (decideSenderAddress) — the platform fallback is gone.
    check("the dispatcher refuses a back that IS the front (no LOB_POSTCARD_BACK_ID ?? front fallback) and takes the tenant's inline `from` from the sender gate",
      /back === params\.templateId/.test(disp) && !/backTemplateId \?\? process\.env\.LOB_POSTCARD_BACK_ID/.test(disp) && /const from = senderGate\.from/.test(disp))
    const DIRECT_LOB_ID = /process\.env\.LOB_(?:DEFAULT_TEMPLATE_ID|DEFAULT_LETTER_TEMPLATE_ID|PRELISTING_[A-Z_]+|POSTCARD_BACK_ID)\b/
    check("POSITIVE CONTROL: the direct-Lob-id finder sees a planted read", DIRECT_LOB_ID.test(stripComments("const t = process.env.LOB_DEFAULT_TEMPLATE_ID ?? ''\n")))
    const callers = ["lib/ai-isa/direct-mail-trigger.ts", "app/actions/ai-isa.ts", "lib/agents/marketing-agent-actions.ts", "lib/workflow-orchestrator/chains/listing-appt-prep.ts"]
    const direct = callers.filter((f) => DIRECT_LOB_ID.test(noComments(f)))
    check("the four former direct Lob-id readers take routeMailFormat(format).templates — none reads a Lob template env name itself", direct.length === 0 && callers.every((f) => /routeMailFormat\(/.test(noComments(f))), direct.join(", "))
    check("the campaign door passes the tenant's return address to the dispatcher (fromAddress from the brand cascade)", /fromAddress: brandRead\.facts\.returnAddress/.test(noComments("app/actions/direct-mail.ts")))
  }

  console.log("\n  Blind spots:")
  console.log("  · sendCampaign / trackDelivery / the reputation card are server actions with a cookie session: their wiring is proven on STRIPPED source, the decisions they call (router, merge builder, outcome map, ledger key) at runtime")
  console.log("  · readMailBrandFacts (the async reader over resolveBrandContext) is not driven here — it reads real server clients; buildMailMergeVariables, which it feeds, is. The sender's office is read through resolveUserOffice (stripped-source proof above); an office return address does not exist (`locations` has no ZIP)")
  console.log("  · memSupabase has no CHECKs: the live status CHECK is read from the generated cache scripts/check-vocabularies.ts; m985's CHECKs are read from the migration file, whose line-1 stamp says whether it is applied")
  console.log("  · whether a Google Fonts family exists, and whether Lob renders a merge-variable font URL, are unverified without a Lob test render (LOB_TEST_API_KEY)")
  console.log("  · wave 151 (151H): the dispatcher no longer falls back to the platform LOB_RETURN_ADDRESS_ID — a missing tenant sender address is REFUSED by name (test:direct-mail-rendering §C/§D); an office address still does not exist (`locations` has no ZIP)")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

function brandA(): MailBrandFacts {
  return {
    displayName: "The Alder Team", legalBrokerageName: "Alder Realty LLC", dba: "Alder Homes", teamName: "The Alder Team", officeName: "Riverside Office",
    agentName: "Maya Chen", agentLicenseLine: "GA License # 123456", agentPhotoUrl: "https://cdn.a.example/maya.jpg",
    logoUrl: "https://cdn.a.example/logo.png", primaryColor: "#0F172A", secondaryColor: "#64748B", accentColor: "#F59E0B",
    fontFamily: "Libre Baskerville", tagline: "Rooted where you are.", website: "alderhomes.example", phone: "404-555-0100",
    // Wave 151 (151H): the return address is the TENANT's SenderAddress with its CASS evidence (mailing-cass-gate.ts).
    returnAddress: { name: "Alder Realty LLC", line1: "12 Peachtree St", city: "Atlanta", state: "GA", zip: "30303", source: "tenant_return_address", verification: { method: "lob_cass", deliverability: "deliverable", verifiedAt: "2026-11-09T00:00:00Z" } },
    disclosureShort: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
    disclosureLong: "Alder Realty LLC is committed to the principles of the Fair Housing Act and the Equal Credit Opportunity Act.",
  }
}
function brandB(): MailBrandFacts {
  return {
    displayName: "Harbor & Pine Realty", legalBrokerageName: "Harbor & Pine Realty Inc.", teamName: null, officeName: "Harbor Office",
    agentName: "Luis Ortega", agentLicenseLine: "FL License # SL998877", logoUrl: "https://cdn.b.example/hp.svg",
    primaryColor: "#1E3A8A", secondaryColor: "#94A3B8", accentColor: "#10B981", fontFamily: "Lora", tagline: "Coastal know-how, neighbourly care.",
    website: "harborpine.example", phone: "850-555-0199",
    returnAddress: { name: "Harbor & Pine Realty Inc.", line1: "400 Bay Ave", city: "Pensacola", state: "FL", zip: "32502", source: "tenant_return_address", verification: { method: "lob_cass", deliverability: "deliverable", verifiedAt: "2026-11-09T00:00:00Z" } },
    disclosureShort: "Equal Housing Opportunity.", disclosureLong: "Harbor & Pine Realty Inc. is committed to the Fair Housing Act.",
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
