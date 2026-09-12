/**
 * lib/podcast/auto-producer.ts
 *
 * Wave 15 — autonomous weekly voice podcast episode generator.
 *
 * Replaces the agent's biggest time-sink in their content cadence: writing
 * + recording + uploading a 5-7 minute weekly market commentary episode.
 *
 *   1. Build a structured fact pack from the brokerage's last 7 days:
 *      - recently-published listings (count + price ranges)
 *      - recently-sold transactions (count + days-on-market)
 *      - listings under contract this week
 *      - active market metrics if available (median price, inventory)
 *   2. AI Gateway drafts a 5-7 minute spoken-format script grounded in
 *      the fact pack (banned: invented numbers, protected-class refs,
 *      rate / value guarantees).
 *   3. Pre-flight evaluateOutbound — broadcast shape: Brand voice + Fair
 *      Housing state-specific (Florida etc.) + Them-First. ONE redraft
 *      on violation.
 *   4. ElevenLabs TTS in the agent's cloned voice → Supabase Blob URL.
 *   5. Insert podcast_episodes row (agent_id is the host's agents.id, resolved
 *      once at the top of the run — status='completed', is_ai_generated=true,
 *      approval_status='pending_review' — the agent reviews before
 *      distribute-podcast-episodes cron syndicates).
 *   6. Update podcast_auto_runs ledger: status='rendered', linked
 *      podcast_episode_id, duration estimate.
 *
 * Idempotency: podcast_auto_runs has a unique partial index on
 * (brokerage_id, iso_week). Re-running the cron for the same week is a
 * cheap no-op.
 */
import "server-only"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { createServiceClient } from "@/lib/supabase/service"
// Was `import { put } from "@vercel/blob"`. Survivor:
// lib/remotion/media-host.ts#hostRenderedMedia → Supabase `media`: a published
// episode MP3 is fetched unauthenticated by every podcast client and RSS
// aggregator, so it is public-media rather than document-class.
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import { generateTextRouted } from "@/lib/ai/models"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { synthesizeSpeech } from "@/lib/voice/elevenlabs-tts"
import { pickTopics, renderTopicsForPrompt, type TopicCandidate } from "@/lib/content-intel/topic-bank"
import { logTopicUses } from "@/lib/content-intel/performance-aggregator"
import { runWithComplianceRedraft } from "@/lib/kernel/compliance-redraft"

export interface RunInput {
  brokerageId: string
  /** users.id of the host agent — resolved by the cron from podcast_show_settings. */
  hostUserId:  string
  /** ISO week string for idempotency, e.g. "2026-W23". */
  isoWeek:     string
}

export interface RunResult {
  ok:     boolean
  status: "queued" | "rendered" | "skipped" | "already_run" | "failed"
  podcast_episode_id?: string
  ledger_id?:          string
  reason?:             string
  violations?:         string[]
}

interface FactPack {
  new_listings_count: number
  new_listings_median_price: string
  sold_count: number
  sold_median_dom: number | null
  under_contract_count: number
  brokerage_name: string
}

