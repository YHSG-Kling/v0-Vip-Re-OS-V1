// lib/kernel/week-in-review.ts
// ─────────────────────────────────────────────────────────────────────────────
// VOICE WEEK-IN-REVIEW — the voice admin's OUTBOUND direction. The admin takes
// commands; this is it reporting BACK: a Monday spoken brief per agent built
// from the SAME persisted Income Truth the email digest uses (income_forecast_
// gap_analysis + income_gap_recommended_actions — read, never recomputed), then
// closing the loop with a gated "want me to start on this?" proposal so the
// brief turns into DELEGATION, not just reporting. Audio is honest: ElevenLabs
// creds-gated (no key → text-only notification, never a fake link); the top
// action lands on the agent_client_messages rail (audience 'agent', rationale
// [WEEKLY_REVIEW] [isoWeek] dedupe — the equity-trigger pattern) so NOTHING
// auto-sends. Rides the cron dispatcher Mondays after the digest persists.

export interface WeekReviewNumbers {
  firstName: string | null
  ytdGciCents: number | null
  annualGoalCents: number | null
  projectedYearEndCents: number | null
  gapToGoalCents: number | null
  weighted30Cents: number | null
  actions: Array<{ title: string; description: string | null; impactCents: number | null }>
  /** Optional call-intelligence paragraph (lib/kernel/call-intelligence) — "" when no calls. */
  callIntelBrief?: string
  /** Optional voice-lane work report (what the AI DID on the phones) — "" on a silent week. */
  voiceActivityBrief?: string
  /** Optional draft-flywheel line (adoption + edit rate) — "" when nothing drafted. */
  draftQualityBrief?: string
  /** Optional self-heal line (repairs + open exceptions for brokers) — "" on a quiet week. */
  selfHealBrief?: string
}

const dollars = (cents: number | null | undefined): string =>
  cents == null ? "unknown" : `$${Math.round(cents / 100).toLocaleString("en-US")}`

/** PURE: the spoken script — plain sentences, honest numbers (unknowns said
 *  plainly, never invented), top 3 actions, delegation close. */
export function composeWeekInReviewScript(n: WeekReviewNumbers): string {
  const hello = n.firstName ? `Good morning, ${n.firstName}.` : "Good morning."
  const lines: string[] = [hello, "Here's your week in review from your AI team."]

  if (n.ytdGciCents != null && n.annualGoalCents != null) {
    lines.push(`You're at ${dollars(n.ytdGciCents)} of your ${dollars(n.annualGoalCents)} goal this year.`)
    if (n.projectedYearEndCents != null) {
      const gap = n.gapToGoalCents ?? 0
      lines.push(gap > 0
        ? `On the current pace you'd finish near ${dollars(n.projectedYearEndCents)} — about ${dollars(gap)} short, so this week matters.`
        : `On the current pace you'd finish near ${dollars(n.projectedYearEndCents)} — ahead of goal. Keep the foot down.`)
    }
  } else {
    lines.push("You haven't set an annual income goal yet — set one in Income Truth and I can coach against it.")
  }
  if (n.weighted30Cents != null && n.weighted30Cents > 0) {
    lines.push(`Your weighted thirty-day pipeline is ${dollars(n.weighted30Cents)}.`)
  }

  if (n.voiceActivityBrief) lines.push(n.voiceActivityBrief)
  if (n.callIntelBrief) lines.push(n.callIntelBrief)
  if (n.draftQualityBrief) lines.push(n.draftQualityBrief)
  if (n.selfHealBrief) lines.push(n.selfHealBrief)

  const top = n.actions.slice(0, 3)
  if (top.length > 0) {
    lines.push(top.length === 1 ? "One move stands out this week:" : `Top ${top.length} moves this week:`)
    top.forEach((a, i) => {
      const impact = a.impactCents != null && a.impactCents > 0 ? ` — worth roughly ${dollars(a.impactCents)}` : ""
      lines.push(`${i + 1}. ${a.title}${impact}.`)
    })
    lines.push("I've queued the first one as a proposal — approve it in your command center and the team starts on it.")
  } else {
    lines.push("No stacked-up moves this week — your pipeline actions are clear.")
  }
  return lines.join(" ")
}

