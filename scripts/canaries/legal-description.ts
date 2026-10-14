/**
 * scripts/canaries/legal-description.ts — LEGAL DESCRIPTION canary (wave 141, lane 141J; wired by lane 141K):
 *   a form that requires it gets the canonical value, or BLOCKS correctly (never invented)
 * through the ONE property-identification prefill (lib/intelligence/offer-property-prefill.ts
 * buildPropertyPrefill — fills only property-identification fields, only from KNOWN facts, leaves a
 * recognized-but-unknown field UNRESOLVED for a human, never touches an offer term) and, LANDED AT 81fcd1f14
 * (lane 141C), lib/forms/legal-description.ts: the PURE requirement / typed value / INCOMPLETE gate, and the
 * I/O resolver in the owner's order — the agent's TYPED value → the RECORD (m768 legal_description on
 * listings + transactions) → the APPROVED capability (RentCast's property record) → else a HUMAN is asked on the
 * existing task rail and the form stays incomplete. Owner (wave 141): "PROPERTY → legal description → canonical
 * transaction/form model → provider field. Never invent it: use an approved property-data capability if it
 * legitimately provides it, else ask a human; the form stays incomplete until the data exists."
 * The capability is a RECORDER here (installed through _harness.ts stubModule before the resolver reaches it):
 * the canary asserts WHEN it is asked and WHEN it is not; no RentCast request can leave this process.
 */
