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
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"
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
  const labels = [...wizard.matchAll(/STEP_LABELS_(OFFER|LISTING)\s*=\s*\[([^\]]*)\]/g)].map((m) => `${m[1]}: ${m[2].replace(/["'\s]/g, "")}`)
  console.log(`    census: wizard steps at HEAD — ${labels.join(" · ") || "(no STEP_LABELS const)"}; the owner's sequence (Purpose → Property → Parties → Terms → Recommended Forms → Complete → Review → E-sign/Deliver) and the opening question are lane 142B's hook`)
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
      c.hook(h.lane, h.contract, /sequence/i.test(h.contract) ? `at HEAD the steps are ${labels[0] ?? "Context, Forms, Fill, Signers, E-Sign, Monitor"}; no 'listing forms or an offer?' question` : /SOURCE \(a\)/.test(h.contract) ? "at HEAD packets are brokerage-scoped only (brokerage_form_library behind app/api/admin/transaction-forms); nothing under platform Media carries a form packet" : /SOURCE \(b\)/.test(h.contract) ? "at HEAD the vocabulary is 'transaction forms' everywhere (TransactionFormsProvider 42 hits / 19 files); 'legal forms' has 0 spellings" : "at HEAD LEGAL_DESCRIPTION_SOURCES = agent | rentcast (m768)")
      continue
    }
    if (h.lane === "142C") {
      const { LEGAL_DESCRIPTION_SOURCES } = await import("../../lib/forms/legal-description")
      const sources = LEGAL_DESCRIPTION_SOURCES as readonly string[]
      c.step(`${h.lane} landed (${at}): the sources keep agent + rentcast and add the owner's three (an active-listing / IDX-MLS record, a county / public-record capability, approved OSINT research) — each a provenance value, never the street address`, sources.includes("agent") && sources.includes("rentcast") && sources.some((s) => /listing|idx|mls/i.test(s)) && sources.some((s) => /county|public/i.test(s)) && sources.some((s) => /osint/i.test(s)), sources.join(","))
      continue
    }
    if (/sequence/i.test(h.contract)) {
      const landedLabels = [...(strippedRepo(at) ?? "").matchAll(/STEP_LABELS_(OFFER|LISTING)\s*=\s*\[([^\]]*)\]/g)].map((m) => m[2])
      c.step(`${h.lane} landed (${at}): the wizard asks 'listing forms or an offer?' and its step vocabulary carries Recommended Forms + Review + E-sign/Deliver (never a CDA step)`, /listing forms or an offer/i.test(strippedRepo(at) ?? "") && landedLabels.some((l) => /Recommended/i.test(l) && /Review/i.test(l)) && !landedLabels.some((l) => /CDA/i.test(l)), landedLabels.join(" · "))
      continue
    }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary and assert the contract (WAVE142 HOOK (integrator): ${h.lane})`, false, h.contract.slice(0, 120))
  }
  c.blind("The wizard is a client component (React) — its sequence, the popup launcher and the iframe rule are asserted on stripped source, not rendered; the e-sign send is the dispatch recorder's (cda-esign / listing-lifecycle canaries); provider forms (SkySlope / Form Simplicity) are never fetched; RLS not modelled.")
  const a = await cleanupCanary(svc, B), b = await cleanupCanary(svc, B2)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", a.mismatches.length + b.mismatches.length === 0 && a.residual + b.residual === 0, [...a.cleanup, ...b.cleanup].map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report([...a.cleanup, ...b.cleanup], a.residual + b.residual)
}
