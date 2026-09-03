

import { createServiceClient } from "@/lib/supabase/service"
import { currentUsagePeriod } from "@/lib/usage/period"
import type { CapMetric } from "@/lib/usage/check-cap"

export interface UsageLimit {
  withinLimit: boolean
  used: number
  limit: number
  percentage: number
  metric: string
}

/**
 * Increments usage counter for a given metric and brokerage
 * Upserts into the current billing period (month-based)
 */
export async function incrementUsage(brokerageId: string, metric: string, amount = 1): Promise<void> {
  // SERVICE CLIENT, like the other usage_counters writer (log-media-usage).
  // Every usage_counters policy is TO authenticated; on the anonymous AI lanes
  // (widget visitor, D-ID avatar turn — #187) the cookie client is the anon
  // role, so the increment was refused, the refusal swallowed below, and the
  // spend never reached the ai_tokens_monthly counter the cap reads.
  const supabase = createServiceClient()

  // ONE period vocabulary (#190). This function used to compute LOCAL month
  // boundaries with an INCLUSIVE end while every reader — including the
  // v_brokerage_ai_quota view that gates AI spend — keyed on the UTC/EXCLUSIVE
  // convention. period_end is part of the UNIQUE key, so the quota join could
  // NEVER match a row this wrote: AI usage metered to a row nothing read.
  const { periodStartIso, periodEndIso } = currentUsagePeriod()

  // Read-then-write raced under concurrency (two requests both see "missing",
  // one insert loses). The UNIQUE(brokerage_id, period_start, period_end,
  // metric) key makes the read half of the old dance unnecessary for the
  // insert case; the increment still needs the current value, so keep the read
  // but let a conflicting insert fall through to an update instead of erroring.
  const { data: existing, error: fetchError } = await supabase
    .from("usage_counters")
    .select("id, value")
    .eq("brokerage_id", brokerageId)
    .eq("metric", metric)
    .eq("period_start", periodStartIso)
    .maybeSingle()
  if (fetchError) {
    console.error("[usage] counter read refused — this call will NOT be metered:", fetchError.message)
    return
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("usage_counters")
      .update({ value: existing.value + amount })
      .eq("id", existing.id)
    if (updateError) console.error("[usage] counter update refused — not metered:", updateError.message)
    return
  }

  const { error: insertError } = await supabase.from("usage_counters").insert({
    brokerage_id: brokerageId,
    metric,
    value: amount,
    period_start: periodStartIso,
    period_end: periodEndIso,
  })
  if (!insertError) return
  // Lost the insert race: another request created the row between our read and
  // write. Fold this increment into it rather than dropping the count.
  if (insertError.code === "23505") {
    const { data: winner } = await supabase
      .from("usage_counters")
      .select("id, value")
      .eq("brokerage_id", brokerageId)
      .eq("metric", metric)
      .eq("period_start", periodStartIso)
      .maybeSingle()
    if (winner) {
      const { error: e2 } = await supabase
        .from("usage_counters").update({ value: winner.value + amount }).eq("id", winner.id)
      if (e2) console.error("[usage] post-race update refused — not metered:", e2.message)
      return
    }
  }
  console.error("[usage] counter insert refused — this call was NOT metered:", insertError.message)
}

/**
 * Checks if a brokerage is within limits for a given metric.
 *
 * ─── ADAPTER OVER THE SURVIVOR, NOT A SECOND CAP READER (§1 merge, wave 26) ──
 *
 * SURVIVOR: lib/usage/check-cap.ts:49 `checkUsageCap`. This function used to
 * carry its OWN copy of the tier → plan_limits → usage_counters walk, and that
 * copy was worse than the survivor on four measured axes:
 *
 *   1. WRONG CLIENT. It read on the COOKIE client (the awaited server helper).
 *      Worded WITHOUT the literal call token on purpose:
 *      scripts/stream-routing-simulator.ts:192 slices this file UP TO the
 *      `checkLimit` declaration — so this comment sits inside that window — and
 *      counts that token with `codeHits`, which blanks STRINGS but not
 *      COMMENTS. Spelling it here would make prose count as code and fail a
 *      guard that is in fact satisfied (CLAUDE.md §2, a tombstone is not a
 *      call site).
 *      Every usage_counters policy is TO authenticated, so on the anonymous AI
 *      lanes (widget visitor, D-ID avatar turn) it was the anon role and the
 *      read was refused. `incrementUsage` above was moved to the service client
 *      for exactly this reason (see its comment at the top of this file); the
 *      cap half never followed, so the writer and the reader disagreed about
 *      who could see the row.
 *   2. IT SELECTED soft_limit_threshold AND THREW IT AWAY, so "approaching your
 *      limit" was unrepresentable here. The survivor honours it
 *      (check-cap.ts:87,105,118). The tombstone below already recorded this.
 *   3. NO PRE-FLIGHT. It could only answer "already over", never "would this
 *      call cross the cap" — the survivor's `addQuantity`.
 *   4. IT FAILED CLOSED on an unreadable brokerage (withinLimit:false) against
 *      the survivor's stated ruling ("usage caps are advisory, never the path
 *      that takes a customer down", check-cap.ts:17-19). Two opposite answers
 *      to one question is the §6 defect, and the survivor owns the ruling.
 *
 * THE SHELL STAYS EXPORTED ON PURPOSE. scripts/stream-routing-simulator.ts:192
 * slices this file between `incrementUsage` and `checkLimit` to prove
 * incrementUsage writes on the service client. Removing the declaration would
 * silently blank that proof's window and turn a passing guard vacuous
 * (CLAUDE.md §2). So the duplicate LOGIC is gone; the name is the anchor.
 *
 * TYPE NOTE, stated rather than cast away: this signature takes `metric: string`
 * while the survivor takes the closed `CapMetric` union. The widening is safe at
 * runtime — an unknown (tier, metric) pair has no plan_limits row and the
 * survivor returns UNLIMITED (check-cap.ts:81-84) — but it is a real widening
 * and not a proof that every string is a metric.
 */
