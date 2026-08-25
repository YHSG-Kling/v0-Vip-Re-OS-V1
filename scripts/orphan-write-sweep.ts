#!/usr/bin/env tsx
/**
 * scripts/orphan-write-sweep.ts  (PASS 17)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "WRITE-ONLY LEDGER" SWEEP — the mirror of pass 16 (writer-less reads,
 * burned to zero). This finds the OTHER open-loop class: tables the code
 * WRITES but nothing ever READS — AI outputs, receipts, and ledgers that cost
 * compute/storage and inform nobody (contract_reviews, meeting_briefs,
 * fair_housing_logs were all this class). A write nothing consumes is either
 * a missing surface (build the reader) or waste (repoint/delete the write).
 *
 * Report-only with a committed baseline: NEW write-only tables fail CI; the
 * existing list is a burn-down (each entry needs a verdict — build the
 * reader, repoint the write to the canonical twin, or delete the dead write).
 * Audit-trail tables that are intentionally write-heavy get an AUDIT_EXEMPT
 * entry naming who consumes them out-of-band (compliance export, retention).
 *
 * Run: npx tsx scripts/orphan-write-sweep.ts  (npm run test:orphan-writes)
 * Tighten: GUARD_WRITE_BASELINE=1 npx tsx scripts/orphan-write-sweep.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { join } from "node:path"

const BASELINE = join(process.cwd(), "scripts/orphan-write-baseline.json")

/** Intentionally write-heavy audit/forensic ledgers — each names its
 *  out-of-band consumer so the exemption stays auditable. (Round-11 batch:
 *  every entry below carries the verdict from the full 44-table review.) */
const AUDIT_EXEMPT: Record<string, string> = {
  superadmin_audit_log: "app/dashboard/superadmin/audit (platform-action viewer)",
  lifecycle_events: "kernel event spine — consumed by processKernelEvent subscribers",
  tenant_transition_log: "forensic boundary-crossing ledger (compliance export)",
  audit_logs: "compliance export + retention",
  security_audit_log: "compliance export + retention",
  // ── Telemetry / debugging ledgers ──
  agent_assistant_tool_calls: "assistant tool-call telemetry (debugging/analytics)",
  ai_usage_log: "LLM token/cost record — billing & cost reconciliation export",
  automation_logs: "automation-execution forensics (debugging)",
  event_processing_log: "orchestrator event replay/debugging ledger",
  workflow_webhook_events: "inbound webhook receipt — replay/debugging",
  video_render_log: "video-ops render telemetry (cost monitoring)",
  photo_enhancement_jobs: "enhancement job telemetry (status updated inline, same call)",
  onboarding_ai_chats: "onboarding assistant transcript (support/debugging)",
  // ── Compliance / legal proof ledgers ──
  document_audit_trail: "document access/change events — compliance export + retention",
  phone_number_events: "telephony provisioning lifecycle — carrier/A2P compliance audit",
  platform_tos_acceptances: "ToS consent record — legal proof-of-acceptance export",
  license_verifications: "license-check results — regulatory compliance proof",
  reg_change_observations: "regulatory watcher ledger (self-consumed for dedup/escalation)",
  notification_log: "delivery forensics for sent notifications (distinct from live notifications)",
  cost_breakdown_tracking: "per-transaction cost lines — brokerage P&L reconciliation",
  showing_communications: "showing-comms delivery ledger (forensic)",
  mentor_sessions: "mentorship check-in record (coaching history)",
  newsletter_seo_scores: "SEO score history (score served inline to the caller)",
  smart_landing_sessions: "raw landing-session events — aggregates read via listing_page_analytics",
  vendor_communications: "vendor email delivery ledger — rows written ONLY after a real dispatchEmail success",
  // ── Lead-intelligence enrichment provenance (derived score lands on the contact) ──
  lead_osint_data: "OSINT enrichment provenance (feeds contact fields)",
  google_search_activity: "SERP-presence signal provenance",
  google_search_intelligence: "parsed search-intel provenance",
  nextdoor_activity: "Nextdoor mention provenance",
  external_behavior: "external behavioral-event provenance",
  intelligent_outreach_log: "AI outreach decision log (provenance)",
  intelligence_signals_log: "aggregated intel-signal provenance (derived score drives decisions)",
}

/** Tables read through Postgres RPCs the .from() scanner can't see —
 *  table → the rpc name that reads it (verified in code). */