export async function runAutoPodcast(input: RunInput): Promise<RunResult> {
  const svc = createServiceClient()

  // 0. Identity, once, before anything is written. podcast_auto_runs.agent_id,
  //    podcast_episodes.agent_id and agent_voice_profiles.agent_id are all
  //    agents(id) and all NOT NULL, so the host's users.id has to become an
  //    agents.id here or the run has nowhere to land. Server-only resolver:
  //    this is unattended cron code that already imports "server-only", and it
  //    memoises across the week's hosts.
  //    A host with no agents row in this brokerage is a real misconfiguration —
  //    nobody is watching this run, so it is logged, not swallowed.
  const hostAgentRecordId = await resolveUserIdToAgentRecord(input.hostUserId, input.brokerageId)
  if (!hostAgentRecordId) {
    console.error(
      `[auto-podcast] no agent profile for host users.id=${input.hostUserId} in brokerage=${input.brokerageId}` +
      ` — skipping ${input.isoWeek}; podcast_show_settings points at a user with no agents row`,
    )
    return { ok: false, status: "failed", reason: "host has no agent profile in this brokerage" }
  }

  // 1. Idempotency ledger. The insert IS the ledger, and the database is its
  //    reader: uq_podcast_auto_runs_brokerage_week is a PARTIAL unique on
  //    (brokerage_id, iso_week) WHERE status <> 'failed' (m588, verified live).
  //    So 23505 below means a COMPLETED, QUEUED or SKIPPED run already holds
  //    this week — while a week whose only row is status='failed' does NOT
  //    conflict, and this insert succeeds, which is the retry working. Before
  //    m588 the unique was plain and a failed row blocked the week forever,
  //    every retry being told "already_run": a failure masquerading as
  //    idempotency.
  //    The stale failed row is deliberately LEFT AS HISTORY — the settings
  //    card renders its error_message, and every "latest run" read orders by
  //    created_at DESC, so the retry's row wins the top slot with the failure
  //    visible beneath it. 'skipped' keeps the slot on purpose: a skip is a
  //    decision about this week (host has no voice id), and retrying it each
  //    tick would burn model spend on the same refusal.
  const ledgerIns = await svc.from("podcast_auto_runs").insert({
    brokerage_id:  input.brokerageId,
    agent_id:      hostAgentRecordId,
    iso_week:     input.isoWeek,
    status:       "queued",
  }).select("id").maybeSingle()
  if (ledgerIns.error) {
    if ((ledgerIns.error as { code?: string }).code === "23505") {
      return { ok: true, status: "already_run", reason: "a non-failed run already holds (brokerage, iso_week)" }
    }
    return { ok: false, status: "failed", reason: `ledger insert: ${ledgerIns.error.message}` }
  }
  const ledgerId = ledgerIns.data!.id as string

  try {
    // 2. Voice profile gate — same agents.id resolved above.
    const { data: profile } = await svc.from("agent_voice_profiles")
      .select("elevenlabs_voice_id")
      .eq("agent_id", hostAgentRecordId)
      .maybeSingle()
    const voiceId = (profile as { elevenlabs_voice_id?: string } | null)?.elevenlabs_voice_id ?? null
    if (!voiceId) {
      await svc.from("podcast_auto_runs").update({ status: "skipped", error_message: "host has no elevenlabs_voice_id" }).eq("id", ledgerId)
      return { ok: true, status: "skipped", reason: "host voice profile not configured" }
    }

    // 3. Pull value-first topics from the content intelligence bank. The
    //    podcast LEADS with these (audience-driven Reddit threads, market
    //    education topics). The agent's own listings/closings fold in as
    //    20% supporting context, not the headline.
    const topics = await pickTopics({
      brokerageId:   input.brokerageId,
      categoriesAny: ["buyer_advice", "seller_advice", "finance", "market_education", "neighborhood", "regulation"],
      limit:         5,
      markUsed:      true,
    })

    // 4. Fact pack — grounded numbers ABOUT THE BROKERAGE (folded in as
    //    supporting examples, not the lead).
    const facts = await buildBrokerageTidbits(svc, input.brokerageId)

    // 5. Draft + pre-flight compliance — VALUE-FIRST prompt.
    const script = await draftAndClearScript({
      svc,
      brokerageId: input.brokerageId,
      hostUserId: input.hostUserId,
      facts,
      topics,
      isoWeek: input.isoWeek,
    })

    // 5. ElevenLabs TTS → Supabase `media`.
    const tts = await synthesizeSpeech({ text: script, voiceId })
    if (!tts.success || !tts.audioBuffer) throw new Error(`ElevenLabs failed: ${tts.error}`)
    const audioUrl = await hostRenderedMedia(
      svc,
      `${input.brokerageId}/podcast/episodes/${ledgerId}.mp3`,
      tts.audioBuffer,
      "audio/mpeg",
      "media",
    )

    // Estimated duration — ~155 words/minute spoken in the agent's voice.
    const wordCount = script.split(/\s+/).filter(Boolean).length
    const durationSeconds = Math.max(120, Math.round((wordCount / 155) * 60))

    // 6. Insert podcast_episodes (status='completed' + approval_status='pending_review';
    //    the distribute-podcast-episodes cron skips episodes that aren't
    //    approval_status='approved').
    const { data: episode, error: epErr } = await svc.from("podcast_episodes")
      .insert({
        brokerage_id:      input.brokerageId,
        agent_id:          hostAgentRecordId,
        title:             `${facts.brokerage_name} Weekly — ${input.isoWeek}`,
        description:       `Auto-generated weekly market commentary. Reviewed by the host before publication.`,
        script,
        audio_url:         audioUrl,
        duration_seconds:  durationSeconds,
        status:            "completed",
        is_ai_generated:   true,
        approval_status:   "pending_review",
      })
      .select("id")
      .single()
    if (epErr || !episode) throw new Error(`podcast_episodes insert: ${epErr?.message}`)

    // Wave 19 — close the performance loop. Log which topics seeded this
    // episode so the daily aggregator can read downstream engagement and
    // boost / decay their picker rank.
    void logTopicUses({
      topicIds:    topics.map((t) => t.id),
      brokerageId: input.brokerageId,
      assetType:   "podcast_episode",
      assetId:     episode.id,
    })

    await svc.from("podcast_auto_runs").update({
      status:             "rendered",
      podcast_episode_id: episode.id,
      script_word_count:  wordCount,
      duration_seconds:   durationSeconds,
      completed_at:       new Date().toISOString(),
    }).eq("id", ledgerId)

    return { ok: true, status: "rendered", podcast_episode_id: episode.id, ledger_id: ledgerId }
  } catch (err) {
    const msg = (err as Error).message
    await svc.from("podcast_auto_runs").update({
      status:        "failed",
      error_message: msg.slice(0, 800),
    }).eq("id", ledgerId)
    return { ok: false, status: "failed", reason: msg, ledger_id: ledgerId }
  }
}

