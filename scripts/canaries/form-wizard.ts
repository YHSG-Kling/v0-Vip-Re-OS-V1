/**
 * scripts/canaries/form-wizard.ts — FORMWIZARD canary (wave 142, lane 142J):
 *   listing vs offer → the actual available forms → a Media packet FILLS / SAVES / DOWNLOADS → autosave/resume →
 *   the legal description arrives or the packet stays INCOMPLETE → the provider path is API/popup, never a blank
 *   iframe → the tenant's e-sign → mobile
 * through the survivors at HEAD: lib/forms/pdf-form-fill.ts (pdf-lib on the PDF BYTES — listPdfFields /
 * fillPdfForm / readPdfTextFields; only fields that exist are filled, flatten locks them), lib/kernel/forms.ts
 * (loadAvailableTransactionForms — the brokerage's own library + the context defaults, never empty; saveFormDraft /
 * loadFormDraft — ONE draft row per context, tenant-pinned), lib/forms/legal-description.ts (legalDescriptionGate — the
 * dispatch core refuses an INCOMPLETE packet; lane 142C extends its sources, this canary consumes), the ONE provider
 * catalog (lib/integrations/providers/catalog.ts — embed is a per-provider evidence flag) and the wizard itself
 * (app/components/form-wizard/FormWizard.tsx — a client component, asserted on STRIPPED source: popup via window.open,
 * iframe only where the catalog says the vendor frames). Owner (wave 142): "FormWizard: LISTING and OFFER forms only;
 * CDA is NOT a FormWizard step … either an iframe or popup in the platform; never an UNSUPPORTED iframe … AI coaches
 * like a knowledgeable real-estate coach; never invents legal terms, signatures or material facts."
 * In-memory only; the real PDF bytes are built here with pdf-lib (the same library the fill survivor uses).
 */
import { PDFDocument, StandardFonts } from "pdf-lib"
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, landedModule, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, listFiles, readRepo, strippedRepo } from "./_registry"
import { overflowFindings } from "./mobile"

/** A real AcroForm PDF with the four fields a purchase contract's identification page carries. */
async function buildPacketPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const form = doc.getForm()
  let y = 700
  for (const name of ["Property Address", "Legal Description", "Purchase Price", "Seller Name"]) {
    page.drawText(name, { x: 50, y: y + 22, size: 10, font })
    const tf = form.createTextField(name)
    tf.addToPage(page, { x: 50, y, width: 400, height: 18 })
    y -= 60
  }
  return doc.save()
}

