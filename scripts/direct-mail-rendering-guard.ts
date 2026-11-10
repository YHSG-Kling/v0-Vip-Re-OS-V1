/**
 * scripts/direct-mail-rendering-guard.ts — test:direct-mail-rendering (wave 151, lane 151H).
 *
 * Owner (verbatim): "direct mail, the rendered pieces should not use the platform return address"; "the direct mail
 * templates should be blank templates with just layout"; "handwritten font by computer can be a substitute".
 * Directive 151H rendering proof contract: "template is a format/layout only; on each piece look up the specific tenant's
 * sender address/branding, per-Contact dynamic copy, appropriate license/disclosure, QR destination and attribution. Refuse
 * missing/invalid sender address rather than substituting the platform address. Test two tenants on the same blank layout
 * to prove logos, return address, Contacts, images and QR never cross. Separate 'API accepted', 'charge settled',
 * 'printed', 'mailed', 'delivered' and 'returned'; a successful HTTP response is not proof of delivery. Retain physical
 * proof previews and duplicate-send/idempotency protection."
 *
 * Sections (every absence assertion carries a POSITIVE CONTROL — CLAUDE.md §2; code-token scans read STRIPPED source):
 *   A. blank layouts — the library is format-only (no brand, no address, no platform identity), each slot distinct by NAME,
 *      format ↔ template id distinct, every declared merge variable is one the builder emits; notecard EVALUATED—NOT IMPLEMENTED
 *   B. two tenants on the same blank layout never cross — logos, return address, Contacts, images, QR, legal identity; the
 *      sender resolver on the in-memory client returns each tenant its own row and honors user > team > tenant > brokerage
 *   C. the platform return address is REFUSED as a sender (saved Lob id; the platform's name; the planted id) — positive control
 *   D. a missing / incomplete / unverified / undeliverable sender address is refused BY NAME
 *   E. handwriting-STYLE is labeled PRINTED everywhere; "handwritten" is reserved for a pen provider
 *   F. delivery truth — six separate states; an API 200 is `apiAccepted` and nothing else; returned mail updates the record and
 *      stops the sequence (real applyReturnedMailHandling on the in-memory client, counted); a wrong tenant changes nothing
 *   G. idempotent re-send — the per-piece ledger key replays, never re-charges (real withActionLedger on memSupabase)
 *   H. tenant approval before send + the whole-batch spend guard (pure gate + stripped-source wiring)
 *   I. wiring — the dispatcher gate (no platform fallback), every mail door passes the tenant's address, the 151I hook exists
 *   J. migrations m980 / m981 — stamps, the sender table, the evidence columns the code writes
 *   K. cost strategy — notecard / PostcardMania / AMcards EVALUATED—NOT IMPLEMENTED; every optional provider dormant
 *
 * No network, no Lob key, no paid mailing: LOB_API_KEY / LOB_TEST_API_KEY are deleted at start.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import {
  LOB_TEMPLATE_ENV, MAIL_FORMAT_LABELS, MAIL_LAYOUT_LIBRARY, HANDWRITING_STYLE_TYPEFACE, MAIL_DELIVERY_OUTCOMES,
  OPTIONAL_MAIL_PROVIDERS, routeMailFormat, fallbackLobTemplates, buildMailMergeVariables, layoutContentViolations,
  pickSenderAddressRow, senderAddressFromRow, resolveTenantSenderAddress,
  campaignSendGate, applyReturnedMailHandling, mailPieceIdempotencyKey, mailTemplateProvenance, formatForCampaignPieceType,
  type MailBrandFacts, type SenderAddressRow,
} from "../lib/direct-mail/piece-type"
import { mailPieceTruth, mailOutcomeFromLobEvent } from "../lib/direct-mail/mail-piece-rules"
import { decideSenderAddress, senderAddressShapeRefusal, planReturnedMailHandling, type SenderAddress } from "../lib/providers/mailing-cass-gate"
import { DEFAULT_PRODUCT_BRAND } from "../lib/platform/product-brand"
import { withActionLedger, settleDispatchResult, replayDispatchResult, type DispatchLike } from "../lib/kernel/action-ledger"

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

const FOUR = { LOB_LETTER_TEMPLATE_ID: "tmpl_letter", LOB_PERSONAL_LETTER_TEMPLATE_ID: "tmpl_personal", LOB_POSTCARD_FRONT_TEMPLATE_ID: "tmpl_front", LOB_POSTCARD_BACK_TEMPLATE_ID: "tmpl_back" }
const PLATFORM_ID = "adr_platform000000"

const verified = (over: Partial<SenderAddress> = {}): SenderAddress => ({
  name: "Alder Realty LLC", line1: "12 Peachtree St", line2: null, city: "Atlanta", state: "GA", zip: "30303", source: "tenant_return_address",
  verification: { method: "lob_cass", deliverability: "deliverable", verifiedAt: "2026-11-09T00:00:00Z" }, addressId: "sa-a", approvedByUserId: "u-admin-a", ...over,
})

async function main() {
  console.log("\n[A · blank layouts: format only, distinct by NAME]")
  {
    const lib = MAIL_LAYOUT_LIBRARY
    const withSlots = Object.values(lib).filter((l) => l.slot)
    check("five layouts: letter, personal note, postcard front, postcard back, notecard", Object.keys(lib).sort().join() === ["letter", "notecard", "personal_letter", "postcard_back", "postcard_front"].join())
    check("the four printable layouts name four DISTINCT Lob slots, exactly the env-name slots", withSlots.length === 4 && new Set(withSlots.map((l) => l.slot)).size === 4 && withSlots.every((l) => l.slot! in LOB_TEMPLATE_ENV))
    const L = routeMailFormat("letter", FOUR), P = routeMailFormat("personal_letter", FOUR), C = routeMailFormat("postcard", FOUR)
    const ids = [L.ok && L.templates.templateId, P.ok && P.templates.templateId, C.ok && C.templates.templateId, C.ok && C.templates.backTemplateId].filter(Boolean)
    check("format ↔ template id distinct: letter, personal note, postcard front and back resolve to four different ids", ids.length === 4 && new Set(ids).size === 4)
    check("a letterTemplateId is never reused for an incompatible format (personal note shares the letter's id → BOTH refused)", !routeMailFormat("personal_letter", { ...FOUR, LOB_PERSONAL_LETTER_TEMPLATE_ID: "tmpl_letter" }).ok)
    const builderKeys = new Set(Object.keys(buildMailMergeVariables(brandA(), { bodies: { copy_text: "x", note_body: "y" } }).mergeVars))
    for (const [k, l] of Object.entries(lib)) {
      const missing = l.mergeVariables.filter((v) => !builderKeys.has(v))
      check(`layout ${k}: every declared merge variable is one the builder emits (${l.mergeVariables.length} declared)`, missing.length === 0, missing.join(", "))
    }
    check("the layout texts carry no brand, address or platform identity (layoutContentViolations)", Object.values(lib).every((l) => layoutContentViolations(l.layout).length === 0 && layoutContentViolations(l.label).length === 0))
    const planted = layoutContentViolations("Sent by VIP Agents · 1234 Main Street, Austin, TX 78701 · from adr_9f8e7d6c5b4a")
    check("POSITIVE CONTROL: a planted platform name, a hard-coded street address and a saved Lob address id are each caught", planted.length === 3, planted.join(" | "))
    check("CONTROL: a clean tenant line passes the same finder", layoutContentViolations("Prepared by Maya Chen, The Alder Team — Alder Realty LLC").length === 0)
    for (const f of ["lib/direct-mail/render-letter.ts", "remotion/PostcardFront4x6.tsx", "remotion/PostcardBack4x6.tsx"]) {
      check(`in-repo layout ${f} carries no platform identity or hard-coded address`, layoutContentViolations(noComments(f)).length === 0, layoutContentViolations(noComments(f)).join(" | "))
    }
    check("render-letter.ts runs the same scan on its OUTPUT and refuses a piece that fails it", /layoutContentViolations\(html\)/.test(code("lib/direct-mail/render-letter.ts")) && /layout_content_refused/.test(noComments("lib/direct-mail/render-letter.ts")))
    check("the notecard layout is EVALUATED—NOT IMPLEMENTED (no Lob product), with the personal note as its substitute", lib.notecard.status === "unsupported_by_provider" && lib.notecard.slot === null && lib.notecard.substitute === "personal_letter" && /EVALUATED—NOT IMPLEMENTED/.test(lib.notecard.layout))
    check("the handwriting-style typeface is a LAYOUT constant: Google-hosted (Lob can fetch it), in its own family list, described as printed", HANDWRITING_STYLE_TYPEFACE.kind === "handwriting_style" && HANDWRITING_STYLE_TYPEFACE.families.includes(HANDWRITING_STYLE_TYPEFACE.family) && /^https:\/\/fonts\.googleapis\.com\//.test(HANDWRITING_STYLE_TYPEFACE.cssUrl) && /printed/.test(HANDWRITING_STYLE_TYPEFACE.description) && !/handwritten/i.test(HANDWRITING_STYLE_TYPEFACE.description))
    check("the personal-note layout sets the handwriting-style typeface and emits note_font_family / note_font_css_url", lib.personal_letter.typeface === "handwriting_style" && lib.personal_letter.mergeVariables.includes("note_font_css_url") && builderKeys.has("note_font_css_url"))
    const fbNote = fallbackLobTemplates("handwritten_letter", "tenant_tmpl", FOUR)
    check("a campaign 'handwritten_letter' / 'thank_you_note' row falls back to the GLOBAL personal-note layout (never the letter's, never a tenant template)", fbNote.ok && fbNote.templateId === "tmpl_personal" && fbNote.source === "global_format_template" && fallbackLobTemplates("thank_you_note", null, FOUR).ok)
    check("…and with no global personal-note template it is REFUSED rather than mailed on a legacy tenant template", !fallbackLobTemplates("handwritten_letter", "tenant_tmpl", { LOB_LETTER_TEMPLATE_ID: "l" }).ok)
  }

  console.log("\n[B · two tenants on the same blank layout never cross]")
  {
    const a = buildMailMergeVariables(brandA(), { recipientName: "Rosa Diaz", qrDestinationUrl: "https://a.example/api/qr/scan?slug=aaa", frontArtUrl: "https://cdn.a.example/front.png", pictureUrl: "https://cdn.a.example/house.jpg", bodies: { note_body: "Rosa — thank you for trusting us with the move." } })
    const b = buildMailMergeVariables(brandB(), { recipientName: "Tom Nguyen", qrDestinationUrl: "https://b.example/api/qr/scan?slug=bbb", frontArtUrl: "https://cdn.b.example/front.png", pictureUrl: "https://cdn.b.example/house.jpg", bodies: { note_body: "Tom — welcome to the Gulf side." } })
    for (const k of ["brand_logo_url", "return_name", "return_address_line1", "return_zip", "recipient_name", "recipient_first_name", "front_art_url", "picture_url", "qr_destination_url", "sender_legal_identity", "creator_attribution", "agent_license_line", "note_body"]) {
      check(`same layout, different tenant data: ${k} differs`, a.mergeVars[k] !== b.mergeVars[k], `${a.mergeVars[k]} / ${b.mergeVars[k]}`)
    }
    const aDistinct = new Set(Object.values(a.mergeVars).filter((v) => v && /alder|peachtree|a\.example|rosa|maya|30303/i.test(v)))
    check("no value of tenant A's piece appears anywhere on tenant B's piece", !Object.values(b.mergeVars).some((v) => aDistinct.has(v)))
    check("the return address printed is the TENANT's (name = its legal brokerage), on both pieces", a.mergeVars.return_name === "Alder Realty LLC" && b.mergeVars.return_name === "Harbor & Pine Realty Inc.")
    check("the sender's legal identity carries the brokerage of record and the license line", /Alder Realty LLC/.test(a.mergeVars.sender_legal_identity) && /GA License/.test(a.mergeVars.sender_legal_identity))
    check("creator attribution names the sending agent, the team and the brokerage of record", a.mergeVars.creator_attribution === "Prepared by Maya Chen, The Alder Team — Alder Realty LLC")
    check("no merge variable names the platform", !Object.values({ ...a.mergeVars, ...b.mergeVars }).some((v) => /vip\s?agents/i.test(v)))
    check("the handwriting-style typeface is the same LAYOUT constant for both tenants (a layout property, not brand)", a.mergeVars.note_font_family === b.mergeVars.note_font_family && a.mergeVars.note_font_family === HANDWRITING_STYLE_TYPEFACE.family)

    // The resolver on the in-memory client: each tenant gets its own row; precedence user > team > tenant default.
    const rows: SenderAddressRow[] = [
      row("sa-a", "b-A", "brokerage", "b-A", "Alder Realty LLC", "12 Peachtree St", "30303", { is_default: true }),
      row("sa-a-team", "b-A", "team", "t-A1", "The Alder Team", "900 Riverside Dr", "30307"),
      row("sa-a-user", "b-A", "user", "u-A-maya", "Maya Chen, Alder Realty LLC", "77 Oak Ln", "30309"),
      row("sa-a-unapproved", "b-A", "user", "u-A-luis", "Luis", "1 Unapproved Way", "30310", { approved_at: null }),
      row("sa-b", "b-B", "brokerage", "b-B", "Harbor & Pine Realty Inc.", "400 Bay Ave", "32502", { is_default: true }),
    ]
    const svc = memSupabase({ direct_mail_sender_addresses: rows, brokerages: [{ id: "b-C", name: "Cedar Co", address: "5 Cedar Rd", city: "Austin", state: "TX", zip: "78701" }, { id: "b-D", name: "No Address LLC", address: null, city: null, state: null, zip: null }] })
    const rA = await resolveTenantSenderAddress({ brokerageId: "b-A", client: svc, verifyNow: false })
    const rB = await resolveTenantSenderAddress({ brokerageId: "b-B", client: svc, verifyNow: false })
    check("tenant A resolves to ITS default return address", rA.address?.line1 === "12 Peachtree St" && rA.address?.source === "tenant_return_address")
    check("tenant B resolves to ITS default — never A's row", rB.address?.line1 === "400 Bay Ave" && rB.address?.name === "Harbor & Pine Realty Inc.")
    const rAteam = await resolveTenantSenderAddress({ brokerageId: "b-A", teamId: "t-A1", client: svc, verifyNow: false })
    const rAuser = await resolveTenantSenderAddress({ brokerageId: "b-A", teamId: "t-A1", agentUserId: "u-A-maya", client: svc, verifyNow: false })
    check("a team's approved address wins over the tenant default for that team's sender", rAteam.address?.line1 === "900 Riverside Dr" && rAteam.address?.source === "team_approved_address")
    check("a sending user's own approved address wins over the team's (\"another address expressly approved for the actual sender\")", rAuser.address?.line1 === "77 Oak Ln" && rAuser.address?.source === "sender_approved_address")
    const rAluis = await resolveTenantSenderAddress({ brokerageId: "b-A", agentUserId: "u-A-luis", client: svc, verifyNow: false })
    check("an UNAPPROVED row is never picked (falls to the tenant default)", rAluis.address?.line1 === "12 Peachtree St")
    const rBcross = await resolveTenantSenderAddress({ brokerageId: "b-B", teamId: "t-A1", agentUserId: "u-A-maya", client: svc, verifyNow: false })
    check("tenant B naming tenant A's team and user ids still gets ONLY its own row (tenant pinned)", rBcross.address?.line1 === "400 Bay Ave")
    check("pickSenderAddressRow is pure and agrees with the resolver", pickSenderAddressRow(rows, { brokerageId: "b-A", agentUserId: "u-A-maya" })?.row.id === "sa-a-user" && senderAddressFromRow(rows[0], "tenant_return_address").verification?.method === "lob_cass")
    const rC = await resolveTenantSenderAddress({ brokerageId: "b-C", client: svc, verifyNow: false })
    check("a tenant with no approved row falls to ITS OWN brokerage-of-record business address, source brokerage_of_record, UNVERIFIED", rC.address?.line1 === "5 Cedar Rd" && rC.address?.source === "brokerage_of_record" && rC.address?.verification === null)
    check("…which the gate then REFUSES as unverified (never mailed on an unverified sender)", !decideSenderAddress(rC.address, {}).ok && (decideSenderAddress(rC.address, {}) as { code: string }).code === "unverified")
    const rD = await resolveTenantSenderAddress({ brokerageId: "b-D", client: svc, verifyNow: false })
    check("a tenant with no row and no business address resolves to NOTHING, with a refusal naming Settings", rD.address === null && /Settings → Direct mail/.test(rD.refusal ?? ""))
    const refused = memSupabase({}, { refuse: { direct_mail_sender_addresses: "permission denied" } })
    const rR = await resolveTenantSenderAddress({ brokerageId: "b-A", client: refused, verifyNow: false })
    check("a REFUSED read of the sender table is said in readErrors (never read as 'no addresses')", rR.readErrors.some((e) => /direct_mail_sender_addresses/.test(e)))
  }

  console.log("\n[C · the platform return address is refused as a sender]")
  {
    const env = { platformLobAddressId: PLATFORM_ID }
    const savedId = decideSenderAddress(PLATFORM_ID, env)
    check("a saved Lob address id (the LOB_RETURN_ADDRESS_ID shape) is refused: platform_address", !savedId.ok && savedId.code === "platform_address")
    const anyId = decideSenderAddress("adr_other", env)
    check("ANY saved Lob address id is refused as a sender (a tenant's address is always inline)", !anyId.ok && anyId.code === "platform_address")
    const plantedName = decideSenderAddress(verified({ name: "VIP Agents" }), env)
    check("POSITIVE CONTROL: a planted platform NAME as the return name is caught", !plantedName.ok && plantedName.code === "platform_address")
    const brandName = decideSenderAddress(verified({ name: `${DEFAULT_PRODUCT_BRAND.name} Support` }), env)
    check(`the gate's platform tokens agree with the product brand's name ("${DEFAULT_PRODUCT_BRAND.name}") — derived, not pinned`, !brandName.ok && brandName.code === "platform_address")
    const plantedId = decideSenderAddress(verified({ addressId: PLATFORM_ID }), env)
    check("a candidate whose addressId IS the platform's saved id is caught", !plantedId.ok && plantedId.code === "platform_address")
    const ok = decideSenderAddress(verified(), env)
    check("CONTROL: a tenant's verified address passes, inline, country US, the tenant's own name", ok.ok && ok.from.name === "Alder Realty LLC" && ok.from.address_country === "US" && ok.from.address_zip === "30303" && ok.source === "tenant_return_address")
    check("the decision carries evidence (address id, verified at, deliverability)", ok.ok && ok.evidence.addressId === "sa-a" && ok.evidence.verifiedAt === "2026-11-09T00:00:00Z")
    const disp = noComments("lib/providers/dispatch.ts")
    const FALLBACK = /const from = [\s\S]{0,400}?process\.env\.LOB_RETURN_ADDRESS_ID/
    check("the dispatcher no longer falls back to process.env.LOB_RETURN_ADDRESS_ID for `from`", !FALLBACK.test(disp))
    check("POSITIVE CONTROL: the finder sees the old fallback in a specimen", FALLBACK.test(`const from = fa && fa.name\n    ? { name: fa.name }\n    : process.env.LOB_RETURN_ADDRESS_ID`))
    check("the dispatcher resolves the TENANT's address when a caller passes none, and judges every candidate with decideSenderAddress", /resolveTenantSenderAddress\(\{ brokerageId: params\.brokerageId/.test(disp) && /decideSenderAddress\(senderCandidate, \{ platformLobAddressId: process\.env\.LOB_RETURN_ADDRESS_ID \}\)/.test(disp) && /const from = senderGate\.from/.test(disp))
    check("the dispatcher's refusal is BEFORE any Lob create and names the gate's code", disp.indexOf("sender address refused") < disp.indexOf("lob.postcards.create(") && /sender address refused \(\$\{senderGate\.code\}\)/.test(disp))
    check("LOB_RETURN_ADDRESS_ID is read in the dispatcher ONLY as the id to recognize and refuse", (disp.match(/process\.env\.LOB_RETURN_ADDRESS_ID/g) ?? []).length === 1)
  }

  console.log("\n[D · a missing / invalid sender address is refused BY NAME]")
  {
    const missing = decideSenderAddress(null, {})
    check("missing → code missing, naming where to configure it", !missing.ok && missing.code === "missing" && /Settings → Direct mail/.test(missing.reason) && /never used/.test(missing.reason))
    const noZip = decideSenderAddress(verified({ zip: "" }), {})
    check("incomplete → code incomplete, naming the field (zip)", !noZip.ok && noZip.code === "incomplete" && noZip.missing.includes("zip"))
    const badZip = decideSenderAddress(verified({ zip: "ABCDE" }), {})
    check("a non-US ZIP → incomplete, naming zip", !badZip.ok && badZip.code === "incomplete" && badZip.missing.includes("zip"))
    const unverified = decideSenderAddress(verified({ verification: null }), {})
    check("unverified → code unverified (no CASS evidence is a refusal for a SENDER, never a defer)", !unverified.ok && unverified.code === "unverified" && /CASS/.test(unverified.reason))
    const undeliverable = decideSenderAddress(verified({ verification: { method: "lob_cass", deliverability: "undeliverable", verifiedAt: "2026-11-09T00:00:00Z" } }), {})
    check("undeliverable → code undeliverable (a return address that cannot receive mail loses every returned piece)", !undeliverable.ok && undeliverable.code === "undeliverable")
    check("a deliverable-with-unit-note bucket still passes (Lob's deliverable_* family)", decideSenderAddress(verified({ verification: { method: "lob_cass", deliverability: "deliverable_missing_unit", verifiedAt: "x" } }), {}).ok)
    const shape = senderAddressShapeRefusal({ name: "Alder Realty LLC", line1: "", city: "Atlanta", state: "GA", zip: "30303" }, {})
    check("the SAVE-time shape check names the missing field before a verification is bought", shape?.code === "incomplete" && shape.missing.includes("line1"))
    check("…and refuses the platform's name at save time", senderAddressShapeRefusal({ name: "VIPAgents.ai", line1: "1 Main St", city: "X", state: "GA", zip: "30303" }, {})?.code === "platform_address")
    check("CONTROL: a complete tenant shape passes the save-time check", senderAddressShapeRefusal({ name: "Alder Realty LLC", line1: "12 Peachtree St", city: "Atlanta", state: "GA", zip: "30303" }, {}) === null)
  }

  console.log("\n[E · handwriting-STYLE is labeled PRINTED; 'handwritten' is reserved for a pen]")
  {
    const pl = MAIL_FORMAT_LABELS.personal_letter
    check("the personal-note label says handwriting-style AND printed, and never 'handwritten'", /handwriting-style/i.test(pl) && /printed/i.test(pl) && !/handwritten/i.test(pl))
    check("only the pen-provider format's label uses 'handwritten', and it names a pen", Object.entries(MAIL_FORMAT_LABELS).filter(([, l]) => /handwritten/i.test(l)).map(([k]) => k).join() === "handwritten_card" && /pen/i.test(MAIL_FORMAT_LABELS.handwritten_card))
    check("the layout library's personal note is labeled with the same wording", MAIL_LAYOUT_LIBRARY.personal_letter.label === pl)
    // Lexical rule over the surfaces this lane owns: every "handwritten" is either the stored key (followed by "_") or within
    // reach of the word "pen" (a pen provider). Anything else calls a printed piece handwritten.
    const surfaces = ["app/dashboard/campaigns/mail/components/mail-piece-preview.tsx", "app/dashboard/campaigns/mail/components/create-campaign-dialog.tsx", "app/dashboard/campaigns/mail/components/tracking-tab.tsx", "app/settings/direct-mail/client.tsx", "lib/direct-mail/render-letter.ts", "lib/direct-mail/draft-copy.ts", "lib/direct-mail/orchestrate-send.ts", "lib/direct-mail/campaign-drain.ts"]
    const offenders = (src: string): string[] => {
      const out: string[] = []
      for (const m of src.matchAll(/handwritten/gi)) {
        const i = m.index ?? 0
        if (src[i + m[0].length] === "_") continue
        const around = src.slice(Math.max(0, i - 80), i + 80)
        if (/\bpen\b/i.test(around)) continue
        out.push(around.replace(/\s+/g, " ").trim())
      }
      return out
    }
    const hits = surfaces.flatMap((f) => offenders(noComments(f)).map((h) => `${f}: ${h}`))
    check(`no owned surface calls a printed piece handwritten (${surfaces.length} files, stored keys and pen-provider mentions allowed)`, hits.length === 0, hits.slice(0, 3).join(" | "))
    check("POSITIVE CONTROL: the finder catches a specimen label", offenders(`label: "Handwritten note", sub: "in script"`).length === 1 && offenders(`value: "handwritten_letter"`).length === 0 && offenders(`written with a pen by a handwriting provider — handwritten card`).length === 0)
    const rl = noComments("lib/direct-mail/render-letter.ts")
    check("the in-repo letter layout sets the note in HANDWRITING_STYLE_TYPEFACE and prints 'handwriting-style typeface' on the piece", /HANDWRITING_STYLE_TYPEFACE\.cssUrl/.test(rl) && /HANDWRITING_STYLE_TYPEFACE\.family/.test(rl) && /Printed in a handwriting-style typeface/.test(rl))
    check("the preview and the create dialog describe the note as handwriting-style and printed", /Handwriting-style printed note/.test(noComments("app/dashboard/campaigns/mail/components/mail-piece-preview.tsx")) && /Printed typeface, not pen/.test(noComments("app/dashboard/campaigns/mail/components/create-campaign-dialog.tsx")))
    check("a campaign note row routes to the personal_letter format (printed), never to a pen format", formatForCampaignPieceType("handwritten_letter") === "personal_letter" && formatForCampaignPieceType("thank_you_note") === "personal_letter")
    check("the handwritten_card format is still refused while every pen provider is dormant (no silent downgrade)", !routeMailFormat("handwritten_card", FOUR).ok && Object.values(OPTIONAL_MAIL_PROVIDERS).every((p) => p.status === "dormant"))
  }

  console.log("\n[F · delivery truth — six separate states; an API 200 is only `apiAccepted`]")
  {
    const sig = (o: Parameters<typeof mailPieceTruth>[0]) => { const t = mailPieceTruth(o); return JSON.stringify([t.apiAccepted, t.printed, t.mailed, t.delivered, t.returned]) }
    const accepted = mailPieceTruth("accepted")
    check("API accepted (a 2xx with a piece id) → apiAccepted only: not printed, not mailed, not delivered, not returned", accepted.apiAccepted && accepted.printed === "not_reported_by_provider" && !accepted.mailed && accepted.delivered === "no" && !accepted.returned)
    check("a Lob 'created' event (the HTTP success) is NOT delivered", mailPieceTruth(mailOutcomeFromLobEvent("letter.created").outcome).delivered === "no")
    check("rendered → still not mailed (a proof is not a mailpiece)", !mailPieceTruth("rendered").mailed)
    const mailed = mailPieceTruth("mailed")
    check("mailed → mailed yes, printed IMPLIED (Lob reports no print event — said as implied, never proven), delivered no", mailed.mailed && mailed.printed === "implied_by_mailed" && mailed.delivered === "no")
    const delivered = mailPieceTruth("delivered_per_carrier_scan")
    check("delivered → carrier_scan only (never household receipt), returned no", delivered.delivered === "carrier_scan" && !delivered.returned && delivered.mailed)
    const returned = mailPieceTruth("returned_to_sender")
    check("returned → returned yes, delivered no", returned.returned && returned.delivered === "no")
    check("unknown → apiAccepted false (nothing is assumed)", !mailPieceTruth("unknown").apiAccepted && !mailPieceTruth(null).apiAccepted)
    const sigs = (["accepted", "rendered", "mailed", "delivered_per_carrier_scan", "returned_to_sender", "unknown"] as const).map(sig)
    check("accepted / rendered share a signature by design; mailed, delivered, returned, unknown are each DISTINCT", new Set(sigs.slice(2)).size === 4 && !sigs.slice(2).includes(sigs[0]))
    check("the charge is a SEPARATE truth from the outcome: unknown with no ledger, estimated unsettled, settled when the ledger settled", mailPieceTruth("mailed").chargeSettled === "unknown" && mailPieceTruth("mailed", { settledAt: null }).chargeSettled === "estimated" && mailPieceTruth("mailed", { settledAt: "2026-11-09T00:00:00Z" }).chargeSettled === "settled")
    check("the outcome vocabulary is untouched (m985): 11 values, no received / read / opened", MAIL_DELIVERY_OUTCOMES.length === 11 && !MAIL_DELIVERY_OUTCOMES.some((o) => /receiv|read|open/.test(o)))

    // Returned mail on the in-memory client — the REAL applyReturnedMailHandling.
    const seed = () => memSupabase({
      leads: [{ id: "L1", brokerage_id: "b-A", mailing_address_verified: true, mailing_address_source: "lob_cass" }],
      contacts: [{ id: "C1", brokerage_id: "b-A", mailing_address_verified: true, mailing_address_source: "lob_cass" }],
      direct_mail_recipients: [
        { id: "R1", brokerage_id: "b-A", campaign_id: "camp-1", lead_id: "L1", contact_id: null, address_line1: "1 Elm St", zip: "30301", delivery_status: "returned", provider_piece_id: "psc_1" },
        { id: "R2", brokerage_id: "b-A", campaign_id: "camp-1", lead_id: null, contact_id: null, address_line1: "1 ELM ST", zip: "30301-1234", delivery_status: "pending" },
        { id: "R3", brokerage_id: "b-A", campaign_id: "camp-1", lead_id: null, contact_id: null, address_line1: "9 Oak Ave", zip: "30301", delivery_status: "pending" },
        { id: "R4", brokerage_id: "b-A", campaign_id: "camp-2", lead_id: null, contact_id: null, address_line1: "1 Elm St", zip: "30301", delivery_status: "pending" },
        { id: "R5", brokerage_id: "b-A", campaign_id: "camp-1", lead_id: null, contact_id: null, address_line1: "22 Pine Ct", zip: "30305", delivery_status: "returned", provider_piece_id: "psc_5" },
        { id: "R6", brokerage_id: "b-A", campaign_id: "camp-1", lead_id: null, contact_id: "C1", address_line1: "5 Birch Rd", zip: "30306", delivery_status: "returned" },
      ],
      contact_suppression_list: [],
    })
    const svc = seed()
    const r1 = await applyReturnedMailHandling(svc, { brokerageId: "b-A", recipient: svc.tables.direct_mail_recipients[0] as never })
    const lead = svc.tables.leads[0]
    check("a returned LEAD piece un-verifies the lead's mailing address with source lob_returned_to_sender (counted: 1 row)", r1.entityRowsPatched === 1 && lead.mailing_address_verified === false && lead.mailing_address_source === "lob_returned_to_sender")
    check("the pending sibling to the SAME mailbox in the SAME campaign is stopped (case / ZIP+4 insensitive); other mailboxes and other campaigns are untouched", r1.siblingsStopped === 1 && svc.tables.direct_mail_recipients[1].delivery_status === "failed" && svc.tables.direct_mail_recipients[2].delivery_status === "pending" && svc.tables.direct_mail_recipients[3].delivery_status === "pending")
    check("a lead-anchored return does NOT suppress the mailbox key (the record was corrected instead — over-suppression deletes paid reach)", r1.addressSuppressed === false && r1.plan.suppressAddress === false)
    check("the handling is written beside the piece (return_handling) with counts", (svc.tables.direct_mail_recipients[0].return_handling as { entity_rows_patched: number } | undefined)?.entity_rows_patched === 1)
    const r5 = await applyReturnedMailHandling(svc, { brokerageId: "b-A", recipient: svc.tables.direct_mail_recipients[4] as never })
    check("an ADDRESS-ONLY return (no lead, no contact) suppresses the mailbox key for mail — the only lever that stops that sequence", r5.plan.suppressAddress && r5.addressSuppressed && svc.tables.contact_suppression_list.length === 1 && svc.tables.contact_suppression_list[0].channel === "mail" && svc.tables.contact_suppression_list[0].suppression_reason === "returned_to_sender")
    const r6 = await applyReturnedMailHandling(svc, { brokerageId: "b-A", recipient: svc.tables.direct_mail_recipients[5] as never })
    check("a returned CONTACT piece corrects the contact's record (counted: 1 row)", r6.entityRowsPatched === 1 && svc.tables.contacts[0].mailing_address_verified === false)
    const svc2 = seed()
    const wrong = await applyReturnedMailHandling(svc2, { brokerageId: "b-B", recipient: svc2.tables.direct_mail_recipients[0] as never })
    check("WRONG TENANT: the same return applied under another tenant changes NOTHING (0 rows patched, 0 stopped — counted, not assumed)", wrong.entityRowsPatched === 0 && wrong.siblingsStopped === 0 && svc2.tables.leads[0].mailing_address_verified === true)
    const plan = planReturnedMailHandling({ id: "x", campaign_id: "c", lead_id: null, contact_id: null, address_line1: "1 Elm St", zip: "30301" }, [{ id: "y", campaign_id: "c", address_line1: "1 Elm Street", zip: "30301", delivery_status: "pending" }])
    check("the pure plan does not equate '1 Elm St' with '1 Elm Street' (sibling matching is exact-line, not a second normalizer)", plan.stopRecipientIds.length === 0 && plan.suppressAddress)
    const dm = noComments("app/actions/direct-mail.ts")
    check("trackDelivery reads the six truths and hands a returned piece to applyReturnedMailHandling (same tenant, same piece id)", /truth = mailPieceTruth\(reading\.outcome\)/.test(dm) && /reading\.outcome === "returned_to_sender" && pieceSettled > 0/.test(dm) && /applyReturnedMailHandling\(supabase, \{ brokerageId: campaign\.brokerage_id/.test(dm))
    check("the Tracking tab folds Lob's raw event onto the outcome and shows the six truths separately", /mailPieceTruth\(mailOutcomeFromLobEvent\(status\)\.outcome\)/.test(noComments("app/dashboard/campaigns/mail/components/tracking-tab.tsx")))
  }

  console.log("\n[G · idempotent re-send]")
  {
    const svc = memSupabase({ agent_action_ledger: [] }, { unique: { agent_action_ledger: [["idempotency_key"]] }, uuidIds: true })
    let charges = 0
    const lobCharge = async (): Promise<DispatchLike> => { charges++; return { success: true, providerKey: "lob", messageId: `ltr_${charges}` } }
    const hooks = { settle: (r: DispatchLike) => settleDispatchResult(r, 1.226), replay: replayDispatchResult }
    const ctx = (key: string) => ({ brokerageId: "b-A", action: "comms.direct_mail.send", channel: "direct_mail", actor: { type: "user" as const, userId: "u-1" }, subject: { type: "recipient" as const, id: null, ref: "1 Elm St, 30301" }, idempotencyKey: key, riskClass: "COMMUNICATION" as const })
    const key = mailPieceIdempotencyKey("campaign_recipient", "camp-1", "R1")
    const first = await withActionLedger(ctx(key), lobCharge, hooks, { client: svc })
    const second = await withActionLedger(ctx(key), lobCharge, hooks, { client: svc })
    const third = await withActionLedger(ctx(key), lobCharge, hooks, { client: svc })
    check("re-sending the same piece three times charges Lob ONCE; every retry replays the first piece id", charges === 1 && first.messageId === second.messageId && second.messageId === third.messageId)
    check("CONTROL: another recipient of the same campaign is a new piece and IS charged", (await withActionLedger(ctx(mailPieceIdempotencyKey("campaign_recipient", "camp-1", "R2")), lobCharge, hooks, { client: svc }), charges === 2))
    check("the per-piece key is stable and tenant-free (the ledger row carries the tenant)", key === mailPieceIdempotencyKey("campaign_recipient", "camp-1", "R1") && !/b-A/.test(key))
    check("sendCampaign still dispatches under the per-piece key and stamps it on the recipient", /mailPieceIdempotencyKey\("campaign_recipient", params\.campaignId, recipient\.id\)/.test(noComments("app/actions/direct-mail.ts")))
  }

  console.log("\n[H · tenant approval before send + the whole-batch spend guard]")
  {
    const okBudget = { allowed: true, reason: "ok", remainingBudget: 100 }
    const pending = campaignSendGate({ approvalStatus: "pending", status: "planning", pieces: 10, unitCostUsd: 0.909, budget: okBudget })
    check("a campaign awaiting approval (pending) is refused: not_approved — the Send button cannot step over the queue", !pending.ok && pending.code === "not_approved")
    check("pending_review and rejected are refused too", !campaignSendGate({ approvalStatus: "pending_review", status: "planning", pieces: 1, unitCostUsd: 1, budget: okBudget }).ok && !campaignSendGate({ approvalStatus: "rejected", status: "planning", pieces: 1, unitCostUsd: 1, budget: okBudget }).ok)
    const approved = campaignSendGate({ approvalStatus: "approved", status: "planning", pieces: 10, unitCostUsd: 0.909, budget: okBudget })
    check("an approved campaign within budget passes with the whole-batch estimate (10 × $0.909 = $9.09) and a spend preview", approved.ok && approved.estimatedCostUsd === 9.09 && approved.spendPreview.pieces === 10 && approved.warning === null)
    check("a user-authored campaign (no approval_status) passes — the signed-in Send IS the approval, stamped by sendCampaign", campaignSendGate({ approvalStatus: null, status: "planning", pieces: 1, unitCostUsd: 1, budget: okBudget }).ok)
    const over = campaignSendGate({ approvalStatus: "approved", status: "planning", pieces: 500, unitCostUsd: 0.909, budget: { allowed: false, reason: "vendor_budget_exhausted", remainingBudget: 12.5 } })
    check("an AFFIRMATIVE budget refusal stops the send at piece 0, naming the remaining budget", !over.ok && over.code === "budget" && /\$12\.50 left/.test(over.reason) && /500 piece/.test(over.reason))
    const degraded = campaignSendGate({ approvalStatus: "approved", status: "planning", pieces: 5, unitCostUsd: 0.909, budget: { allowed: false, reason: "ledger_unreadable", remainingBudget: null, budgetDegraded: true } })
    check("a DEGRADED budget read proceeds with a warning (the documented fail-open), never silently", degraded.ok && /fail-open/.test(degraded.warning ?? ""))
    check("no documented price → refused (nothing is mailed at an unknown price)", (campaignSendGate({ approvalStatus: "approved", status: "planning", pieces: 5, unitCostUsd: null, budget: okBudget }) as { code: string }).code === "no_price")
    check("already mailed / no pieces are refused", (campaignSendGate({ approvalStatus: "approved", status: "mailed", pieces: 5, unitCostUsd: 1, budget: okBudget }) as { code: string }).code === "already_mailed" && (campaignSendGate({ approvalStatus: "approved", status: "planning", pieces: 0, unitCostUsd: 1, budget: okBudget }) as { code: string }).code === "no_pieces")
    const dm = noComments("app/actions/direct-mail.ts")
    check("sendCampaign asks the SAME billing resolver the dispatcher uses, for pieces × the ONE Lob price, BEFORE the first piece", /mayUseAndAfford\(\{ brokerageId: params\.brokerageId, capability: "comms\.send", estCostUsd: Math\.round\(recipients\.length \* unit \* 100\) \/ 100 \}\)/.test(dm) && /DIRECT_MAIL_PIECE_COST_USD\[route\.templates\.pieceType\]/.test(dm) && dm.indexOf("campaignSendGate({") < dm.indexOf("const lobResult = await dispatchDirectMail("))
    check("sendCampaign judges the sender address ONCE for the campaign (before the proof and the loop) and refuses by name", dm.indexOf("decideSenderAddress(brandRead.facts.returnAddress") < dm.indexOf("if (params.previewOnly)") && /sender address refused \(\$\{sender\.code\}\)/.test(dm))
    check("the proof carries the TENANT's `from`, and the preview reports the sender and the spend", /from: sender\.from/.test(dm) && /senderAddress: senderSnapshot/.test(dm) && /spend: spendGate\.ok/.test(dm))
    check("the spend preview and the sender snapshot are written in SEPARATE stamps (a pending m980/m981 cannot take the send down)", /stampProvenance\(\{ sender_address_snapshot: senderSnapshot, sender_address_id: sender\.evidence\.addressId, spend_preview: \{ \.\.\.spendGate\.spendPreview/.test(dm))
    check("the provenance records the tenant source of the return address (never 'platform')", (mailTemplateProvenance(routeMailFormat("letter", FOUR), { provenance: { logo: "brokerage", color: "brokerage", tagline: "none", license: "agent", office: "none", returnAddress: "tenant_return_address", readErrors: [] }, missing: [] }) as { sender_address_source: string }).sender_address_source === "tenant_return_address")
  }

  console.log("\n[I · wiring — every mail door carries the tenant's address; the 151I hook exists]")
  {
    const os = noComments("lib/direct-mail/orchestrate-send.ts")
    check("orchestrate-send resolves and gates the sender BEFORE any render (saves the Remotion / model spend on a refusal)", os.indexOf("resolveTenantSenderAddress({ brokerageId: args.brokerageId") < os.indexOf("renderPostcardBothSides6x9({") && /decideSenderAddress\(senderRead\.address/.test(os))
    check("orchestrate-send passes the tenant's address on EVERY path (rendered and fallback) — no fallback-only `from`", /fromAddress:\s+senderAddress,/.test(os) && !/fallbackFrom/.test(code("lib/direct-mail/orchestrate-send.ts")))
    check("POSITIVE CONTROL: the finder would see the old fallback-only variable", /fallbackFrom/.test("let fallbackFrom = null"))
    check("orchestrate-send renders the personal note in the handwriting-style typeface with the return address on the letterhead, and falls back to the personal-note layout", /noteStyle:\s+format === "personal_letter" \? "handwriting_style" : null/.test(os) && /returnAddress:\s+senderAddress/.test(os) && /fallbackLobTemplates\(format === "personal_letter" \? "personal_letter" : args\.pieceType/.test(os))
    const ps = noComments("lib/direct-mail/orchestrate-preset-send.ts")
    check("orchestrate-preset-send reads the brand (and the sender) for every piece, gates it, and passes fromAddress", /decideSenderAddress\(brandRead\.facts\.returnAddress/.test(ps) && /fromAddress:\s+brandRead\.facts\.returnAddress/.test(ps))
    const drain = noComments("lib/direct-mail/campaign-drain.ts")
    check("the drain folds the row's piece vocabulary onto the PRINT format once and hands the orchestrator a Lob piece type + the format", /formatForCampaignPieceType\(/.test(drain) && /pieceType: lobPieceType,/.test(drain) && /format: mailFormat,/.test(drain))
    const dc = noComments("lib/direct-mail/draft-copy.ts")
    // The HOOK marker is documentation (a comment), so it is read from RAW source; the exports and the call are code tokens.
    check("draft-copy exports the sender-voice brief shape + reader, marks the 151I HOOK, and both prompts take the brief from the first draft", /export interface SenderVoiceBrief/.test(dc) && /export async function readSenderVoiceBrief/.test(dc) && /151I HOOK/.test(read("lib/direct-mail/draft-copy.ts")) && /renderSenderVoiceBlock\(brief\)/.test(dc))
    check("the orchestrator stamps the brief on copyCtx BEFORE rendering (the first draft is in the sender's voice)", os.indexOf("readSenderVoiceBrief(args.copyCtx)") < os.indexOf("renderPostcardBothSides6x9({"))
    const callers = ["lib/direct-mail/orchestrate-send.ts", "lib/direct-mail/orchestrate-preset-send.ts", "app/actions/direct-mail.ts"]
    check("every dispatchDirectMail call in this lane's doors passes fromAddress", callers.every((f) => /fromAddress:/.test(noComments(f))))
    const outside = ["lib/agents/marketing-agent-actions.ts", "lib/ai-isa/direct-mail-trigger.ts", "lib/workflow/adapters/direct-mail.ts", "app/actions/ai-isa.ts", "app/actions/reputation-kernel.ts"]
    const noFrom = outside.filter((f) => !/fromAddress:/.test(noComments(f)))
    console.log(`  · ${noFrom.length} out-of-lane callers pass no fromAddress (${noFrom.join(", ")}) — covered by the dispatcher's own resolve + gate (section C), not by the platform fallback`)
    check("the settings action saves / approves through the SAME shape check and gate (approval refuses what a send would refuse)", /senderAddressShapeRefusal\(\{ name: input\.name/.test(noComments("app/actions/direct-mail-settings.ts")) && /decideSenderAddress\(senderAddressFromRow\(row as SenderAddressRow, "tenant_return_address"\)/.test(noComments("app/actions/direct-mail-settings.ts")))
    check("the settings page tells the admin which address a send would use TODAY, judged by the same gate", /decideSenderAddress\(picked \? senderAddressFromRow\(picked\.row, picked\.source\) : null/.test(noComments("app/actions/direct-mail-settings.ts")) && /SenderAddressSection/.test(noComments("app/settings/direct-mail/client.tsx")))
  }

  console.log("\n[J · migrations m980 / m981]")
  {
    const m980 = read("supabase/migrations/m980-direct-mail-sender-addresses-the-tenant-return-address.sql")
    const m981 = read("supabase/migrations/m981-direct-mail-delivery-truth-spend-preview-and-returned-mail.sql")
    const stamp = (s: string) => s.split("\n")[0].startsWith("-- WRITTEN, NOT APPLIED (wave 151, lane 151H)") || s.split("\n")[0].startsWith("-- ── APPLIED LIVE ")
    check("m980 and m981 carry the lane stamp (or the APPLIED stamp) on line 1, with no migration number on that line", stamp(m980) && stamp(m981) && !/\bm9\d\d\b/.test(m980.split("\n")[0]) && !/\bm9\d\d\b/.test(m981.split("\n")[0]))
    check("m980 creates direct_mail_sender_addresses with the three scopes the resolver picks (brokerage / team / user) and the two statuses", /create table if not exists public\.direct_mail_sender_addresses/.test(m980) && /check \(scope_type in \('brokerage', 'team', 'user'\)\)/.test(m980) && /check \(status in \('active', 'retired'\)\)/.test(m980))
    check("m980's scope vocabulary equals the resolver's (derived from pickSenderAddressRow's three picks)", (noComments("lib/direct-mail/piece-type.ts").match(/pick\("(brokerage|team|user)"/g) ?? []).length === 3)
    check("m980 holds one default per scope and enables RLS with a tenant select", /direct_mail_sender_addresses_default_uq/.test(m980) && /where is_default and status = 'active'/.test(m980) && /enable row level security/.test(m980) && /brokerage_id = public\.current_user_brokerage_id\(\)/.test(m980))
    check("m980 adds the evidence columns sendCampaign writes (sender_address_id, sender_address_snapshot)", /sender_address_id\s+uuid references public\.direct_mail_sender_addresses/.test(m980) && /sender_address_snapshot jsonb/.test(m980) && /sender_address_snapshot: senderSnapshot/.test(noComments("app/actions/direct-mail.ts")))
    check("m981 adds spend_preview (campaigns) and return_handling (recipients) — the columns the code writes", /add column if not exists spend_preview jsonb/.test(m981) && /add column if not exists return_handling jsonb/.test(m981) && /spend_preview:/.test(noComments("app/actions/direct-mail.ts")) && /update\(\{ return_handling:/.test(noComments("lib/direct-mail/piece-type.ts")))
    check("neither migration carries a platform address or a saved Lob address id (layoutContentViolations on the SQL text)", layoutContentViolations(m980.replace(/LOB_RETURN_ADDRESS_ID/g, "")).length === 0 && layoutContentViolations(m981).length === 0)
    check("the recipient-side columns m985 added are still the ones the settle writes (no second vocabulary)", /delivery_outcome: reading\.outcome/.test(noComments("app/actions/direct-mail.ts")))
  }

  console.log("\n[K · cost strategy — evaluated, not implemented]")
  {
    const doc = read("docs/commercial/DIRECT-MAIL-PROVIDER-COMPARISON.md")
    const s13 = doc.slice(doc.indexOf("## 13."))
    check("§13 (wave 151) exists", doc.includes("## 13."))
    for (const p of ["PostcardMania", "AMcards", "notecard"]) check(`§13 marks ${p} EVALUATED—NOT IMPLEMENTED`, new RegExp(`${p}[^\\n]*EVALUATED—NOT IMPLEMENTED|EVALUATED—NOT IMPLEMENTED[^\\n]*${p}`, "i").test(s13))
    check("§13 records the blank-layout library and the return-address rule in the owner's words", /blank/i.test(s13) && /platform return address|platform's return address/i.test(s13) && /handwriting-style printed/i.test(s13))
    check("§13 requests no quote (outreach is the owner's)", /no quote/i.test(s13))
    check("every optional provider stays dormant (no adapter, no purchase)", Object.values(OPTIONAL_MAIL_PROVIDERS).every((p) => p.status === "dormant"))
    check("the canary ran with no Lob key in the environment", !process.env.LOB_API_KEY && !process.env.LOB_TEST_API_KEY)
  }

  console.log("\n  Blind spots:")
  console.log("  · the Lob global templates themselves live on the platform's Lob account and are not in this tree: the layout contract (names, no brand / address) is asserted on MAIL_LAYOUT_LIBRARY and the in-repo layouts; whether the four Lob HTML templates match it needs one TEST-key proof per format (LOB_TEST_API_KEY, WAITING_EXTERNAL)")
  console.log("  · resolveTenantSenderAddress's Lob verification branch (verifyNow) is not driven here (no key, no network): the brokerage-of-record path is proven unverified → refused; a verified-at-resolve path is asserted by construction")
  console.log("  · the dispatcher, sendCampaign, trackDelivery and the settings actions are session / secret gated server code: their wiring is proven on STRIPPED source, the decisions they call at runtime")
  console.log("  · the 'handwritten' lexical rule covers the surfaces this lane owns; app/components/reputation/ReputationPanel.tsx (not this lane's) keeps its stored key and 'Personal note (printed)' label")
  console.log("  · memSupabase has no CHECKs / RLS: m980's CHECKs and policies are read from the migration file; the tenant pin is proven by the resolver's and the handler's own predicates")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

function row(id: string, brokerageId: string, scope: SenderAddressRow["scope_type"], scopeId: string, name: string, line1: string, zip: string, over: Partial<SenderAddressRow> = {}): SenderAddressRow {
  return {
    id, brokerage_id: brokerageId, scope_type: scope, scope_id: scopeId, label: null, name, line1, line2: null, city: "City", state: "GA", zip,
    cass_deliverability: "deliverable", cass_verified_at: "2026-11-09T00:00:00Z", approved_by_user_id: "u-admin", approved_at: "2026-11-09T01:00:00Z", is_default: false, status: "active", ...over,
  }
}

function brandA(): MailBrandFacts {
  return {
    displayName: "The Alder Team", legalBrokerageName: "Alder Realty LLC", dba: "Alder Homes", teamName: "The Alder Team", officeName: "Riverside Office",
    agentName: "Maya Chen", agentLicenseLine: "GA License # 123456", agentPhotoUrl: "https://cdn.a.example/maya.jpg",
    logoUrl: "https://cdn.a.example/logo.png", primaryColor: "#0F172A", secondaryColor: "#64748B", accentColor: "#F59E0B",
    fontFamily: "Libre Baskerville", tagline: "Rooted where you are.", website: "alderhomes.example", phone: "404-555-0100",
    returnAddress: verified(),
    disclosureShort: "Equal Housing Opportunity. All information deemed reliable but not guaranteed.",
    disclosureLong: "Alder Realty LLC is committed to the principles of the Fair Housing Act and the Equal Credit Opportunity Act.",
  }
}
function brandB(): MailBrandFacts {
  return {
    displayName: "Harbor & Pine Realty", legalBrokerageName: "Harbor & Pine Realty Inc.", teamName: null, officeName: "Harbor Office",
    agentName: "Luis Ortega", agentLicenseLine: "FL License # SL998877", logoUrl: "https://cdn.b.example/hp.svg",
    primaryColor: "#1E3A8A", secondaryColor: "#94A3B8", accentColor: "#10B981", fontFamily: "Lora", tagline: "Coastal know-how, neighborly care.",
    website: "harborpine.example", phone: "850-555-0199",
    returnAddress: verified({ name: "Harbor & Pine Realty Inc.", line1: "400 Bay Ave", city: "Pensacola", state: "FL", zip: "32502", addressId: "sa-b", approvedByUserId: "u-admin-b" }),
    disclosureShort: "Equal Housing Opportunity.", disclosureLong: "Harbor & Pine Realty Inc. is committed to the Fair Housing Act.",
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
