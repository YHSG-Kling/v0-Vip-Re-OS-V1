import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { NextRequest, NextResponse } from "next/server"

// ─── Intent types the voice assistant understands ────────────────────────────
type VoiceIntent =
  | "query_showings"
  | "query_hot_contacts"
  | "query_tasks"
  | "query_transactions"
  | "query_pipeline"
  | "create_task"
  | "schedule_followup"
  | "team_query"
  | "morning_standup"
  | "do_standup_item"
  | "reject_standup_item"
  | "area_query"
  | "voice_followup"
  | "start_marketing"
  | "cut_promo"
  | "commission_video"
  | "studio_session"
  | "optimize_tour"
  | "closings_at_risk"
  | "send_equity_report"
  | "general_query"

interface CallQueueItem {
  contactId: string
  name: string
  phone: string
  score: number
  reason: string
}

interface VoiceCommandResponse {
  spokenResponse: string
  intent: VoiceIntent
  action: string | null
  callQueue: CallQueueItem[]
  data: Record<string, unknown>
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { transcript, sessionId } = await req.json()
  if (!transcript || typeof transcript !== "string") {
    return NextResponse.json({ error: "transcript required" }, { status: 400 })
  }

  const service = createServiceClient()

  // Get user profile for brokerage_id and agent record
  const { data: profile } = await service
    .from("users")
    .select("id, user_type, brokerage_id, first_name")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile) return NextResponse.json({ error: "User not found" }, { status: 404 })

  const brokerageId = profile.brokerage_id
  const today = new Date().toISOString().slice(0, 10)
  const startOfWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  // ── Classify intent using AI ──────────────────────────────────────────────
  const classifyResult = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
    system: `Classify the real estate assistant voice command into one of these intents:
- query_showings: asking about today's or upcoming showings
- query_hot_contacts: asking about hot leads, top contacts, who to call
- query_tasks: asking about tasks, to-dos, overdue items
- query_transactions: asking about active deals or transactions
- query_pipeline: asking about leads in pipeline or follow-ups needed
- create_task: asking to create, add, or set a task reminder
- schedule_followup: asking to schedule a follow-up
- morning_standup: asking the team what to do / what matters today / what's my day / where to start / priorities (NO specific person named)
- do_standup_item: telling the team to DO / knock out / handle / approve a stand-up item BY ITS RANK ("do number two", "knock out the first one", "handle #3")
- reject_standup_item: REJECTING a stand-up item by rank, optionally with a reason ("reject number two — too pushy", "kill the second one, wrong tone")
- area_query: asking what's happening / running / for sale in an AREA, neighborhood, city, or near a street ("anything happening near 44 Birch", "what's running in Springfield", "our listings in Oakdale")
- team_query: addressing the whole team ("hey team", "ask the team") OR asking what's happening with a SPECIFIC named person/client/family
- voice_followup: asking to SEND a follow-up/thank-you/recap message to a named person (e.g. after a call: "send Jordan a follow-up", "follow up with the Hendersons saying ...")
- start_marketing: asking to start/kick off marketing or a campaign for a named person ("get marketing going for Jordan", "push a campaign for the Hendersons")
- cut_promo: asking to create/cut/make a promo video/reel for a LISTING ADDRESS ("cut a promo reel for 44 Birch Lane", "make a video for the new listing on Maple")
- commission_video: asking to create an ON-DEMAND video that is NOT a listing promo — a market update, CMA/home-value, explainer/educational, neighborhood spotlight, testimonial, or anniversary/equity reel ("make a market update reel for Instagram", "create an explainer video about escrow for TikTok", "cut a neighborhood spotlight for Oakdale")
- studio_session: asking to BOOK / PLAN / SCHEDULE a BATCH or CALENDAR of content / reels / videos for a duration (a day, a week, a month) — the agent wants MULTIPLE reels planned and staged at once ("book me a week of content", "schedule a month of reels", "plan my content calendar for the week", "line up a week of videos", "get me a content calendar")
- optimize_tour: asking to optimize/fix/re-route a buyer's TOUR by named person ("optimize the Henderson tour", "fix the route and times for Jordan's tour", "sort the Garcia showings by drive time")
- closings_at_risk: asking which closings/deals are AT RISK or tight this week ("what closings are at risk this week", "any deals about to slip", "which closings are tight")
- send_equity_report: asking to send/run a named person's ANNIVERSARY EQUITY report ("send the Garcias their anniversary equity report", "run Jordan's equity update")
- general_query: anything else

Respond with ONLY the intent string, nothing else.`,
    messages: [{ role: "user", content: transcript }],
    maxOutputTokens: 20,
  })

  const intent = (classifyResult.text.trim().toLowerCase() as VoiceIntent) ?? "general_query"

  let spokenResponse = ""
  let callQueue: CallQueueItem[] = []
  let data: Record<string, unknown> = {}
  let action: string | null = null

  // ── Resolve data by intent ────────────────────────────────────────────────
  try {
    if (intent === "query_showings") {
      const { data: showings } = await service
        .from("showings")
        .select("id, scheduled_at, scheduled_date, scheduled_time, status, contacts(first_name, last_name), listings(address, city)")
        .eq("agent_id", user.id)
        .gte("scheduled_date", today)
        .lte("scheduled_date", new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
        .order("scheduled_date", { ascending: true })
        .limit(10)

      const todayShowings = (showings ?? []).filter((s) => s.scheduled_date === today)
      const upcomingShowings = (showings ?? []).filter((s) => s.scheduled_date !== today)
      data = { todayShowings, upcomingShowings }

      if (todayShowings.length === 0 && upcomingShowings.length === 0) {
        spokenResponse = "You have no showings scheduled for today or the next three days."
      } else if (todayShowings.length > 0) {
        const names = todayShowings.map((s) => {
          const c = s.contacts as { first_name?: string; last_name?: string } | null
          const l = s.listings as { address?: string; city?: string } | null
          const name = c ? `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() : "a client"
          const addr = l?.address ?? "unknown address"
          return `${name} at ${addr} at ${s.scheduled_time ?? "TBD"}`
        })
        spokenResponse = `You have ${todayShowings.length} showing${todayShowings.length > 1 ? "s" : ""} today. ${names.join(". ")}.`
      } else {
        spokenResponse = `No showings today, but you have ${upcomingShowings.length} coming up this week.`
      }
    } else if (intent === "query_hot_contacts") {
      // Pull contacts with highest intent_score or engagement_score, with phone numbers
      const { data: contacts } = await service
        .from("contacts")
        .select("id, first_name, last_name, phone, intent_score, engagement_score, buyer_stage, status")
        .eq("agent_id", user.id)
        .eq("brokerage_id", brokerageId)
        .neq("phone", null)
        .neq("call_stop_flag", true)
        .neq("dnc_status", true)
        .order("intent_score", { ascending: false, nullsFirst: false })
        .limit(5)

      callQueue = (contacts ?? [])
        .filter((c) => c.phone)
        .map((c) => ({
          contactId: c.id,
          name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Unknown",
          phone: c.phone!,
          score: c.intent_score ?? c.engagement_score ?? 0,
          reason: c.buyer_stage ? `Stage: ${c.buyer_stage.replace(/_/g, " ")}` : "High intent score",
        }))

      data = { contacts: callQueue }

      if (callQueue.length === 0) {
        spokenResponse = "You have no hot contacts with phone numbers right now."
      } else {
        const names = callQueue.slice(0, 3).map((c) => c.name).join(", ")
        spokenResponse = `Your top ${Math.min(callQueue.length, 5)} hot contacts are ${names}${callQueue.length > 3 ? `, and ${callQueue.length - 3} more` : ""}. I've queued their numbers for you.`
      }
    } else if (intent === "query_tasks") {
      const { data: tasks } = await service
        .from("tasks")
        .select("id, title, due_date, priority, status, contacts(first_name, last_name)")
        .eq("assigned_to_agent_id", user.id)
        .eq("brokerage_id", brokerageId)
        .neq("status", "completed")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(5)

      const overdue = (tasks ?? []).filter((t) => t.due_date && t.due_date < today)
      const dueToday = (tasks ?? []).filter((t) => t.due_date === today)
      data = { overdue, dueToday, total: tasks?.length ?? 0 }

      if (!tasks?.length) {
        spokenResponse = "You have no pending tasks."
      } else if (overdue.length > 0) {
        spokenResponse = `You have ${overdue.length} overdue task${overdue.length > 1 ? "s" : ""} and ${dueToday.length} due today. Your most urgent is: ${overdue[0].title}.`
      } else if (dueToday.length > 0) {
        spokenResponse = `You have ${dueToday.length} task${dueToday.length > 1 ? "s" : ""} due today. First up: ${dueToday[0].title}.`
      } else {
        spokenResponse = `You have ${tasks.length} upcoming task${tasks.length > 1 ? "s" : ""}. Next: ${tasks[0].title}.`
      }
    } else if (intent === "query_transactions") {
      const { data: transactions } = await service
        .from("transactions")
        .select("id, deal_name, status, stage, close_date, purchase_price, contacts(first_name, last_name)")
        .eq("agent_id", user.id)
        .eq("brokerage_id", brokerageId)
        .not("status", "eq", "closed")
        .order("close_date", { ascending: true, nullsFirst: false })
        .limit(5)

      data = { transactions: transactions ?? [] }

      if (!transactions?.length) {
        spokenResponse = "You have no active transactions right now."
      } else {
        spokenResponse = `You have ${transactions.length} active deal${transactions.length > 1 ? "s" : ""}. ${transactions.slice(0, 2).map((t) => `${t.deal_name ?? "Untitled"} in ${t.stage ?? "unknown stage"}`).join(". ")}.`
      }
    } else if (intent === "query_pipeline") {
      const { data: leads } = await service
        .from("contacts")
        .select("id, first_name, last_name, intent_score, buyer_stage, last_contacted_at")
        .eq("agent_id", user.id)
        .eq("brokerage_id", brokerageId)
        .not("buyer_stage", "is", null)
        .order("intent_score", { ascending: false, nullsFirst: false })
        .limit(5)

      const needFollowup = (leads ?? []).filter(
        (l) => !l.last_contacted_at || new Date(l.last_contacted_at) < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      )
      data = { leads: leads ?? [], needFollowup }
      spokenResponse = needFollowup.length > 0
        ? `${needFollowup.length} contact${needFollowup.length > 1 ? "s" : ""} in your pipeline haven't been contacted in over a week. Top one is ${needFollowup[0].first_name ?? "Unknown"}.`
        : `You have ${leads?.length ?? 0} active leads in your pipeline. All have been contacted recently.`
    } else if (intent === "team_query") {
      // "HEY TEAM—" — the bullpen question: every manager contributes what its own
      // tables know about the named person; one manager-attributed spoken answer.
      // Read-only: the team reports, acting still goes through the gate.
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract the person/family name the user is asking about. Respond with ONLY the name (e.g. "Henderson" or "Jordan Henderson"). If no name is present, respond with NONE.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 12,
      })
      const personQuery = extract.text.trim()
      if (!personQuery || personQuery.toUpperCase() === "NONE" || !brokerageId) {
        spokenResponse = "Who should I ask the team about? Give me a name and I'll pull everything the managers know."
      } else {
        const { dispatchTeamCommand } = await import("@/lib/voice/team-commands")
        const r = await dispatchTeamCommand("team_query", { person_query: personQuery }, { brokerageId, agentUserId: user.id, firstName: profile.first_name }, service)
        spokenResponse = r.spoken
        data = r.data ?? {}
        action = r.data?.contactId ? "team_query_answered" : null
      }
    } else if (intent === "morning_standup") {
      // "Hey team, what should I do today?" — the managers rank the day's top 3 moves
      // (fires → aging approvals → warmest cooling lead). Read-only; acting is the
      // existing voice verbs.
      if (!brokerageId) {
        spokenResponse = "I can't pull your day without a brokerage on your profile."
      } else {
        const { dispatchTeamCommand } = await import("@/lib/voice/team-commands")
        const r = await dispatchTeamCommand("morning_standup", {}, { brokerageId, agentUserId: user.id, firstName: profile.first_name }, service)
        spokenResponse = r.spoken
        data = r.data ?? {}
        action = ((r.data?.items as unknown[] | undefined)?.length ?? 0) > 0 ? "standup_delivered" : null
      }
    } else if (intent === "do_standup_item") {
      // "Knock out number two" — re-derive the stand-up (live) and act on item N
      // through its rail (approval → the gate as the agent; reengage → follow-up;
      // fire → never auto-resolved).
      const { parseOrdinal } = await import("@/lib/kernel/standup-action")
      const ordinal = parseOrdinal(transcript)
      if (!ordinal || !brokerageId) {
        spokenResponse = "Which one — number one, two, or three? Say the rank and I'll knock it out."
      } else {
        const { dispatchTeamCommand } = await import("@/lib/voice/team-commands")
        const r = await dispatchTeamCommand("standup_action", { ordinal }, { brokerageId, agentUserId: user.id, firstName: profile.first_name }, service)
        spokenResponse = r.spoken
        data = r.data ?? {}
        action = r.ok ? `standup_${r.data?.actedKind ?? "item"}_done` : null
      }
    } else if (intent === "reject_standup_item") {
      // "Reject number two — too pushy" — the spoken NO carries its reason; outcome
      // learning stores it so the team drafts it better next time.
      const { parseOrdinal, runStandupReject } = await import("@/lib/kernel/standup-action")
      const ordinal = parseOrdinal(transcript)
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract WHY the user is rejecting (the reason after the rank, e.g. "too pushy", "wrong tone"). Respond with ONLY the reason, or NONE.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 30,
      })
      const reasonRaw = extract.text.trim()
      const reason = reasonRaw && reasonRaw.toUpperCase() !== "NONE" ? reasonRaw : null
      if (!ordinal || !brokerageId) {
        spokenResponse = "Which one should I reject — number one, two, or three? Add a reason and the team learns from it."
      } else {
        const r = await runStandupReject({ brokerageId, agentUserId: user.id, ordinal, reason, firstName: profile.first_name }, service)
        spokenResponse = r.spoken
        data = { ordinal, reason, entityId: r.entityId ?? null }
        action = r.ok ? "standup_rejected" : null
      }
    } else if (intent === "area_query") {
      // "Anything happening near 44 Birch?" — the marketing bench reports listings,
      // reels, and live ads in the area. Read-only.
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract the area, neighborhood, city, or street the user is asking about. Respond with ONLY that place (e.g. "44 Birch" or "Springfield"). If none, respond NONE.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 16,
      })
      const areaQuery = extract.text.trim()
      if (!areaQuery || areaQuery.toUpperCase() === "NONE" || !brokerageId) {
        spokenResponse = "Which area? Give me a street, neighborhood, or city and I'll pull what the team has going there."
      } else {
        const { dispatchTeamCommand } = await import("@/lib/voice/team-commands")
        const r = await dispatchTeamCommand("area_query", { area_query: areaQuery }, { brokerageId, agentUserId: user.id, firstName: profile.first_name }, service)
        spokenResponse = r.spoken
        data = r.data ?? {}
        action = ((r.data?.contributions as unknown[] | undefined)?.length ?? 0) > 0 ? "area_query_answered" : null
      }
    } else if (intent === "voice_followup" || intent === "start_marketing") {
      // VOICE DELEGATION — the spoken instruction is the human decision. Follow-ups
      // run propose→approve(as the agent) through the SAME gate (consent re-checked);
      // marketing enrolls in a sequence whose steps clear the compliance gate.
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `From the voice command, extract:\nNAME: the person/family name\nDICTATION: the exact message content the user dictated, if any (the words after "saying"/"tell them"), else NONE\nFormat exactly:\nNAME: <name or NONE>\nDICTATION: <text or NONE>`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 120,
      })
      const nameMatch = extract.text.match(/NAME:\s*(.+)/)?.[1]?.trim()
      const dictMatch = extract.text.match(/DICTATION:\s*([\s\S]+)/)?.[1]?.trim()
      const personQuery = nameMatch && nameMatch.toUpperCase() !== "NONE" ? nameMatch : null
      const dictation = dictMatch && dictMatch.toUpperCase() !== "NONE" ? dictMatch : null
      if (!personQuery || !brokerageId) {
        spokenResponse = "Who is that for? Give me the name and I'll take it from there."
      } else {
        const { dispatchTeamCommand } = await import("@/lib/voice/team-commands")
        const cmd = intent === "voice_followup" ? "voice_followup" : "start_marketing"
        const r = await dispatchTeamCommand(cmd, { person_query: personQuery, dictation }, { brokerageId, agentUserId: user.id, firstName: profile.first_name }, service)
        spokenResponse = r.spoken
        data = r.data ?? {}
        action = r.ok ? (intent === "voice_followup" ? "voice_followup_sent" : "marketing_started") : null
      }
    } else if (intent === "cut_promo") {
      // "Cut a promo reel for 44 Birch" — the voice command is a manual trigger on the
      // CANONICAL Remotion + D-ID promo rail (compliance pre-flight, cooldown debounce,
      // social drafts still human-approved).
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract the listing street address the user wants a promo video for. Respond with ONLY the address fragment (e.g. "44 Birch Lane"). If none, respond NONE.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 20,
      })
      const addressQuery = extract.text.trim()
      if (!addressQuery || addressQuery.toUpperCase() === "NONE" || !brokerageId) {
        spokenResponse = "Which listing? Give me the street number and name and I'll cut the reel."
      } else {
        const { dispatchTeamCommand } = await import("@/lib/voice/team-commands")
        const r = await dispatchTeamCommand("cut_promo", { address_query: addressQuery }, { brokerageId, agentUserId: user.id, firstName: profile.first_name }, service)
        spokenResponse = r.spoken
        data = r.data ?? {}
        action = r.ok ? "promo_dispatched" : null
      }
    } else if (intent === "commission_video") {
      // "Make a market-update reel for Instagram" — the Video Director takes the command:
      // picks the best Remotion format for the situation+channel and assembles intro→main→
      // outro (brand+photo+hook / brand+contact+QR), compliance-gated, social drafts approved
      // by a human. On-demand kinds only; listing promos route through cut_promo.
      const { normalizeVideoKind, normalizeVideoChannel, voiceCommissionVideo } = await import("@/lib/kernel/voice-delegation")
      const kind = normalizeVideoKind(transcript)
      const targetChannel = normalizeVideoChannel(transcript)
      if (!kind || !brokerageId) {
        spokenResponse = "What kind of video — a market update, CMA, explainer, neighborhood spotlight, testimonial, or anniversary equity reel? Tell me the type and the channel and I'll direct it."
      } else {
        const r = await voiceCommissionVideo({ brokerageId, agentUserId: user.id, kind, targetChannel }, service)
        spokenResponse = r.spoken
        data = { kind, targetChannel }
        action = r.ok ? "video_commissioned" : null
      }
    } else if (intent === "studio_session") {
      // "Book me a week of content" — the Studio Session BATCH: plans N reels (which
      // formats, which listings/topics, which dates) and stages them for approval via the
      // Video Director. Nothing auto-publishes — every reel lands at pending_review. The
      // spoken command IS the human trigger; approvals still happen one-by-one in the
      // Content Studio.
      if (!brokerageId) {
        spokenResponse = "I can't book a studio session without a brokerage on your profile."
      } else {
        const { voiceStudioSession } = await import("@/lib/voice/studio-session")
        const r = await voiceStudioSession({ brokerageId, agentUserId: user.id, transcript }, service)
        spokenResponse = r.spoken
        data = {
          sessionId: r.sessionId ?? null,
          sessionKey: r.sessionKey ?? null,
          commissioned: r.commissioned ?? 0,
          skipped: r.skipped ?? 0,
          videoProjectIds: r.videoProjectIds ?? [],
          planItemCount: r.plan?.items.length ?? 0,
        }
        action = r.ok ? (r.stage === "already_commissioned" ? "studio_session_existing" : "studio_session_commissioned") : null
      }
    } else if (intent === "optimize_tour") {
      // "Optimize the Henderson tour" — resolve the buyer → their latest planned tour →
      // run the REAL optimizer (tour-optimizer.ts) → speak the new order + honest geocoding
      // note. Read+write on the buyer's own tour rows only; nothing client-facing is sent.
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract the buyer/person/family name whose tour to optimize. Respond with ONLY the name (e.g. "Henderson" or "Jordan Henderson"). If none, respond NONE.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 12,
      })
      const personQuery = extract.text.trim()
      if (!personQuery || personQuery.toUpperCase() === "NONE" || !brokerageId) {
        spokenResponse = "Whose tour should I optimize? Give me the buyer's name and I'll fix the route and times."
      } else {
        const { runTeamQuery } = await import("@/lib/kernel/team-query")
        const tq = await runTeamQuery(brokerageId, personQuery, {}, service)
        if (!tq.found || !tq.contactId) {
          spokenResponse = tq.spoken
        } else {
          const { voiceOptimizeTour } = await import("@/lib/kernel/voice-delegation")
          const r = await voiceOptimizeTour({ brokerageId, agentUserId: user.id, contactId: tq.contactId }, service)
          spokenResponse = r.spoken
          data = { contactId: tq.contactId, tourId: r.tourId ?? null, totalDriveMinutes: r.totalDriveMinutes ?? null, stopsSequenced: r.stopsSequenced ?? null, stopsTotal: r.stopsTotal ?? null }
          action = r.ok ? "tour_optimized" : null
        }
      }
    } else if (intent === "closings_at_risk") {
      // "What closings are at risk this week?" — READ-ONLY scan of the brokerage's live
      // under-contract deals' date chains; reuses the watchtower's pure critical-path over
      // the SAME read path the runner uses. No recompute, no writes.
      if (!brokerageId) {
        spokenResponse = "I can't read your closings without a brokerage on your profile."
      } else {
        const { voiceClosingsAtRisk } = await import("@/lib/kernel/voice-delegation")
        const r = await voiceClosingsAtRisk({ brokerageId }, service)
        spokenResponse = r.spoken
        data = { deals: r.deals, scanned: r.scanned, skippedNoChain: r.skippedNoChain }
        action = r.ok ? "closings_at_risk_scanned" : null
      }
    } else if (intent === "send_equity_report") {
      // "Send the Garcias their anniversary equity report" — resolve the contact → run the
      // REAL anniversary-equity play scoped to that ONE contact → the client-facing note
      // lands in the GATE (approval queue), exactly like voiceFollowUp. Never autonomous.
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract the person/family name whose anniversary equity report to send. Respond with ONLY the name (e.g. "Garcia" or "Maria Garcia"). If none, respond NONE.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 12,
      })
      const personQuery = extract.text.trim()
      if (!personQuery || personQuery.toUpperCase() === "NONE" || !brokerageId) {
        spokenResponse = "Who is the equity report for? Give me the client's name and I'll run their anniversary update."
      } else {
        const { runTeamQuery } = await import("@/lib/kernel/team-query")
        const tq = await runTeamQuery(brokerageId, personQuery, {}, service)
        if (!tq.found || !tq.contactId) {
          spokenResponse = tq.spoken
        } else {
          const { voiceSendEquityReport } = await import("@/lib/kernel/voice-delegation")
          const r = await voiceSendEquityReport({ brokerageId, contactId: tq.contactId }, service)
          spokenResponse = r.spoken
          data = { contactId: tq.contactId, proposed: r.proposed ?? false, skipReason: r.skipReason ?? null }
          action = r.proposed ? "equity_report_queued" : null
        }
      }
    } else if (intent === "create_task" || intent === "schedule_followup") {
      // "Create a task to call the lender Friday" / "remind me to follow up with the
      // Hendersons tomorrow" — previously these classified but had NO handler and fell
      // through to the chat deflection (no task created). Now: extract title + due phrase
      // + optional person, resolve the date deterministically, create the real task.
      const isFollowUp = intent === "schedule_followup"
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract a task from a real-estate agent's spoken command. Respond with ONLY compact JSON: {"title":"<short imperative task, no date>","due":"<relative date phrase like today/tomorrow/friday/in 3 days/next week, or NONE>","person":"<client/family name if one is named, or NONE>"}. Keep the title under 8 words. Do not invent a person or date that wasn't said.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 60,
      })
      let title = "", duePhrase: string | null = null, personQuery = ""
      try {
        const raw = extract.text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "")
        const parsed = JSON.parse(raw) as { title?: string; due?: string; person?: string }
        title = (parsed.title ?? "").trim()
        duePhrase = parsed.due && parsed.due.toUpperCase() !== "NONE" ? parsed.due : null
        personQuery = parsed.person && parsed.person.toUpperCase() !== "NONE" ? parsed.person.trim() : ""
      } catch { /* deterministic fallbacks below */ }

      const { parseRelativeDueDate, buildVoiceTaskRow, spokenTaskConfirmation } = await import("@/lib/voice/task-command")
      const dueDate = parseRelativeDueDate(duePhrase, today)

      // Resolve a named contact (best-effort; an undated, unlinked task is still valid).
      let contactId: string | null = null
      let contactName: string | null = null
      if (personQuery && brokerageId) {
        const { runTeamQuery } = await import("@/lib/kernel/team-query")
        const tq = await runTeamQuery(brokerageId, personQuery, {}, service)
        if (tq.found && tq.contactId) { contactId = tq.contactId; contactName = personQuery }
      }

      // tasks.assigned_to_agent_id FK → agents.id (NOT users.id) — resolve the agent profile.
      const { data: agentRow } = await service.from("agents").select("id").eq("user_id", user.id).maybeSingle()
      const agentId = (agentRow as { id?: string } | null)?.id ?? null

      if (!brokerageId) {
        spokenResponse = "I couldn't find your brokerage to file that task under."
      } else if (!agentId) {
        spokenResponse = "I can only file tasks for agent accounts — yours isn't linked to an agent profile."
      } else {
        const row = buildVoiceTaskRow({ title, dueDate, contactId, brokerageId, agentId, isFollowUp })
        const { data: created, error: taskErr } = await service.from("tasks").insert(row).select("id, title, due_date").maybeSingle()
        if (taskErr || !created) {
          spokenResponse = "I couldn't save that task — please try again."
        } else {
          spokenResponse = spokenTaskConfirmation(created.title, created.due_date ?? null, contactName)
          data = { taskId: created.id, title: created.title, dueDate: created.due_date ?? null, contactId }
          action = "task_created"
        }
      }
    } else {
      // General query — pass to the main AI chat endpoint context
      spokenResponse = "Got it. I'm sending that to the assistant for you."
      action = "forward_to_chat"
    }
  } catch {
    spokenResponse = "I ran into an issue getting that data. Please try again."
  }

  // ── Log to voice_commands ────────────────────────────────────────────────
  await service
    .from("voice_commands")
    .insert({
      user_id: user.id,
      brokerage_id: brokerageId,
      raw_transcript: transcript,
      parsed_intent: intent,
      command_type: intent,
      entities: data,
      action_taken: action ?? intent,
      action_result: { spokenResponse, callQueueCount: callQueue.length },
      success: true,
      source: "voice_assistant",
    })
    .then(() => {}, () => {}) // non-fatal

  const response: VoiceCommandResponse = {
    spokenResponse,
    intent,
    action,
    callQueue,
    data,
  }

  return NextResponse.json(response)
}
