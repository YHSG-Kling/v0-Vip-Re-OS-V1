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
 *
 * WAVE 142 (lane 142J, HEAD fec8b6a95): the SAME pattern for lanes 142A–I — WAVE142_HOOKS below, read through the
 * same hookCensus (per wave or both) and the same hooksFor. The roster gains the thirteen wave-142 journeys.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { blankStrings, stripComments } from "../strip-comments"

export const ROOT = process.cwd()

/** The runner's roster — order is run order. The seven wave-140 chains first, then the wave-141 canaries, then
 *  the thirteen wave-142 journeys (lane 142J — the owner's list: security/support, listing, offer, FormWizard,
 *  preliminary HUD/CD, CDA, commissions/payment, lifetime, intelligence, marketing, video, AI/support/education,
 *  commercial/platform). Every wave-142 canary is IN-MEMORY ONLY (the live database has never been operated —
 *  support_tickets 0, offers 0, closing_disclosure_agreement 0, business_card_scans 0, lead_enrichment_queue 0,
 *  every video/render table 0 rows at 2026-10-19 — so a live mode would prove nothing and a count of 0 is unproven,
 *  never PASS). */
export const CANARY_KEYS = [
  "subscriber", "seat", "lead", "buyer", "seller", "communication", "self-healing",
  "solo-subscriber", "same-name-brokerage", "brokerage-adoption", "user-invite", "lead-magnet", "business-card",
  "transaction-provider", "cda-esign", "legal-description", "crm-outbound", "crm-inbound", "coupon", "custom-domain", "mobile",
  "support-isolation", "listing-lifecycle", "offer-lifecycle", "form-wizard", "preliminary-cd", "cda-closing", "commission-payment",
  "lifetime", "immediate-enrichment", "autonomous-marketing", "video-pipeline", "ai-by-your-side", "commercial-platform",
] as const
export type CanaryKey = (typeof CANARY_KEYS)[number]
export type Wave141Lane = "141A" | "141B" | "141C" | "141D" | "141E" | "141F" | "141G" | "141H" | "141I"
/** WAVE 142 (lane 142J): the lanes whose contracts the wave-142 canaries are written against ($S/prompt142A..I.md). */
export type Wave142Lane = "142A" | "142B" | "142C" | "142D" | "142E" | "142F" | "142G" | "142H" | "142I"
export type HookLane = Wave141Lane | Wave142Lane
/** The wave a hook belongs to, read off its lane ("141B" → "141", "142C" → "142") — never a second field to drift. */
export function hookWave(lane: HookLane | string): "141" | "142" { return lane.startsWith("142") ? "142" : "141" }

