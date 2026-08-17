import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { createTenantUserAction } from "@/app/actions/superadmin/tenant-users"
import { NextRequest, NextResponse } from "next/server"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
  | "launch_campaign"
  | "query_flight_risk"
  | "query_vendor_coverage"
  | "query_referral_income"
  | "draft_save_plays"
  | "create_tenant_user"
  | "find_properties"
  | "draft_offer"
  | "draft_listing"
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
    .select("id, user_type, brokerage_id, first_name, platform_role")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile) return NextResponse.json({ error: "User not found" }, { status: 404 })

  const brokerageId = profile.brokerage_id
  // pass 11: showings/contacts/transactions.agent_id + tasks.assigned_to_agent_id
  // FK agents(id), NOT users(id) — filtering by the raw user.id returned EMPTY,
  // so the voice admin found none of the agent's own showings/contacts/deals.
  const { resolveAgentId } = await import("@/lib/kernel/agent-identity")
  // NOT `?? user.id` (m353) — the comment above says the raw user.id filter is
  // why "the voice admin found none of the agent's own showings/contacts/deals".
  // Falling back to it means the voice agent answers "you have nothing today"
  // with total confidence, which is the worst possible failure for a spoken UI.
  const voiceAgentId = await resolveAgentId(service as any, user.id)
  if (!voiceAgentId) {
    return NextResponse.json({ ok: false, spoken: "I can't reach your agent profile yet — finish account setup and try again." }, { status: 409 })
  }
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
- launch_campaign: asking to LAUNCH / push / kick off / go live with the MARKETING CAMPAIGN for a LISTING ADDRESS ("launch the campaign for 123 Oak Street", "push the just-listed campaign on Maple", "take the Birch Lane campaign live")
- query_flight_risk: asking which AGENTS are at RETENTION / FLIGHT risk, who's slipping, who might leave ("who's at flight risk", "any agents about to leave", "who's slipping on my team", "retention risks")
- query_vendor_coverage: asking about VENDOR COVERAGE gaps in the bench — categories with upcoming demand but no reliable vendor ("any vendor coverage gaps", "is my bench covered", "do I have enough inspectors", "vendor gaps coming up")
- query_referral_income: asking about the agent's own AGENT-TO-AGENT referral income / earnings / how much they've earned referring clients ("how much have I earned in referrals", "my referral income", "what have my agent referrals paid me")
- draft_save_plays: COMMANDING the assistant to DRAFT / write / prepare retention SAVE-PLAYS for the at-risk / flight-risk agents ("draft save-plays for everyone at flight risk", "write save-plays for my at-risk agents", "prepare retention outreach for the agents who are slipping")
- create_tenant_user: a PLATFORM-ADMIN command to CREATE / add / invite a new USER / agent / admin / TC into a brokerage ("create a new agent named Jane Doe at jane@x.com", "add an admin to the Denver brokerage", "invite a TC to Coastal Realty")
- find_properties: asking to FIND / SEARCH / pull PROPERTIES or LISTINGS for a named BUYER with criteria — beds/baths/price/area ("find the Hendersons a 3-bed under 500k in Austin", "search a 4 bedroom with a pool under 800 for Jordan", "what's on the market for the Garcias in Oakdale")
- draft_offer: asking to DRAFT / write / prepare an OFFER for a named buyer on a property ("draft an offer for the Hendersons on 44 Birch at 450", "write up an offer for Jordan at 620 thousand", "start an offer for the Garcias")
- draft_listing: asking to DRAFT / write / prepare a LISTING AGREEMENT for a named seller/property ("draft a listing agreement for the Garcias at 12 Oak", "write up the listing for 88 Maple", "start a listing agreement for Jordan's house")
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
        .eq("agent_id", voiceAgentId)
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
        .eq("agent_id", voiceAgentId)
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
        .eq("assigned_to_agent_id", voiceAgentId)
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
      // transactions → contacts carries THREE FKs (transactions_contact_id_fkey,
      // transactions_buyer_contact_id_fkey, transactions_seller_contact_id_fkey), so a
      // bare `contacts(...)` is ambiguous: PostgREST refuses the ENTIRE request
      // (PGRST201) and supabase-js resolves it, so `transactions` came back null and
      // the assistant spoke "You have no active transactions right now" over a full
      // pipeline — the worst failure mode for a voice UI. Named contact_id: this is the
      // agent's own deal list ("your active deals"), and contact_id is the client on the
      // deal regardless of which side they sit on; buyer_/seller_contact_id are the
      // per-side links and would drop every deal where the agent's client is the other party.
      const { data: transactions, error: transactionsError } = await service
        .from("transactions")
        .select("id, deal_name, status, stage, close_date, purchase_price, contacts!transactions_contact_id_fkey(id, first_name, last_name)")
        .eq("agent_id", voiceAgentId)
        .eq("brokerage_id", brokerageId)
        .not("status", "eq", "closed")
        .order("close_date", { ascending: true, nullsFirst: false })
        .limit(5)

      data = { transactions: transactions ?? [] }

      if (transactionsError) {
        // A resolved-but-failed read must not be spoken as "you have nothing".
        spokenResponse = "I couldn't reach your deals just now — try me again in a moment."
      } else if (!transactions?.length) {
        spokenResponse = "You have no active transactions right now."
      } else {
        spokenResponse = `You have ${transactions.length} active deal${transactions.length > 1 ? "s" : ""}. ${transactions.slice(0, 2).map((t) => `${t.deal_name ?? "Untitled"} in ${t.stage ?? "unknown stage"}`).join(". ")}.`
      }
    } else if (intent === "query_pipeline") {
      const { data: leads } = await service
        .from("contacts")
        .select("id, first_name, last_name, intent_score, buyer_stage, last_contacted_at")
        .eq("agent_id", voiceAgentId)
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
    } else if (intent === "launch_campaign") {
      // "Launch the campaign for 123 Oak Street" — resolve the listing by address → pick the
      // most launch-ready campaign for it → launch via the existing admin-gated executor
      // (it enforces role + tenant + compliance; a non-admin speaker is refused honestly).
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `Extract the LISTING street address whose marketing campaign to launch. Respond with ONLY the address or street (e.g. "123 Oak Street" or "Maple"). If none, respond NONE.`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 16,
      })
      const addr = extract.text.trim()
      if (!addr || addr.toUpperCase() === "NONE" || !brokerageId) {
        spokenResponse = "Which listing's campaign should I launch? Tell me the address."
      } else {
        const { data: listing } = await service
          .from("listings")
          .select("id, address")
          .eq("brokerage_id", brokerageId)
          .ilike("address", `%${addr}%`)
          .limit(1)
          .maybeSingle()
        if (!listing) {
          spokenResponse = `I couldn't find a listing matching "${addr}".`
        } else {
          const { data: campaigns } = await service
            .from("marketing_campaigns")
            .select("id, status, campaign_name, campaign_type, created_at")
            .eq("brokerage_id", brokerageId)
            .eq("listing_id", listing.id)
          const { pickLaunchableCampaign } = await import("@/lib/voice/campaign-command")
          const pick = pickLaunchableCampaign((campaigns ?? []) as Array<{ id: string; status: string; created_at?: string | null }>)
          if (!pick) {
            spokenResponse = `There's no campaign ready to launch for ${listing.address}. Set one up first.`
          } else {
            const { launchMarketingCampaignAction } = await import("@/app/actions/marketing-campaigns-admin")
            const r = await launchMarketingCampaignAction(pick.id)
            if (r.ok) {
              spokenResponse = `Launched the ${pick.campaign_name ?? "campaign"} for ${listing.address} to ${r.audienceSize} contact${r.audienceSize === 1 ? "" : "s"}. Compliance: ${r.complianceStatus}.`
              data = { campaignId: pick.id, listingId: listing.id, audienceSize: r.audienceSize, complianceStatus: r.complianceStatus }
              action = "campaign_launched"
            } else {
              spokenResponse = r.error?.toLowerCase().includes("forbidden") || r.error?.toLowerCase().includes("admin")
                ? "You don't have permission to launch campaigns — ask a broker or admin."
                : `I couldn't launch that campaign: ${r.error}`
            }
          }
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
        // tenant anchor (scope burn-down): pin the insert to the caller's resolved brokerage
        const { data: created, error: taskErr } = await service.from("tasks").insert({ ...row, brokerage_id: brokerageId }).select("id, title, due_date").maybeSingle()
        if (taskErr || !created) {
          spokenResponse = "I couldn't save that task — please try again."
        } else {
          spokenResponse = spokenTaskConfirmation(created.title, created.due_date ?? null, contactName)
          data = { taskId: created.id, title: created.title, dueDate: created.due_date ?? null, contactId }
          action = "task_created"
        }
      }
    } else if (intent === "query_flight_risk") {
      // "Who's at flight risk?" — the Recruiting Manager's retention board, spoken.
      if (!brokerageId) {
        spokenResponse = "I can't check retention without a brokerage on your profile."
      } else {
        const { generateRetentionBoard } = await import("@/lib/intelligence/retention-board")
        const board = await generateRetentionBoard(brokerageId, service)
        if (!board || board.scored === 0) {
          spokenResponse = "No retention scores yet — your team's flight risk will show once the radar has run."
        } else if (board.atRisk === 0) {
          spokenResponse = `Good news — none of your ${board.scored} agents are at flight risk right now.`
        } else {
          const worst = board.agents.slice(0, 3).map((a) => `${a.name} at ${a.score}`).join(", ")
          spokenResponse = `${board.atRisk} agent${board.atRisk === 1 ? " is" : "s are"} at flight risk. The most at-risk: ${worst}. Want me to draft their save-plays?`
          data = { atRisk: board.atRisk, agents: board.agents.slice(0, 5) }
        }
      }
    } else if (intent === "query_vendor_coverage") {
      // "Any vendor coverage gaps?" — the forward-looking bench forecast, spoken.
      if (!brokerageId) {
        spokenResponse = "I can't check your bench without a brokerage on your profile."
      } else {
        const { runVendorCoverageForecast } = await import("@/lib/kernel/vendor-coverage-forecast")
        const r = await runVendorCoverageForecast(service, { brokerageId })
        if (r.gaps === 0) {
          spokenResponse = r.deals === 0
            ? "No deals in the pipeline need a vendor right now, so your bench is fine."
            : `Your vendor bench covers what's coming — no gaps across ${r.deals} active deal${r.deals === 1 ? "" : "s"}.`
        } else {
          spokenResponse = `Heads up — you have ${r.gaps} vendor coverage gap${r.gaps === 1 ? "" : "s"} on the way. I've put the details in your approval queue so you can recruit or assign before a deal stalls.`
          data = { coverageGaps: r.gaps, thin: r.thin }
          action = "vendor_coverage_flagged"
        }
      }
    } else if (intent === "query_referral_income") {
      // "How much have I earned in referrals?" — the agent's agent-to-agent referral fees, spoken.
      if (!brokerageId) {
        spokenResponse = "I can't total your referrals without a brokerage on your profile."
      } else {
        const { data: agentRow } = await service.from("agents").select("id").eq("user_id", user.id).eq("brokerage_id", brokerageId).maybeSingle()
        const agentRecordId = (agentRow as { id?: string } | null)?.id ?? null
        if (!agentRecordId) {
          spokenResponse = "I couldn't find your agent profile to total your referrals."
        } else {
          const { data: dists } = await service.from("commission_distributions")
            .select("calculated_amount").eq("brokerage_id", brokerageId).eq("agent_id", agentRecordId).eq("distribution_type", "referral")
          const total = ((dists ?? []) as Array<{ calculated_amount: number | null }>).reduce((s, d) => s + Number(d.calculated_amount ?? 0), 0)
          spokenResponse = total > 0
            ? `You've earned $${Math.round(total).toLocaleString()} from agent-to-agent referrals so far.`
            : "You haven't earned any agent-to-agent referral income yet — refer a relocating client to another agent in your brokerage and you'll earn a fee when it closes."
          data = { referralIncome: Math.round(total * 100) / 100 }
        }
      }
    } else if (intent === "draft_save_plays") {
      // COMMAND — draft gated retention save-plays for the at-risk agents. Authority-gated: a broker/admin
      // manages the team; a solo agent runs their own shop; a plain team agent is refused honestly.
      if (!brokerageId) {
        spokenResponse = "I can't draft save-plays without a brokerage on your profile."
      } else {
        const isStaff = isAdminOrBroker({ user_type: profile.user_type ?? "" })
        let allowed = isStaff
        if (!allowed) {
          const { data: b } = await service.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
          allowed = (b as { plan_tier?: string } | null)?.plan_tier === "solo_agent"
        }
        if (!allowed) {
          spokenResponse = "Only a broker or admin can draft team save-plays — ask yours to run this."
        } else {
          const { draftSavePlaysForAtRiskAgents } = await import("@/lib/recruiting/retention-radar")
          const r = await draftSavePlaysForAtRiskAgents(service, { brokerageId })
          spokenResponse = r.atRisk === 0
            ? "No agents are at flight risk right now, so there's nothing to draft."
            : r.drafted === 0
              ? `Your ${r.atRisk} at-risk agent${r.atRisk === 1 ? " already has" : "s already have"} a save-play waiting in your approval queue.`
              : `Done — I've drafted ${r.drafted} save-play${r.drafted === 1 ? "" : "s"} for your at-risk agents. Review and release them from your approval queue.`
          data = { atRisk: r.atRisk, drafted: r.drafted }
          action = "save_plays_drafted"
        }
      }
    } else if (intent === "create_tenant_user") {
      // PLATFORM-ADMIN command — "make a new agent in the Denver brokerage." Superadmin ONLY
      // (this authenticated route proves the caller's identity; the underlying action also
      // re-checks requireSuperadmin, so this is defence in depth). Routes to the SAME tested,
      // audited createTenantUserAction the god console uses — the "voice admin does it" story.
      // NAMED FOR WHAT IT TESTS. This local was called `isPlatformStaff`, which reads
      // as the four-role roster helper and is not what it does — it is the
      // superadmin-only test (both columns, the is_platform_admin() shape), and that
      // is CORRECT here: creating tenant users is superadmin-only by design, and the
      // underlying action re-checks requireSuperadmin. Deliberately NOT widened to the
      // staff roster; only renamed so it cannot be mistaken for it.
      const isSuperadmin = profile.user_type === "superadmin" || (profile as any).platform_role === "superadmin"
      if (!isSuperadmin) {
        spokenResponse = "Creating platform users is a superadmin-only command — I can't run that for your role."
      } else {
        const extract = await generateText({
          model: resolveModel("openai/gpt-4o-mini"),
          system: `Extract from the command a JSON object: {"email": string, "firstName": string, "lastName": string, "role": one of ["agent","admin","broker","team_lead","tc","isa","compliance_officer","lender","vendor"] (default "agent"), "brokerageName": string or null (the brokerage/company named, else null)}. Respond with ONLY the JSON.`,
          messages: [{ role: "user", content: transcript }],
          maxOutputTokens: 200,
        })
        let ex: { email?: string; firstName?: string; lastName?: string; role?: string; brokerageName?: string | null } = {}
        try { ex = JSON.parse(extract.text.trim().replace(/^```json\s*|\s*```$/g, "")) } catch { /* leave empty */ }

        if (!ex.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ex.email)) {
          spokenResponse = "I need a valid email to create the user — try 'create an agent named Jane Doe at jane@example.com'."
        } else {
          // Resolve the target brokerage: a named one (by name), else the superadmin's own.
          let targetBrokerageId: string | null = brokerageId
          if (ex.brokerageName) {
            const { data: brk } = await service.from("brokerages").select("id, name").ilike("name", `%${ex.brokerageName}%`).is("deleted_at", null).limit(1).maybeSingle()
            targetBrokerageId = (brk as any)?.id ?? null
          }
          if (!targetBrokerageId) {
            spokenResponse = ex.brokerageName ? `I couldn't find a brokerage matching "${ex.brokerageName}".` : "Which brokerage should I add them to?"
          } else {
            const res = await createTenantUserAction({
              brokerageId: targetBrokerageId, email: ex.email,
              firstName: ex.firstName ?? "", lastName: ex.lastName ?? "", userType: ex.role ?? "agent",
            })
            if (res.ok) {
              spokenResponse = `Done — I've created ${ex.firstName ?? "the new user"} as a ${ex.role ?? "agent"} and sent their invite. They'll finish setup from the email.`
              action = "tenant_user_created"
              data = { userId: res.userId, brokerageId: targetBrokerageId, role: ex.role ?? "agent" }
            } else {
              spokenResponse = `I couldn't create that user: ${res.error}`
            }
          }
        }
      }
    } else if (intent === "find_properties") {
      // "Find the Hendersons a 3-bed under 500k in Austin" — the SAME canonical
      // find_properties backend (dispatchTeamCommand → searchPropertiesCore) the
      // premium voice cockpit uses. Resolves the buyer, runs the NL match
      // (inventory + IDX, Fair-Housing-sanitized), reads back the top matches.
      // Read-only. Folded here so the always-on assistant shares one search brain.
      const extract = await generateText({
        model: resolveModel("openai/gpt-4o-mini"),
        system: `From the property-search command extract two lines exactly:\nNAME: the buyer/person/family the search is for (or NONE)\nCRITERIA: the search criteria phrase — beds, baths, price, area, features (or NONE)`,
        messages: [{ role: "user", content: transcript }],
        maxOutputTokens: 80,
      })
      const nameMatch = extract.text.match(/NAME:\s*(.+)/)?.[1]?.trim()
      const critMatch = extract.text.match(/CRITERIA:\s*([\s\S]+)/)?.[1]?.trim()
      const personQuery = nameMatch && nameMatch.toUpperCase() !== "NONE" ? nameMatch : null
      const criteria = critMatch && critMatch.toUpperCase() !== "NONE" ? critMatch : null
      if (!personQuery || !criteria || !brokerageId) {
        spokenResponse = "Who's the search for, and what are they after? Try 'find the Hendersons a 3-bed under 500k in Austin'."
      } else {
        const { dispatchTeamCommand } = await import("@/lib/voice/team-commands")
        const r = await dispatchTeamCommand("find_properties", { person_query: personQuery, query: criteria }, { brokerageId, agentUserId: user.id, firstName: profile.first_name }, service)
        spokenResponse = r.spoken
        data = r.data ?? {}
        action = r.ok ? "properties_found" : null
      }
    } else if (intent === "draft_offer") {
      // "Draft an offer for the Hendersons on 44 Birch at 450" — the SAME canonical
      // voice intake the mobile panel + premium voice use (voiceDraftOffer: extract →
      // fill packet → documents DRAFT). Single-shot per turn; the spoken response asks
      // for anything still missing. DRAFT ONLY — nothing dispatches for signature here.
      if (!brokerageId) {
        spokenResponse = "I can't draft an offer without a brokerage on your profile."
      } else {
        const { voiceDraftOffer } = await import("@/app/actions/voice-assistant/draft-offer-from-voice")
        const r = await voiceDraftOffer({ voiceInput: transcript })
        spokenResponse = r.kind === "error" ? r.error : r.spokenResponse
        data = { kind: r.kind, sessionId: r.kind === "error" ? null : r.sessionId, documentId: r.kind === "finalized" ? r.documentId : null }
        action = r.kind === "finalized" ? "offer_drafted" : r.kind === "error" ? null : "offer_intake_continuing"
      }
    } else if (intent === "draft_listing") {
      // "Draft a listing agreement for the Garcias at 12 Oak" — the SAME canonical
      // voiceDraftListing intake. Single-shot per turn; DRAFT ONLY.
      if (!brokerageId) {
        spokenResponse = "I can't draft a listing without a brokerage on your profile."
      } else {
        const { voiceDraftListing } = await import("@/app/actions/voice-assistant/draft-listing-from-voice")
        const r = await voiceDraftListing({ voiceInput: transcript })
        spokenResponse = r.kind === "error" ? r.error : r.spokenResponse
        data = { kind: r.kind, sessionId: r.kind === "error" ? null : r.sessionId, documentId: r.kind === "finalized" ? r.documentId : null }
        action = r.kind === "finalized" ? "listing_drafted" : r.kind === "error" ? null : "listing_intake_continuing"
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
      // voice_commands.source is the CLIENT SURFACE (web|mobile|pwa|voice_call)
      // and is nullable. This internal route cannot know which one, and
      // "voice_assistant" is the feature, not the surface — so it says nothing
      // rather than guessing.
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
