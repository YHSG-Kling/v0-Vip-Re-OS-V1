"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
// `openai` (the raw transcription model handle) and `callConnector` (the raw
// asset download) were both imported ONLY for the inline Whisper block that used
// to live in transcribeAudio. That block is gone — the fetch, the cap, the vendor
// choice and the metering all belong to lib/repurpose/transcribe-core.ts now — so
// the imports go with it rather than sitting here as a second way to do it.
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

/**
 * AI Voice Transcription & Call Analysis System
 * Transcribes calls, extracts insights, and generates follow-up actions
 */

const CallAnalysisSchema = z.object({
  summary: z.string(),
  duration: z.string(),
  sentiment: z.enum(["very_positive", "positive", "neutral", "negative", "very_negative"]),
  keyTopics: z.array(z.string()),
  clientConcerns: z.array(z.string()),
  agentCommitments: z.array(z.object({
    commitment: z.string(),
    deadline: z.string().optional(),
  })),
  clientCommitments: z.array(z.object({
    commitment: z.string(),
    deadline: z.string().optional(),
  })),
  actionItems: z.array(z.object({
    action: z.string(),
    assignedTo: z.enum(["agent", "client", "vendor", "other"]),
    priority: z.enum(["high", "medium", "low"]),
    dueDate: z.string().optional(),
  })),
  nextSteps: z.array(z.string()),
  propertyMentions: z.array(z.object({
    address: z.string().optional(),
    mlsNumber: z.string().optional(),
    context: z.string(),
  })),
  financialDiscussions: z.array(z.object({
    topic: z.string(),
    amount: z.string().optional(),
    context: z.string(),
  })),
  scheduledFollowUp: z.object({
    scheduled: z.boolean(),
    dateTime: z.string().optional(),
    purpose: z.string().optional(),
  }),
  complianceFlags: z.array(z.object({
    flag: z.string(),
    severity: z.enum(["info", "warning", "critical"]),
    context: z.string(),
  })),
  coachingOpportunities: z.array(z.string()),
})