export async function checkLimit(brokerageId: string, metric: string): Promise<UsageLimit> {
  // DYNAMIC on purpose: lib/usage/check-cap.ts is `import "server-only"`, and
  // this module is reachable (via services/supabaseService.ts and the shared
  // constants/types barrels) from graphs that are not provably server-only. A
  // static import would put server-only into that graph; the type import above
  // is erased at compile time and costs nothing. Same idiom the hub uses to
  // reach incrementUsage.
  const { checkUsageCap } = await import("@/lib/usage/check-cap")
  const cap = await checkUsageCap({ brokerageId, metric: metric as CapMetric })
  return {
    withinLimit: cap.allowed,
    used: cap.used,
    limit: cap.limit,
    percentage: cap.percent,
    metric,
  }
}

// ─── TOMBSTONES (orphan burn-down, lane E) ───────────────────────────────────
//
// `getAllUsageMetrics(brokerageId)` DELETED.
//   SURVIVOR: app/actions/usage-overview.ts:63 `loadUsageOverview`, which serves
//   /dashboard/settings/usage and is strictly more complete on every axis:
//     · It derives the metric list FROM plan_limits instead of a hard-coded
//       array. That array named EIGHT metrics; plan_limits carries EIGHTEEN on
//       the live database, so the deleted function could never report
//       ai_tokens_monthly (the one metric with live counter rows), ai_voice_minutes,
//       live_avatar_*, live_assistant_*, tts_characters, voice_clones_created or
//       avatars_created — the whole AI/voice half of what a tenant is billed for.
//     · It HONOURS plan_limits.soft_limit_threshold. checkLimit below used to
//       SELECT that column and throw it away, so "approaching your limit" was
//       unrepresentable; the survivor turns it into status warning/exceeded.
//       (checkLimit now delegates to lib/usage/check-cap.ts, which honours it
//       too — see the note on that function.)
//     · It resolves the tenant through resolveWriteContext() and gates on
//       isAdminOrBroker, rather than trusting a brokerageId argument.
//   MERGED BEFORE DELETING: the one thing this file held that the survivor
//   lacked — reads keyed on period_start ALONE, never period_end (see
//   lib/usage/period.ts). That is now carried at
//   app/actions/usage-overview.ts:88, and the cap survivor holds the same rule
//   at lib/usage/check-cap.ts:93-101.
//
// `getBrokeragePlan(brokerageId)` DELETED.
//   SURVIVORS, one per half of what it returned:
//     · plan_tier → lib/billing/plan-tier.ts:51 `resolvePlanTier`, THE tier
//       reader. It normalises through toPlanTier so an unknown/missing value
//       falls to the TIGHTEST tier (FALLBACK_TIER) instead of being handed to
//       the caller raw — this function returned an untyped row, so a tenant with
//       a NULL plan_tier reached callers as `null` and each one guessed.
//     · billing_metadata → parsed by the ONE seat-override reader,
//       app/actions/superadmin/tenant-entitlements.ts:305 `parseSeatOverride`
//       (also used at app/dashboard/settings/page.tsx:147). Handing the raw jsonb
//       out invited a second parser.
//   Nothing merged: the deleted function performed no validation of either half.
//
// `checkLimit`'s DUPLICATE BODY DELETED (wave 26). The name is still exported
//   and still declared here; only the second copy of the cap walk is gone.
//   SURVIVOR: lib/usage/check-cap.ts:49 `checkUsageCap` — four measured
//   advantages, listed in full on checkLimit itself above. checkLimit is now a
//   thin adapter onto it.
//   THE DECLARATION STAYS because scripts/stream-routing-simulator.ts:192
//   slices this file between `incrementUsage` and `checkLimit` to prove
//   incrementUsage writes on the service client — removing the name would
//   silently blank that proof's window and turn a passing guard into a vacuous
//   one (CLAUDE.md §2). The proof needs the anchor, not the duplicate logic.
