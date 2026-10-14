/**
 * scripts/canaries/legal-description.ts — LEGAL DESCRIPTION canary (wave 141, lane 141J):
 *   a form that requires it gets the canonical value, or BLOCKS correctly (never invented)
 * through the ONE property-identification prefill (lib/intelligence/offer-property-prefill.ts
 * buildPropertyPrefill — fills only property-identification fields, only from KNOWN facts, leaves a
 * recognized-but-unknown field UNRESOLVED for a human, never touches an offer term). Owner (wave 141):
 * "some forms need address AND legal description. PROPERTY → legal description → canonical transaction/form
 * model → provider field. Never invent it: use an approved property-data capability if it legitimately
 * provides it, else ask a human; the form stays incomplete until the data exists." The canonical column on
 * the property model + the approved-capability resolution + the human-ask rail (lane 141C) is a WAVE141 HOOK;
 * the fact that RentCast's property record carries `legalDescription` (lib/property/rentcast.ts) is asserted
 * on stripped source so the lane resolves through an existing capability, not a new vendor.
 */
import { canary } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Legal description: a required form gets the canonical value or blocks correctly (never invented)")
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
  // WAVE141 HOOK (integrator): 141C — the canonical column + resolution + human ask.
  for (const h of hooksFor("legal-description")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, "at HEAD no canonical property column carries legal_description; the prefill reads whatever facts the caller passes"); continue }
    c.step(`${h.lane} landed (${at}) — wire the canonical read + the human-ask refusal into this canary (WAVE141 HOOK (integrator): 141C)`, false, "")
  }
  c.blind("Pure: no property record is read and no provider is called; the mapping onto a PROVIDER field (SkySlope / Dotloop form field names) is the forms wizard's (test:form-wizard-esign, test:pdf-form-fill).")
  return c.report([], 0)
}
