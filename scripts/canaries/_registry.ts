/**
 * scripts/canaries/_registry.ts — the canary ROSTER and the WAVE-141 HOOK CENSUS (wave 141, lane 141J).
 *
 * PURE (fs + the one correct scanner, scripts/strip-comments.ts): no node:module hooks, no client,
 * no kernel import — so BOTH readers can import it without side effects:
 *   · scripts/canaries/run-canaries.ts   iterates CANARY_KEYS and prints the hook census beside the
 *     RESULT line;
 *   · scripts/production-readiness-guard.ts (section G, the RELEASE GATE) derives CERTIFIED /
 *     NOT CERTIFIED per owner gate from this roster + the hooks that are still pending.
 *
 * A WAVE141 HOOK is a canary step written against another lane's CONTRACT (the lane prompts
 * $S/prompt141A..I.md) where that lane's module does not exist at HEAD 01a71c3c2. Each hook carries a
 * PROBE that reads STRIPPED source (CLAUDE.md §2 — a tombstone, a comment or a prompt quotation is not
 * a landing) and answers "where did the lane land?" (a repo-relative path) or null. While null the
 * canary records the step as PENDING (⏳, counted beside the RESULT line, never silently green) and the
 * gate that depends on it reads NOT CERTIFIED; once the probe answers, the canary runs the contract
 * assertion and the integrator wires whatever the lane named differently
 * (`// WAVE141 HOOK (integrator): <lane>` marks the exact line).
 *
 * MEASURED AT 01a71c3c2 (every probe below answered null — the positive control of the census: a probe
 * that answered at HEAD would be reading a comment, a string or a prompt, not code).
 *
 * WIRED AT 81fcd1f14 (wave 141, lane 141K — the integration lane): lanes A, B, C, D, F, G, H, I are merged.
 * Each probe now answers where its lane LANDED (several lanes named their module differently from the
 * prompt's guess — the probe follows the code, the contract text records the landed name), and the canary
 * behind it runs the contract against the real export. Lane 141E (lead magnets) landed at integration
 * (lib/lead-magnets/ai-draft.ts, lib/lead-magnets/attribution.ts) and the lead-magnet canary wires both
 * of its hooks. The 141B role-safety probe (crm-inbound) flipped by itself once the integrator removed
 * the legacy user_type='superadmin' arm from lib/platform/platform-staff-roster.ts (owner ruling
 * 2026-10-14; m780 aligned public.is_platform_admin()/is_platform_staff()) — the crm-inbound canary
 * asserts that contract on the resolver itself and was never relaxed (lane141K-notes).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { blankStrings, stripComments } from "../strip-comments"

export const ROOT = process.cwd()

/** The runner's roster — order is run order. The seven wave-140 chains first, then the wave-141 canaries. */
export const CANARY_KEYS = [
  "subscriber", "seat", "lead", "buyer", "seller", "communication", "self-healing",
  "solo-subscriber", "same-name-brokerage", "brokerage-adoption", "user-invite", "lead-magnet", "business-card",
  "transaction-provider", "cda-esign", "legal-description", "crm-outbound", "crm-inbound", "coupon", "custom-domain", "mobile",
] as const
export type CanaryKey = (typeof CANARY_KEYS)[number]
export type Wave141Lane = "141A" | "141B" | "141C" | "141D" | "141E" | "141F" | "141G" | "141H" | "141I"

export interface CanaryHook {
  canary: CanaryKey
  lane: Wave141Lane
  /** The contract the canary asserts once the lane lands (from the lane's prompt). */
  contract: string
  /** Where the lane landed (repo-relative path) or null while pending. Reads STRIPPED source only. */
  probe: () => string | null
}

