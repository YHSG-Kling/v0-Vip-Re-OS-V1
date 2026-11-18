#!/usr/bin/env tsx
/**
 * scripts/product-surface-audit-guard.ts — wave 154, lane 154K (directive K1: "audit the existing FULL OS as a product, not just a
 * code census … user-facing action → canonical decision → real writer → observed output").
 *
 * WHAT IT PROVES (no DB, no network, no model — every row is SIMULATED unless a real run exists, and none does):
 *   §A TRACED PATHS — one realistic path per K1 capability family, each pinned as a RULE over STRIPPED source (scripts/strip-comments.ts,
 *      so a tombstone or a comment naming a function is never read as a call site): the CONTROL (button / form / cron / event) still
 *      calls the DECISION's door, the decision's gate is still in the door, the WRITER still writes its table, and the READER the
 *      person sees still reads it. A path whose link breaks fails here with the file and the missing token. Line numbers are DERIVED
 *      on every run (never pinned), so the generated table follows the code.
 *   §B FOUR RULES behind this lane's fixes, each DERIVED over the tree and each with a POSITIVE CONTROL that recreates the base defect
 *      (a broken finder and a clean tree both read zero — CLAUDE.md §2):
 *      B1 every client control that calls a commission payout action passes `advanceReason` (the funds gate asks for a reason; a
 *         control that cannot send one is a dead end — 143C-OL-04);
 *      B2 nothing computes a zone as `primary_timezone … ?? 'UTC'` outside the settings resolver's own default (every milestone was
 *         UTC — 143H-OL-02); the milestone bridge resolves through resolveTenantTimeZone;
 *      B3 the packet actor resolver is grant-aware (withTenantRoleGrants) like its SQL twin is_brokerage_admin() (145A-SO-06);
 *      B4 a page that renders a form-library `pdf_url` as a link also guards it by `storage_path` (sign-on-read — 145A-OL-05).
 *   --write regenerates docs/operations/WAVE154-PRODUCT-SURFACE-AUDIT.md from §A (the doc is generated — never hand-edit it).
 *
 * BLIND SPOTS (published): a token present is not a click that works — no browser runs here; a path is the ONE realistic path traced,
 * not every door of the family; persona = the existing user types and scope rules (CLAUDE.md §4), not a test identity; provider
 * legs are OWNER-HELD / LICENSE-HELD and nothing here calls one.
 *
 * Run: npx tsx scripts/product-surface-audit-guard.ts [--write]      (npm run -s test:product-surface-audit)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const DOC = "docs/operations/WAVE154-PRODUCT-SURFACE-AUDIT.md"
type Status = "EXISTING VERIFIED" | "FIXED" | "PARTIAL" | "OWNER-HELD" | "LICENSE-HELD"
type Step = { file: string; token: string }
interface TracedPath {
  family: string; persona: string; capability: string
  control: Step; decision: Step; writer: Step & { table: string }; reader: Step
  status: Status; proof: "SIMULATED" | "LIVE-VERIFIED"; note: string
}

// ── §A the traced paths (persona = existing user types / scope rules only) ─────────────────────────────────────────
const PATHS: TracedPath[] = [
  { family: "Onboarding · seats", persona: "broker_owner (TENANT_COMMERCE_ADMIN_USER_TYPES)", capability: "buy seat packages",
    control: { file: "app/dashboard/admin/billing/seat-door-card.tsx", token: "buySeatPackagesAction(p.packages)" },
    decision: { file: "app/actions/billing.ts", token: "const auth = await requireTenantCommerceAdmin()" },
    writer: { file: "app/actions/billing.ts", token: ".update({ seat_packages: qty, extra_seats: newExtra", table: "brokerage_subscriptions" },
    reader: { file: "app/actions/billing.ts", token: "export async function getSeatDoorAction(): Promise<SeatDoor>" },
    status: "OWNER-HELD", proof: "SIMULATED", note: "the seat door and its gate are real; the Stripe seat item is OWNER-HELD (no Stripe objects)" },
  { family: "Sources · connections", persona: "broker / broker_admin (TENANT_ADMIN_USER_TYPES)", capability: "save a lead-source credential, never claimed 'connected'",
    control: { file: "app/dashboard/settings/integrations/lead-sources/lead-sources-client.tsx", token: "const r = await saveTenantConnectionAction({" },
    decision: { file: "app/actions/tenant-connections.ts", token: "const verified = await verifyCredentialRow(svc, { brokerageId: ctx.brokerageId, platform: input.platform })" },
    writer: { file: "app/actions/tenant-connections.ts", token: ": await svc.from(\"platform_credentials\").insert(row)", table: "platform_credentials" },
    reader: { file: "app/dashboard/settings/integrations/lead-sources/page.tsx", token: "getTenantConnectionsAction" },
    status: "EXISTING VERIFIED", proof: "SIMULATED", note: "saved + re-read active = 'saved and active', NOT 'connected' (no vendor test on this door); refusals go through presentTenantError; vendor legs AWAITING KEY" },
  { family: "Topic pool (Google / chatter)", persona: "platform cron for a tenant", capability: "public chatter → reworded topic → pool",
    control: { file: "app/api/cron/content-intel-reddit/route.ts", token: "const r = await intakeTopicIdeas(svc, { brokerageId: s.brokerage_id, ideas, now })" },
    decision: { file: "lib/content-intel/topic-intake.ts", token: "export function classifyTopicExclusion(" },
    writer: { file: "lib/content-intel/topic-intake.ts", token: "content_topic_bank", table: "content_topic_bank" },
    reader: { file: "lib/content-intel/topic-intelligence.ts", token: "await db.from(\"content_topic_bank\").select(\"id, raw_data, source_url\")" },
    status: "FIXED", proof: "SIMULATED", note: "one producer: every source (Trends, search demand, public chatter, Facebook and Meta ideas, news, local facts, brand listening, look-alike briefs, Refurbish, manual saves) files through the ONE intake — test:topic-pool holds exactly one inserting module; the Trends and Search Console grants themselves stay OWNER-HELD" },
  { family: "Refurbish · competitor research", persona: "agent (own brokerage)", capability: "refurbish a competitor idea in the user's voice",
    control: { file: "app/dashboard/marketing/seo/components/market-trends-panel.tsx", token: "const r = await refurbishCompetitorIdea({ competitorContentId: postId, outputFormats: [format] })" },
    decision: { file: "lib/repurpose/refurbish-run.ts", token: "const originality = assessOriginality({" },
    writer: { file: "lib/repurpose/actions.ts", token: "return executePipeline({ pipelineId: created.pipelineId, brokerageId: ctx.brokerageId })", table: "repurpose pipeline rows" },
    reader: { file: "app/api/marketing/content-command/route.ts", token: "route_refurbish:" },
    status: "EXISTING VERIFIED", proof: "SIMULATED", note: "an idea is not refused as inspiration; a synonym swap fails assessOriginality; the model leg is SIMULATED" },
  { family: "Arbitration · delegation", persona: "agent / team_lead (contacts only)", capability: "re-engage a stale contact through the arbiter",
    control: { file: "app/dashboard/stale/actions.ts", token: "const result = await initiateAIISAContactEngagement(contactId)" },
    decision: { file: "app/actions/ai-isa/engage-contact.ts", token: "await arbitrateAndRecordExperience(supabase, {" },
    writer: { file: "lib/kernel/action-ledger.ts", token: "from(\"agent_action_ledger\")", table: "agent_action_ledger" },
    reader: { file: "app/actions/flight-recorder.ts", token: "await svc.from(\"agent_action_ledger\").select(ACTION_COLS)" },
    status: "EXISTING VERIFIED", proof: "SIMULATED", note: "the same arbiter serves the stale-contact cron (ledger 143E-SO-03 closed); speed-to-lead stays time-critical by design" },
  { family: "Marketing bundles · channels", persona: "agent (assigned contact)", capability: "send a campaign bundle to a contact",
    control: { file: "app/crm/contacts/[contactId]/components/campaign-bundle-send-card.tsx", token: "const result = await sendCampaignBundleToContactAction({ bundleId, contactId })" },
    decision: { file: "lib/direct-mail/orchestrate-bundle-send.ts", token: "const { orchestrateSmsPresetSend } = await import(\"@/lib/sms/orchestrate-sms-preset-send\")" },
    writer: { file: "lib/sms/orchestrate-sms-preset-send.ts", token: "const plan = planCampaignTouchpoint({ channel: \"sms\"", table: "campaign touchpoints (attribution only with a verified campaign)" },
    reader: { file: "lib/intelligence/roi-ledger.ts", token: "export async function loadRoiOutcomeLedger(" },
    status: "PARTIAL", proof: "SIMULATED", note: "the contact-card send passes no marketingCampaignId, so its SMS / email touches carry no campaign identity — attribution stays NULL, never guessed (lane 154H2 owns the sender)" },
  { family: "Gamification · Academy", persona: "agent (own points)", capability: "earn points once per real milestone; see the board",
    control: { file: "lib/kernel/event-reactor.ts", token: "const { awardLifecycleMilestones } = await import(\"@/lib/gamification/lifecycle-awards\")" },
    decision: { file: "lib/gamification/lifecycle-awards.ts", token: "const res = await awardAgentPointsOnce(db, {" },
    writer: { file: "lib/gamification/award-points.ts", token: "db.rpc(\"award_agent_points\", {", table: "agent_points_log (+ agents.gamification_points, one RPC)" },
    reader: { file: "app/dashboard/motivation/motivation-client.tsx", token: "const result = await getLeaderboard({" },
    status: "EXISTING VERIFIED", proof: "SIMULATED", note: "the unsafe self-award stays retired; a trusted lifecycle event feeds the one award writer with a once-key" },
  { family: "Shopping Agent · family shares", persona: "buyer Contact (portal, self only) + family collaborator", capability: "share picked homes with family only",
    control: { file: "app/portal/[contactId]/search/ShareWithFamilyCard.tsx", token: "const r = await shareHomesWithFamilyAction({ contactId, listingRefs: picked" },
    decision: { file: "app/actions/collaborative-search.ts", token: "const g = await gateBuyerSelf(input.contactId)" },
    writer: { file: "lib/portal/collaborative-share.ts", token: "svc.from(\"collaborative_search_properties\")", table: "collaborative_searches / collaborative_search_properties" },
    reader: { file: "app/actions/collaborative-search.ts", token: "export async function getSearchProperties(searchId: string)" },
    status: "EXISTING VERIFIED", proof: "SIMULATED", note: "IDX / RentCast results stay LICENSE-HELD / AWAITING KEY; the share itself is first-party" },
  { family: "Listing → Offer → Transaction", persona: "agent / TC (deal party)", capability: "an accepted offer becomes a transaction only through its whole packet",
    control: { file: "lib/transactions/transaction-creation-gate.ts", token: "import { governingOfferPacket, type GoverningOfferPacket } from \"@/lib/offers/governing-terms\"" },
    decision: { file: "lib/offers/governing-terms.ts", token: "const seq = acceptedOfferSequence(chain.rows, offerId)" },
    writer: { file: "lib/kernel/transactions.ts", token: "const { freezeExecutedTermsAfterPromotion } = await import(\"@/lib/offers/governing-terms\")", table: "transactions + contract_term_versions" },
    reader: { file: "lib/transactions/closing-compliance.ts", token: "const { governingContractTerms } = await import(\"@/lib/offers/governing-terms\")" },
    status: "EXISTING VERIFIED", proof: "SIMULATED", note: "the gate reads root → counters → head at document level (ledger 144C-SO-02 re-classified)" },
  { family: "Closing · CDA on/off", persona: "broker_owner / broker_admin", capability: "turn CDA on or off; the closing proof follows it",
    control: { file: "app/dashboard/admin/onboarding/components/os/cda-setup-panel.tsx", token: "const res = await setBrokerageCdaSettingAction({" },
    decision: { file: "app/actions/brokerage-cda-setup.ts", token: "export async function setBrokerageCdaSettingAction(input: {" },
    writer: { file: "app/actions/brokerage-cda-setup.ts", token: "await svc.from(\"brokerages\").update(patch).eq(\"id\", admin.brokerageId).select(\"id\")", table: "brokerages.offers_cda" },
    reader: { file: "app/actions/transactions/closing-proof.ts", token: "await db.from(\"brokerages\").select(\"offers_cda, non_cda_payout_default\")" },
    status: "EXISTING VERIFIED", proof: "SIMULATED", note: "the no-CDA closing proof card reads the brokerage's live mode and the deal's evidence" },
  { family: "Transaction milestones", persona: "agent / TC (deal party)", capability: "inspection / appraisal / financing / closing / CD dates land in the tenant's zone",
    control: { file: "lib/kernel/lifecycle.ts", token: "import { createTransactionMilestoneCalendarEvents } from \"./milestone-calendar-bridge\"" },
    decision: { file: "lib/kernel/milestone-calendar-bridge.ts", token: "return resolveTenantTimeZone({" },
    writer: { file: "lib/kernel/calendar-engine.ts", token: ".from('calendar_events')", table: "calendar_events" },
    reader: { file: "lib/kernel/calendar-deadline-watcher.ts", token: ".from('calendar_events')" },
    status: "FIXED", proof: "SIMULATED", note: "every milestone was stamped at the UTC instant (the settings resolver defaults primary_timezone to 'UTC'); now global_settings.timezone → explicit setting → brokerage state" },
  { family: "Finance · commissions · payout", persona: "broker / broker_owner (BROKERAGE_FINANCE_ADMIN_USER_TYPES)", capability: "pay a commission, or pay ahead of funds with a stated reason",
    control: { file: "app/components/features/financial/PayoutButton.tsx", token: "advanceReason: advanceReason.trim() || null," },
    decision: { file: "lib/kernel/financial.ts", token: "const gate = payoutReleaseGate({" },
    writer: { file: "lib/kernel/financial.ts", token: ".from(\"agent_commissions\")", table: "agent_commissions (+ the payout-advance evidence)" },
    reader: { file: "app/dashboard/financials/payouts/page.tsx", token: "<PayoutButton commissionId={c.id} brokerageId={profile.brokerage_id} />" },
    status: "FIXED", proof: "SIMULATED", note: "the funds gate asked for a reason no control could send; both payout controls now carry it on that refusal" },
  { family: "Legal forms · packet oversight", persona: "agent holding a brokerage-pinned admin grant", capability: "see and manage the brokerage's form library",
    control: { file: "app/dashboard/admin/transaction-forms/transaction-forms-client.tsx", token: "const res = await fetch(\"/api/admin/transaction-forms\")" },
    decision: { file: "lib/forms/tenant-form-packets.ts", token: "const granted = await withTenantRoleGrants(svc," },
    writer: { file: "lib/forms/tenant-form-packets.ts", token: "svc.from(\"brokerage_form_library\")", table: "brokerage_form_library" },
    reader: { file: "app/api/admin/transaction-forms/route.ts", token: "const minted = await issueTenantPacketUrl(auth.svc as never, auth.actor, f, \"manage\")" },
    status: "FIXED", proof: "SIMULATED", note: "the code resolver now honours the grant its SQL twin is_brokerage_admin() honours; links minted per view" },
  { family: "Compliance · required documents", persona: "broker_admin / compliance_officer", capability: "a required-document template link never carries a stored bearer URL",
    control: { file: "app/dashboard/settings/required-documents/page.tsx", token: "{form.storage_path ? (" },
    decision: { file: "app/api/admin/transaction-forms/route.ts", token: "if (!f.storage_path) return f" },
    writer: { file: "lib/forms/tenant-form-packets.ts", token: "svc.from(\"brokerage_form_library\")", table: "brokerage_form_library" },
    reader: { file: "app/dashboard/admin/transaction-forms/page.tsx", token: "(f.storage_path ? { ...f, pdf_url: null } : f)" },
    status: "FIXED", proof: "SIMULATED", note: "the 10-year persisted URLs on OTHER document tables stay open (ledger 146A-SO-02)" },
  { family: "Errors · support tickets", persona: "any tenant seat (own tickets only)", capability: "raise a support ticket and see it",
    control: { file: "app/dashboard/help/help-client.tsx", token: "const r = await createSupportTicket({ subject, description, lane, category" },
    decision: { file: "app/actions/support.ts", token: "if (!isTicketLane(input.lane)) return { ok: false, error: \"A support lane is required\" }" },
    writer: { file: "app/actions/support.ts", token: ".from(\"support_tickets\")", table: "support_tickets" },
    reader: { file: "app/dashboard/help/page.tsx", token: "listMyTickets()," },
    status: "EXISTING VERIFIED", proof: "SIMULATED", note: "tenant isolation is proved by test:support-isolation" },
  { family: "Storage buckets (O1) · portal seeds (O2)", persona: "owner (storage admin)", capability: "private document buckets scoped per owner; portal seeds linked",
    control: { file: "supabase/migrations/m874-document-bucket-path-rules-and-offer-party-reads.sql", token: "storage_bucket_policy_readiness" },
    decision: { file: "supabase/migrations/m874-document-bucket-path-rules-and-offer-party-reads.sql", token: "storage_bucket_policy_readiness" },
    writer: { file: "supabase/migrations/m874-document-bucket-path-rules-and-offer-party-reads.sql", token: "storage_bucket_policy_readiness", table: "storage.objects policies (owner SQL)" },
    reader: { file: "supabase/migrations/m874-document-bucket-path-rules-and-offer-party-reads.sql", token: "storage_bucket_policy_readiness" },
    status: "OWNER-HELD", proof: "LIVE-VERIFIED", note: "read-only live read 2026-11-18: five private buckets read `open` and 4 of 4 contact seats are unlinked — release stays BLOCKED until the owner runs OWNER-SQL §F/§G/§I" },
]

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
const cache = new Map<string, string | null>()
function stripped(file: string): string | null {
  if (cache.has(file)) return cache.get(file)!
  const abs = path.join(ROOT, file)
  const v = existsSync(abs) ? (file.endsWith(".sql") ? readFileSync(abs, "utf8") : stripComments(readFileSync(abs, "utf8"))) : null
  cache.set(file, v)
  return v
}
function lineOf(src: string, token: string): number | null {
  const i = src.indexOf(token)
  return i < 0 ? null : src.slice(0, i).split("\n").length
}
function locate(step: Step, read: (f: string) => string | null = stripped): { ok: boolean; at: string; why?: string } {
  const src = read(step.file)
  if (src === null) return { ok: false, at: step.file, why: "file missing" }
  const ln = lineOf(src, step.token)
  return ln === null ? { ok: false, at: step.file, why: `token not in stripped source: ${step.token}` } : { ok: true, at: `${step.file}:${ln}` }
}
function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir)
  if (!existsSync(abs)) return out
  for (const n of readdirSync(abs)) {
    if (n === "node_modules" || n.startsWith(".") || n === "__tests__") continue
    const rel = path.join(dir, n)
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(rel)
  }
  return out
}

// ── §B the derived rules (each finder is exported so its positive control runs on a fixture) ─────────────────────────
const PAYOUT_ACTION = /\b(markCommissionPaidAction|initiateCommissionPayoutAction)\(\s*\{([\s\S]*?)\}\s*\)/g
/** B1: a client call of a payout action that cannot carry `advanceReason`. */
function payoutCallsWithoutReason(src: string): number {
  let n = 0
  for (const m of src.matchAll(PAYOUT_ACTION)) if (!/\badvanceReason\b/.test(m[2])) n++
  return n
}
/** B2: a zone read off primary_timezone with a bare 'UTC' fallback. */
function utcZoneFallbacks(src: string): number {
  return (src.match(/primary_timezone['"\]]*\)?[^;\n]*\n?[^;\n]*(\?\?|\|\|)\s*['"]UTC['"]/g) ?? []).length
}
/** B3: the packet actor resolver's body, and whether it consults the grant reader. */
function packetResolverGrantAware(src: string): boolean | null {
  const i = src.indexOf("export async function resolvePacketActor(")
  if (i < 0) return null
  const rest = src.slice(i + 10)
  const end = rest.search(/\nexport (async )?function /)
  return /withTenantRoleGrants\(/.test(end < 0 ? rest : rest.slice(0, end))
}
/** B4: a page that links a form-library pdf_url without consulting storage_path. */
function unguardedPdfUrlLinks(src: string): boolean {
  return /brokerage_form_library/.test(src) && /href=\{[^}]*pdf_url/.test(src) && !/storage_path/.test(src)
}

function main(): number {
  const failures: string[] = []
  const ok = (cond: boolean, label: string, detail = "") => { console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) failures.push(label) }

  console.log("§A traced paths (control → decision → writer → reader, stripped source)")
  const rows: Array<TracedPath & { at: Record<string, string> }> = []
  for (const p of PATHS) {
    const at: Record<string, string> = {}
    for (const k of ["control", "decision", "writer", "reader"] as const) {
      const r = locate(p[k])
      at[k] = r.at
      ok(r.ok, `${p.family} · ${k}`, r.ok ? r.at : r.why)
    }
    rows.push({ ...p, at })
  }
  // Positive control: a comment that names the token is NOT a call site (the tombstone lesson, CLAUDE.md §2).
  const fx = new Map([["fx.ts", "// const r = await createSupportTicket({ subject, description, lane, category\nexport const x = 1\n"]])
  ok(!locate({ file: "fx.ts", token: "const r = await createSupportTicket({ subject, description, lane, category" }, (f) => (fx.has(f) ? stripComments(fx.get(f)!) : null)).ok,
    "CONTROL §A: a token inside a comment does not count as the control calling the door")
  const vocab: Status[] = ["EXISTING VERIFIED", "FIXED", "PARTIAL", "OWNER-HELD", "LICENSE-HELD"]
  ok(PATHS.every((p) => vocab.includes(p.status)), "every path carries a truth word from the vocabulary")
  ok(PATHS.every((p) => p.proof === "SIMULATED" || /live read/i.test(p.note)), "LIVE-VERIFIED only where a real read is recorded")

  console.log("§B derived rules")
  const appFiles = walk("app").filter((f) => f.endsWith(".tsx"))
  const payoutCallers = appFiles.filter((f) => /\b(markCommissionPaidAction|initiateCommissionPayoutAction)\(/.test(stripped(f) ?? ""))
  const deadPayout = payoutCallers.filter((f) => payoutCallsWithoutReason(stripped(f) ?? "") > 0)
  ok(payoutCallers.length > 0 && deadPayout.length === 0, `B1 every payout control passes advanceReason (${payoutCallers.length} control file(s) derived)`, deadPayout.join(", "))
  ok(payoutCallsWithoutReason("await markCommissionPaidAction({ commissionId, brokerageId, paidAt, method })") === 1, "CONTROL B1: the base PayoutButton call is flagged")

  const zoneFiles = [...walk("lib"), ...walk("app")].filter((f) => f !== "lib/brokerage/get-brokerage-settings.ts" && /primary_timezone/.test(stripped(f) ?? ""))
  const utc = zoneFiles.filter((f) => utcZoneFallbacks(stripped(f) ?? "") > 0)
  ok(utc.length === 0, `B2 no primary_timezone → 'UTC' fallback outside the settings resolver (${zoneFiles.length} reader file(s) derived)`, utc.join(", "))
  ok(utcZoneFallbacks("const timezone: string =\n    ((settings as unknown) as Record<string, unknown>)['primary_timezone'] as string | undefined\n    ?? 'UTC'") === 1, "CONTROL B2: the base milestone-bridge read is flagged")
  ok(/resolveTenantTimeZone\(/.test(stripped("lib/kernel/milestone-calendar-bridge.ts") ?? ""), "B2 the milestone bridge resolves through resolveTenantTimeZone")

  ok(packetResolverGrantAware(stripped("lib/forms/tenant-form-packets.ts") ?? "") === true, "B3 resolvePacketActor consults the grant reader")
  ok(packetResolverGrantAware("export async function resolvePacketActor(svc, userId) {\n  return { oversight: PACKET_OVERSIGHT_USER_TYPES.has(t) }\n}\nexport function next() {}") === false, "CONTROL B3: a seat-only resolver is flagged")

  const pdfPages = appFiles.filter((f) => /brokerage_form_library/.test(stripped(f) ?? "") && /pdf_url/.test(stripped(f) ?? ""))
  const unguarded = pdfPages.filter((f) => unguardedPdfUrlLinks(stripped(f) ?? ""))
  ok(unguarded.length === 0, `B4 every form-library page that links pdf_url guards storage_path (${pdfPages.length} page(s) derived)`, unguarded.join(", "))
  ok(unguardedPdfUrlLinks(`.from("brokerage_form_library").select("id, pdf_url")\n<a href={form.pdf_url as string}>x</a>`), "CONTROL B4: the base required-documents link is flagged")

  if (process.argv.includes("--write")) {
    const md = [
      "<!-- GENERATED by `npx tsx scripts/product-surface-audit-guard.ts --write` (wave 154, lane 154K). Do not hand-edit: line numbers are derived from stripped source on every run. -->",
      "# Wave 154 — product surface audit (K1)",
      "",
      "One realistic path per capability family: the control a person (or a cron / event) uses → the canonical decision → the real writer → the reader that shows the outcome. Personas are the existing user types and scope rules (CLAUDE.md §4). Every row is SIMULATED unless it says a real read exists; no provider was called. The guard (`npm run -s test:product-surface-audit`) fails when any link below stops being true in stripped source.",
      "",
      "| family | persona / structure | capability | control | decision | writer (table) | reader | status | proof | note |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.family} | ${r.persona} | ${r.capability} | \`${r.at.control}\` | \`${r.at.decision}\` | \`${r.at.writer}\` (${r.writer.table}) | \`${r.at.reader}\` | ${r.status} | ${r.proof} | ${r.note.replace(/\|/g, "\\|")} |`),
      "",
      "Blind spots: a token present is not a click that works (no browser runs); one path per family, not every door; provider legs are OWNER-HELD / LICENSE-HELD.",
      "",
    ].join("\n")
    writeFileSync(path.join(ROOT, DOC), md)
    console.log(`  → ${DOC}`)
  }
  console.log(`PRODUCT-SURFACE-AUDIT: ${PATHS.length} paths, ${failures.length} failure(s)`)
  return failures.length ? 1 : 0
}

if (/product-surface-audit-guard\.ts$/.test(process.argv[1] ?? "")) process.exitCode = main()
