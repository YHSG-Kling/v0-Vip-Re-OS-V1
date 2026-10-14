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
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../strip-comments"

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
    contract: "the member core (lib/kernel/users.ts inviteTenantMember) dispatches the invite in the SAME request, reads the result, evidences + routes a failure (USER_INVITED kernel event from the core with the dispatch outcome; a registered manager or the canonical service consumes it) — never success on a failed post-condition",
    probe: () => (/\bUSER_INVITED\b/.test(strippedRepo("lib/kernel/users.ts") ?? "") ? "lib/kernel/users.ts" : null),
  },
  {
    canary: "crm-inbound", lane: "141B",
    contract: "ROLE SAFETY: no authority resolver defaults an unknown type to a privileged role — lib/platform/platform-staff-roster.ts resolvePlatformRoleIdentity no longer reads users.user_type === 'superadmin' as platform staff (platform staff live in platform_role)",
    probe: () => { const s = strippedRepo("lib/platform/platform-staff-roster.ts"); return s && !/userType\s*===\s*["']superadmin["']/.test(s) ? "lib/platform/platform-staff-roster.ts" : null },
  },
  {
    canary: "transaction-provider", lane: "141C",
    contract: "lib/transactions/provider-capabilities.ts — the FACTUAL MATRIX as a typed registry: provider → credentials (tenant-owned) → settings → forms → transaction creation → upload → fill → e-sign → status → sync, each cell BUILT/PARTIAL/UNWIRED/MISSING; a provider is selectable in tenant settings ONLY for capabilities whose required paths function",
    probe: () => (existsSync(join(ROOT, "lib/transactions/provider-capabilities.ts")) ? "lib/transactions/provider-capabilities.ts" : null),
  },
  {
    canary: "cda-esign", lane: "141C",
    contract: "CDA routes through the tenant's E-SIGN selection via the canonical e-sign adapter (lib/integrations/resolve-esign-provider.ts), never the transaction-forms vendor and never hardwired to Dotloop; a transaction platform fulfils it only when its e-sign path is certified in the matrix",
    probe: () => (/resolve-esign-provider/.test(strippedRepo("lib/transactions/cda-esign.ts") ?? "") ? "lib/transactions/cda-esign.ts" : null),
  },
  {
    canary: "legal-description", lane: "141C",
    contract: "the canonical property model carries legal_description (column, m768 if needed); PROPERTY → legal description → canonical transaction/form model → provider field; absent → resolved through an approved property-data capability ONLY if it legitimately provides it (cost-booked), else the form is INCOMPLETE and a human is asked through the existing task/notification rail — never invented",
    probe: () => firstStrippedMatch([...listFiles("lib/property", TS), ...listFiles("lib/transactions", TS)], /\blegal_description\b/),
  },
  {
    canary: "crm-outbound", lane: "141D",
    contract: "AIRTABLE RETIRED: no operational path (reader, writer, cron, settings UI, env) under lib/, app/ or services/ names airtable — historical data kept; the tenant's outbound sync (VIPAgents canonical → mapping → tenant CRM) is the only CRM direction a tenant controls",
    probe: () => {
      // Cheap pre-filter on RAW text, then the verdict on STRIPPED source (a tombstone naming Airtable is not a path).
      const candidates = [...listFiles("lib", TS), ...listFiles("app", TS), ...listFiles("services", TS)].filter((f) => /airtable/i.test(readRepo(f) ?? ""))
      const live = candidates.filter((f) => /airtable/i.test(strippedRepo(f) ?? ""))
      return live.length === 0 ? "lib" : null
    },
  },
  {
    canary: "crm-inbound", lane: "141D",
    contract: "INBOUND is PLATFORM STAFF ONLY with an explicit field MAPPING against the canonical schema (required canonical fields for workflows/triggers in ONE registry) → preview → validation → identity/dedup → controlled commit → only then workflows/triggers; a tenant is REFUSED with a clear sentence; external schemas never write canonical fields directly",
    probe: () => firstStrippedMatch([...listFiles("lib/crm", TS), ...listFiles("lib/platform", TS), ...listFiles("app/actions/lead-import", TS)], /\b(previewCrmImport|canonicalFieldMapping|REQUIRED_CANONICAL_FIELDS|CRM_IMPORT_FIELD_MAP|CRM_INBOUND_MAPPING)\b/),
  },
  {
    canary: "lead-magnet", lane: "141E",
    contract: "AI CREATION: the AI produces the ACTUAL draft (concept → copy/questions/design/assets/configuration) as a real lead_capture_forms record in DRAFT through the existing AI gateway + cost accounting + mayUseAndAfford; human preview → edit → approve → publish",
    probe: () => firstStrippedMatch(["lib/kernel/lead-magnets.ts", ...listFiles("lib/lead-magnets", TS), ...listFiles("lib/marketing", TS)].filter((f) => existsSync(join(ROOT, f))), /\b(generateObjectRouted|generateTextRouted)\b[\s\S]*["'`]lead_capture_forms["'`]|["'`]lead_capture_forms["'`][\s\S]*\b(generateObjectRouted|generateTextRouted)\b/),
  },
  {
    canary: "lead-magnet", lane: "141E",
    contract: "ATTRIBUTION: a lead magnet used in an ad keeps campaign/ad/creative attribution (campaign_id / ad_id / creative_id or utm_*) through capture → consent → intake → dedup → contact lifecycle → follow-up → outcome → learning",
    probe: () => (/\b(campaign_id|ad_id|creative_id|utm_source)\b/.test(strippedRepo("lib/kernel/lead-magnets.ts") ?? "") ? "lib/kernel/lead-magnets.ts" : null),
  },
  {
    canary: "lead-magnet", lane: "141F",
    contract: "QR: no open redirect — the scan resolver routes only to an ALLOW-LIST of in-app destinations (lead magnet, form, property, contact, open house, vCard); no cross-tenant resolution; the scan landing renders at 360–430px",
    probe: () => firstStrippedMatch(["app/api/qr/scan/route.ts", "lib/marketing/tracked-qr.ts"], /allow[-_]?list|ALLOWED_|isAllowedDestination|isInAppDestination/i),
  },
  {
    canary: "business-card", lane: "141F",
    contract: "BUSINESS CARD: per-FIELD confidence from the one vision extraction → human confirmation where confidence is low → identity/dedup → canonical contact; a field-level MERGE rule never overwrites higher-confidence data with a weak extraction (with evidence)",
    probe: () => firstStrippedMatch([...listFiles("lib/contacts", TS), ...listFiles("app/actions/business-card", TS)], /\b(fieldConfidence|confidenceByField|per_field_confidence|field_confidence)\b/),
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
