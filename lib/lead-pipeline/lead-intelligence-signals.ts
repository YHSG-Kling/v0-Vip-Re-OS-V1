// lib/lead-pipeline/lead-intelligence-signals.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE READER FOR intelligence_signals_log AND intelligent_outreach_log.
//
// Both tables had a writer — app/actions/lead-intelligence.ts (the high-intent
// provenance ledger at :264/:2125 and the value-first outreach log at :2308) —
// and NO reader anywhere in the tree (scripts/readerless-write-baseline.json,
// wave 64). Per CLAUDE.md §1 ("no duplicate → BUILD the missing half"), this is
// the reader.
//
//   intelligence_signals_log — WHY the ISA/system flagged this contact: what
//     kind of signal fired (high-intent behavioral, AI unified-profile
//     provenance…), how strong, and when. This is provenance, not a score —
//     it explains a score another table already carries.
//   intelligent_outreach_log — WHAT the platform already sent this contact
//     as value-first outreach, so a lead-desk reader can see whether a nudge
//     already went out before sending another one.
//
// TENANCY (CLAUDE.md §4): both tables carry brokerage_id (nullable on the live
// column, but every writer above stamps it), so every read here is scoped by
// BOTH contact_id and brokerage_id explicitly — a service-client read has no
// RLS to fall back on.
//
// SURFACE: BROKERAGE LEAD-DESK ONLY (LEAD_DESK_USER_TYPES,
// lib/auth/lead-visibility.ts). Never an agent-facing surface — agents see
// CONTACTS, not the raw intelligence ledger (CLAUDE.md §5). The one caller
// today is app/leads/[leadId]/page.tsx, which already gates the whole page on
// resolveLeadVisibility + leadRowInScope before this ever runs.
import type { SupabaseClient } from "@supabase/supabase-js"

export interface IntelligenceSignalRow {
  id: string
  signal_type: string | null
  signal_strength: number | null
  signal_data_json: Record<string, unknown> | null
  detected_at: string | null
  lead_profile_id: string | null
}

export interface OutreachLogRow {
  id: string
  outreach_type: string | null
  channel: string | null
  content: string | null
  // NOT `result` — that column has NO WRITER anywhere in the tree (verified
  // 2026-09-15; app/actions/lead-intelligence.ts:2308's insert never sets it).
  // Reading it here would create a NEW one-sided pair (opposite-missing 1b)
  // instead of closing the one this reader exists to close — CLAUDE.md §1
  // forbids inventing a writer just to justify a read. Left for the lane that
  // decides what marks outreach delivered/opened/failed.
  created_at: string | null
}

export interface LeadIntelligenceSignals {
  signals: IntelligenceSignalRow[]
  outreach: OutreachLogRow[]
  /** Honest error surfaces — a refused read must never render as "nothing happened yet". */
  signalsError: string | null
  outreachError: string | null
}

const EMPTY: LeadIntelligenceSignals = { signals: [], outreach: [], signalsError: null, outreachError: null }

/**
 * Fetch a contact's provenance signals + prior value-first outreach, tenant-
 * scoped. Returns the honest EMPTY shape (never throws) when contactId is
 * absent — a raw/pre-conversion lead has no contact row yet, and that is not
 * an error condition for this reader.
 */
export async function getLeadIntelligenceSignals(
  supabase: SupabaseClient<any, any, any>,
  params: { contactId: string | null; brokerageId: string | null; limit?: number },
): Promise<LeadIntelligenceSignals> {
  const { contactId, brokerageId, limit = 25 } = params
  if (!contactId || !brokerageId) return EMPTY

  const [signalsRes, outreachRes] = await Promise.all([
    supabase
      .from("intelligence_signals_log")
      .select("id, signal_type, signal_strength, signal_data_json, detected_at, lead_profile_id")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .order("detected_at", { ascending: false })
      .limit(limit),
    supabase
      .from("intelligent_outreach_log")
      .select("id, outreach_type, channel, content, created_at")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(limit),
  ])

  // supabase-js RESOLVES a refusal (CLAUDE.md §3) — read BOTH errors, and never
  // let a refused read collapse into a silent empty list.
  return {
    signals: (signalsRes.data as IntelligenceSignalRow[] | null) ?? [],
    outreach: (outreachRes.data as OutreachLogRow[] | null) ?? [],
    signalsError: signalsRes.error?.message ?? null,
    outreachError: outreachRes.error?.message ?? null,
  }
}