// Analyze a call transcript
export async function analyzeCallTranscript(params: {
  transcriptId?: string
  transcript: string
  contactId: string
  agentId: string
  callDuration?: number
  callType?: "inbound" | "outbound"
}) {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid contact or agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get contact context.
    //
    // `error` is destructured and the read FAILS CLOSED. supabase-js RESOLVES a
    // refused query, so `const { data: contact }` alone read "you may not look at
    // this contact" as "this contact has no details" — and the action carried on,
    // prompting the model with `undefined undefined` for the client's name and
    // then writing `brokerage_id: contact?.brokerage_id` (undefined) onto
    // `call_analyses`.
    //
    // It matters for the tenant too. This contact row IS the anchor
    // `activities_set_brokerage` reads for the activity written below: the
    // trigger is SECURITY INVOKER, `supabase` is the SESSION client, and its
    // `contact_id → contacts` lookup runs under exactly the RLS this read runs
    // under. So a refusal here is precisely the case where the trigger comes back
    // empty — and because `activities.brokerage_id` is NOT NULL, that activity
    // was refused 23502, not written untenanted.
    //
    // BEHAVIOUR CHANGE, flagged rather than slipped in: this action previously
    // returned an AI analysis built on a contact it could not read. It now
    // refuses.
    // AMBIGUOUS EMBED — the `!transactions_contact_id_fkey` hint is load-bearing.
    // `transactions` carries THREE foreign keys to `contacts`
    // (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
    // transactions_seller_contact_id_fkey), so the bare `transactions(*)` this
    // replaces was unresolvable and PostgREST refused the ENTIRE request with
    // PGRST201. The fail-closed guard below then reported "Could not read contact …"
    // on every call — the read never failed on permissions, it failed on grammar.
    //
    // `contact_id` is the party WE represent on the deal (documented on the canonical
    // writer, lib/transactions/offer-bridge.ts:302). "Active Deals" in the prompt
    // below means the deals this client is OURS on, whichever side they sat. The
    // buyer/seller slots are side mirrors — null on the other side — so either would
    // under-count a client who has both bought and sold with us.
    //
    // Columns are named, not `*` inside an embed (defect #214). `contacts.pipeline_stage`
    // was also read below and does NOT exist on this table; the live lifecycle column
    // is `lifecycle_state`.
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select(`
        first_name, last_name, contact_type, lifecycle_state, brokerage_id,
        transactions!transactions_contact_id_fkey(status)
      `)
      .eq("id", params.contactId)
      .single()

    if (contactError || !contact) {
      return {
        success: false,
        error: contactError
          ? `Could not read contact ${params.contactId}: ${contactError.message}`
          : `Contact ${params.contactId} not found`,
      }
    }

    const { object: analysis } = await generateObject({
      model: "openai/gpt-4o",
      schema: CallAnalysisSchema,
      prompt: `Analyze this real estate phone call transcript:

CALL DETAILS:
- Type: ${params.callType || "Unknown"}
- Duration: ${params.callDuration ? `${Math.round(params.callDuration / 60)} minutes` : "Unknown"}

CLIENT INFO:
- Name: ${contact?.first_name} ${contact?.last_name}
- Type: ${contact?.contact_type || "Unknown"}
- Stage: ${contact?.lifecycle_state || "Unknown"}
- Active Deals: ${contact?.transactions?.filter((t: any) => t.status === "active").length || 0}

TRANSCRIPT:
${params.transcript}

Extract:
1. Concise summary of the call
2. Key topics discussed
3. Any concerns the client expressed
4. Commitments made by the agent (things they promised to do)
5. Commitments made by the client
6. Clear action items with priorities
7. Any properties mentioned
8. Financial discussions (prices, budgets, offers, etc.)
9. Scheduled follow-ups
10. Any compliance concerns (fair housing, discrimination, unauthorized promises)
11. Coaching opportunities for agent improvement`,
    })

    // Save analysis. LIVE-SCHEMA FACT: call_analyses.sentiment CHECK allows
    // only positive|neutral|negative|mixed — the model's very_positive /
    // very_negative violated it and this insert was silently dropped. Map to
    // the CHECK vocabulary.
    const sentimentForDb = analysis.sentiment.replace(/^very_/, "")
    const { data: savedAnalysis } = await supabase
      .from("call_analyses")
      .insert({
        transcript_id: params.transcriptId,
        contact_id: params.contactId,
        agent_id: params.agentId,
        brokerage_id: contact?.brokerage_id,
        transcript: params.transcript,
        call_type: params.callType,
        call_duration: params.callDuration,
        summary: analysis.summary,
        sentiment: sentimentForDb,
        key_topics: analysis.keyTopics,
        client_concerns: analysis.clientConcerns,
        agent_commitments: analysis.agentCommitments,
        client_commitments: analysis.clientCommitments,
        action_items: analysis.actionItems,
        next_steps: analysis.nextSteps,
        property_mentions: analysis.propertyMentions,
        financial_discussions: analysis.financialDiscussions,
        scheduled_follow_up: analysis.scheduledFollowUp,
        compliance_flags: analysis.complianceFlags,
        coaching_opportunities: analysis.coachingOpportunities,
        analyzed_at: new Date().toISOString(),
      })
      .select()
      .single()

    // Create tasks from action items
    const agentTasks = analysis.actionItems.filter(a => a.assignedTo === "agent")
    if (agentTasks.length > 0) {
      // pass 14 (variable-insert sweep): tasks assignment keys on
      // assigned_to_agent_id (agents class), brokerage_id is NOT NULL, and
      // source_id doesn't exist — the analysis id rides the description.
      const tasks = agentTasks.map(item => ({
        brokerage_id: contact?.brokerage_id,
        assigned_to_agent_id: params.agentId,
        contact_id: params.contactId,
        title: item.action,
        description: savedAnalysis?.id ? `From call analysis ${savedAnalysis.id}` : null,
        priority: item.priority,
        status: "pending",
        due_date: item.dueDate || null,
        source: "call_analysis",
      }))

      await supabase.from("tasks").insert(tasks)
    }

    // Log compliance flags if any
    if (analysis.complianceFlags.length > 0) {
      // compliance_events.actor_user_id FKs users; params.agentId is an agents.id, so resolve the
      // agent's user_id for the actor.
      const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", params.agentId).maybeSingle()
      const { error: complianceLogError } = await supabase.from("compliance_events").insert({
        // Mapped onto the canonical gate-event schema (13 consumers); severity + details carry the
        // richer voice-flag metadata.
        actor_role: "agent",
        actor_user_id: agentRow?.user_id ?? null,
        brokerage_id: contact?.brokerage_id,
        entity_type: "contact",
        entity_id: params.contactId,
        gate_name: "call_compliance_flags",
        allowed: false,
        violations: analysis.complianceFlags,
        severity: analysis.complianceFlags.some(f => f.severity === "critical") ? "high" : "medium",
        details: {
          call_analysis_id: savedAnalysis?.id,
          flags: analysis.complianceFlags,
        },
      })
      if (complianceLogError) {
        // The call analysis is saved and returned; this row is the compliance
        // record of what the call tripped. A refusal must not read as "the call
        // was clean".
        console.error(
          `[ai-voice-transcription] compliance_events insert REFUSED for contact ${params.contactId} — ${analysis.complianceFlags.length} call flag(s) are UNRECORDED:`,
          complianceLogError.message,
        )
      }
    }

    // TENANT: the contact this call is filed against — the same record the
    // SECURITY INVOKER trigger would have read, now read once, above, by this
    // action itself and proven readable before we get here. Resolved once per
    // action, not once per row. An explicit stamp wins over the trigger (it only
    // fires `IF NEW.brokerage_id IS NULL`), so this is strictly compatible with
    // the rows the trigger was already resolving.
    const { error: callActivityError } = await supabase.from("activities").insert({
      brokerage_id:  contact.brokerage_id,
      contact_id:    params.contactId,
      agent_id:      params.agentId,
      activity_type: "call",
      title:         "Call completed",
      notes:         analysis.summary,
      outcome:       "completed",
      status:        "completed",
    })
    // Destructured: a refused insert RESOLVES, so the bare `await` this replaced
    // reported a completed call on the contact timeline that was never recorded.
    if (callActivityError) {
      console.error(
        `[voice-transcription] "call" activity NOT recorded for contact ${params.contactId}:`,
        callActivityError.message,
      )
    }

    revalidatePath(`/crm/contacts/${params.contactId}`)

    return {
      success: true,
      analysis: savedAnalysis,
      summary: {
        sentiment: analysis.sentiment,
        actionItemsCount: analysis.actionItems.length,
        complianceFlagsCount: analysis.complianceFlags.length,
        hasFollowUp: analysis.scheduledFollowUp.scheduled,
      },
    }
  } catch (error) {
    console.error("[AI Call Analysis Error]:", error)
    return handleError(error, "analyzeCallTranscript")
  }
}