// ─── Fact pack ──────────────────────────────────────────────────────────────

/**
 * Build the BROKERAGE TIDBITS pack — internal data about the agent's own
 * activity (recent listings, transactions, etc.). This is INTENTIONALLY
 * separate from the content topic bank: the topic bank holds EXTERNAL
 * audience signal (Reddit / Exa / RSS / Apify) that leads the script as
 * value content; the tidbits below are folded in as ~20% supporting
 * context in the "bridge to local" segment. Renamed from buildFactPack
 * to make the distinction explicit per the code-review clarification.
 *
 * All 4 independent counts run in parallel via Promise.all (~150ms total
 * instead of ~600ms serial). Each query's failure is logged (not swallowed
 * silently) so a schema drift or RLS regression shows up in monitoring.
 */
async function buildBrokerageTidbits(svc: ReturnType<typeof createServiceClient>, brokerageId: string): Promise<FactPack> {
  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const since7dDate = since7d.slice(0, 10)

  const [brokerageRes, newListingsRes, soldRes, underContractRes] = await Promise.all([
    svc.from("brokerages").select("name").eq("id", brokerageId).maybeSingle(),
    svc.from("listings")
      .select("list_price")
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
      .gte("created_at", since7d)
      .limit(500),
    svc.from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "closed")
      .gte("close_date", since7dDate),
    svc.from("transactions")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("status", "under_contract"),
  ])

  if (brokerageRes.error)     console.error("[auto-producer] brokerages query failed:",      brokerageRes.error.message)
  if (newListingsRes.error)   console.error("[auto-producer] listings query failed:",        newListingsRes.error.message)
  if (soldRes.error)          console.error("[auto-producer] transactions(closed) failed:",  soldRes.error.message)
  if (underContractRes.error) console.error("[auto-producer] transactions(uc) failed:",      underContractRes.error.message)

  const brokerageName = (brokerageRes.data as { name?: string } | null)?.name ?? "Our Team"
  const prices = (newListingsRes.data ?? []).map((r) => (r as { list_price?: number | null }).list_price ?? null).filter((p): p is number => typeof p === "number")
  const newListingsCount = (newListingsRes.data ?? []).length
  let medianPrice = ""
  if (prices.length > 0) {
    const sorted = [...prices].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    medianPrice = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(median)
  }
  const soldCount = soldRes.count ?? 0
  const underContractCount = underContractRes.count ?? 0

  return {
    new_listings_count:        newListingsCount,
    new_listings_median_price: medianPrice,
    sold_count:                soldCount,
    sold_median_dom:           null,
    under_contract_count:      underContractCount,
    brokerage_name:            brokerageName,
  }
}