export interface CanaryHook {
  canary: CanaryKey
  lane: HookLane
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

// ── THE WAVE-142 HOOKS (lane 142J) ────────────────────────────────────────────────────────────────
// Same pattern as above: a canary step written against a wave-142 lane's CONTRACT ($S/prompt142A..I.md) whose
// module does not exist at HEAD fec8b6a95. Each probe reads STRIPPED source (strings kept — a column name in a
// select list is code; a comment, a prompt quotation or a tombstone is not a landing). MEASURED AT fec8b6a95:
// every probe below answers null (the census's positive control — a probe that answered at HEAD would be reading
// a comment, not code), except where a HEAD fact is itself the probe's subject and is stated beside it.
// Once a probe answers, the canary behind it runs the contract against the real export, and the integrator wires
// whatever the lane named differently at the `// WAVE142 HOOK (integrator): <lane>` line.
const SQL_STATEMENT = (re: RegExp) => (f: string) => re.test(readRepo(f) ?? "")
/** A migration file by number (supabase/migrations/mNNN-*.sql) or null. A SQL file has no JS comments; a
 *  statement probe is LINE-ANCHORED (`^\s*ALTER POLICY`) so a `-- ALTER POLICY …` prose line never lands it. */
function migrationFile(num: string): string | null {
  const dir = "supabase/migrations"
  const hit = listFiles(dir, (f) => new RegExp(`/${num}-[^/]+\\.sql$`).test(f))[0]
  return hit ?? null
}
const pkgHas = (key: string): boolean => new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(readRepo("package.json") ?? "")
/** A lane's registered proof, when package.json names it AND its script file exists (a key alone is not a landing). */
function proofFile(key: string): string | null {
  const pkg = readRepo("package.json") ?? ""
  const m = new RegExp(`"${key}"\\s*:\\s*"[^"]*?(scripts/[\\w./\\[\\]-]+\\.ts)`).exec(pkg)
  return m && existsSync(join(ROOT, m[1])) ? m[1] : null
}

export const WAVE142_HOOKS: CanaryHook[] = [
  // ── 142A · security, tenancy, support isolation, brokerage identity ──
  {
    canary: "support-isolation", lane: "142A",
    contract: "SUPPORT ISOLATION (owner: 'tenant should not read ticket queue across brokerages, only their tenancy'): app/actions/support.ts callerReadsAllBrokerages admits NO tenant user_type — 'support' is a storable TENANT seat — cross-tenant reads/writes are PLATFORM STAFF by platform_role through the roster predicates only; every tenant reader/writer of support_tickets + support_ticket_messages (search, counts, notifications, exports, AI context) is pinned to the session tenant; RLS on both tables admits by platform identity, never by user_type (m781 where a policy did); test:support-isolation registered",
    // HEAD: `if (ctx.userType === "support") return true` at support.ts:108 — the arm the ruling removes.
    probe: () => { const s = strippedRepo("app/actions/support.ts"); return s && !/userType\s*===\s*["']support["']/.test(s) ? "app/actions/support.ts" : null },
  },
  {
    canary: "support-isolation", lane: "142A",
    contract: "LEGACY SUPERADMIN CLEANUP: ONE idempotent reviewed migration m781 of `ALTER POLICY … USING/WITH CHECK` over the 37 live policies (SHAPE P arm → is_platform_admin(); SHAPE T → 'superadmin'/'super_admin' dropped from the user_type array; brokerage predicates for the three policies that had none) + a SEPARATE owner-SQL file m782 for users_user_type_check without 'superadmin' ('support' decided with evidence); platform authority preserved by platform_role; cross-tenant-read-simulator / platform-discriminator assert the rule with a positive control",
    probe: () => { const f = migrationFile("m781"); return f && SQL_STATEMENT(/^\s*ALTER\s+POLICY/mi)(f) ? f : null },
  },
  {
    canary: "brokerage-adoption", lane: "142A",
    contract: "STRIPE HANDOFF ACTOR: lib/kernel/brokerage-transfer.ts runs the billing handoff as the APPROVING brokerage admin (initiated_by_user_id / the approval row's actor), not the SUBJECT, so a Stripe-linked adoption completes in ONE consent-driven run — no stripe_handoff_pending stall; independent billing stops at the effective time with proration, seat/tech-fee responsibility moves, no double billing, no unauthorized data transfer, idempotent; test:brokerage-identity / test:coupons-and-handoff carry the actor rule + a positive control",
    // HEAD: brokerage-transfer.ts:452 passes the consenting SUBJECT as the migration actor; :640 hands that actor to the
    // billing handoff; subscriber-handoff.ts:220 requires an admin OF THE TARGET → the stall the brokerage-adoption
    // canary asserts as it stands. Landed = the rail derives the handoff actor from the request's initiating admin.
    probe: () => { const s = strippedRepo("lib/kernel/brokerage-transfer.ts") ?? ""; return /(approv\w*(UserId|Admin\w*)|handoffActor\w*|billingActor\w*|actorUserId)\s*[:=][^\n]{0,160}initiated_by_user_id/.test(s) || /initiated_by_user_id[^\n]{0,160}(approv|handoff|billing)/i.test(s) && /approv\w*\s*[:=]/.test(s) ? "lib/kernel/brokerage-transfer.ts" : null },
  },
  // ── 142B · listings, offers, e-sign monitoring, compliance, FormWizard, legal-forms vocabulary ──
  {
    canary: "listing-lifecycle", lane: "142B",
    contract: "ONE e-sign status vocabulary (CHECK, m783–m785 widening the existing envelope/document status survivor): draft · sent · partially_signed · all_signed · compliance_pending · correction_required · compliance_approved · fully_executed · declined · voided · expired — two spellings merged (§6); provider completion ≠ compliance approval",
    // `\bfully_executed\b` does not match the existing `fully_executed_at` column (an underscore is a word char).
    probe: () => firstStrippedMatch([...listFiles("lib/esign", TS), ...listFiles("lib/forms", TS), ...listFiles("lib/buyer-offer", TS), ...listFiles("lib/transactions", TS), ...listFiles("lib/compliance", TS), ...listFiles("lib/kernel", TS)], /^(?=[\s\S]*\bcompliance_approved\b)(?=[\s\S]*\bcorrection_required\b)(?=[\s\S]*\bcompliance_pending\b)/),
  },
  {
    canary: "listing-lifecycle", lane: "142B",
    contract: "LISTING AGREEMENT all-signed → signed documents retrieved + verified → agent + responsible compliance notified → the packet AUTO-SUBMITTED to compliance (the existing listing compliance loop) → required docs / initials / signatures / disclosures checked → deficiencies notified immediately → corrections / re-sign → ONLY after compliance approval the listing reads FULLY EXECUTED — never on the provider's completion event",
    // HEAD: lib/forms/esign-execution-loop.ts applyReadyWrites stamps listing_agreements { esign_status: "fully_signed",
    // fully_executed_at: now } the moment the PROVIDER reports every tracked form signed — before the compliance loop runs.
    probe: () => { const s = strippedRepo("lib/forms/esign-execution-loop.ts"); return s && !/esign_status:\s*["']fully_signed["'],\s*fully_executed_at:\s*now/.test(s) ? "lib/forms/esign-execution-loop.ts" : null },
  },
  {
    canary: "listing-lifecycle", lane: "142B",
    contract: "NOTIFICATIONS AT EVERY HOP through the existing fan-out (lib/notifications/notify-helpers.ts / the kernel notification engine): sent, participant signed, all signed, failed/declined/expired, compliance begins, corrections requested, approved, fully executed — deduped, no duplicates, no unauthorized document exposure (a party sees only its own documents)",
    probe: () => firstStrippedMatch(["lib/notifications/notify-helpers.ts", "lib/kernel/notification-engine.ts", "lib/kernel/event-fanout.ts", ...listFiles("lib/esign", TS)], /\b(partially_signed|participant_signed|ESIGN_PARTICIPANT_SIGNED|ESIGN_ALL_SIGNED|notifyEsignHop|notifySigningHop)\b/),
  },
  {
    canary: "offer-lifecycle", lane: "142B",
    contract: "E-SIGN MONITORING through the tenant's SELECTED e-sign provider (resolveESignChoice; platform default DocuSign; never Dotloop-hardwired): verified provider WEBHOOKS preferred (signature verified at the door), provider-compliant status RECONCILIATION as the backup through ONE reconciler (cron is the fallback, never the primary way a signing event is found)",
    probe: () => firstStrippedMatch([...listFiles("lib/esign", TS), ...listFiles("lib/forms", TS), ...listFiles("lib/esign-webhooks", TS), ...listFiles("app/api/cron", TS)], /\b(reconcileEnvelopeStatus|reconcileEsignStatus|reconcileEsignEnvelopes|reconcileEnvelopeStatuses|esignStatusReconciliation|reconcileSigningStatus)\b/),
  },
  {
    canary: "offer-lifecycle", lane: "142B",
    contract: "LIFECYCLE VOCABULARY proven by test:listing-offer-lifecycle: Listing → Offer → Signatures → Compliance → Fully Executed Contract → Transaction → Closing; an OUTSIDE-PROPERTY offer needs NO internal listing id at any door (createOffer / submitForSignature / submitOfferToCompliance / the kernel); a transaction is created ONLY after the executed contract is compliance-approved — never on submit, verbal acceptance or envelope-complete",
    probe: () => proofFile("test:listing-offer-lifecycle"),
  },
  {
    canary: "form-wizard", lane: "142B",
    contract: "FORMWIZARD (EXTEND app/components/form-wizard/FormWizard.tsx + lib/kernel/forms.ts, never rewrite): LISTING and OFFER only (CDA is never a step); the opening question 'Are we preparing listing forms or an offer?' → conversational intake (listing: property, seller, representation, price, period, compensation, disclosures, special terms; offer: in-house vs outside, buyer/seller, price, financing, deposits, closing date, contingencies, credits, inclusions, special terms) → the AI recommends ACTUAL available forms (jurisdiction, brokerage settings, representation, verified requirements — never invented) → the agent approves the packet → Complete → Review → E-sign/Deliver; the AI coaches, never invents legal terms, signatures or material facts",
    probe: () => { const s = strippedRepo("app/components/form-wizard/FormWizard.tsx"); return s && /listing forms or an offer/i.test(s) ? "app/components/form-wizard/FormWizard.tsx" : null },
  },
  {
    canary: "form-wizard", lane: "142B",
    contract: "SOURCE (a): a licensed form PACKET from PLATFORM Media rendered INSIDE VIPAgents — fillable (verified-data prefill, AI-assisted completion with human review, manual edit, required-field validation, autosave/resume, PDF generation, version history, download) on the existing pdf-lib / forms survivors (lib/forms/pdf-form-fill.ts, saveFormDraft / loadFormDraft); at HEAD packets are brokerage-scoped only (brokerage_form_library) and nothing under platform/superadmin Media carries a packet",
    probe: () => firstStrippedMatch([...listFiles("lib/forms", TS), "lib/kernel/forms.ts", "app/actions/forms-kernel.ts", ...listFiles("app/dashboard/superadmin", TS), ...listFiles("app/actions/superadmin", TS)], /\b(platform_form_packets|platformFormPackets|PLATFORM_FORM_PACKET\w*|platform_form_library|platformFormLibrary)\b/),
  },
  {
    canary: "form-wizard", lane: "142B",
    contract: "SOURCE (b) + VOCABULARY: the tenant's LEGAL-FORMS provider (renamed from 'transaction provider' by MERGE at the type / UI-copy / settings-label level — one spelling, tombstones, no DB column renames this wave) through its OFFICIAL API → official embedded interface → secure popup/new window with state-preserving return (never an unsupported iframe); the catalog's matrix says exactly credentials / settings / forms-upload / fill / e-sign-if-supported / status / sync per provider",
    probe: () => firstStrippedMatch(["lib/integrations/providers/catalog.ts", "lib/kernel/forms.ts", "lib/connections/scope.ts", ...listFiles("lib/integrations/providers", TS)], /\b(LegalFormsProvider|legalFormsProvider|LEGAL_FORMS_PROVIDER\w*|legal_forms_provider|LegalFormsCapability)\b/),
  },
  // ── 142C · CDA, preliminary HUD/CD, commissions, payments, lifetime, legal-description sources ──
  {
    canary: "form-wizard", lane: "142C",
    contract: "LEGAL DESCRIPTION SOURCES widened on lib/forms/legal-description.ts (CHECK legal_description_source via m786): the ACTIVE LISTING record (IDX/MLS), the RentCast property record, a county/public-record capability, approved OSINT property research (osint_free rail), human-verified entry — each with provenance, never invented, never the street address — and wired into the ADDRESS FILL (the property step) so the legal description arrives with the address when a source has it",
    probe: () => { const s = strippedRepo("lib/forms/legal-description.ts") ?? ""; const m = /LEGAL_DESCRIPTION_SOURCES\s*=\s*\[([^\]]*)\]/.exec(s); return m && /\b(osint|county|public_record|idx|mls|listing)\b/i.test(m[1]) ? "lib/forms/legal-description.ts" : null },
  },
  {
    canary: "preliminary-cd", lane: "142C",
    contract: "PRELIMINARY HUD / CLOSING DISCLOSURE: the TITLE COMPANY supplies it — on the Deal Team through the authorized title portal (uploadTitleDocument settlement_statement / final_closing_disclosure) → agent + TC notified IMMEDIATELY → attached to the transaction as a VERSION (closing_disclosure_agreement.preliminary_cd_* + closing_disclosure_agreement_revisions) → agent/TC review vs the executed contract + waterfall → discrepancy DOCUMENTED → correction request to title → revised official statement → version retained → waterfall reconciled → broker reviews on corrected values; outside title → agent/TC attaches; the AI explains discrepancies, never fabricates values, never alters the title company's document",
    // HEAD (SURVIVORS142 §4): a settlement statement uploaded by title never reaches preliminary_cd_* — only
    // cda-workflow-client calls uploadPreliminaryCdAction / notifyAgentOfPreliminaryCdAction; uploadTitleDocument
    // writes transaction_documents and revalidates a path, notifying nobody.
    probe: () => { const s = strippedRepo("app/actions/title-portal.ts") ?? ""; return /\b(preliminary_cd_\w+|uploadPreliminaryCd\w*|notifyAgentOfPreliminaryCd\w*|CD_RECEIVED|settlement_statement_versions|requestSettlementCorrection|settlementCorrectionRequest)\b/.test(s) ? "app/actions/title-portal.ts" : firstStrippedMatch(listFiles("lib/transactions", TS), /\b(settlement_statement_versions|requestSettlementCorrection|settlementCorrectionRequest|cdDiscrepanc\w+|settlementDiscrepanc\w+|titleDocumentToCda|bridgeTitleUpload\w*)\b/) },
  },
  {
    canary: "cda-closing", lane: "142C",
    contract: "CDA EXISTS ONLY when brokerage settings say so (brokerages.offers_cda / cda_onboarding_at / non_cda_payout_default, live): disabled → no mandatory CDA, no auto-generation, nothing blocks closing, the brokerage-received-commission + agent payout flow applies; enabled → the AGENT selects the approved CDA form from platform Media and fills it MANUALLY (AI MUST NOT FILL THE CDA — it may explain waterfall figures when asked); completeness validated vs the corrected preliminary statement + waterfall; broker on VIPAgents → the existing authorized approval/e-sign; broker outside → download, sign outside, return; provider signature status tracked; never approved because an envelope was sent",
    // HEAD: app/actions/cda-portal.ts names offers_cda only in a comment (stripped → absent): the CDA doors do not read
    // the brokerage setting; the manual-fill rule itself IS built (cda-template-fields.ts: a waterfall field is never
    // pre-filled) and the canary proves it at HEAD.
    probe: () => { const s = strippedRepo("app/actions/cda-portal.ts") ?? ""; return /\boffers_cda\b/.test(s) ? "app/actions/cda-portal.ts" : null },
  },
  {
    canary: "cda-closing", lane: "142C",
    contract: "CDA DEADLINE + DELIVERY: the signed, approved CDA reaches title BEFORE/AT the scheduled closing date/time (tenant timezone; earlier brokerage/title requirements win) with reminders + IMMEDIATE escalation to the registered owner; delivery to a Deal-Team title company through the authorized title portal inbox (evidence, status, notice) or to a verified outside recipient through the existing configured outbound email (GHL/SMTP already configured — no SMTP server) with tracked status; agent/TC told on failure; never duplicated on retry",
    // HEAD: cda-delivery-policy.ts escalates 12 h AFTER APPROVAL (CDA_DELIVERY_GRACE_HOURS) — not anchored to the closing;
    // sendCdaToTitleAction's methods are email | docusign | dotloop | manual — no title-portal inbox method.
    probe: () => firstStrippedMatch(["lib/transactions/cda-delivery-policy.ts", "lib/transactions/cda-delivery-reaper.ts", "app/actions/cda-portal.ts"], /\b(closing_date|closingAt|scheduledClosing\w*|scheduled_closing\w*|closingDeadline|cdaDeadline|timeZone|timezone|title_portal|titlePortalInbox)\b/),
  },
  {
    canary: "commission-payment", lane: "142C",
    contract: "PAYMENT STATES tracked separately — expected · preliminary · approved_final · payment_initiated · payment_recorded · payment_received · reconciled — merged onto the existing commission-state vocabulary (CHECK widened by migration where needed); the no-CDA flow: title pays the brokerage → receipt verified → waterfall → brokerage authorizes → CHECK or DIRECT DEPOSIT → recorded + reconciled (Stripe Billing never executes brokerage payouts); manual agent receipt confirmation = an ATTESTATION (amount, date, payer, method, evidence/reference); QuickBooks matched only against the ACTUAL connected integration; corrections = linked adjustment / reversal entries; no duplicate payouts",
    probe: () => firstStrippedMatch([...listFiles("lib/commission", TS), "lib/kernel/financial.ts", ...listFiles("lib/finance", TS)], /\b(payment_recorded|payment_received|payment_initiated|approved_final|receipt_attestation|recordReceiptAttestation|commissionReceiptAttestation|attestCommissionReceipt)\b/),
  },
  {
    canary: "lifetime", lane: "142C",
    contract: "CONTACT → LIFETIME after the VERIFIED closing + required records through the existing Lifetime workflow (closeTransactionCommand's conversion): CLOSED / PAYOUT PENDING until the payout is verified where rules require; final commission attribution preserved; eligible past-client follow-up starts (the touchpoint schedule); NO duplicate conversions or accounting on a re-run",
    // HEAD: closeTransactionCommand converts both parties and inserts the touchpoint schedule on EVERY call (the
    // lifetime canary measures the re-run); no payout-pending state exists in lib/kernel/transactions.ts.
    probe: () => { const s = strippedRepo("lib/kernel/transactions.ts") ?? ""; return /\b(payout_pending|PAYOUT_PENDING|payoutVerified|payout_verified|payoutPending)\b/.test(s) ? "lib/kernel/transactions.ts" : null },
  },
  // ── 142D · entity types, scanner, immediate enrichment, Versium ──
  {
    canary: "immediate-enrichment", lane: "142D",
    contract: "IMMEDIATE ENRICHMENT (owner: 'as soon as a new contact or form submission comes in'): every create door (captureContact, captureFormSubmission, /api/forms/submit, ad-lead intake, the scanner, CRM inbound commit, manual create) dispatches an INLINE best-effort drain of the just-queued row through the ONE orchestrator (consent, dedup, territory/identity gate, missing-field-only waterfall, provenance, mayUseAndAfford, no unsafe overwrite) — fire-and-forget with evidence, never blocking the capture; the 15-minute cron stays the backstop; test:immediate-enrichment proves every door and catches a cron-only door",
    probe: () => proofFile("test:immediate-enrichment") ?? firstStrippedMatch(["lib/contact-pipeline/contact-capture.ts", "lib/enrichment/contact-enrichment-core.ts", "lib/kernel/lead-magnets.ts", "lib/lead-pipeline/enrichment-orchestrator.ts", "lib/kernel/event-reactor.ts"], /\b(drainEnrichmentRow|processEnrichmentEntry|enrichQueuedContactNow|processEnrichmentQueueRow|drainOneEnrichment|enrichContactImmediately|runImmediateEnrichment|drainEnrichmentNow|immediateEnrichment\w*)\b/),
  },
  {
    canary: "immediate-enrichment", lane: "142D",
    contract: "VERSIUM audited against the REAL products (contact/business append, B2B2C identity matching, 'Online Presence Indicator - Real Estate' and the other real-estate indicators, Versium REACH MCP, the B2B2C append API) — every field verified against the real schema before use; exposed through the EXISTING kernel capability routing (routeCapability / provider chain) with mayUseAndAfford + meterVendorSpend + withActionLedger, no second rail; look-alike audiences (recent buyers / new listings / just-sold) as COMPLIANT research only (consent, fair housing, protected characteristics, platform ad policy; restricted → content planning)",
    probe: () => { const s = strippedRepo("lib/external/versium-client.ts") ?? ""; return /b2b2c|online[_ ]?presence/i.test(s) ? "lib/external/versium-client.ts" : null },
  },
  {
    canary: "business-card", lane: "142D",
    contract: "ENTITY TYPE BEFORE SCAN (owner: 'before scanning, the user chooses which type and then scans … we have user types and contact types'): SELECT vendor / contact / agent → SCAN → EXTRACT → VERIFY → IDENTITY/DEDUP → the CORRECT DOMAIN ENTITY (vendor → canonical vendor/company structures; agent → identity/affiliation record, NEVER an automatic tenant login; contact → the contact lifecycle) → ENRICH → authorized workflow; no silent Auto-detect default (auto-detect only as an explicit pick that still confirms the type before any entity is written); nothing non-contact is 'saved as a contactId'; test:entity-types registered",
    // HEAD: app/dashboard/agent/business-cards/page.tsx:17 offers { value: "", label: "Auto-detect" } as the default
    // pick — the silent default the ruling removes. (A vendor / agent scan already lands vendors / recruits with
    // contactId null — the business-card canary asserts that at HEAD.)
    probe: () => { const page = strippedRepo("app/dashboard/agent/business-cards/page.tsx"); return proofFile("test:entity-types") ?? (page && !/value:\s*"",\s*label:\s*"Auto-detect"/.test(page) ? "app/dashboard/agent/business-cards/page.tsx" : null) },
  },
  // ── 142E · autonomous marketing, lead magnets, fair-housing rewrite, omnipresence, book ──
  {
    canary: "autonomous-marketing", lane: "142E",
    contract: "SUGGESTION SOURCES: suggestLeadMagnetIdeas (lib/lead-magnets/suggestions.ts) also draws from the TOPIC BANK (content_topic_bank / pickTopics), COMPETITIVE-INTELLIGENCE high-traffic topics (promote-to-topic-bank) and AI-SEARCH discovery (the citation monitor) — real readers wired, no fourth ideation engine; MARKET SIGNAL → OPPORTUNITY → CREATIVE IDEA → STRATEGY → REAL ASSET → HUMAN APPROVAL → PUBLISH → OMNIPRESENCE → FOLLOW-UP → ATTRIBUTION → LEARNING",
    probe: () => { const s = strippedRepo("lib/lead-magnets/suggestions.ts") ?? ""; return /\b(content_topic_bank|pickTopics|keyword_intelligence|ai_search_citation\w*|competitor\w*|promoteCompetitorAdsToTopicBank|citation)\b/.test(s) ? "lib/lead-magnets/suggestions.ts" : null },
  },
  {
    canary: "autonomous-marketing", lane: "142E",
    contract: "FAIR-HOUSING REWRITE LOOP for PUBLIC copy (lead magnets, landing copy, ads, social — the video loop's shape reused): flagged → the AI rewrites with the specific findings → recheck (fair-housing-patterns / realEstateComplianceGate) → a human approves the corrected creative; capped (e.g. 2 rewrites) then escalated to a human; NEVER applied to private CDA / financial records or routine internal form entry (positive control); no hard-written marketing copy outside examples / templates / business rules",
    probe: () => firstStrippedMatch([...listFiles("lib/lead-magnets", TS), ...listFiles("lib/kernel/marketing", TS), ...listFiles("lib/compliance-rules", TS), ...listFiles("lib/ads", TS), ...listFiles("lib/marketing", TS)], /\b(rewriteForFairHousing|fairHousingRewrite\w*|rewriteWithFindings|FAIR_HOUSING_REWRITE_CAP|MAX_FAIR_HOUSING_REWRITES|rewriteCopyForCompliance|complianceRewriteLoop)\b/),
  },
  {
    canary: "autonomous-marketing", lane: "142E",
    contract: "OMNIPRESENCE carries an APPROVED creative / lead-magnet asset reference across website, YouTube/video (lane F publishes), social, paid ads, email, permitted SMS, direct mail, QR, follow-up and education through the existing distribution survivors (omnipresence_topic_fanout / cross-post / campaign manager; consent, fatigue, opt-outs, channel rules respected), and the approved creative stays ACCESSIBLE to follow-up services (asset-library reference on the magnet / campaign: version, ownership, attribution, rights, performance)",
    // The fanout BRANCH only (up to the next `case`): at HEAD its postcard arm writes `asset_id: null` — no asset
    // reference — so the probe demands a reference that is NOT null (a null is the absence this contract closes).
    probe: () => { const s = strippedRepo("lib/agents/marketing-agent-actions.ts") ?? ""; const branch = /case\s+["']omnipresence_topic_fanout["']:([\s\S]*?)\n\s*case\s+["']/.exec(s)?.[1] ?? ""; return /\bmarketing_assets\b|\b(assetId|magnetId|lead_magnet_id|lead_capture_forms|creativeAssetId|creative_asset_id)\b|asset_id:\s*(?!null\b)\S/.test(branch) ? "lib/agents/marketing-agent-actions.ts" : null },
  },
  {
    canary: "autonomous-marketing", lane: "142E",
    contract: "BOOK CREATOR on the booklet survivor (guide-booklet-content.ts + client-pdf.ts + lead-magnet-delivery-runner.ts): concept → research (existing topic / citation readers) → outline → ORIGINAL chapters (routed lane, feature key, cost booked) → fact-check pass → edit pass → cover (image rail or typographic) → layout → PDF in the asset bucket → lead_capture_forms magnet (buyer_guide / seller_guide, or a 'book' type via m791) → capture → follow-up → attribution; human approval before publish; the guard proves real multi-page PDF bytes; an incomplete generator is never certified",
    probe: () => firstStrippedMatch([...listFiles("lib/marketing", TS), ...listFiles("lib/documents", TS), ...listFiles("lib/lead-magnets", TS), ...listFiles("lib/kernel", TS)], /\b(factCheck\w*|fact_check\w*|bookOutline|generateBookChapters|BOOK_PIPELINE\w*|book_project\w*|createBookDraft|produceBook\w*|BookManuscript|bookManuscript)\b/),
  },
  {
    canary: "autonomous-marketing", lane: "142E",
    contract: "DUPLICATE FORMS DOOR consolidated (lane 141E's finding): admin Forms Manager + POST /api/forms/submit merge their unique pieces (settings.default_contact_type, resolveCapturedLanguage, the field editor) onto the lead-magnet survivor — /api/forms/submit keeps the slug → form lookup and DELEGATES to captureFormSubmission; routes keep resolving; the duplicate is tombstoned naming the survivor",
    probe: () => { const s = strippedRepo("app/api/forms/submit/route.ts") ?? ""; return /\bcaptureFormSubmission\b/.test(s) ? "app/api/forms/submit/route.ts" : null },
  },
  // ── 142F · Remotion, video pipeline, landing video, YouTube ──
  {
    canary: "video-pipeline", lane: "142F",
    contract: "PLAYABLE OUTPUT: a render is complete ONLY when the stored file is playable — object size > 0, MP4/WebM container header readable (ftyp/moov or EBML), duration > 0 where cheap (ffprobe if present, else a header parse) — verified at the completion path (finalizeCoordinatedRender / hostRenderedMedia) BEFORE render_status 'succeeded'; otherwise 'failed' with the reason, the reaper / escalation through the registered owner; a read-only failure CENSUS over remotion_composition_renders.error_message / retry_count so the first production failures are visible (the live table holds 0 rows at 2026-10-19); each recurring root cause documented with evidence and fixed where live",
    probe: () => firstStrippedMatch([...listFiles("lib/remotion", TS), ...listFiles("lib/video", TS)], /\b(ftyp|EBML|ffprobe|isPlayableMedia|probePlayable\w*|verifyPlayable\w*|assertPlayable\w*|playableOutput\w*|renderOutputPlayable|PlayableProbe)\b/),
  },
  {
    canary: "video-pipeline", lane: "142F",
    contract: "LANDING VIDEO SLOT on every published landing page — /lm/[slug] (poster + onError fallback on the existing <video>), /site/[slug] (a slot fed by approved marketing video assets), listing landings — using approved media when available with a functional fallback (poster / still / text); never a broken player",
    probe: () => { const lm = strippedRepo("app/lm/[slug]/page.tsx") ?? "", site = strippedRepo("app/site/[slug]/page.tsx") ?? ""; return /\b(poster|onError)\b/.test(lm) && /<video\b|VideoSlot|LandingVideo|landingVideo/.test(site) ? "app/lm/[slug]/page.tsx" : null },
  },
  {
    canary: "video-pipeline", lane: "142F",
    contract: "YOUTUBE (owner: 'all videos that are not personal should also be added to youtube'): approved NON-PERSONAL publicly distributable videos auto-publish after human approval through the existing authorized YouTube path (OAuth, channel ownership tenant/platform, privacy driven by the classification personalVideoTypes / ai_video_projects.audience_type — never a hard-coded 'public'; rights/approvals; never client/transaction media) under a tenant setting (default on for non-personal marketing classes); the upload result + YouTube id/url recorded on the asset so campaigns, lead magnets and follow-up can reuse it; the platform channel wired or stated UNSUPPORTED",
    // HEAD: lib/social/publisher.ts:305 `privacyStatus: "public"` is hard-coded on every upload.
    probe: () => { const s = strippedRepo("lib/social/publisher.ts"); return s && !/privacyStatus:\s*["']public["']/.test(s) && /privacyStatus/.test(s) ? "lib/social/publisher.ts" : null },
  },
  // ── 142G · AI by your side: support triage, education intelligence, live avatar ──
  {
    canary: "ai-by-your-side", lane: "142G",
    contract: "SUPPORT AI TRIAGE at createSupportTicket (app/actions/support.ts — lane A's isolation untouched) through the routed AI lane (feature key, cost booked, mayUseAndAfford for tenant lanes, platform budget for the platform lane) → category / priority / owner suggestion → a registered-owner signal (manager-signals) → SAFE REPAIR via a self-healing playbook where one exists → else a HUMAN → verification → resolution; evidence row; errors in tenant creation / users / invites / billing / connections / A2P surface immediately through lib/kernel/immediate-operations.ts into the ticket / incident flow; the tenant sees a sanitized actionable status — never 'platform-covered', never a credential or an internal price",
    probe: () => firstStrippedMatch(["app/actions/support.ts", ...listFiles("lib/support", TS)], /\btriage/i),
  },
  {
    canary: "ai-by-your-side", lane: "142G",
    contract: "EDUCATION INTELLIGENCE: recurring SUPPORT ticket subjects + FormWizard coaching questions feed the existing gap loop (question-gap → knowledge-gap-detector → curriculum-author) under the right cron owner (the education / competency cron, not recruit-outreach), proposing education assets (help articles, tutorials, FormWizard coaching, videos by reference, lessons, buyer/seller education) with factual / compliance review + approval, and each proposal carries a 'repeats decreased?' measure",
    probe: () => firstStrippedMatch(["lib/education/curriculum-author.ts", "lib/education/question-gap.ts", "lib/education/knowledge-gap-detector.ts"], /\bsupport_tickets\b/),
  },
  {
    canary: "ai-by-your-side", lane: "142G",
    contract: "AI BY YOUR SIDE per audience — platform staff, brokerage/tenant admins, agents/teams, buyers/sellers, VENDORS — real contextual assistance wired to an authorized tool path (the tool-call route, manager coordination) with response/action evidence (withActionLedger / ai_tool_usage); chat, voice and LIVE AVATAR (D-ID live agent, ElevenLabs, Simli backup) run real sessions through configured providers with cost booking; a static preview is never presented as live; a platform-paid provider that is dark reads as a sanitized capability status; test:ai-by-your-side registered",
    probe: () => proofFile("test:ai-by-your-side"),
  },
  // ── 142H · UI / mobile product-journey audit ──
  {
    canary: "mobile", lane: "142H",
    contract: "COMPLETE UI / MOBILE AUDIT on the lane-141I survivors (ui-wiring-census, mobile-readiness, the shrink-only ratchets): every visible action wired, no dead buttons / selectors / tabs / cards / save / generate / send, no false success states; mobile ADAPTS (tables → cards, multi-column → stepper/drawer, side panels → sheets, touch-safe), never merely shrinks; 'legal-forms provider' and listing / offer / transaction words in touched copy; every literal href resolves; the Playwright smoke carries a MOBILE / TABLET viewport project (390 / 820) so the 390px rule is driven, not only censused",
    // HEAD: playwright.config.ts:27 has one project (Desktop Chrome) — lane 141I's open finding, re-proven at fec8b6a95.
    probe: () => { const s = strippedRepo("playwright.config.ts") ?? ""; return /devices\[["'](iPhone|Pixel|Galaxy|iPad)[^"']*["']\]|viewport:\s*\{\s*width:\s*(390|412|430|820)\b/.test(s) ? "playwright.config.ts" : null },
  },
  // ── 142I · production configuration + readiness ──
  {
    canary: "commercial-platform", lane: "142I",
    contract: "READINESS CHECKS for the wave-142 gates read from CODE in scripts/production-readiness-guard.ts / the readiness contract: tenant support isolation (lane A's guard key), CDA policy configuration (brokerage setting present + consistent), the playable-video rule (lane F's key), the certified tenant-selected LEGAL-FORMS + e-sign configurations, the superadmin / RLS policy census through provider-posture / readiness rails, support / incident operations — and a readiness row that would read LIVE operational counts treats 0 rows as NOT_APPLICABLE / unproven, never PASS (the live database has never been operated)",
    probe: () => firstStrippedMatch(["scripts/production-readiness-guard.ts", "lib/kernel/tenant-readiness.ts", "lib/platform/provider-posture.ts"], /^(?=[\s\S]*\b(support[-_]isolation|supportIsolation)\b)(?=[\s\S]*\boffers_cda\b)/),
  },
  {
    canary: "commercial-platform", lane: "142I",
    contract: "NO UNCERTIFIED DEFAULT LEGAL-FORMS INTEGRATION (owner: 'dotloop is not the only … they all should be fully functional for the tenants to choose'): SYSTEM_DEFAULTS.transaction (lib/kernel/providers.ts + the provider-settings-actions mirror) is a CERTIFIED provider per the matrix (docusign for e-sign; the certified transaction-only provider or 'none until the tenant selects' for forms) — never 'dotloop' — and the readiness check asserts the rule",
    // HEAD: lib/kernel/providers.ts:62 `transaction: "dotloop"` — a provider PROVIDER_CAPABILITY_MATRIX does not certify.
    probe: () => { const s = strippedRepo("lib/kernel/providers.ts"); return s && !/transaction:\s*["']dotloop["']/.test(s) && /transaction:/.test(s) ? "lib/kernel/providers.ts" : null },
  },
]

/** Every hook of both waves — the one list both readers walk. */
export const HOOKS: readonly CanaryHook[] = [...WAVE141_HOOKS, ...WAVE142_HOOKS]

export function hooksFor(canary: CanaryKey): CanaryHook[] {
  return HOOKS.filter((h) => h.canary === canary)
}

/** The census both readers print: pending (probe null) vs landed (probe answered). `wave` narrows it to one
 *  wave's hooks ("141" | "142"); omitted = both (the release gate reads every pending hook of a canary). */
export function hookCensus(wave?: "141" | "142"): { pending: Array<CanaryHook & { at: null }>; landed: Array<CanaryHook & { at: string }> } {
  const pending: Array<CanaryHook & { at: null }> = []
  const landed: Array<CanaryHook & { at: string }> = []
  for (const h of HOOKS) {
    if (wave && hookWave(h.lane) !== wave) continue
    const at = h.probe(); if (at) landed.push({ ...h, at }); else pending.push({ ...h, at: null })
  }
  return { pending, landed }
}