// Generate call summary email
export async function generateCallSummaryEmail(params: {
  analysisId: string
  recipientType: "client" | "agent" | "both"
  agentId: string
}) {
  // Tenant for the AI cost ledger — SESSION, never `params.agentId` (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: analysis } = await supabase
      .from("call_analyses")
      .select("*, contacts(*)")
      .eq("id", params.analysisId)
      .single()

    if (!analysis) {
      return { success: false, error: "Analysis not found" }
    }

    const { text: email } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `Generate a professional follow-up email after a real estate phone call.

CALL SUMMARY: ${analysis.summary}

KEY POINTS DISCUSSED:
${analysis.key_topics?.join("\n- ")}

COMMITMENTS MADE:
Agent: ${analysis.agent_commitments?.map((c: any) => c.commitment).join(", ") || "None"}
Client: ${analysis.client_commitments?.map((c: any) => c.commitment).join(", ") || "None"}

NEXT STEPS:
${analysis.next_steps?.join("\n- ")}

Generate a warm, professional email to the ${params.recipientType === "client" ? "client" : "agent"} summarizing the call and next steps. Keep it concise but thorough.`,
    })

    return { success: true, email }
  } catch (error) {
    return handleError(error, "generateCallSummaryEmail")
  }
}

// Get call insights for agent performance
export async function getAgentCallInsights(params: {
  agentId: string
  timeframe: "week" | "month" | "quarter"
}) {
  const supabase = await createClient()

  try {
    const days = params.timeframe === "week" ? 7 : params.timeframe === "month" ? 30 : 90
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    const { data: analyses } = await supabase
      .from("call_analyses")
      .select("*")
      .eq("agent_id", params.agentId)
      .gte("analyzed_at", startDate)

    if (!analyses || analyses.length === 0) {
      return { success: true, insights: null, message: "No calls analyzed in this timeframe" }
    }

    const { object: insights } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        totalCalls: z.number(),
        avgCallDuration: z.number(),
        sentimentDistribution: z.object({
          positive: z.number(),
          neutral: z.number(),
          negative: z.number(),
        }),
        topTopics: z.array(z.string()),
        commonConcerns: z.array(z.string()),
        strengthAreas: z.array(z.string()),
        improvementAreas: z.array(z.string()),
        complianceScore: z.number(),
        conversionIndicators: z.string(),
        recommendations: z.array(z.string()),
      }),
      prompt: `Analyze this agent's call performance over ${days} days:

CALL DATA (${analyses.length} calls):
${analyses.map(a => `
- Sentiment: ${a.sentiment}
- Topics: ${a.key_topics?.join(", ")}
- Concerns: ${a.client_concerns?.join(", ")}
- Compliance flags: ${a.compliance_flags?.length || 0}
- Coaching notes: ${a.coaching_opportunities?.join("; ")}
`).join("\n")}

Provide:
1. Overall performance metrics
2. Sentiment distribution
3. Most discussed topics
4. Common client concerns
5. Agent strengths
6. Areas for improvement
7. Compliance score (0-100)
8. Conversion indicators
9. Specific recommendations for improvement`,
    })

    return { success: true, insights }
  } catch (error) {
    return handleError(error, "getAgentCallInsights")
  }
}

