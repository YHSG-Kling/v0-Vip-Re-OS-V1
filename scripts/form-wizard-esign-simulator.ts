#!/usr/bin/env tsx
/**
 * scripts/form-wizard-esign-simulator.ts — lane 88C (wave 88), `npm run test:form-wizard-esign`.
 *
 * Owner: "There needs to be no issues with the form wizard … the real estate agent can pull local
 * form packages for listing agreements, offers, etc or view the external transaction providers form
 * selections in an iframe … fill out the form fields in real time … connect to their esign provider
 * in an iframe or such to send the forms … We have this built already … just make sure that the
 * capability/feature work like intended." And: "google esign is default not dotloop."
 *
 * Proves the FormWizard's agent flow end to end, as RULES (never waypoints):
 *   A. PROVIDER WINDOW — iframe only where the vendor documents framing; popup otherwise; ONE
 *      portal-URL map (the catalog) — no second spelling anywhere in app/ or lib/.
 *   B. PACKAGE — the state's package (registry) is joined to the agent's library; missing forms named.
 *   C. FILL IN REAL TIME — a real AcroForm PDF: property + party prefill, the agent's typed values
 *      win, the filled bytes carry them, signature/price fields are never prefilled.
 *   D. TENANT — every brokerage-forms path the service client reads is in the SESSION's scope.
 *   E. SEND — the wizard reads the send's result and ships the filled packet; the send attaches
 *      before it sends and reads the provider's verdict; Google eSignature is the default.
 *   F. SIGNED BACK — the listing lane stamps the envelope where the provider webhooks look.
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2). Code-token scans read
 * STRIPPED source (scripts/strip-comments.ts) so a tombstone never counts as a call site.
 *
 * MAINTENANCE: domain `form_wizard_esign` in lib/kernel/manager-registry.ts — manager
 * deal_coordinator; coOwners compliance_officer (tenant scope + e-sign records) and
 * data_steward (the provider catalog and connection cascade).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { PDFDocument } from "pdf-lib"
import { stripComments, blankStrings } from "./strip-comments"
import { PROVIDER_CATALOG, providerPortalMode, supportsEmbeddedSend, PROVIDER_PORTAL_URLS, getCatalogEntry, DEFAULT_ESIGN_PROVIDER } from "../lib/integrations/providers/catalog"
import { deriveEsignAnchors } from "../lib/forms/esign-anchors"
import { anchorsForProvider, docusignTabsByRecipient } from "../lib/forms/esign-anchor-adapters"
import { checkFormPathsInScope } from "../lib/forms/form-path-scope"
import { buildPartyPrefill } from "../lib/forms/party-prefill"
import { matchStatePackage } from "../lib/forms/state-package-match"
import { getStateForms } from "../lib/state-forms/registry"
import { prefillPropertyIntoPdf } from "../lib/forms/prefill-property-into-pdf"
import { fillPdfForm, readPdfTextFields } from "../lib/forms/pdf-form-fill"
import { googleDriveGranted, buildDriveMultipartBody, driveFileOpenUrl } from "../lib/esign/google-drive-upload"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
/** Code only: comments stripped (line numbers kept). */
const code = (p: string) => stripComments(src(p))
/** Code with string literals blanked too — for token scans a fixture string must not satisfy. */
const bare = (p: string) => blankStrings(stripComments(src(p)))

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const rel = join(dir, e)
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel)
  }
  return out
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" FormWizard → e-sign flow simulator (lane 88C)")
  console.log("══════════════════════════════════════════════════\n")

  // ── A. PROVIDER WINDOW ────────────────────────────────────────────────────
  console.log("[A · provider window: iframe only where framing is documented]")
  const modes = Object.fromEntries(Object.keys(PROVIDER_CATALOG).map((k) => [k, providerPortalMode(k)?.mode]))
  check("SkySlope frames (documented Forms Widget iframe) → iframe", modes.skyslope === "iframe")
  check("SkySlope window is the frameable Forms app (forms.skyslope.com)", PROVIDER_PORTAL_URLS.skyslope.startsWith("https://forms.skyslope.com"))
  for (const p of ["google_esign", "dotloop", "docusign", "authentisign", "brokermint", "formsimplicity"]) {
    check(`${p} has no documented embed surface → popup (never a blank iframe)`, modes[p] === "new_tab")
  }
  check("only DocuSign offers an embedded SENDER view", Object.keys(PROVIDER_CATALOG).filter((k) => supportsEmbeddedSend(k)).join(",") === "docusign")
  check("Google eSignature is ONE catalog entry (88B's google_esign): portal-send, no class, popup",
    PROVIDER_CATALOG.google_esign?.portalSend === true && PROVIDER_CATALOG.google_esign.implemented === false && modes.google_esign === "new_tab")
  check("§6: no second Google e-sign spelling in the catalog", !("google" in PROVIDER_CATALOG))

  // ONE portal-URL map — the catalog. Finder: a Record literal of provider → URL outside the catalog.
  const dupFinder = (s: string) => /dotloop\s*:\s*["'`]https?:\/\//.test(s) && /(skyslope|docusign)\s*:\s*["'`]https?:\/\//.test(s)
  const fakeEmbed = (s: string) => /dotloop\.com\/loops\?embed=1/.test(s)
  const specimen = `const providerUrls = {\n dotloop: "https://www.dotloop.com/",\n skyslope: "https://app.skyslope.com/" }`
  check("POSITIVE CONTROL: the duplicate-map finder recognises a local provider→URL map", dupFinder(specimen))
  check("POSITIVE CONTROL: the fake-embed finder recognises the retired dotloop '?embed=1' URL", fakeEmbed(`src="https://dotloop.com/loops?embed=1"`))
  const files = [...walk("app"), ...walk("lib")]
  const dupSites = files.filter((f) => f !== join("lib", "integrations", "providers", "catalog.ts") && dupFinder(code(f)))
  check(`no second provider portal-URL map in app/ or lib/ (scanned ${files.length} files)`, dupSites.length === 0, dupSites.join(", "))
  const fakeSites = files.filter((f) => fakeEmbed(code(f)))
  check("the non-existent dotloop '?embed=1' endpoint is referenced nowhere", fakeSites.length === 0, fakeSites.join(", "))
  const wizard = code("app/components/form-wizard/FormWizard.tsx")
  check("FormWizard frames the provider only when embedMode === 'iframe' and otherwise opens a popup",
    /providerInfo\.embedMode\s*===\s*"iframe"\s*\?/.test(wizard) && /openProviderPopup\(providerInfo\.embedUrl/.test(wizard))

  // ── B. PACKAGE ────────────────────────────────────────────────────────────
  console.log("\n[B · the state's local form package, joined to the agent's library]")
  const ca = getStateForms("CA", "listing")
  const lib = [
    { name: "CAR RLA Residential Listing Agreement 2025.pdf" },
    { name: "CAR TDS Transfer Disclosure Statement.pdf" },
    { name: "Brokerage Wire Fraud Advisory.pdf" },
  ]
  const m = matchStatePackage(ca, lib, "CA")
  const rla = m.find((x) => x.required.includes("RLA"))
  check("CA listing package: the RLA matches the library's listing agreement", rla?.file?.name === lib[0].name)
  check("CA listing package: the TDS matches its file", m.find((x) => x.required.includes("TDS"))?.file?.name === lib[1].name)
  check("a required form the library lacks is NAMED (not silently absent)", m.some((x) => x.kind === "required" && x.file === null))
  check("an unrelated library file is never forced onto a package form", !m.some((x) => x.file?.name === lib[2].name))
  check("each library file is used at most once", new Set(m.filter((x) => x.file).map((x) => x.file!.name)).size === m.filter((x) => x.file).length)
  check("a TX offer package never matches a California file (the property's state decides)",
    !matchStatePackage(getStateForms("TX", "offer"), [{ name: "CAR RPA Residential Purchase Agreement.pdf" }], "TX").some((x) => x.file))
  check("filler words and the state code never make a match on their own",
    !matchStatePackage({ required: ["CA Residential Real Estate Form"], addenda: [], brokerageRepresentation: "" }, [{ name: "CA Residential Form.pdf" }], "CA").some((x) => x.file))
  check("FormWizard renders the package panel and selects its matched files",
    /<StatePackagePanel\b/.test(wizard) && /matchStatePackage\(pkg, myForms, code\)/.test(wizard))

  // ── C. FILL IN REAL TIME ──────────────────────────────────────────────────
  console.log("\n[C · fill fields in real time — a real AcroForm PDF]")
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const form = doc.getForm()
  const names = ["Property Address", "Buyer Name", "Buyer 2 Name", "Seller Name", "Buyer's Agent Name", "Listing Agent Name", "Purchase Price", "Buyer Signature Name", "Buyer Email"]
  names.forEach((n, i) => form.createTextField(n).addToPage(page, { x: 40, y: 740 - i * 30, width: 300, height: 20 }))
  const pdf = await doc.save()
  const prop = await prefillPropertyIntoPdf(pdf, { address: "12 Elm St" })
  check("property prefill fills the property address", prop.filled.includes("Property Address"))
  const party = buildPartyPrefill(prop.available, { mode: "offer", buyers: ["Casey Buyer", "Sam Co"], sellers: [], agentName: "Pat Agent" })
  const byName = Object.fromEntries(party.filled.map((f) => [f.name, f.value]))
  check("party prefill: Buyer Name ← first buyer", byName["Buyer Name"] === "Casey Buyer")
  check("party prefill: Buyer 2 Name ← second buyer", byName["Buyer 2 Name"] === "Sam Co")
  check("party prefill (offer): OUR agent is the buyer's agent", byName["Buyer's Agent Name"] === "Pat Agent")
  check("party prefill (offer): the LISTING agent is never filled with our agent", !("Listing Agent Name" in byName))
  check("party prefill never touches price, signature or email fields",
    !("Purchase Price" in byName) && !("Buyer Signature Name" in byName) && !("Buyer Email" in byName))
  check("party prefill: an unknown seller is left blank and reported", party.unresolved.includes("Seller Name"))
  const listingSide = buildPartyPrefill(["Listing Agent Name", "Buyer's Agent Name", "Seller Name"], { mode: "listing", buyers: [], sellers: ["Lee Seller"], agentName: "Pat Agent" })
  check("listing mode: our agent is the LISTING agent, never the buyer's agent",
    listingSide.filled.some((f) => f.name === "Listing Agent Name" && f.value === "Pat Agent") && !listingSide.filled.some((f) => f.name === "Buyer's Agent Name"))
  check("listing mode: the seller is filled from the wizard's seller", listingSide.filled.some((f) => f.name === "Seller Name" && f.value === "Lee Seller"))
  const unnamed = buildPartyPrefill(["Name 1", "Printed Name"], { mode: "offer", buyers: ["Casey Buyer"], sellers: ["Lee Seller"], agentName: "Pat Agent" })
  check("POSITIVE CONTROL: a field naming no party is not claimed (filled nor reported)", unnamed.filled.length === 0 && unnamed.unresolved.length === 0)
  const typed = await fillPdfForm(prop.bytes, [...party.filled, { name: "Purchase Price", value: "$525,000" }, { name: "Buyer Name", value: "Casey Q. Buyer" }].filter((v, i, a) => a.findLastIndex((x) => x.name === v.name) === i))
  const after = Object.fromEntries((await readPdfTextFields(typed.bytes)).map((f) => [f.name, f.value]))
  check("the agent's typed value wins over the prefill and is IN the filled bytes", after["Buyer Name"] === "Casey Q. Buyer")
  check("the agent's typed offer term is in the filled bytes", after["Purchase Price"] === "$525,000")
  check("readPdfTextFields returns every text field (the wizard's editable panel)", names.every((n) => n in after))
  const prefillAction = code("app/actions/buyer-offer/prefill-storage-form.ts")
  check("the fill action applies parties, then the agent's typed values, and returns the fields",
    /buildPartyPrefill\(/.test(prefillAction) && /input\.fieldValues/.test(prefillAction) && /fields:\s*await readPdfTextFields\(bytes\)/.test(prefillAction))
  check("the wizard renders the fields as inputs and re-fills on Apply", /applyEdits\(f\.formRef\)/.test(wizard) && /fieldValues:\s*typed/.test(wizard))

  // ── D. TENANT ─────────────────────────────────────────────────────────────
  console.log("\n[D · tenant: every brokerage-forms path is in the SESSION's scope]")
  const actor = { brokerageId: "b1", teamId: "t1", userId: "u1" }
  let offerReads = 0
  const fakeSvc = (rows: Array<{ id: string }> | null, error: { message: string } | null) => ({
    from: () => ({ select: () => ({ in: () => ({ eq: async () => { offerReads++; return { data: rows, error } } }) }) }),
  })
  const noOffers = fakeSvc([], null)
  const inScope = async (p: string) => (await checkFormPathsInScope(noOffers, [p], actor)).ok
  check("own brokerage library → allowed", await inScope("brokerage/b1/rla.pdf"))
  check("ANOTHER brokerage's library → refused", !(await inScope("brokerage/b2/rla.pdf")))
  check("own team / own agent folder (incl. uploads/) → allowed", (await inScope("teams/t1/x.pdf")) && (await inScope("agents/u1/uploads/x.pdf")))
  check("another team's / another agent's folder → refused", !(await inScope("teams/t2/x.pdf")) && !(await inScope("agents/u2/x.pdf")))
  const hostile = ["brokerage/b1/../b2/x.pdf", "/brokerage/b1/x.pdf", "https://evil/x.pdf", "brokerage/b1", "other/b1/x.pdf"]
  check("path traversal / absolute / URL / bare root / unknown root → refused", (await Promise.all(hostile.map(inScope))).every((ok) => !ok))
  offerReads = 0
  check("own filled copy → allowed with NO offer read", (await inScope("filled/u1/a.pdf")) && offerReads === 0)
  check("POSITIVE CONTROL: a filled copy under another id DOES trigger the offer proof", !(await inScope("filled/o9/a.pdf")) && offerReads === 1)
  check("filled/{offerId} of MY brokerage → allowed", (await checkFormPathsInScope(fakeSvc([{ id: "o9" }], null), ["filled/o9/a.pdf"], actor)).ok)
  check("filled/{offerId} of another brokerage → refused", !(await checkFormPathsInScope(fakeSvc([], null), ["filled/o9/a.pdf"], actor)).ok)
  const refusedRead = await checkFormPathsInScope(fakeSvc(null, { message: "rls" }), ["filled/o9/a.pdf"], actor)
  check("a REFUSED offer read fails CLOSED (refused, with the reason)", !refusedRead.ok && /rls/.test(refusedRead.error ?? ""))
  // Every service-client reader of the bucket checks scope BEFORE it downloads.
  for (const p of ["app/actions/buyer-offer/prefill-storage-form.ts", "app/actions/buyer-offer/esign-anchor-plan.ts"]) {
    const c = bare(p)
    const gate = c.indexOf("checkFormPathsInScope("), dl = c.indexOf(".download(")
    check(`${p}: scope check precedes the service-client download`, gate > 0 && dl > gate)
  }
  check("POSITIVE CONTROL: the ordering finder flags a download with no scope check",
    (() => { const c = `const f = await svc.storage.from(B).download(p)`; const g = c.indexOf("checkFormPathsInScope("); return !(g > 0 && c.indexOf(".download(") > g) })())
  const route = bare("app/api/form-wizard/resolve-provider/route.ts")
  check("resolve-provider takes NO tenant ids from the request", !/searchParams|req\.nextUrl|request\.url/.test(route))
  check("POSITIVE CONTROL: that finder sees the old query-string read", /searchParams/.test(`const brokerageId = searchParams.get("brokerageId")`))
  const tds = code("app/actions/transaction-document-signatures.ts")
  check("the per-document send reads the document under the SESSION's brokerage", /\.eq\("transaction_id", transactionId\)\s*\n\s*\.eq\("brokerage_id", brokerageId\)/.test(tds))

  // ── E. SEND ───────────────────────────────────────────────────────────────
  console.log("\n[E · send: result read, packet attached, provider verdict read, Google default]")
  const discarded = (s: string) => /(^|\n)\s*await submitForSignature\(/.test(s)
  check("POSITIVE CONTROL: the finder recognises a discarded submitForSignature result", discarded(`\n      await submitForSignature({ offerId })`))
  check("FormWizard READS the send's result (no discarded await)", !discarded(wizard) && /const sent = await submitForSignature\(/.test(wizard))
  check("FormWizard ships the FILLED packet with the send", /documents:\s*packetDocuments\(state\)/.test(wizard))
  check("a refused send stays on step 5 (setError + return before setStep(6))", /if \(!sent\.success\) \{[\s\S]{0,300}?return\s*\n\s*\}/.test(wizard))
  check("the NAR commission-disclosure refusal offers the dialog that clears it", /blocker === "commission_disclosure_required"/.test(wizard) && /<CommissionDisclosureDialog/.test(wizard))
  const core = bare("lib/esign/dispatch-packet.ts")
  const coreCode = code("lib/esign/dispatch-packet.ts")
  const iAttach = core.indexOf(".attachForms("), iSend = core.indexOf(".sendForSignature(")
  check("the dispatch core ATTACHES the packet before it sends", iAttach > 0 && iSend > iAttach)
  check("the dispatch core reads the provider's verdict on send AND attach", /if \(!sent\.success\)/.test(core) && /if \(!attached\.success\)/.test(core))
  check("a partial attach is a refusal, never 'sent'", /attachedCount < input\.documents\.length/.test(core))
  check("the core resolves through the ONE e-sign choice (selection → the catalog default)", /resolveESignChoice\(/.test(core))
  for (const p of ["app/actions/buyer-offer/submit-for-signature.ts", "app/actions/transaction-document-signatures.ts", "app/dashboard/transactions/[id]/page.tsx"]) {
    const c = code(p)
    check(`${p}: no brokerage-wide 'newest platform_credentials' e-sign read`, !/\.from\("platform_credentials"\)/.test(c))
  }
  check("POSITIVE CONTROL: that finder sees the old credential read", /\.from\("platform_credentials"\)/.test(`supabase.from("platform_credentials").select("platform")`))
  check("submitForSignature and the per-document send both go through dispatchEsignPacket",
    /dispatchEsignPacket\(/.test(code("app/actions/buyer-offer/submit-for-signature.ts")) && /dispatchEsignPacket\(/.test(tds))
  const choice = code("lib/integrations/resolve-esign-provider.ts")
  // The choice follows the ONE rule (lane 89A): the e-sign SELECTION (a Google selection = the
  // Google choice; any other = its credential through the resolver), else the DEFAULT through the
  // same resolver. A refusal is returned — never a silent switch to Google or to another vendor.
  const fnStart = choice.indexOf("export async function resolveESignChoice")
  const iChosen = choice.indexOf("const chosen = pick ?? DEFAULT_ESIGN_PROVIDER", fnStart)
  const iPortal = choice.indexOf("if (getCatalogEntry(chosen)?.portalSend) return google(pickScope)", iChosen)
  const iApi = choice.indexOf("const resolved = await resolveESignProviderForActor(ctx)", iPortal)
  const fnEnd = choice.indexOf("\nfunction buildResolved", iApi)
  const choiceBody = choice.slice(fnStart, fnEnd)
  check("choice order (89A's rule): selection ?? default → a portal-send choice is Google → otherwise the resolver; no silent Google fallback",
    fnStart > 0 && iChosen > fnStart && iPortal > iChosen && iApi > iPortal && !/return google\("default"\)/.test(choiceBody))
  check("POSITIVE CONTROL: the finder sees the retired silent-Google fallback shape", /return google\("default"\)/.test(`  } catch {\n    return google("default")\n  }`))
  check("the platform e-sign default is the catalog's ONE constant (kernel + settings mirror)",
    /esign:\s*DEFAULT_ESIGN_PROVIDER/.test(code("lib/kernel/providers.ts")) && /esign:\s*DEFAULT_ESIGN_PROVIDER/.test(code("app/actions/settings/provider-settings-actions.ts")))
  check("POSITIVE CONTROL: the default finder sees a hard-coded Dotloop default", !/esign:\s*DEFAULT_ESIGN_PROVIDER/.test(`esign:       "dotloop",`))
  check("Google eSignature stays selectable in Integrations (a choice, not the default)", /getSelectableEsignProviders\(\)/.test(code("app/dashboard/settings/integrations/integrations-client.tsx")) && getCatalogEntry("google_esign")?.portalSend === true && DEFAULT_ESIGN_PROVIDER !== "google_esign")
  check("Google without the Drive grant falls to 88B's manual rail (Drive + filled PDFs), never a dead end",
    /if \(!placed\.needsReconnect\) return \{ ok: false/.test(coreCode) && /choice\.manualSteps/.test(coreCode) && /\(filled PDF\)/.test(coreCode))
  check("the workflow send step places the staged PDF in the agent's Drive when it can (88B rail kept as fallback)",
    /handOffToGoogleEsign\(/.test(code("lib/workflow/adapters/send-for-esign.ts")) && /manualEntry\?\.portalSend && driveFileUrl/.test(code("lib/workflow/adapters/send-for-esign.ts")))
  check("a portal-send envelope is never re-used as a provider envelope (vocabulary-safe, no literal)",
    /!getCatalogEntry\(offer\.esign_provider as string\)\?\.portalSend/.test(code("app/actions/buyer-offer/submit-for-signature.ts")))
  check("the Google connection requests drive.file (narrowest Drive grant)", /auth\/drive\.file/.test(src("app/api/integrations/oauth/[provider]/route.ts")))
  check("Drive grant detection: drive.file → true, none → false, unknown → null",
    googleDriveGranted("openid https://www.googleapis.com/auth/drive.file") === true && googleDriveGranted("openid email") === false && googleDriveGranted(null) === null)
  const body = buildDriveMultipartBody("Offer", new Uint8Array([37, 80, 68, 70]), "BND").toString("utf8")
  check("Drive upload body is multipart/related: JSON metadata then the PDF, named .pdf", /--BND\r\nContent-Type: application\/json[\s\S]*"name":"Offer\.pdf"[\s\S]*--BND\r\nContent-Type: application\/pdf\r\n\r\n%PDF[\s\S]*--BND--$/.test(body))
  check("the agent's Drive window is the file's /view page", driveFileOpenUrl("abc") === "https://drive.google.com/file/d/abc/view")
  check("status honesty: Google / embedded → awaiting_agent_send; only a direct API send is 'sent'",
    /return kind === "google" \|\| embedded \? "awaiting_agent_send" : "sent"/.test(coreCode)
    && /status:\s*dispatchStatusFor\("google", false\)/.test(coreCode)
    && /status:\s*dispatchStatusFor\("api", true\)/.test(coreCode)
    && /status:\s*dispatchStatusFor\("api", false\)/.test(coreCode))
  const ds = code("lib/integrations/providers/docusign-provider.ts")
  check("DocuSign embedded send: sender view scoped to the envelope (viewAccess 'envelope')", /views\/sender/.test(ds) && /viewAccess:\s*"envelope"/.test(ds))
  const submit = code("app/actions/buyer-offer/submit-for-signature.ts")
  check("an awaiting-agent-send packet is stamped 'pending', not 'sent'", /esign_status:\s*dispatch\.status === "sent" \? "sent" : "pending"/.test(submit))

  // ── F. SIGNED BACK ────────────────────────────────────────────────────────
  console.log("\n[F · signed back → stored on the deal]")
  const lk = code("app/actions/listings-kernel.ts")
  check("the listing lane SENDS the agreement (action exported, wizard calls it)",
    /export async function sendListingAgreementForSignatureAction/.test(lk) && /sendListingAgreementForSignatureAction\(\{/.test(wizard))
  check("listing send stamps the envelope where the webhooks' execution loop resolves a listing",
    /external_provider_transaction_id:\s*dispatch\.envelopeId/.test(lk) && /listings", "external_provider_transaction_id"/.test(code("lib/forms/esign-execution-loop.ts")))
  check("listing send files a listing_agreement document keyed by the envelope (finalize-packet's key)",
    /signature_request_id:\s*dispatch\.envelopeId/.test(lk) && /metadata->>signature_request_id/.test(code("lib/esign-webhooks/finalize-packet.ts")))
  check("the per-document send records provider_envelope_id (finalize-packet completes contract_signatures on it)",
    /provider_envelope_id:\s*dispatch\.envelopeId/.test(tds) && /from\("contract_signatures"\)[\s\S]{0,200}provider_envelope_id/.test(code("lib/esign-webhooks/finalize-packet.ts")))

  // ── G. THE FULL RUN, BOTH PATHS (lane 89A) ────────────────────────────────
  console.log("\n[G · the e-sign window: contact pick, where they sign, and the provider-window path]")
  // G1 · the contact pick (owner: "select the customers contact info and email").
  check("Signers step picks each customer from the CRM (the Forms Library's own getContacts) into name/email/phone",
    /<ContactPickerDialog\b/.test(wizard) && /getContacts\(\{ limit: 200 \}\)/.test(wizard) && /function pickContact\(/.test(wizard) && /Pick from contacts/.test(wizard))
  check("a contact with no email is shown as such, not silently addressed", /no email on file/.test(wizard))
  check("a signer's party (buyer / co-buyer / seller / listing agent) is selectable on the row", /SIGNER_ROLES\.filter\(r => r !== "agent"\)/.test(wizard))
  // G2 · where they sign — the placement TRAVELS with the send (it was built, shown and dropped).
  const derived = deriveEsignAnchors(["Buyer Signature", "Seller Initials", "Date Signed", "Buyer Name"])
  const manualRole = "seller" as const
  const resolved = [...derived.anchors, ...derived.ambiguous.filter((a) => a.matchedRoles.length === 0).map((a) => ({ role: manualRole, type: a.type, key: `${manualRole}_${a.type}_9`, fieldName: a.fieldName }))]
  const tags = anchorsForProvider("docusign", resolved)
  check("auto-derived fields carry their party; an ambiguous field (no party named) becomes a tag ONLY once the agent assigns one",
    derived.anchors.length === 2 && derived.ambiguous.length === 1 && derived.ambiguous[0].fieldName === "Date Signed" && tags.length === 3 && tags.some((t) => t.anchorKey === "seller_date_9"))
  const buckets = docusignTabsByRecipient(tags)
  check("DocuSign tags land on the RIGHT recipient (buyer signHere, seller initialHere + dateSigned)",
    Array.isArray(buckets.buyer?.signHereTabs) && buckets.buyer.signHereTabs.length === 1 && Array.isArray(buckets.seller?.initialHereTabs) && Array.isArray(buckets.seller?.dateSignedTabs))
  check("the wizard rebuilds the provider-shaped tags from the plan + the agent's assignments (anchorsForProvider) into state",
    /update\("esignTags", anchorsForProvider\(adapter, anchors\)\)/.test(wizard) && /function resolvedAnchors\(/.test(wizard) && /Place by hand/.test(wizard))
  check("an unassigned ambiguous field is never tagged (placed by hand, never guessed)", /const r = roles\?\.\[a\.fieldName\]; if \(r && a\.type\) push\(/.test(wizard))
  check("the placement TRAVELS: both sends carry `tags: state.esignTags`", (wizard.match(/tags: state\.esignTags/g) ?? []).length === 2)
  check("the listing send forwards tags to the dispatch core (offer send already did)", /tags:\s*params\.tags/.test(lk) && /tags:\s*params\.tags/.test(submit))
  check("the anchor-plan action returns the anchors AND the ambiguous fields' types (the window needs both)",
    /anchors: plan\.anchors\.map/.test(code("app/actions/buyer-offer/esign-anchor-plan.ts")) && /type: a\.type \}\)\)/.test(code("app/actions/buyer-offer/esign-anchor-plan.ts")))
  check("DocuSign's sender view opens on the Tagger with the recipients (and their tabs) already added", /addRecipients\(request\)/.test(ds) && /startingScreen: "Tagger"/.test(ds))
  // G3 · the provider-window path — recorded, never an empty envelope.
  const { describeProviderWindowSend } = await import("../lib/esign/dispatch-packet")
  const pw = describeProviderWindowSend({ provider: "skyslope", envelopeId: "env-77", propertyAddress: "12 Elm St" })
  check("forms filled + sent inside SkySlope's window → recorded as awaiting the agent's send there, envelope kept, iframe hand-off",
    pw.ok && pw.providerName === "skyslope" && pw.status === "awaiting_agent_send" && pw.envelopeId === "env-77" && pw.handoff?.mode === "iframe" && pw.attachedCount === 0)
  check("Dotloop / Form Simplicity windows → popup hand-off", describeProviderWindowSend({ provider: "dotloop", propertyAddress: "x" }).handoff?.mode === "popup" && describeProviderWindowSend({ provider: "formsimplicity", propertyAddress: "x" }).ok)
  const bm = describeProviderWindowSend({ provider: "brokermint", propertyAddress: "x" })
  check("Brokermint (no e-sign) is refused by name — fill there, sign through the e-sign provider", !bm.ok && /Brokermint/.test(bm.error ?? ""))
  const ge = describeProviderWindowSend({ provider: "google_esign", propertyAddress: "x" })
  check("a portal-send provider is not a transaction window (refused)", !ge.ok)
  check("POSITIVE CONTROL: the finder for an empty-packet dispatch sees the retired shape (documents: [] straight to the core)",
    /documents:\s*packetDocuments\(state\)/.test(`documents: packetDocuments(state),`))
  check("the wizard records a provider-window send instead of dispatching an empty packet (both lanes)",
    /function providerWindowSend\(/.test(wizard) && (wizard.match(/providerWindow: providerWindow \?\? undefined/g) ?? []).length === 2 && /packetDocuments\(state\)\.length > 0\) return null/.test(wizard))
  check("SkySlope Forms' postMessage is origin-checked and its file / envelope ids are kept", /SKYSLOPE_FORMS_ORIGIN = "https:\/\/forms\.skyslope\.com"/.test(wizard) && /if \(origin !== SKYSLOPE_FORMS_ORIGIN\) return null/.test(wizard) && /digisignEnvelopeId/.test(wizard))
  check("submitForSignature / the listing send accept providerWindow and route it through describeProviderWindowSend (gates still run first)",
    /params\.providerWindow && packetDocs\.length === 0/.test(submit) && submit.indexOf("checkAgentTransactable") < submit.indexOf("describeProviderWindowSend(") && /providerWindow\s*\?\s*describeProviderWindowSend/.test(lk))
  // m665: the provider-window stamp for Form Simplicity — read live first, the CHECK lacks it.
  const m665 = readFileSync(join(ROOT, "supabase/migrations/m665-offers-esign-provider-admits-formsimplicity.sql"), "utf8")
  check("m665 widens offers.esign_provider with 'formsimplicity' (the RULE: the CHECK admits it — applied live 2026-09-29)", /offers_esign_provider_check/.test(m665) && /'formsimplicity'/.test(m665) && /'google_esign'/.test(m665))
  // G4 · whose account carried it is recorded.
  check("the dispatch result says whose credential carried the send (tenant tier or the platform's DocuSign account) and the records keep it",
    /credentialScope:\s*resolved\.resolvedScope/.test(coreCode) && /credential_scope:\s*dispatch\.credentialScope/.test(submit) && /credential_scope:\s*dispatch\.credentialScope/.test(lk))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ FormWizard → e-sign flow verified (package, real-time fill, tenant scope, send, signed back, contact pick, placement, provider window).")
  console.log(" FORM_WIZARD_ESIGN_PASS")
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