export async function run() {
  const c = canary("FormWizard: listing vs offer → actual forms → a Media packet fills/saves/downloads → autosave/resume → legal description or INCOMPLETE → provider API/popup → tenant e-sign → mobile")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only — drafts are tenant rows and the e-sign hop is a recorder")
  const B = uuid(), B2 = uuid(), AG_U = uuid(), AG = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-fw`, state: "FL" }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-fw2` }],
    users: [{ id: AG_U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: AG_U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    brokerage_forms: [
      { id: uuid(), brokerage_id: B, form_name: `${CANARY_TAG} Exclusive Listing Agreement`, form_category: "listing_agreement", form_type: "listing", is_required: true, is_active: true, document_url: "https://files.example/la.pdf", state: "FL" },
      { id: uuid(), brokerage_id: B, form_name: `${CANARY_TAG} Purchase Contract (FL)`, form_category: "purchase_contract", form_type: "offer", is_required: true, is_active: true, document_url: "https://files.example/pc.pdf", state: "FL" },
    ],
  })
  setSvc(svc)

  // ── 1 · the Media packet: real PDF bytes, filled in-app, read back, locked for download ──
  const { listPdfFields, fillPdfForm, readPdfTextFields } = await import("../../lib/forms/pdf-form-fill")
  const blank = await buildPacketPdf()
  const fields = await listPdfFields(blank)
  c.step("a licensed packet in Media is a real AcroForm PDF: its fillable fields are LISTED off the bytes (4), never guessed", fields.length === 4 && fields.includes("Legal Description") && Buffer.from(blank.slice(0, 5)).toString() === "%PDF-", fields.join(" | "))
  const filled = await fillPdfForm(blank, [{ name: "Property Address", value: "9 Outside Rd, Pensacola, FL 32501" }, { name: "Purchase Price", value: "$400,000" }, { name: "Seller Name", value: "Sam Seller" }, { name: "Buyer Shoe Size", value: "11" }])
  const readBack = await readPdfTextFields(filled.bytes)
  c.step("FILL: only fields the PDF HAS are written (3), a requested field it lacks is returned in `skipped` — never invented onto the page; the filled bytes read back exactly what was typed (the preview IS the artifact)", filled.filled.length === 3 && filled.skipped.join() === "Buyer Shoe Size" && readBack.find((f) => f.name === "Purchase Price")?.value === "$400,000" && readBack.find((f) => f.name === "Legal Description")?.value === "", JSON.stringify({ filled: filled.filled, skipped: filled.skipped }))
  const { legalDescriptionGate } = await import("../../lib/forms/legal-description")
  const gate1 = legalDescriptionGate([{ name: "Purchase Contract", fields: readBack }])
  c.step("LEGAL DESCRIPTION (lane 141C/142C survivor, consumed): a packet whose legal-description field is BLANK is INCOMPLETE — the document and the field named — and the dispatch core refuses it before any envelope (never the street address, never invented)", !gate1.complete && gate1.blank.length === 1 && gate1.blank[0].field === "Legal Description" && /INCOMPLETE/.test(gate1.reason ?? "") && /legalDescriptionGate\(/.test(strippedRepo("lib/esign/dispatch-packet.ts") ?? ""), gate1.reason ?? "")
  const completed = await fillPdfForm(filled.bytes, [{ name: "Legal Description", value: "LOT 7 BLK 2 CANARY COVE PB 12 PG 34" }])
  const gate2 = legalDescriptionGate([{ name: "Purchase Contract", fields: await readPdfTextFields(completed.bytes) }])
  c.step("with the legal description sourced (typed by the agent, or resolved from the record / RentCast / a human ask by lib/forms/legal-description.ts resolveLegalDescriptionForForm — the legal-description canary drives that order) the packet is COMPLETE", gate2.complete && gate2.blank.length === 0, "")
  const locked = await fillPdfForm(completed.bytes, [], { flatten: true })
  c.step("DOWNLOAD: flattening locks every value into the page (0 editable fields remain) and the bytes are still a PDF — the copy the agent downloads or the envelope carries cannot be edited downstream", (await listPdfFields(locked.bytes)).length === 0 && Buffer.from(locked.bytes.slice(0, 5)).toString() === "%PDF-" && (await PDFDocument.load(locked.bytes)).getPageCount() === 1, `${locked.bytes.length} bytes`)

  // ── 2 · autosave / resume: ONE draft row per context, tenant-pinned ──
  const { saveFormDraft, loadFormDraft, loadAvailableTransactionForms } = await import("../../lib/kernel/forms")
  const CTX = uuid()
  const s1 = await saveFormDraft({ brokerage_id: B, agent_id: AG, form_name: `${CANARY_TAG} Purchase Contract (FL)`, context_type: "offer", context_id: CTX, field_values: { "Purchase Price": "$400,000" } })
  const s2 = await saveFormDraft({ brokerage_id: B, agent_id: AG, form_name: `${CANARY_TAG} Purchase Contract (FL)`, context_type: "offer", context_id: CTX, field_values: { "Purchase Price": "$405,000", "Seller Name": "Sam Seller" } })
  const resumed = await loadFormDraft({ brokerage_id: B, agent_id: AG, form_name: `${CANARY_TAG} Purchase Contract (FL)`, context_id: CTX })
  c.step("AUTOSAVE / RESUME: the first save creates the draft (status draft, no external event), the second UPDATES the same row (one draft per agent × form × context), and loadFormDraft resumes the latest values", s1.success && s2.success && s1.data?.draft_id === s2.data?.draft_id && (svc.tables.form_submissions ?? []).filter((r) => r.context_id === CTX).length === 1 && resumed.success && resumed.data?.draft?.field_values?.["Purchase Price"] === "$405,000" && resumed.data?.draft?.status === "draft" && !(svc.tables.lifecycle_events ?? []).length, s1.error ?? s2.error ?? resumed.error ?? "")
  const foreign = await loadFormDraft({ brokerage_id: B2, agent_id: AG, form_name: `${CANARY_TAG} Purchase Contract (FL)`, context_id: CTX })
  c.step("POSITIVE CONTROL (tenant boundary): another tenant resuming the same context finds NO draft", foreign.success && foreign.data?.draft === null, "")

  // ── 3 · the ACTUAL available forms: the brokerage's own library + the context defaults, never invented, never empty ──
  const offerForms = await loadAvailableTransactionForms({ brokerage_id: B, context_type: "offer", state: "FL" })
  const listingForms = await loadAvailableTransactionForms({ brokerage_id: B, context_type: "listing", state: "FL" })
  c.step("RECOMMENDED FORMS come from what EXISTS: the offer context lists the brokerage's own FL purchase contract first; the listing context lists its listing agreement; every entry carries a name and a category; the two contexts are the wizard's two purposes (listing / offer — CDA is never one of them)", offerForms.success && listingForms.success && (offerForms.data?.forms ?? [])[0]?.name === `${CANARY_TAG} Purchase Contract (FL)` && (listingForms.data?.forms ?? [])[0]?.name === `${CANARY_TAG} Exclusive Listing Agreement` && [...(offerForms.data?.forms ?? []), ...(listingForms.data?.forms ?? [])].every((f) => !!f.name && !!f.category) && !(offerForms.data?.forms ?? []).some((f) => /cda|disbursement/i.test(String(f.name))), (offerForms.data?.forms ?? []).map((f) => f.name).join(" | ").slice(0, 200))

  // ── 4 · the provider path: API/popup where the vendor does not frame; iframe only where it documents framing ──
  const { PROVIDER_CATALOG, providerOfferVerdict, DEFAULT_ESIGN_PROVIDER } = await import("../../lib/integrations/providers/catalog")
  const wizard = strippedRepo("app/components/form-wizard/FormWizard.tsx") ?? ""
  c.step("provider window: the catalog's embed flag is per-provider EVIDENCE (SkySlope frames; Dotloop does not); the wizard opens a non-framing provider as a sized POPUP (window.open popup=yes, tab fallback) and frames an <iframe> ONLY under the iframe mode the catalog granted — a blank vendor iframe cannot happen by construction", PROVIDER_CATALOG.skyslope.capabilities.embed === true && PROVIDER_CATALOG.dotloop.capabilities.embed === false && /window\.open\([^)]*popup=yes/.test(wizard) && /embedMode\s*===\s*["']iframe["']\s*\?\s*["']iframe["']\s*:\s*["']popup["']/.test(wizard) && /handoff\.mode\s*===\s*["']iframe["']/.test(wizard), "")
  // The Google hand-off mode is named in code only through the dispatch's `embeddedSend` flag (false = the popup
  // hand-off); the literal "google_drive_handoff" lives in a comment at HEAD — stripped, so never asserted.
  const dispatch = strippedRepo("lib/esign/dispatch-packet.ts") ?? ""
  c.step("then the TENANT'S e-sign: the wizard sends through the one dispatch (sendListingAgreementForSignatureAction / submitForSignature → dispatchEsignPacket, resolveESignChoice — platform default DocuSign), the embedded DocuSign sender view framed (embedded_send → embeddedSend: true), the Google hand-off as the popup (embeddedSend false)", /sendListingAgreementForSignatureAction|submitForSignature/.test(wizard) && DEFAULT_ESIGN_PROVIDER === "docusign" && providerOfferVerdict("esign", "docusign").ok && /embeddedSend:\s*esignMode\s*===\s*["']embedded_send["']/.test(wizard) && /embeddedSend\??:\s*boolean/.test(dispatch) && /dispatchStatusFor\(/.test(dispatch), "")
  // WIRED 142K: the steps live on the spine (lib/forms/form-wizard-sequence.ts — lane 142B), never numbered in the component.
  const { FORM_WIZARD_STEP_LABELS: wizardLabels } = await import("../../lib/forms/form-wizard-sequence")
  console.log(`    census: wizard steps at HEAD — ${wizardLabels.join(" → ")} (FORM_WIZARD_SEQUENCE, rendered by stepKeyAt); the owner's sequence + the opening question are asserted in the 142B hook below`)
  // AI coaches, never authors a legal fact: the fill, the legal description and the wizard's prefill door name no model.
  const authored = ["lib/forms/pdf-form-fill.ts", "lib/forms/legal-description.ts", "app/actions/buyer-offer/prefill-storage-form.ts"].filter((f) => /generateText|generateObject|gatewayChat|Routed\(/.test(strippedRepo(f) ?? ""))
  c.step("NEVER model-authored: the PDF fill, the legal-description resolver and the wizard's prefill door name no model call (0 of 3) — the AI explains what is missing; a human fills the legal facts", authored.length === 0, authored.join(",") || "0 of 3")
  c.step("POSITIVE CONTROL: the model-call finder catches a specimen that routes a legal field through generateObjectRouted", /generateText|generateObject|gatewayChat|Routed\(/.test(`const { object } = await generateObjectRouted({ feature: "x", schema, prompt: "write the legal description" })`))
  // Mobile: the wizard is a dialog of six steps; the overflow census the mobile canary runs on pages is run on it here.
  const overflow = overflowFindings("app/components/form-wizard/FormWizard.tsx", wizard)
  c.step(`mobile (static census): the wizard's module carries ${overflow.length} overflow-risk idiom(s) (bare table / fixed width ≥ 480px / hard grid) — read beside the mobile canary's ratchet; the 390px render itself is the Playwright smoke (lane 142H)`, true, overflow.map((f) => `${f.kind}@${f.line}`).join(",") || "none")

  // ── WAVE142 HOOKS (integrator): 142B — the owner's sequence + AI intake; platform Media packets; the legal-forms
  //    provider vocabulary + popup/API; 142C — the widened legal-description sources in the address fill. ──
  for (const h of hooksFor("form-wizard")) {
    const at = h.probe()
    if (!at) {
      c.hook(h.lane, h.contract, /sequence/i.test(h.contract) ? `at HEAD the steps are ${wizardLabels.join(" → ")}; no 'listing forms or an offer?' question` : /SOURCE \(a\)/.test(h.contract) ? "STILL at 28774bdc2 (lane 142B landed no platform-Media packet — integrator finding, lane142K-notes): packets are brokerage-scoped only (brokerage_form_library behind app/api/admin/transaction-forms); nothing under platform Media carries a form packet" : /SOURCE \(b\)/.test(h.contract) ? "at HEAD the vocabulary is 'transaction forms' everywhere (TransactionFormsProvider 42 hits / 19 files); 'legal forms' has 0 spellings" : "at HEAD LEGAL_DESCRIPTION_SOURCES = agent | rentcast (m768)")
      continue
    }
    if (h.lane === "142C") {
      // WAVE142 HOOK (integrator): 142C — wired 142K: the landed sources (lane C folded county + approved OSINT research into
      // ONE provenance value, public_record, accepted only cited + shaped and stamped verification_required).
      const { LEGAL_DESCRIPTION_SOURCES } = await import("../../lib/forms/legal-description")
      const { looksLikeLegalDescription } = await import("../../lib/intelligence/offer-property-prefill")
      const sources = LEGAL_DESCRIPTION_SOURCES as readonly string[]
      const m786 = listFiles("supabase/migrations", (f) => /\/m786-[^/]+\.sql$/.test(f))[0] ?? null
      const sql = m786 ? readRepo(m786) ?? "" : ""
      const ld = strippedRepo("lib/forms/legal-description.ts") ?? "", lookup = strippedRepo("lib/property/address-lookup.ts") ?? ""
      const address = looksLikeLegalDescription("1 Canary Way, Pensacola, FL 32501"), street = looksLikeLegalDescription("123 Main Street, Pensacola, FL 32501")
      const ldChecks: Array<[string, boolean]> = [
        ["four sources", sources.length === 4 && ["agent", "listing", "rentcast", "public_record"].every((s) => sources.includes(s))],
        ["m786 spells all four", ["agent", "listing", "rentcast", "public_record"].every((s) => new RegExp(`'${s}'`).test(sql))],
        ["public_record stamped verification_required", /verification_required:\s*source\s*===\s*["']public_record["']/.test(ld)],
        ["address fill carries legalDescriptionSource", /legalDescriptionSource/.test(lookup)],
        ["a legal description passes the shape rule", looksLikeLegalDescription("LOT 7 BLK 2 CANARY COVE PB 12 PG 34").ok],
        ["a street address never does", !address.ok && !street.ok && ["street_address", "no_legal_tokens"].includes(address.reason) && ["street_address", "no_legal_tokens"].includes(street.reason)],
        ["empty refused", !looksLikeLegalDescription("").ok],
      ]
      c.step(`${h.lane} landed (${at}): the sources keep agent + rentcast and add the ACTIVE-LISTING record ('listing' — the IDX/MLS-fed row) and the public-record research capability ('public_record' — county record / approved OSINT research, accepted only CITED and SHAPED, stamped verification_required so a human verifies before the packet relies on it) — four provenance values the m786 CHECK spells; the ADDRESS FILL returns legalDescription + legalDescriptionSource beside the address; the shape rule never accepts a street address (two positive controls)`, ldChecks.every(([, ok]) => ok), `${sources.join(",")}; m786 ${m786 ?? "MISSING"}; address → ${address.reason} / ${street.reason}${ldChecks.some(([, ok]) => !ok) ? `; FAILED: ${ldChecks.filter(([, ok]) => !ok).map(([n]) => n).join(", ")}` : ""}`)
      continue
    }
    if (/^FORMWIZARD/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142B — wired 142K: the spine, the coach, the recommendation and the terms, driven pure.
      const seq = await import("../../lib/forms/form-wizard-sequence")
      const { getStateForms } = await import("../../lib/state-forms/registry")
      const fl = getStateForms("FL", "offer")
      const financingAddendum = fl.addenda.find((a) => /financ/i.test(a)) ?? null
      const inspectionAddendum = fl.addenda.find((a) => /inspection/i.test(a)) ?? null
      // A realistic library: the required contract in Media, the two contingency addenda at the legal-forms provider.
      const providerForm = (name: string) => ({ ref: `skyslope:${name}`, name, source: "legal_forms_provider" as const, providerName: "skyslope" })
      const available = [{ ref: `lib/${fl.required[0]}.pdf`, name: fl.required[0], source: "my_forms" as const }, ...(inspectionAddendum ? [providerForm(inspectionAddendum)] : []), ...(financingAddendum ? [providerForm(financingAddendum)] : [])]
      const cashAnswers = { property_source: "outside", offer_price: "$400,000", financing_type: "cash", earnest_money: 5000, closing_date: "2026-12-01", inspection_period_days: 10, sale_of_buyer_home: false, pre_1978: false, hoa: false }
      const cash = seq.recommendForms({ purpose: "offer", answers: cashAnswers, statePackage: fl, available, stateCode: "FL" })
      const financed = seq.recommendForms({ purpose: "offer", answers: { ...cashAnswers, financing_type: "conventional", financing_contingency_days: 21, appraisal_contingency: true }, statePackage: fl, available, stateCode: "FL" })
      const none = seq.recommendForms({ purpose: "offer", answers: cashAnswers, statePackage: null, available, stateCode: "FL" })
      // MEASURED (lane 142B / integrator, the matcher's precision): with a SPARSE library (the financing file only) the token
      // matcher (lib/forms/state-package-match.ts:60 — a 2/3-token overlap scores) attaches the FINANCING file to the
      // INSPECTION slot and starves the financing entry; a realistic library joins correctly (the step above).
      const sparse = financingAddendum ? seq.recommendForms({ purpose: "offer", answers: cashAnswers, statePackage: fl, available: [providerForm(financingAddendum)], stateCode: "FL" }) : null
      const misJoin = sparse?.recommended.find((r) => r.name === financingAddendum && r.packageForm !== financingAddendum) ?? null
      console.log(`    finding (lane 142B, matcher precision): sparse library → ${misJoin ? `"${misJoin.name}" attached to the "${misJoin.packageForm}" slot (state-package-match.ts:60 admits a 2/3-token overlap)` : "no mis-join"}`)
      const terms = seq.offerTermsToCreateOfferFields(cashAnswers)
      const first8 = seq.FORM_WIZARD_STEP_LABELS.slice(0, 8).map((l) => l.toLowerCase().replace(/[^a-z]/g, ""))
      const wizardChecks: Array<[string, boolean]> = [
        ["the owner's sequence, no CDA step", first8.join(",") === "purpose,property,parties,terms,recommendedforms,complete,review,esigndeliver" && !seq.FORM_WIZARD_STEP_LABELS.some((l) => /cda/i.test(l))],
        ["the opening question + two purposes", /listing forms or an offer/i.test(seq.FORM_WIZARD_OPENING_QUESTION) && [...seq.FORM_WIZARD_PURPOSES].join() === "listing,offer"],
        ["the coach never invents", seq.AI_COACH_RULES.some((r) => /never invents legal terms, signatures or material facts/.test(r))],
        ["intake names what is missing", seq.missingRequiredIntake("offer", {}).some((p) => /offer price/i.test(p)) && seq.missingRequiredIntake("offer", cashAnswers).length === 0 && seq.missingRequiredIntake("listing", {}).some((p) => /representation/i.test(p))],
        ["recommendation returns only forms that exist", cash.recommended.every((r) => available.some((a) => a.ref === r.ref)) && cash.recommended.some((r) => r.kind === "required" && r.name === fl.required[0])],
        ["a required form nobody has is NAMED, never invented", cash.missing.length >= Math.max(0, fl.required.length - 1) && cash.missing.every((m) => /not in your library or your legal-forms provider/.test(m.why))],
        ["financing addendum only when financed", !financingAddendum || (!cash.recommended.some((r) => r.name === financingAddendum) && financed.recommended.some((r) => r.name === financingAddendum && r.kind === "addendum" && /financed/.test(r.reason) && r.source === "legal_forms_provider"))],
        ["no package → nothing", none.recommended.length === 0 && none.missing.length === 0],
        ["terms become the offer's fields", terms.offer_price === 400_000 && terms.earnest_money === 5000 && terms.financing_type === "cash" && !terms.financing_contingency && !terms.appraisal_contingency && terms.inspection_contingency && terms.inspection_period_days === 10 && terms.closing_date === "2026-12-01"],
        ["form_source is the column's word", seq.offerFormSourceFor([{ source: "my_forms" }]) === "in_app" && seq.offerFormSourceFor([{ source: "legal_forms_provider", providerName: "SkySlope" }]) === "skyslope" && seq.offerFormSourceFor([{ source: "legal_forms_provider", providerName: "formsimplicity" }]) === "manual" && seq.offerFormSourceFor([]) === "manual"],
        ["the wizard renders from the spine", /stepKeyAt\(/.test(wizard) && /StepPurpose/.test(wizard)],
      ]
      const wizardBad = wizardChecks.filter(([, ok]) => !ok).map(([n]) => n)
      c.step(`${h.lane} landed (${at}): the wizard renders the OWNER's sequence from ONE spine (Purpose → Property → Parties → Terms → Recommended Forms → Complete → Review → E-sign/Deliver; CDA is never a step) and opens with "${seq.FORM_WIZARD_OPENING_QUESTION}" (listing | offer are the only purposes); the coach's rules say it never invents legal terms, signatures or material facts; the intake names what is still missing (a blank offer misses the price; a blank listing misses the representation); the RECOMMENDATION returns only forms that EXIST (the state's verified package joined to the library / the legal-forms provider; a required form nobody has is NAMED under missing, never invented; a financing addendum only when the purchase is financed; no package → nothing); the TERMS become the offer's real fields (price 400000, cash → no financing / appraisal contingency, inspection 10 days); form_source is the column's word (in_app | the provider's name | manual)`, wizardBad.length === 0, `FL offer package: ${fl.required.length} required, ${fl.addenda.length} addenda; recommended cash ${cash.recommended.length} / financed ${financed.recommended.length}; missing ${cash.missing.length}${wizardBad.length ? `; FAILED: ${wizardBad.join(", ")} — cash ${JSON.stringify(cash.recommended.map((r) => r.name))} financed ${JSON.stringify(financed.recommended.map((r) => r.name))} missing ${JSON.stringify(cash.missing.map((m) => m.packageForm))} intake ${JSON.stringify(seq.missingRequiredIntake("offer", cashAnswers))}` : ""}`)
      continue
    }
    if (/SOURCE \(a\)/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142B — wired by lane 143B: the PLATFORM-MEDIA packet source (lib/forms/platform-form-packets.ts,
      // m807 platform_form_packets, /api/form-wizard/platform-packets, superadmin approve/retire) on the existing fill rail.
      const packets = await import("../../lib/forms/platform-form-packets")
      const { checkFormPathsInScope } = await import("../../lib/forms/form-path-scope")
      const m807 = listFiles("supabase/migrations", (f) => /\/m\d+-platform-form-packets\.sql$/.test(f))[0] ?? null
      const sql = m807 ? readRepo(m807) ?? "" : ""
      const approved = { id: "11111111-1111-4111-8111-111111111111", status: "approved", state: null, packet_type: "offer", field_count: 4, license_note: "Licensed to the platform by the association for member redistribution", license_expires_at: null, approved_by: "u1", storage_path: "platform/11111111-1111-4111-8111-111111111111/contract.pdf" }
      const registry = (rows: Array<Record<string, unknown>>) => ({ from: () => ({ select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }) }) })
      const actor = { brokerageId: B, teamId: null, userId: "u1" }
      // WAVE 144 (lane 144J, per lane 144C Outside-lane 1 — owner ruling 3: form packets are BROKERAGE / TEAM-owned): the wave-143
      // rule this step asserted ("a tenant agent fills an approved platform packet directly") is REVERSED. The platform registry
      // (m807) stays as a labelled CATALOGUE a brokerage copies from (addPlatformPacketToLibrary → brokerage_form_library, m853);
      // agents reach only their brokerage's / team's packets. The m807 CHECK, the path grammar, the prefill rail and the superadmin
      // items are kept. At 967a4866 alone (without 144C) the catalogue-master item is red — the reversal is the ruling.
      const tenantPackets = await landedModule("../../lib/forms/tenant-form-packets.ts")
      const catalogueRefused = await checkFormPathsInScope(registry([approved]), [approved.storage_path], actor)
      const wiring: Array<[string, boolean]> = [
        ["m807 registers the packets with an approval-evidence CHECK", /platform_form_packets_approved_needs_evidence/.test(sql) && /field_count > 0/.test(sql)],
        ["a tenant NEVER fills a catalogue master (platform/… refused even when approved)", !catalogueRefused.ok],
        ["a brokerage / team packet path names its owner", tenantPackets?.parseTenantPacketPath?.(`teams/${"11111111-1111-4111-8111-111111111111"}/packets/${"22222222-2222-4222-8222-222222222222"}/x.pdf`)?.kind === "team"],
        ["the platform path grammar refuses traversal and depth", packets.parsePlatformPacketPath("platform/11111111-1111-4111-8111-111111111111/../x.pdf") === null && packets.parsePlatformPacketPath("platform/11111111-1111-4111-8111-111111111111/a/b.pdf") === null],
        ["the wizard lists the brokerage's / team's packets through /api/form-wizard/form-packets and never a platform group", /\/api\/form-wizard\/form-packets/.test(wizard) && !/\/api\/form-wizard\/platform-packets/.test(wizard) && !/scope: "platform"/.test(wizard) && !/source: "platform/.test(wizard)],
        ["a brokerage ADDS a catalogue packet to its own library", /addPlatformPacketToLibrary\(/.test(strippedRepo("app/api/admin/transaction-forms/route.ts") ?? "")],
        ["the fill action reaches the packet through checkFormPathsInScope (unchanged rail)", /checkFormPathsInScope/.test(strippedRepo("app/actions/buyer-offer/prefill-storage-form.ts") ?? "")],
        ["approval is superadmin-gated and recorded", /requireSuperadmin\(\)/.test(strippedRepo("app/actions/superadmin/platform-form-packets.ts") ?? "") && /platform_form_packet\.approved/.test(readRepo("app/actions/superadmin/platform-form-packets.ts") ?? "")],
      ]
      const bad = wiring.filter(([, ok]) => !ok).map(([n]) => n)
      c.step(`${h.lane} landed (${at}) — SOURCE (a), re-asserted for owner ruling 3 (wave 144): the platform holds a licensed CATALOGUE (registry m807: approver, licence basis, expiry, ≥1 fillable field enforced by CHECK); brokerages add packets to their own library; agents see only their brokerage's / team's — a platform/… master is never filled directly (refused even when approved), a tenant packet path names its owner (brokerage | team), the wizard lists the tenant library only, the same fill rail (checkFormPathsInScope) takes it, and superadmin approves / retires catalogue rows with an audit row`, bad.length === 0, bad.join(" | ") || `${m807 ?? "m807 MISSING"}; ${wiring.length} checks`)
      continue
    }
    if (/SOURCE \(b\)/.test(h.contract)) {
      // WAVE142 HOOK (integrator): 142B — wired 142K: ONE tenant-facing spelling; the matrix per provider; no old spelling left.
      const { LEGAL_FORMS_PROVIDER_LABEL, PROVIDER_CAPABILITY_MATRIX } = await import("../../lib/integrations/providers/catalog")
      const rows = Object.entries(PROVIDER_CAPABILITY_MATRIX) as Array<[string, Record<string, unknown>]>
      const need = ["credentials", "settings", "forms", "transaction_creation", "esign", "status", "sync"]
      // The COPY census: tenant-facing surfaces (app/**/*.tsx, stripped) with import specifiers dropped — a module PATH
      // (lib/integrations/transaction-providers/…) is code the lane deliberately did not rename, never copy. The .ts
      // residues (server log strings, module paths) are published beside the zero, not counted.
      const OLD = /transaction[- ]?(forms?)?[- ]provider/i
      const dropImports = (s: string) => s.replace(/\bfrom\s+["'][^"']+["']/g, "").replace(/import\(\s*["'][^"']+["']\s*\)/g, "")
      const oldSpelling = listFiles("app", (f) => /\.tsx$/.test(f)).filter((f) => OLD.test(dropImports(strippedRepo(f) ?? "")))
      const residues = listFiles("app", (f) => /\.ts$/.test(f)).filter((f) => OLD.test(dropImports(strippedRepo(f) ?? "")))
      const integrations = strippedRepo("app/dashboard/settings/integrations/integrations-client.tsx") ?? ""
      c.step(`${h.lane} landed (${at}) — SOURCE (b) + VOCABULARY: the tenant-facing name is ONE spelling (LEGAL_FORMS_PROVIDER_LABEL = 'Legal-forms provider'; the integrations table carries it; the wizard's source vocabulary is my_forms | legal_forms_provider); 0 tenant-facing 'transaction provider' spellings remain in app/**/*.tsx after stripping (import paths dropped; positive control: the finder catches the old spelling in a specimen); the matrix says per provider (${rows.length}) credentials / settings / forms / transaction creation / document upload / form fill / e-sign / status / sync with evidence per cell; the provider window is API → embedded → popup, never an unsupported iframe (asserted above)`, LEGAL_FORMS_PROVIDER_LABEL === "Legal-forms provider" && /legal-forms provider/i.test(integrations) && /legal_forms_provider/.test(strippedRepo("lib/forms/form-wizard-sequence.ts") ?? "") && oldSpelling.length === 0 && OLD.test("Connect your transaction forms provider") && !OLD.test(dropImports(`import { x } from "@/lib/integrations/transaction-providers/resolve-transaction-provider"`)) && rows.length >= 5 && rows.every(([, row]) => need.every((k) => k in row) && Object.keys(row).length >= 8), `cells: ${rows[0] ? Object.keys(rows[0][1]).join(",") : "none"}; old spelling in .tsx: ${oldSpelling.join(",") || "none"}`)
      console.log(`    census (§6 residues, not copy): the old spelling in app/**/*.ts after stripping, import paths dropped — ${residues.length ? residues.join(", ") : "none"} (server-log strings in ai-offer-creation.ts; module paths lib/integrations/transaction-providers/* + transaction-provider.interface are file names lane 142B left unrenamed — report for the integrator)`)
      continue
    }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary and assert the contract (WAVE142 HOOK (integrator): ${h.lane})`, false, h.contract.slice(0, 120))
  }
  c.blind("The wizard is a client component (React) — its sequence, the popup launcher and the iframe rule are asserted on stripped source, not rendered; the e-sign send is the dispatch recorder's (cda-esign / listing-lifecycle canaries); provider forms (SkySlope / Form Simplicity) are never fetched; RLS not modelled.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