import { CANARY_EMAIL_DOMAIN, CANARY_TAG, LIVE, canary, canaryClient, cleanupCanary, nowIso, setSvc, stubModule, uuid } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Legal description: a required form gets the canonical value or blocks correctly (never invented)")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: the resolver writes records and tasks — in-memory only")
  // THE CAPABILITY RECORDER — before lib/forms/legal-description.ts first reaches "@/lib/property/rentcast".
  const G = globalThis as unknown as { __W141_RENTCAST: { calls: Array<Record<string, unknown>>; answer: string | null } }
  G.__W141_RENTCAST = { calls: [], answer: null }
  stubModule("@/lib/property/rentcast", `export async function getRentcastPropertyDetailWithOutcome(args) { const g = globalThis.__W141_RENTCAST; g.calls.push(args); return g.answer ? { detail: { legalDescription: g.answer }, outcome: "ok", eligibility: { eligible: true, reason: "canary recorder" } } : { detail: null, outcome: "unconfigured", eligibility: { eligible: false, reason: "canary: no RentCast key in this runtime" } } }`)
  const rc = G.__W141_RENTCAST
  const { buildPropertyPrefill, KNOWN_PROPERTY_FIELD_LABELS } = await import("../../lib/intelligence/offer-property-prefill")
  const FORM = ["Property Address", "Legal Description", "Purchase Price", "Buyer City", "Earnest Money"]
  const known = buildPropertyPrefill(FORM, { address: "1 Canary Way, Pensacola, FL 32501", legalDescription: "LOT 7 BLK 2 CANARY COVE PB 12 PG 34", propertyCity: "Pensacola" })
  c.step("canonical value: with the property's legal description KNOWN, both identification fields are filled from the property record (source named)", known.filled.length === 2 && known.filled.some((f) => f.formField === "Legal Description" && f.source === "legalDescription" && /LOT 7/.test(f.value)) && known.filled.some((f) => f.formField === "Property Address" && f.source === "address"), JSON.stringify(known.filled.map((f) => f.formField)))
  c.step("never an offer term: Purchase Price and Earnest Money are untouched (the agent's job)", !known.filled.some((f) => /Price|Earnest/.test(f.formField)) && !known.unresolved.some((f) => /Price|Earnest/.test(f)), "")
  c.step("never a bare city: 'Buyer City' is NOT filled from the property's city (a property-qualified field would be)", !known.filled.some((f) => f.formField === "Buyer City") && !known.unresolved.includes("Buyer City"), "")
  const unknown = buildPropertyPrefill(FORM, { address: "1 Canary Way, Pensacola, FL 32501" })
  c.step("blocks correctly: with the legal description UNKNOWN the field is UNRESOLVED (left blank for a human) — never fabricated, the form stays incomplete", unknown.filled.length === 1 && unknown.unresolved.length === 1 && unknown.unresolved[0] === "Legal Description", JSON.stringify(unknown))
  c.step("vocabulary: the canonical identification labels include Legal Description (one field vocabulary for callers with no AcroForm list)", (KNOWN_PROPERTY_FIELD_LABELS as readonly string[]).includes("Legal Description"), KNOWN_PROPERTY_FIELD_LABELS.join(","))
  c.step("POSITIVE CONTROL: an empty / whitespace legal description is UNKNOWN, not a value", buildPropertyPrefill(["Legal Description"], { legalDescription: "   " }).unresolved.length === 1, "")
  const rentcast = strippedRepo("lib/property/rentcast.ts") ?? ""
  c.step("approved capability exists: the platform's property-data provider (RentCast, lib/property/rentcast.ts) maps the vendor's legalDescription onto its typed record — the lane resolves through it, never a new vendor", /\blegalDescription\b/.test(rentcast), "")

  // WAVE141 HOOK (integrator): 141C — the canonical column + resolution + human ask; wired 141K.
  const landed = hooksFor("legal-description").map((h) => ({ h, at: h.probe() }))
  for (const { h, at } of landed) if (!at) c.hook(h.lane, h.contract, "at HEAD no canonical property column carries legal_description; the prefill reads whatever facts the caller passes")
  const wired = landed.find((x) => x.at)
  if (!wired) {
    c.blind("Pure: no property record is read and no provider is called; the mapping onto a PROVIDER field (SkySlope / Dotloop form field names) is the forms wizard's (test:form-wizard-esign, test:pdf-form-fill).")
    return c.report([], 0)
  }
  const { legalDescriptionRequirement, typedLegalDescription, legalDescriptionGate, resolveLegalDescriptionForForm, LEGAL_DESCRIPTION_TASK_SOURCE, LEGAL_DESCRIPTION_SOURCES } = await import("../../lib/forms/legal-description")
  const req = legalDescriptionRequirement(FORM, {})
  c.step(`${wired.h.lane} landed (${wired.at}): the PURE requirement — a form carrying a legal-description field REQUIRES it (fields named), satisfied only by a non-blank value; the typed value is read off the wizard's field panel by the same recogniser`, req.required && req.fields.join() === "Legal Description" && !req.satisfied && legalDescriptionRequirement(FORM, { legalDescription: "LOT 7" }).satisfied && !legalDescriptionRequirement(["Purchase Price"], {}).required && typedLegalDescription({ "Legal Description": "  LOT 7 BLK 2 " }) === "LOT 7 BLK 2" && typedLegalDescription({ "Purchase Price": "1" }) === null, JSON.stringify(req))
  const gate = legalDescriptionGate([{ name: "Contract", fields: [{ name: "Legal Description", value: "" }, { name: "Property Address", value: "1 Canary Way" }] }])
  c.step("141C the INCOMPLETE gate, read by the ONE dispatch core before any envelope: a filled PDF whose legal-description field is blank is refused with the document and field named; a filled one passes", !gate.complete && gate.blank.length === 1 && gate.blank[0].field === "Legal Description" && /INCOMPLETE/.test(gate.reason ?? "") && legalDescriptionGate([{ name: "Contract", fields: [{ name: "Legal Description", value: "LOT 7" }] }]).complete && /legalDescriptionGate\(/.test(strippedRepo("lib/esign/dispatch-packet.ts") ?? ""), gate.reason ?? "")
  const B = uuid(), B2 = uuid(), U = uuid(), AG = uuid(), L1 = uuid(), L2 = uuid(), L3 = uuid(), L4 = uuid()
  const svc = canaryClient({
    brokerages: [{ id: B, name: `${CANARY_TAG} Brokerage`, plan_tier: "brokerage", slug: `${CANARY_TAG}-legal` }, { id: B2, name: `${CANARY_TAG} Other`, plan_tier: "team", slug: `${CANARY_TAG}-legal2` }],
    users: [{ id: U, email: `agent@${CANARY_EMAIL_DOMAIN}`, user_type: "agent", brokerage_id: B }],
    agents: [{ id: AG, user_id: U, brokerage_id: B, first_name: "Canary", last_name: "Agent", is_active: true }],
    listings: [
      { id: L1, brokerage_id: B, agent_id: AG, address: "1 Canary Way", city: "Pensacola", state: "FL", zip: "32501", status: "active", notes: CANARY_TAG, created_at: nowIso() },
      { id: L2, brokerage_id: B, agent_id: AG, address: "2 Canary Way", city: "Pensacola", state: "FL", zip: "32501", status: "active", notes: CANARY_TAG, legal_description: "LOT 9 BLK 1 CANARY COVE", legal_description_source: "rentcast", created_at: nowIso() },
      { id: L3, brokerage_id: B, agent_id: AG, address: "3 Canary Way", city: "Pensacola", state: "FL", zip: "32501", status: "active", notes: CANARY_TAG, created_at: nowIso() },
      { id: L4, brokerage_id: B, agent_id: AG, address: "4 Canary Way", city: "Pensacola", state: "FL", zip: "32501", status: "active", notes: CANARY_TAG, created_at: nowIso() },
    ],
  })
  setSvc(svc)
  const listing = (id: string) => (svc.tables.listings ?? []).find((l) => l.id === id)
  const tasks = () => (svc.tables.tasks ?? []).filter((t) => t.brokerage_id === B && t.source === LEGAL_DESCRIPTION_TASK_SOURCE)
  const TYPED = "LOT 7 BLK 2 CANARY COVE PB 12 PG 34"
  const typed = await resolveLegalDescriptionForForm(svc, { brokerageId: B, userId: U, listingId: L1, typedValue: TYPED })
  c.step("141C 1 · the agent's TYPED value wins: written to the record (counted, tenant-pinned) as source 'agent' — the record now carries it; the capability is not asked", typed.value === TYPED && typed.source === "agent" && typed.persisted === "listing" && !typed.asked && listing(L1)?.legal_description === TYPED && listing(L1)?.legal_description_source === "agent" && rc.calls.length === 0, JSON.stringify(typed).slice(0, 160))
  const onRecord = await resolveLegalDescriptionForForm(svc, { brokerageId: B, userId: U, listingId: L2, address: "2 Canary Way", city: "Pensacola", state: "FL", zip: "32501" })
  c.step("141C 2 · the RECORD is read next: a listing already carrying it answers from the record (its source kept) — the capability is NOT asked, no task", onRecord.value === "LOT 9 BLK 1 CANARY COVE" && onRecord.source === "rentcast" && !onRecord.asked && rc.calls.length === 0, JSON.stringify(onRecord).slice(0, 160))
  rc.answer = "LOT 11 BLK 3 CANARY COVE PB 12 PG 36"
  const viaCapability = await resolveLegalDescriptionForForm(svc, { brokerageId: B, userId: U, listingId: L3, address: "3 Canary Way", city: "Pensacola", state: "FL", zip: "32501" })
  const asked0 = rc.calls[0] ?? {}
  c.step("141C 3 · the APPROVED capability (RentCast's property record) is asked ONCE, by full postal address, under the tenant + agent with a named systemSource (cost is booked inside the real module); its value is written to the record as source 'rentcast'", viaCapability.value === rc.answer && viaCapability.source === "rentcast" && viaCapability.persisted === "listing" && listing(L3)?.legal_description_source === "rentcast" && rc.calls.length === 1 && asked0.brokerageId === B && asked0.agentUserId === U && /3 Canary Way, Pensacola, FL 32501/.test(String(asked0.address)) && asked0.systemSource === "forms_legal_description", JSON.stringify(asked0).slice(0, 160))
  rc.answer = null
  const asked = await resolveLegalDescriptionForForm(svc, { brokerageId: B, userId: U, listingId: L4, address: "4 Canary Way", city: "Pensacola", state: "FL", zip: "32501" })
  c.step("141C 4 · no source has it → NEVER invented: the value is null, the form is INCOMPLETE, and a HUMAN is asked on the existing task rail — ONE open task for the agent (agents.id), pinned to the tenant + listing, high priority, source legal_description_request; the reason says why", asked.value === null && asked.source === null && asked.asked && !!asked.taskId && /INCOMPLETE/.test(asked.reason ?? "") && /RentCast did not answer/.test(asked.reason ?? "") && tasks().length === 1 && tasks()[0].id === asked.taskId && tasks()[0].assigned_to_agent_id === AG && tasks()[0].listing_id === L4 && tasks()[0].status === "pending" && tasks()[0].priority === "high" && rc.calls.length === 2, (asked.reason ?? "").slice(0, 160))
  const askedAgain = await resolveLegalDescriptionForForm(svc, { brokerageId: B, userId: U, listingId: L4, address: "4 Canary Way", city: "Pensacola", state: "FL", zip: "32501" })
  c.step("141C 4b · idempotent ask: asking again reuses the SAME open task (one row per record) — never a second (the capability IS asked again — the resolver keeps no memo; the real module's in-file cache and meter bound that cost)", askedAgain.asked && askedAgain.taskId === asked.taskId && tasks().length === 1 && rc.calls.length === 3, `capability calls ${rc.calls.length}`)
  const filled = await resolveLegalDescriptionForForm(svc, { brokerageId: B, userId: U, listingId: L4, typedValue: "LOT 12 BLK 3 CANARY COVE" })
  c.step("141C 4c · the human answers: the typed value lands on the record and COMPLETES the open ask (completed_at set, status completed)", filled.persisted === "listing" && listing(L4)?.legal_description === "LOT 12 BLK 3 CANARY COVE" && tasks()[0].status === "completed" && !!tasks()[0].completed_at, "")
  const callsBefore5 = rc.calls.length
  const noAddress = await resolveLegalDescriptionForForm(svc, { brokerageId: B, userId: U, transactionId: uuid() })
  c.step("141C 5 · without a full postal address the capability is NOT asked (nothing to ask by) — the human is asked instead, with that reason", noAddress.value === null && noAddress.asked && /full postal address is not known/.test(noAddress.reason ?? "") && rc.calls.length === callsBefore5, JSON.stringify({ asked: noAddress.asked, taskId: noAddress.taskId, calls: rc.calls.length, reason: (noAddress.reason ?? "").slice(0, 200) }))
  const cross = await resolveLegalDescriptionForForm(svc, { brokerageId: B2, userId: U, listingId: L1, typedValue: "STOLEN" })
  c.step("141C tenant boundary: a caller naming another tenant cannot write onto this tenant's record — the pinned update matches no row (persisted null), the record is unchanged", cross.persisted === null && listing(L1)?.legal_description === TYPED, "")
  const mod = strippedRepo("lib/forms/legal-description.ts") ?? ""
  c.step("141C never model-authored, wired where the form is filled: the resolver names no LLM / gateway call; its sources are exactly the m768 CHECK's (agent | rentcast); the wizard door (prefill-storage-form.ts) resolves it before the fill", !/generateText|generateObject|gatewayChat|Routed\(/.test(mod) && LEGAL_DESCRIPTION_SOURCES.join() === "agent,rentcast" && /resolveLegalDescriptionForForm\(/.test(strippedRepo("app/actions/buyer-offer/prefill-storage-form.ts") ?? ""), "")
  c.blind("RentCast is a recorder (no key, no request): the real module's gate / meter / cache are test:cost-completeness + test:provider-adapter. m768 was APPLIED LIVE 2026-10-14 (integrator, Supabase MCP) — in memory the columns exist by construction; live, the reader degrades to null with a logged refusal until it is applied. The mapping onto a PROVIDER field (SkySlope / Dotloop form field names) is the forms wizard's (test:form-wizard-esign, test:pdf-form-fill).")
  const { cleanup, residual, mismatches } = await cleanupCanary(svc, B)
  c.step("cleanup: every tagged row deleted with .select() counts; residual 0", mismatches.length === 0 && residual === 0, cleanup.map((x) => `${x.table}:${x.deleted}`).join(" "))
  return c.report(cleanup, residual)
}