// ── repo readers shared with the canaries (fs only) ───────────────────────────────────────────────
export function readRepo(rel: string): string | null {
  const p = join(ROOT, rel)
  return existsSync(p) ? readFileSync(p, "utf8") : null
}
const STRIPPED = new Map<string, string | null>()
/** Comment-stripped source (strings and JSX text KEPT — a column name in a select list is code). */
export function strippedRepo(rel: string): string | null {
  if (!STRIPPED.has(rel)) { const raw = readRepo(rel); STRIPPED.set(rel, raw === null ? null : stripComments(raw)) }
  return STRIPPED.get(rel) ?? null
}
/** Every file under `dir` (repo-relative) whose path passes `keep`; node_modules and dot-dirs skipped. */
export function listFiles(dir: string, keep: (rel: string) => boolean, out: string[] = []): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return out
  for (const e of readdirSync(abs)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const rel = `${dir}/${e}`
    if (statSync(join(ROOT, rel)).isDirectory()) listFiles(rel, keep, out)
    else if (keep(rel)) out.push(rel)
  }
  return out
}
const TS = (rel: string) => /\.tsx?$/.test(rel)
/** First file (of the candidates) whose STRIPPED source matches `re`, else null. */
function firstStrippedMatch(files: string[], re: RegExp): string | null {
  for (const f of files) { const s = strippedRepo(f); if (s && re.test(s)) return f }
  return null
}

// ── the Airtable finder (lane 141D's rule, shared by the probe and the crm-outbound canary) ───────
/** PURE: does this source name airtable as a CODE IDENTIFIER (an import, an env key, a symbol)? Comments
 *  are stripped and string literals BLANKED first — a deny-list entry (`"airtable_api_key"` in
 *  SNAPSHOT_FORBIDDEN_FIELDS) or a sentence in registry prose is a string, not an operational path.
 *  @proofSeam the crm-outbound canary holds it with specimens (positive + negative controls). */
export function airtableIdentifierHit(raw: string): boolean {
  return /airtable/i.test(blankStrings(stripComments(raw)))
}
/** The runtime tree's Airtable census: files whose RAW text names it, split into identifier hits (live
 *  paths — must be 0) and string-only residues (published beside the number, never counted as a path). */
export function airtableRuntimeCensus(): { scanned: number; live: string[]; stringOnly: string[] } {
  const files = [...listFiles("lib", TS), ...listFiles("app", TS), ...listFiles("services", TS)]
  const raw = files.filter((f) => /airtable/i.test(readRepo(f) ?? ""))
  const live = raw.filter((f) => airtableIdentifierHit(readRepo(f) ?? ""))
  return { scanned: files.length, live, stringOnly: raw.filter((f) => !live.includes(f)) }
}