const RPC_READERS: Record<string, string> = {
  contact_memory: "contact_memory_recall", // lib/agents/contact-memory.ts recallContactMemory
}

// TOMBSTONE (orphan doctrine §1.1) — the private `walk(dir, acc)` that stood here
// was one of 82 copies of the same readdirSync walker. Survivor:
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// This sweep decides whether a column is WRITTEN WITH NO READER. A file it cannot
// open makes a real reader invisible, so the finding is a false accusation — and
// `proxy.ts`, the edge middleware, reads four tables on every request while being
// outside the corpus, because `walk()` enumerated DIRECTORIES and a root FILE is
// not a directory. `rootRuntimeFiles()` from the same survivor supplies them.

function main() {
  const files: string[] = [
    ...walkTs(join(process.cwd(), "app")),
    ...walkTs(join(process.cwd(), "lib")),
    ...rootRuntimeFiles(process.cwd()),
  ]

  const writers = new Map<string, Set<string>>()
  const readers = new Set<string>()
  const FROM = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g
  // Nested-embed reads: `tbl(...)` or `alias:tbl(...)` inside a .select string.
  const SELECT_EMBED = /\.select\(\s*[`"']([\s\S]{0,600}?)[`"']\s*[,)]/g
  const EMBED_TABLE = /(?:^|[,\s(])(?:[a-z_][a-z0-9_]*:)?([a-z_][a-z0-9_]*)\s*(?:!\w+)?\(/g

  for (const f of files) {
    const s = readFileSync(f, "utf8")
    let m: RegExpExecArray | null
    while ((m = FROM.exec(s))) {
      const table = m[1]
      // 400-char read window: long multi-line .select("...") strings pushed the
      // verb past the old 160 cap and produced false write-only flags
      // (credit_partner_referrals) — widened round 11.
      const window = s.slice(m.index, m.index + m[0].length + 400)
      if (/\.(insert|upsert|update|delete)\s*\(/.test(window)) {
        const set = writers.get(table) ?? new Set<string>()
        set.add(f.replace(process.cwd() + "/", ""))
        writers.set(table, set)
      }
      if (/\.select\s*\(/.test(window)) readers.add(table)
    }
    // RPC reads (pgvector recall etc.) are invisible to the .from() scan.
    for (const [table, rpc] of Object.entries(RPC_READERS)) {
      if (s.includes(`.rpc("${rpc}"`) || s.includes(`.rpc('${rpc}'`)) readers.add(table)
    }
    // Embedded reads count as reads of the embedded table.
    let sm: RegExpExecArray | null
    while ((sm = SELECT_EMBED.exec(s))) {
      let em: RegExpExecArray | null
      while ((em = EMBED_TABLE.exec(sm[1]))) readers.add(em[1])
    }
  }

  const offenders = [...writers.keys()]
    .filter((t) => !readers.has(t) && !(t in AUDIT_EXEMPT))
    .sort()

  if (process.env.GUARD_WRITE_BASELINE === "1") {
    writeFileSync(BASELINE, JSON.stringify(offenders, null, 2) + "\n")
    console.log(`⚙ wrote baseline: ${offenders.length} write-only tables (burn-down list)`)
  }
  const baseline = new Set<string>(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : [])
  const fresh = offenders.filter((t) => !baseline.has(t))
  const fixed = [...baseline].filter((t) => !offenders.includes(t))

  console.log("══════════════════════════════════════════════════")
  console.log(" PASS 17 — write-only ledger sweep (outputs nothing consumes)")
  console.log("══════════════════════════════════════════════════")
  console.log(` ${writers.size} written tables · ${readers.size} read tables`)
  console.log(` write-only tables: ${offenders.length} (baseline ${baseline.size}, burn-down)`)
  for (const t of offenders.slice(0, 100)) {
    const mark = baseline.has(t) ? "·" : "✗ NEW"
    console.log(`  ${mark} ${t} ← ${[...(writers.get(t) ?? [])].slice(0, 2).join(", ")}`)
  }
  if (fixed.length > 0) console.log(` ↘ ${fixed.length} baseline entries now have readers — tighten with GUARD_WRITE_BASELINE=1`)
  if (fresh.length > 0) {
    console.log(` ✗ ${fresh.length} NEW write-only table(s): ${fresh.join(", ")}`)
    console.log("   Give each a verdict: build the reader, repoint the write, or delete the dead write.")
    process.exit(1)
  }
  console.log(" ✅ no NEW write-only tables")
}

main()