/** PURE: the [WEEKLY_REVIEW] rationale tag — the per-agent-per-ISO-week dedupe key. */
export function weekReviewTag(agentId: string, isoWeek: string): string {
  return `[WEEKLY_REVIEW] [${agentId}] [${isoWeek}]`
}

export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

export interface WeekReviewResult { agents: number; briefed: number; audioRendered: number; proposalsQueued: number; skipped: number; errors: number }

/** Monday runner: per active agent — read persisted Income Truth → script →
 *  creds-gated TTS → notification → ONE gated proposal (deduped per ISO week). */
export async function runWeekInReview(svc: any, now: Date = new Date()): Promise<WeekReviewResult> {
  const r: WeekReviewResult = { agents: 0, briefed: 0, audioRendered: 0, proposalsQueued: 0, skipped: 0, errors: 0 }
  const isoWeek = isoWeekOf(now)

  const { data: agents } = await svc.from("agents")
    .select("id, user_id, brokerage_id, is_active, user:users!inner(first_name, user_type)")
    .eq("is_active", true).limit(5000)

  // Self-heal facts once per brokerage (the loop below reuses them): the
  // week's repair count for everyone, open exceptions for broker voices only.
  const selfHealByBrokerage = new Map<string, { healed: number; openExceptions: number }>()

  for (const a of (agents ?? []) as any[]) {
    r.agents += 1
    try {
      if (!a.user_id || !a.brokerage_id) { r.skipped += 1; continue }
      const u = Array.isArray(a.user) ? a.user[0] : a.user

      // READ the persisted Income Truth (the digest cron computes it an hour before).
      const { data: gap } = await svc.from("income_forecast_gap_analysis")
        .select("id, ytd_gci_cents, annual_goal_cents, projected_year_end_cents, gap_to_goal_cents, weighted_30_cents")
        .eq("agent_id", a.id).order("computed_at", { ascending: false }).limit(1).maybeSingle()
      if (!gap) { r.skipped += 1; continue }
      const { data: actions } = await svc.from("income_gap_recommended_actions")
        .select("action_title, action_description, estimated_gci_impact_cents, action_rank")
        .eq("gap_analysis_id", (gap as any).id).order("action_rank", { ascending: true }).limit(5)

      // Call intelligence — what the AI heard on this agent's calls this week
      // (objections, urgency, sentiment) + what it DID on the phones (answered,
      // booked, voicemails, opt-outs honored). Best-effort; "" when silent.
      let callIntelBrief = ""
      let voiceActivityBrief = ""
      let draftQualityBrief = ""
      try {
        const { loadCallIntelligence, composeCallIntelBrief, loadVoiceActivity, composeVoiceActivityBrief } = await import("@/lib/kernel/call-intelligence")
        const { loadDraftQuality, composeDraftQualityBrief } = await import("@/lib/kernel/draft-quality")
        const [intel, activity, drafts] = await Promise.all([
          loadCallIntelligence(svc, a.brokerage_id, a.user_id),
          loadVoiceActivity(svc, a.brokerage_id, a.user_id),
          loadDraftQuality(svc, a.brokerage_id, a.user_id),
        ])
        callIntelBrief = composeCallIntelBrief(intel)
        voiceActivityBrief = composeVoiceActivityBrief(activity)
        draftQualityBrief = composeDraftQualityBrief(drafts)
      } catch { /* the income brief still lands */ }

      // Self-heal line — the voice admin reports the OS's own maintenance.
      // Repairs for everyone; open exceptions spoken only to broker voices.
      let selfHealBrief = ""
      try {
        let facts = selfHealByBrokerage.get(a.brokerage_id)
        if (!facts) {
          const { loadSelfHealRollup } = await import("@/lib/kernel/self-heal-ledger")
          const { composeExceptionCenter } = await import("@/lib/kernel/exception-center")
          const rollup = await loadSelfHealRollup(svc, a.brokerage_id)
          const { data: ledger } = await svc.from("self_heal_events")
            .select("id, subject, action, outcome, detail, created_at")
            .eq("domain", "data_flow").eq("brokerage_id", a.brokerage_id)
            .gte("created_at", new Date(now.getTime() - 30 * 86_400_000).toISOString())
            .order("created_at", { ascending: true }).limit(1000)
          const fold = composeExceptionCenter(((ledger ?? []) as any[]).map((r) => ({
            id: r.id, subject: r.subject, action: r.action ?? null, outcome: r.outcome,
            detail: (r.detail as any) ?? null, createdAt: r.created_at,
          })))
          facts = { healed: rollup.healed, openExceptions: fold.open.length }
          selfHealByBrokerage.set(a.brokerage_id, facts)
        }
        const { composeSelfHealBrief } = await import("@/lib/kernel/repair-digest")
        const isBrokerVoice = ["broker", "broker_admin", "admin"].includes(String(u?.user_type ?? ""))
        selfHealBrief = composeSelfHealBrief({ healed: facts.healed, openExceptions: facts.openExceptions, isBrokerVoice })
      } catch { /* the income brief still lands */ }

      const script = composeWeekInReviewScript({
        firstName: u?.first_name ?? null,
        ytdGciCents: (gap as any).ytd_gci_cents,
        annualGoalCents: (gap as any).annual_goal_cents,
        projectedYearEndCents: (gap as any).projected_year_end_cents,
        gapToGoalCents: (gap as any).gap_to_goal_cents,
        weighted30Cents: (gap as any).weighted_30_cents,
        actions: ((actions ?? []) as any[]).map((x) => ({ title: x.action_title, description: x.action_description, impactCents: x.estimated_gci_impact_cents })),
        callIntelBrief,
        voiceActivityBrief,
        draftQualityBrief,
        selfHealBrief,
      })

      // Idempotency: one brief per agent per ISO week (notification as the key).
      const { data: already } = await svc.from("notifications").select("id")
        .eq("user_id", a.user_id).eq("type", "week_in_review")
        .ilike("body", `%[${isoWeek}]%`).limit(1).maybeSingle()
      if (already) { r.skipped += 1; continue }

      // Audio — honest creds gate: no ELEVENLABS_API_KEY → text-only brief.
      let audioUrl: string | null = null
      if (process.env.ELEVENLABS_API_KEY) {
        try {
          const { synthesizeSpeech } = await import("@/lib/voice/elevenlabs-tts")
          const tts = await synthesizeSpeech({ text: script, brokerageId: a.brokerage_id })
          if (tts.success && tts.audioBuffer) {
            const path = `tts/${a.brokerage_id}/week-review-${a.id}-${isoWeek}.mp3`
            const { error: upErr } = await svc.storage.from("video-assets")
              .upload(path, tts.audioBuffer, { contentType: "audio/mpeg", upsert: true })
            if (!upErr) {
              const { data: pub } = svc.storage.from("video-assets").getPublicUrl(path)
              audioUrl = pub?.publicUrl ?? null
              if (audioUrl) r.audioRendered += 1
            }
          }
        } catch { /* audio is best-effort — the text brief still lands */ }
      }

      await svc.from("notifications").insert({
        user_id: a.user_id, brokerage_id: a.brokerage_id, type: "week_in_review",
        title: "Your week in review — from your AI team",
        body: `${audioUrl ? `▶ Listen: ${audioUrl} — ` : ""}${script}`.slice(0, 480) + ` [${isoWeek}]`,
        priority: "medium", channel: "in_app", is_read: false,
      })
      r.briefed += 1

      // Delegation close: the TOP action as ONE gated proposal (deduped per week).
      const top = ((actions ?? []) as any[])[0]
      if (top) {
        const tag = weekReviewTag(a.id, isoWeek)
        const { data: dup } = await svc.from("agent_client_messages").select("id")
          .ilike("rationale", `${tag}%`).limit(1).maybeSingle()
        if (!dup) {
          const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
          const p = await proposeClientMessage({
            brokerageId: a.brokerage_id, agentKind: "sphere_of_influence",
            entityType: "agent", entityId: a.id, audience: "agent",
            subject: `This week's #1 move: ${top.action_title}`,
            body: `${top.action_title}${top.action_description ? ` — ${top.action_description}` : ""}. Approve and the team starts on it.`,
            rationale: `${tag} — Week-in-review top move${top.estimated_gci_impact_cents ? ` (~$${Math.round(top.estimated_gci_impact_cents / 100).toLocaleString("en-US")} impact)` : ""}`,
          }, svc)
          if ((p as any)?.ok !== false) r.proposalsQueued += 1
        }
      }
    } catch {
      r.errors += 1
    }
  }
  return r
}