// ── THE HOOKS ─────────────────────────────────────────────────────────────────────────────────────
export const WAVE141_HOOKS: CanaryHook[] = [
  {
    canary: "solo-subscriber", lane: "141A",
    contract: "a solo/team subscriber DECLARES an affiliated brokerage identity (brokerages.declared_affiliation jsonb, m765–767) on its OWN tenant — stored without tenancy effect; name equality never associates, merges or routes",
    probe: () => (/\bdeclared_affiliation\b/.test(strippedRepo("lib/kernel/tenant-creation.ts") ?? "") ? "lib/kernel/tenant-creation.ts" : null),
  },
  {
    canary: "brokerage-adoption", lane: "141A",
    contract: "ONE explicit transfer rail: brokerage_transfer_requests (status vocabulary) — target brokerage-location by canonical id, initiated by the target admin, agent/team CONSENT recorded with evidence → verify → migrate membership + data through canonical services (provenance kept) → old tenant ARCHIVED, not deleted → readiness verdict on the target; idempotent; cannot cross to another tenant",
    probe: () => firstStrippedMatch([...listFiles("lib/kernel", TS), ...listFiles("lib/platform", TS)], /["'`]brokerage_transfer_requests["'`]/),
  },
  {
    canary: "brokerage-adoption", lane: "141H",
    contract: "handoffSubscriberBillingToBrokerage(svc, { sourceBrokerageId, targetBrokerageId, effectiveAt, actorUserId }) — stop the individual's direct subscription at effectiveAt with Stripe proration (SDK), no double charge, no lost paid period, no fabricated refund, invoices immutable, idempotent (Stripe idempotency keys + event ledger), evidence rows; then the brokerage seat is the billing relationship",
    probe: () => firstStrippedMatch(listFiles("lib/billing", TS), /export\s+async\s+function\s+handoffSubscriberBillingToBrokerage\b/),
  },
  {
    canary: "user-invite", lane: "141B",
    contract: "the member core (lib/kernel/users.ts inviteTenantMember) dispatches the invite in the SAME request, reads the result, evidences + routes a failure — LANDED as lib/kernel/immediate-operations.ts reportOperationOutcome (an operation.succeeded / operation.failed lifecycle_events row from the core for invitation, user_creation and seat_provisioning, and on failure ONE operation_failure_escalated signal the registered owning manager consumes through handleOperationFailureEscalated on the manager-signals tick) — never success on a failed post-condition",
    probe: () => (/export\s+async\s+function\s+reportOperationOutcome\b/.test(strippedRepo("lib/kernel/immediate-operations.ts") ?? "") && /\breportOperationOutcome\b/.test(strippedRepo("lib/kernel/users.ts") ?? "") ? "lib/kernel/immediate-operations.ts" : null),
  },
  {
    canary: "crm-inbound", lane: "141B",
    contract: "ROLE SAFETY: no authority resolver defaults an unknown type to a privileged role — lib/platform/platform-staff-roster.ts resolvePlatformRoleIdentity no longer reads users.user_type === 'superadmin' as platform staff (platform staff live in platform_role). NOT MET at 81fcd1f14: platform-staff-roster.ts:242 keeps the fallback (lane 141B left it as 'proof-pinned elsewhere'; lane 141D's inboundImportGate refuses a null platform_role at the inbound doors instead) — the crm-inbound canary fails the resolver contract loudly; integrator finding",
    probe: () => { const s = strippedRepo("lib/platform/platform-staff-roster.ts"); return s && !/userType\s*===\s*["']superadmin["']/.test(s) ? "lib/platform/platform-staff-roster.ts" : null },
  },
  {
    canary: "transaction-provider", lane: "141C",
    contract: "the FACTUAL MATRIX as a typed registry — LANDED on the one catalog (lib/integrations/providers/catalog.ts PROVIDER_CAPABILITY_MATRIX + CAPABILITY_REQUIRED_STEPS + providerOfferVerdict, read by lib/connections/scope.ts providerSelectionVerdict): provider → credentials (tenant-owned) → settings → forms → transaction creation → upload → fill → e-sign → status → sync, each cell BUILT/PARTIAL/UNWIRED/MISSING; a provider is selectable in tenant settings ONLY for capabilities whose required paths function",
    probe: () => (/\bPROVIDER_CAPABILITY_MATRIX\b/.test(strippedRepo("lib/integrations/providers/catalog.ts") ?? "") ? "lib/integrations/providers/catalog.ts" : null),
  },
  {
    canary: "cda-esign", lane: "141C",
    contract: "CDA routes through the tenant's E-SIGN selection via the canonical e-sign adapter (lib/integrations/resolve-esign-provider.ts), never the transaction-forms vendor and never hardwired to Dotloop; a transaction platform fulfils it only when its e-sign path is certified in the matrix",
    probe: () => (/resolve-esign-provider/.test(strippedRepo("lib/transactions/cda-esign.ts") ?? "") ? "lib/transactions/cda-esign.ts" : null),
  },
  {
    canary: "legal-description", lane: "141C",
    contract: "the canonical property model carries legal_description (column, m768 if needed); PROPERTY → legal description → canonical transaction/form model → provider field; absent → resolved through an approved property-data capability ONLY if it legitimately provides it (cost-booked), else the form is INCOMPLETE and a human is asked through the existing task/notification rail — never invented",
    // LANDED as lib/forms/legal-description.ts (m768 column on listings + transactions; resolve typed → record →
    // RentCast → human ask on `tasks`); lib/forms first so the probe names the rule's home.
    probe: () => firstStrippedMatch([...listFiles("lib/forms", TS), ...listFiles("lib/property", TS), ...listFiles("lib/transactions", TS), ...listFiles("lib/intelligence", TS)], /\blegal_description\b/),
  },
  {
    canary: "crm-outbound", lane: "141D",
    contract: "AIRTABLE RETIRED: no operational path (reader, writer, cron, settings UI, env) under lib/, app/ or services/ names airtable — historical data kept; the tenant's outbound sync (VIPAgents canonical → mapping → tenant CRM) is the only CRM direction a tenant controls",
    // Lane 141D's rule (scripts/crm-boundaries-guard.ts): an IDENTIFIER census — comments stripped, strings
    // blanked. The two string-only residues left on purpose (a deny-list entry, registry prose) are published
    // by the crm-outbound canary beside the zero, never counted as a path.
    probe: () => (airtableRuntimeCensus().live.length === 0 ? "lib" : null),
  },
  {
    canary: "crm-inbound", lane: "141D",
    contract: "INBOUND is PLATFORM STAFF ONLY with an explicit field MAPPING against the canonical schema (required canonical fields for workflows/triggers in ONE registry) → preview → validation → identity/dedup → controlled commit → only then workflows/triggers; a tenant is REFUSED with a clear sentence; external schemas never write canonical fields directly",
    // LANDED as lib/kernel/schema-adaptation.ts CRM_CONTACT_INGRESS_CONTRACT (the registry) + lib/crm/import-pull.ts
    // crmImportPreviewToken + app/actions/lead-import/crm-pull-actions.ts previewCrmImportAction / inboundImportGate.
    probe: () => firstStrippedMatch(["lib/kernel/schema-adaptation.ts", ...listFiles("lib/crm", TS), ...listFiles("lib/platform", TS), ...listFiles("app/actions/lead-import", TS)], /\b(CRM_CONTACT_INGRESS_CONTRACT|previewCrmImportAction|crmImportPreviewToken|inboundImportGate|previewCrmImport|canonicalFieldMapping|REQUIRED_CANONICAL_FIELDS|CRM_IMPORT_FIELD_MAP|CRM_INBOUND_MAPPING)\b/),
  },
  {
    canary: "lead-magnet", lane: "141E",
    contract: "AI CREATION: the AI produces the ACTUAL draft (concept → copy/questions/design/assets/configuration) as a real lead_capture_forms record in DRAFT through the existing AI gateway + cost accounting + mayUseAndAfford; human preview → edit → approve → publish",
    // Landed name (lane 141E): lib/lead-magnets/ai-draft.ts draftLeadMagnetFromConcept — the routed model lane
    // (generateTextRouted) feeding the kernel's createLeadMagnet (the ONE writer of lead_capture_forms; the table
    // name itself lives in lib/kernel/lead-magnets.ts, not in this file).
    probe: () => firstStrippedMatch([...listFiles("lib/lead-magnets", TS), "lib/kernel/lead-magnets.ts", ...listFiles("lib/marketing", TS)].filter((f) => existsSync(join(ROOT, f))), /^(?=[\s\S]*\bdraftLeadMagnetFromConcept\b)(?=[\s\S]*\b(generateObjectRouted|generateTextRouted)\b)(?=[\s\S]*\bcreateLeadMagnet\()/),
  },
  {
    canary: "lead-magnet", lane: "141E",
    contract: "ATTRIBUTION: a lead magnet used in an ad keeps campaign/ad/creative attribution (campaign_id / ad_id / creative_id or utm_*) through capture → consent → intake → dedup → contact lifecycle → follow-up → outcome → learning",
    probe: () => (/\b(campaign_id|ad_id|creative_id|utm_source)\b/.test(strippedRepo("lib/kernel/lead-magnets.ts") ?? "") ? "lib/kernel/lead-magnets.ts" : null),
  },
  {
    canary: "lead-magnet", lane: "141F",
    contract: "QR: no open redirect — the scan resolver routes only to an ALLOW-LIST of in-app destinations (lead magnet, form, property, contact, open house, vCard); no cross-tenant resolution; the scan landing renders at 360–430px",
    // LANDED as lib/marketing/qr-contract.ts (QR_IN_APP_PUBLIC_PREFIXES + resolveQrScanDestination), read by the scan door.
    probe: () => firstStrippedMatch(["lib/marketing/qr-contract.ts", "app/api/qr/scan/route.ts", "lib/marketing/tracked-qr.ts"], /QR_IN_APP_PUBLIC_PREFIXES|resolveQrScanDestination|allow[-_]?list|ALLOWED_|isAllowedDestination|isInAppDestination/i),
  },
  {
    canary: "business-card", lane: "141F",
    contract: "BUSINESS CARD: per-FIELD confidence from the one vision extraction → human confirmation where confidence is low → identity/dedup → canonical contact; a field-level MERGE rule never overwrites higher-confidence data with a weak extraction (with evidence)",
    // LANDED as lib/contacts/card-classifier.ts (parseCardExtraction / assessCardExtraction / decideCardFieldWrite —
    // the pure rules) applied by app/actions/business-card/business-card-actions.ts.
    probe: () => firstStrippedMatch([...listFiles("lib/contacts", TS), ...listFiles("app/actions/business-card", TS)], /\b(parseCardExtraction|decideCardFieldWrite|fieldConfidence|confidenceByField|per_field_confidence|field_confidence)\b/),
  },
  {
    canary: "custom-domain", lane: "141G",
    contract: "CONNECT-YOUR-OWN-DOMAIN: per-provider DNS instructions (GoDaddy, Cloudflare, Namecheap, Squarespace Domains, other DNS) with the exact CNAME/A/TXT values; ONE verification state machine pending_dns → verifying → active with fail-closed refusals; the platform never sells/registers/hosts domains",
    probe: () => (/godaddy/i.test(strippedRepo("lib/platform/custom-domains.ts") ?? "") ? "lib/platform/custom-domains.ts" : null),
  },
  {
    canary: "custom-domain", lane: "141G",
    contract: "IMMEDIATE post-condition + KERNEL EVENT on connect/verify (lane B's rule): the domain door emits emitKernelEvent (success AND failure, with evidence) and a registered manager or the canonical service consumes it — the signal bus + self-heal ledger alone are not the kernel event",
    probe: () => firstStrippedMatch(["lib/platform/custom-domains.ts", "app/actions/custom-domains.ts"], /\bemitKernelEvent\s*\(/),
  },
  {
    canary: "coupon", lane: "141H",
    contract: "COUPONS: code → Stripe validation (SDK promotion codes / coupons) → eligibility from Stripe's own restrictions → application on the Checkout Session / Subscription / Invoice → internal reconciliation; NO independent discount math on a charge; immediate, specific tenant-facing errors for invalid / expired / ineligible codes",
    probe: () => firstStrippedMatch(listFiles("lib/billing", TS), /\bpromotionCodes\b|\bpromotion_code\b/),
  },
]

export function hooksFor(canary: CanaryKey): CanaryHook[] {
  return WAVE141_HOOKS.filter((h) => h.canary === canary)
}

/** The census both readers print: pending (probe null) vs landed (probe answered). */
export function hookCensus(): { pending: Array<CanaryHook & { at: null }>; landed: Array<CanaryHook & { at: string }> } {
  const pending: Array<CanaryHook & { at: null }> = []
  const landed: Array<CanaryHook & { at: string }> = []
  for (const h of WAVE141_HOOKS) { const at = h.probe(); if (at) landed.push({ ...h, at }); else pending.push({ ...h, at: null }) }
  return { pending, landed }
}