// Transcribe a call recording and LAND THE TRANSCRIPT ON THE CONTACT RECORD.
//
// Schema notes: call_transcriptions is keyed by voice_call_id + brokerage_id
// (both NOT NULL) and carries a UNIQUE index on voice_call_id
// (uq_call_transcriptions_voice_call, verified live). It holds full_text,
// speaker_turns (jsonb), word_count, language and transcribed_at — there is no
// "processing/completed" status column. So we fetch the audio, transcribe
// synchronously, and insert a single row when we have the final text. Failures
// don't write a row.
//
// ── OWNER RULING, AND WHAT IT REVEALED ───────────────────────────────────────
// Carried since wave 2 as "recorded, needs an owner decision". The ruling:
//
//     "transcribeaudio is necessary and then added to the contact record, etc to
//      use later.. which elevenlabs can do or other free options"
//
// KEEP IT — and it was missing the half that makes it worth having. What it did
// with its output before this wave was: write ONE `call_transcriptions` row and
// return the string. That row is a LEAF. Its only readers are two dashboards
// (app/dashboard/isa/page.tsx:213 and app/dashboard/voice/review/[callId]/page.tsx:117),
// and nothing else on the platform can see it. In particular the transcript was
// invisible to:
//
//   · `lib/voice/call-analysis.ts:sweepVoiceCallIntelligence`, whose candidate
//     query is `.not("transcription", "is", null)` — a column this action never
//     touched;
//   · `call_analyses` (the row the coaching brief, the intelligence dashboards,
//     `runMeetingFollowthroughForCall` and `composeMeetingRecap` all read);
//   · `contact_memory`, the per-contact vector recall the drafting rails query
//     through `lib/ai-isa/brand-voice-prompt.ts`.
//
// So the transcript existed and was not "usable later" anywhere. THREE writes
// now close that, all onto rails that already exist:
//
//   1. `voice_calls.transcription` — THE one voice-transcript ledger. Written
//      only when it is EMPTY, so a live turn-by-turn transcript from
//      app/api/voice/twilio/turn/route.ts is never overwritten by a post-hoc
//      recording transcription.
//   2. `lib/voice/call-analysis.ts:analyzeVoiceCallRow` — THE one conversation
//      -intel extractor, stamped with its own provenance. This is EXACTLY the
//      shape `lib/connections/zoom-transcripts.ts:210-222` uses: a transcript
//      arriving from outside the turn loop attaches to the ledger and is analyzed
//      through the shared extractor, never a fork. It is called directly rather
//      than left to the hourly sweep because `isAnalyzableCall` requires a
//      `Caller:`-prefixed line, which is a shape the TURN LOOP produces and a
//      recording transcription does not — the sweep would skip it forever.
//   3. `lib/agents/contact-memory.ts:embedContactMemory` — the extended-memory
//      rail, so the transcript is recallable by the per-contact agents and the
//      portal chat. Best-effort, matching the kernel fanout's own call at
//      lib/kernel/event-fanout.ts:711-723.
//
// TENANT. `voice_calls.brokerage_id` is the record's own tenant and is what the
// `call_transcriptions` row and the analysis carry. The `contact_memory` row is
// about the CONTACT, so its brokerage_id is resolved THROUGH THE CONTACT ROW —
// a different record, therefore a different read, `error` destructured. Where the
// call has no contact_id, or the contact cannot be read, NOTHING is written and
// the reason is named in the result. Ids are never carried between spaces:
// `voice_calls.contact_id` is a contacts.id and is used only as one.
//
// ⚠️ AUTH IS LOAD-BEARING HERE, AND IT WAS ABSENT. This export had no gate at
// all. The explicit session gate below is one, and the lookup is scoped to the
// caller's brokerage so the id cannot be borrowed either.
//
// ── THE SSRF SURFACE, WHICH THE RULING DOES NOT WAIVE ────────────────────────
// "Necessary" settles whether the action exists, not that it should fetch
// arbitrary addresses. `audioUrl` is now checked against
// `lib/security/audio-source-allowlist.ts:platformAudioHostRules()` — the hosts
// THIS system produces or stores audio on, each rule naming the code that puts
// audio there. The fetch, the byte cap, the vendor budget gate and the vendor
// ledger all live in the ONE transcription primitive
// (lib/repurpose/transcribe-core.ts:transcribeMediaUrl), which replaced the
// inline Whisper block that used to sit here — so this lane and the repurpose
// lane can no longer drift on which vendor transcribes or how big a file may be.
export async function transcribeAudio(params: {
  voiceCallId: string
  audioUrl: string
  language?: string
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const supabase = await createClient()

  try {
    // Look up the parent voice_calls row to recover brokerage_id — and the two
    // fields the contact-side rails need: the contact this call is filed against,
    // and whether the ledger already carries a transcript.
    const { data: voiceCall, error: lookupErr } = await supabase
      .from("voice_calls")
      .select("id, brokerage_id, contact_id, agent_id, direction, duration_seconds, transcription")
      .eq("id", params.voiceCallId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (lookupErr || !voiceCall) {
      return { success: false, error: "voice_call not found" }
    }

    // ONE primitive: allowlist → fetch → content-type → 25MB cap → budget gate →
    // vendor → ledger. ElevenLabs Scribe is the owner's named provider and rides
    // the platform ELEVENLABS_API_KEY through the `elevenlabs` connector, the
    // same credential path as every other ElevenLabs egress here; it falls back
    // to the existing Whisper path only when that key is unset, and refuses
    // honestly when neither vendor is configured.
    const { platformAudioHostRules } = await import("@/lib/security/audio-source-allowlist")
    const { transcribeMediaUrl } = await import("@/lib/repurpose/transcribe-core")
    const spoken = await transcribeMediaUrl(params.audioUrl, {
      allowedHosts: platformAudioHostRules(),
      brokerageId: voiceCall.brokerage_id,
      provider: "elevenlabs",
      language: params.language ?? null,
      systemSource: "call_transcription",
    })
    if (!spoken.success) {
      // The reason is carried through rather than flattened: "that host is not
      // one we store audio on" and "no vendor is configured" are different facts
      // about a refusal, and a surface that cannot tell them apart tells the user
      // the wrong thing.
      return { success: false, error: spoken.message, reason: spoken.reason }
    }
    const transcriptText = spoken.transcript

    const { data: transcription, error: insertErr } = await supabase
      .from("call_transcriptions")
      .insert({
        voice_call_id: voiceCall.id,
        brokerage_id: voiceCall.brokerage_id,
        full_text: transcriptText,
        speaker_turns: [],
        word_count: transcriptText.split(/\s+/).filter(Boolean).length,
        language: params.language ?? null,
        transcribed_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (insertErr || !transcription) {
      return { success: false, error: insertErr?.message ?? "Failed to persist transcription" }
    }

    // ── 1. THE LEDGER ─────────────────────────────────────────────────────────
    // `voice_calls.transcription` is what every downstream voice surface reads.
    // Only filled when EMPTY: the turn loop's interleaved `Caller:`/`AI:`
    // transcript is the live record of the conversation and a post-hoc
    // transcription of the recording must not replace it.
    let ledgerStamped = false
    if (!(voiceCall.transcription ?? "").trim()) {
      const { error: ledgerErr } = await supabase
        .from("voice_calls")
        .update({ transcription: transcriptText.slice(0, 60_000) })
        .eq("id", voiceCall.id)
        .eq("brokerage_id", voiceCall.brokerage_id)
      // Destructured: supabase-js RESOLVES a refused update, so a bare await here
      // would report a transcript on the call record that was never written.
      if (ledgerErr) {
        console.error(
          `[voice-transcription] voice_calls.transcription NOT stamped for call ${voiceCall.id}:`,
          ledgerErr.message,
        )
      } else {
        ledgerStamped = true
      }
    }

    // ── 2. THE CONTACT-SIDE INSIGHT ROW ───────────────────────────────────────
    // The Zoom lane's shape exactly: attach, then analyze through THE shared
    // extractor with its own provenance. Deduped on the live UNIQUE index
    // (uq_call_analyses_voice_call) rather than racing it. Best-effort — a
    // failed analysis never invalidates the transcript that is already persisted.
    let analyzed = false
    if (voiceCall.contact_id) {
      const { data: priorAnalysis, error: priorErr } = await supabase
        .from("call_analyses")
        .select("id")
        .eq("voice_call_id", voiceCall.id)
        .maybeSingle()
      if (priorErr) {
        console.error(
          `[voice-transcription] could not check for a prior analysis on call ${voiceCall.id}:`,
          priorErr.message,
        )
      } else if (!priorAnalysis) {
        const { analyzeVoiceCallRow } = await import("@/lib/voice/call-analysis")
        const res = await analyzeVoiceCallRow(
          supabase,
          {
            id: voiceCall.id,
            brokerage_id: voiceCall.brokerage_id,
            contact_id: voiceCall.contact_id,
            agent_id: voiceCall.agent_id ?? null,
            direction: voiceCall.direction ?? null,
            // The ledger's own duration wins; the vendor's measured duration is
            // the fallback, and null when NEITHER is known — never a fabricated 0,
            // which would render as a zero-length call on the coaching surfaces.
            duration_seconds:
              voiceCall.duration_seconds ??
              (spoken.durationSeconds != null ? Math.round(spoken.durationSeconds) : null),
            transcription: transcriptText,
          },
          "audio_transcription",
        )
        analyzed = res.ok
        if (!res.ok) {
          console.error(`[voice-transcription] call analysis failed for ${voiceCall.id}:`, res.error)
        }
      }
    }

    // ── 3. THE EXTENDED-MEMORY RAIL ───────────────────────────────────────────
    // TENANT RESOLVED THROUGH THE RECORD THE ROW IS ABOUT. The memory belongs to
    // the CONTACT, so its brokerage_id comes from the contact's own row — not
    // from the caller's context and not from the call's. Where the contact is
    // absent or unreadable, nothing is written and the reason is returned.
    let memoryId: string | null = null
    let memorySkipped: string | null = null
    if (!voiceCall.contact_id) {
      memorySkipped = "voice_call has no contact_id — nothing to file the transcript against"
    } else {
      const { data: contact, error: contactErr } = await supabase
        .from("contacts")
        .select("id, brokerage_id")
        .eq("id", voiceCall.contact_id)
        .maybeSingle()
      if (contactErr) {
        memorySkipped = `contact ${voiceCall.contact_id} unreadable: ${contactErr.message}`
      } else if (!contact?.brokerage_id) {
        memorySkipped = `contact ${voiceCall.contact_id} resolved no tenant`
      } else {
        const { embedContactMemory } = await import("@/lib/agents/contact-memory")
        const embedded = await embedContactMemory({
          brokerageId: contact.brokerage_id,
          entityType: "contact",
          entityId: contact.id,
          // `agent_note` — the closest admitted value of the LIVE CHECK
          // (contact_memory_memory_kind_check: transparency_update | portal_message
          // | agent_note | showing_feedback | persona_signal | preference |
          // bba_event | agent_message). The provenance that makes it a CALL rather
          // than a typed note rides source_table/source_id + metadata, which is
          // what a reader can filter on without a schema change.
          memoryKind: "agent_note",
          // embedContactMemory caps its own input at 4000 chars for retrieval
          // quality (lib/agents/contact-memory.ts:65). That is a RECALL index,
          // not the record: the full text is already durable on
          // call_transcriptions.full_text and voice_calls.transcription above, so
          // nothing is lost by the cap.
          content: transcriptText,
          sourceTable: "call_transcriptions",
          sourceId: transcription.id,
          metadata: {
            provenance: "call_transcription",
            voice_call_id: voiceCall.id,
            transcription_provider: spoken.provider,
            duration_seconds: spoken.durationSeconds,
            language: params.language ?? null,
          },
        })
        if (embedded.ok) memoryId = embedded.memoryId ?? null
        else memorySkipped = embedded.error ?? "embedding failed"
      }
    }

    if (voiceCall.contact_id) revalidatePath(`/crm/contacts/${voiceCall.contact_id}`)

    return {
      success: true,
      transcriptionId: transcription.id,
      transcript: transcriptText,
      provider: spoken.provider,
      ledgerStamped,
      analyzed,
      memoryId,
      memorySkipped,
    }
  } catch (error) {
    return handleError(error, "transcribeAudio")
  }
}