// ─── Draft + compliance ─────────────────────────────────────────────────────

async function draftAndClearScript(args: {
  svc: ReturnType<typeof createServiceClient>
  brokerageId: string
  hostUserId: string
  facts: FactPack
  topics: TopicCandidate[]
  isoWeek: string
}): Promise<string> {
  const draft = async (violations: string[]): Promise<string> => {
    const fix = violations.length > 0
      ? `\n\nResolve these violations from your prior draft:\n- ${violations.join("\n- ")}\n`
      : ""
    const prompt = `Write a 5-7 minute spoken podcast script for a real-estate agent's weekly show, ISO week ${args.isoWeek}.

THIS SHOW IS NOT ABOUT THE AGENT'S BUSINESS. The audience is buyers, sellers, owners, and curious neighbors. Lead with VALUE TO THEM. The agent's own listings/closings are folded in ONLY where they support a value point — never as the headline.

LEAD TOPICS (this week's audience-relevant threads + themes from the
content intelligence bank — choose the 2-3 strongest as the spine of the
episode):

${renderTopicsForPrompt(args.topics)}

BROKERAGE TIDBITS (fold in 1-2 sentences MAX as supporting examples,
not as features):
- Brokerage: ${args.facts.brokerage_name}
- New listings published this week: ${args.facts.new_listings_count}${args.facts.new_listings_median_price ? ` (median ${args.facts.new_listings_median_price})` : ""}
- Closed transactions this week: ${args.facts.sold_count}
- Currently under contract: ${args.facts.under_contract_count}

EPISODE STRUCTURE (no segment headers read aloud):
  ▸ Cold open (30s) — the most provocative question or counter-intuitive
    insight from the lead topics. Hook the listener.
  ▸ Main value segment 1 (~2 min) — explain the top topic. Why does it
    matter to a buyer / seller / owner? What's the practical takeaway?
    Cite numbers from the topic itself when appropriate.
  ▸ Main value segment 2 (~2 min) — second topic, same treatment.
  ▸ Bridge to local context (~1 min) — connect the broader themes back
    to ${args.facts.brokerage_name}'s local market. THIS is where the
    brokerage tidbits land naturally ("here's how that's playing out
    in our market — we saw X new listings this week"). Don't overstate.
  ▸ Closing thought (~30s) — one durable takeaway the listener can use,
    plus a low-pressure "if you've got a question on any of this, you
    know where to find me."

STYLE:
- First-person, warm, conversational. Read at ~155 words/minute spoken.
- 750-1000 words total.
- No exclamation marks.
- No protected-class refs (race, religion, family status, national
  origin, gender, sexual orientation, disability, source of income).
- No phrases like "perfect for families" or "great starter for newlyweds".
- No rate / valuation / appreciation guarantees.
- No invented numbers — only use facts present in the topics or the
  brokerage tidbits.

Return ONLY the spoken script — no scene directions, no headers, no
segment labels read aloud.${fix}`
    const { text } = await generateTextRouted({
      brokerageId: args.brokerageId,
      userId: args.hostUserId,
      feature:     "podcast_weekly_auto_script",
      prompt,
      maxTokens:   1800,
      temperature: 0.55,
    })
    return text.trim()
  }

  const result = await runWithComplianceRedraft({
    draft: ({ violations }) => draft(violations),
    gate:  async (script) => {
      const r = await evaluateOutbound({
        actorContext: { brokerageId: args.brokerageId, userId: args.hostUserId, role: "system" },
        journeyType:  "buyer", persona: "other", messageType: "social", content: script,
      })
      return { allowed: r.allowed, violations: r.violations }
    },
  })
  if (!result.ok) throw new Error(`compliance failed after redraft: ${result.violations.join("; ")}`)
  return result.script
}

// ─── ISO week helper ────────────────────────────────────────────────────────

export function currentIsoWeek(d: Date = new Date()): string {
  // ISO 8601 week — Thursday-anchored to handle year boundaries.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNr  = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const diff     = (target.getTime() - firstThu.getTime()) / 86_400_000
  const week     = 1 + Math.round((diff - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}
