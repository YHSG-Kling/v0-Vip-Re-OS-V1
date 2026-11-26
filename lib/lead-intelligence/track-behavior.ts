/**
 * lib/lead-intelligence/track-behavior.ts — THE behavioral_signals / site_activity writer for a website visit (moved here
 * from app/actions/lead-intelligence.ts in wave 156, lane 156F).
 *
 * WHY IT MOVED. It was an export of a "use server" file, and every export of such a file is a public HTTP endpoint
 * (CLAUDE.md §4). It takes `brokerage_id` as a parameter — correct for its two real callers, which resolve the tenant
 * first — so as a server action ANY caller could post a visit (IP address, user agent, pages, an email capture) into ANY
 * tenant by naming its id, skipping both routes' tenant binding, origin check and throttle. As a plain module it is
 * reachable only from the two public routes that decide the tenant themselves:
 *   · POST /api/track/visitor — the tenant is the brokerage whose PUBLIC SLUG the widget page carries, bound to the
 *     widget page the call came from (Origin + Referer, fail closed) and to the tenant's widget being on;
 *   · POST /api/widget/capture-lead — the tenant is the chat_sessions row the widget session minted.
 * Body unchanged apart from the import of the model wrapper (now dynamic from its own module).
 *
 * Not "use server". Server-only by its callers (route handlers).
 */
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"

export async function trackBehavior(sessionData: {
  visitor_id: string
  page_visited: string
  time_spent: number
  action_taken?: string
  search_terms?: string[]
  calculator_inputs?: any
  ip_address?: string
  user_agent?: string
  brokerage_id?: string  // REQUIRED — see the tenancy note below
  /**
   * CONSENTED EMAIL CAPTURE (wave 103, lane 103D; m706; owner answer 1). The visit carried an email.
   * It is stored on the signal ONLY with an explicit consent artifact — either the visitor ticked the
   * box on this request (`consented: true` → the one consent writer records it here) or the caller
   * already wrote the artifact through that writer on this request (`consent_event_id`, read back in
   * this tenant). Anything else stores nothing (lib/lead-intelligence/visitor-email-capture.ts —
   * the ONE writer of email_captured; fail closed). Once stored the identify loop fires: the
   * tenant's contact with that email is linked and the person evidence is recorded.
   */
  email_capture?: {
    email: string
    consented?: boolean
    consent_text?: string | null
    consent_event_id?: string | null
  }
}) {
  // ── TENANCY IS NOT OPTIONAL ON THIS TABLE ───────────────────────────────
  // behavioral_signals / site_activity / intelligence_signals_log all carry a
  // NULLABLE brokerage_id, and their RLS policy is
  //     (brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())
  // (verified live). A row written with brokerage_id NULL is therefore
  // readable by EVERY brokerage on the platform — and the rows this function
  // writes are a named visitor's IP address, user agent and inferred intent.
  // The previous `?? null` stamped exactly that. Refuse instead: an untenanted
  // behavioural row is a cross-tenant PII leak, not a slightly worse row.
  if (!isValidUUID(sessionData.brokerage_id)) {
    return {
      success: false,
      error:
        "brokerage_id is required. An untenanted behavioural signal is readable by every brokerage under this table's RLS policy.",
    }
  }
  const brokerageId = sessionData.brokerage_id

  try {
    const supabase = createServiceClient()
    const { generateAIJSON } = await import("@/app/actions/ai-generate")

    // Detect location from IP (simplified - would use IP geolocation service)
    const location = { city: "Unknown", state: "Unknown", zip: "" }

    // Get or create behavioral signal.
    // Scoped by brokerage: visitor_id is a caller-minted cookie value with no
    // uniqueness guarantee, so an unscoped lookup could attach one brokerage's
    // visitor to another brokerage's signal row.
    const { data: signal, error: signalError } = await supabase
      .from("behavioral_signals")
      .select("*")
      .eq("visitor_id", sessionData.visitor_id)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (signalError && signalError.code !== "PGRST116") {
      throw signalError
    }

    let signalId: string
    let totalSessions = 1

    if (signal) {
      totalSessions = (signal.total_sessions || 0) + 1
      // Update existing signal
      await sentinelWrite(supabase, supabase
        .from("behavioral_signals")
        .update({
          last_seen_date: new Date().toISOString(),
          total_sessions: totalSessions,
          ip_address: sessionData.ip_address,
          user_agent: sessionData.user_agent,
        })
        .eq("id", signal.id), { table: "behavioral_signals", flow: "behavioral_signals_write", reason: "visit analytics on an existing signal" })

      signalId = signal.id
    } else {
      // Create new signal — brokerage_id is stamped AT THE INSERT, never null.
      const { data: newSignal, error: newSignalError } = await supabase
        .from("behavioral_signals")
        .insert({
          visitor_id: sessionData.visitor_id,
          brokerage_id: brokerageId,
          ip_address: sessionData.ip_address,
          user_agent: sessionData.user_agent,
          city: location.city,
          state: location.state,
          zip: location.zip,
        })
        .select()
        .maybeSingle()

      // Was `newSignal!.id` on an undestructured result: a refused insert came
      // back as null and threw a TypeError instead of reporting the refusal.
      if (newSignalError) {
        console.error("[lead-intelligence] Behavioral signal insert error:", newSignalError)
        return { success: false, error: newSignalError.message }
      }
      if (!newSignal) return { success: false, error: "Behavioral signal was not created" }

      signalId = newSignal.id
    }

    // Log site activity — inherits brokerage AND contact from the signal.
    //
    // `contact_id` WAS THE MISSING HALF. lib/portal/portal-clients-read.ts:80
    // reads site_activity.contact_id as one of the two arms of a portal client's
    // "last activity" stamp (the other being portal_event_stream.contact_id,
    // which is written) — and no writer had ever set it, so that arm returned
    // nothing on every call and a client's on-site browsing never counted as
    // activity. The contact is not a new fact to look up: identifyVisitor stamps
    // it onto the signal at app/actions/lead-intelligence.ts:2201, so from the
    // visit AFTER an identification the signal already carries it, and it
    // inherits down here exactly the way brokerage_id does. Null until the
    // visitor is identified, which is the honest state — an anonymous session
    // belongs to no contact.
    const { error: activityError } = await supabase.from("site_activity").insert({
      behavioral_signal_id: signalId,
      brokerage_id: brokerageId,
      contact_id: (signal as { contact_id?: string | null } | null)?.contact_id ?? null,
      page_visited: sessionData.page_visited,
      time_on_page_seconds: sessionData.time_spent,
      action_taken: sessionData.action_taken,
      search_terms: sessionData.search_terms || [],
    })
    // supabase-js RESOLVES a refusal (CLAUDE.md §3): this insert was unchecked,
    // so a blocked write left the visit unlogged and the caller was told the
    // session tracked fine.
    if (activityError) {
      console.error("[lead-intelligence] site_activity insert was refused:", activityError.message)
    }

    // ── CONSENTED EMAIL CAPTURE → the identify loop (wave 103, lane 103D; m706) ──────────────────
    // THE ONE door: the signal exists (above, tenant-stamped), the email goes through
    // captureConsentedVisitorEmail, which stores it only once a consent artifact exists (written
    // here through persistContactConsent, or read back by the id the widget form hands over) and
    // then runs the same match resolveIdentity runs for staff. Best-effort for the VISIT: a refused
    // capture is reported on the result, never a tracking failure.
    let emailCapture: { stored: boolean; reason?: string; identified?: boolean } | undefined
    if (sessionData.email_capture) {
      const { captureConsentedVisitorEmail } = await import("@/lib/lead-intelligence/visitor-email-capture")
      const ec = sessionData.email_capture
      const captured = await captureConsentedVisitorEmail(supabase, {
        brokerageId,
        signalId,
        email: ec.email,
        consent: ec.consent_event_id
          ? { consentEventId: ec.consent_event_id }
          : { consented: ec.consented === true, consentText: ec.consent_text ?? null, consentSource: sessionData.page_visited, ipAddress: sessionData.ip_address ?? null, userAgent: sessionData.user_agent ?? null },
        actorUserId: null,
      })
      emailCapture = captured.stored
        ? { stored: true, identified: captured.identity.identified }
        : { stored: false, reason: captured.reason }
      if (!captured.stored && captured.reason !== "no_consent") console.warn(`[lead-intelligence] visitor email not captured (${captured.reason}): ${captured.error ?? ""}`)
    }

    // Get page history for AI analysis if multiple sessions
    if (totalSessions >= 2) {
      const { data: pageHistory } = await supabase
        .from("site_activity")
        .select("*")
        .eq("behavioral_signal_id", signalId)
        .order("timestamp", { ascending: false })
        .limit(20)

      const promptPageList = pageHistory?.map((p: Record<string, unknown>) => p.page_visited).join(", ") || "None"
      const calculatorList = pageHistory?.filter((p: Record<string, unknown>) => (p.action_taken as string | null)?.includes("calculator")).map((p: Record<string, unknown>) => p.action_taken).join(", ") || "None"

      const prompt = `Analyze user behavior to determine real estate intent:

Behavior Data:
- Pages viewed: ${promptPageList}
- Calculators used: ${calculatorList}
- Search terms: ${sessionData.search_terms?.join(", ") || "None"}
- Time spent: ${sessionData.time_spent} seconds
- Total sessions: ${totalSessions}
- Location: ${location.city}, ${location.state}

Determine:
{
  "intent_type": "buyer|seller|investor|researcher|unknown",
  "confidence": 0-100,
  "urgency": "low|medium|high",
  "price_range": "estimate or null",
  "timeline_indicator": "immediate|1-3_months|3-6_months|6-12_months|12+_months|researching",
  "ready_for_contact": boolean,
  "key_indicators": ["list of signals that led to this conclusion"]
}

Buyer signals: affordability calculator, mortgage calculator, neighborhood research, multiple listing views
Seller signals: home value tool, seller net calculator, CMA requests, listing timeline research
Investor signals: ROI calculators, rental income tools, market analysis pages`

      try {
        const intentData = await generateAIJSON(prompt)
        const intent = intentData.data as Record<string, unknown> | null

        if (!intent) {
          return { success: true, signalId, emailCapture }
        }

        // Update behavioral signal with AI insights
        await sentinelWrite(supabase, supabase
          .from("behavioral_signals")
          .update({
            intent_type: intent.intent_type as string | null,
            intent_confidence_score: intent.confidence as number | null,
          })
          .eq("id", signalId), { table: "behavioral_signals", flow: "behavioral_signals_write", reason: "AI intent annotation; recomputed on the next visit" })

        // Flag for enrichment if high intent and multiple sessions
        if ((intent.confidence as number) >= 70 && totalSessions >= 3) {
          await sentinelWrite(supabase, supabase.from("intelligence_signals_log").insert({
            lead_profile_id: signalId,
            brokerage_id: brokerageId,
            signal_type: "high_intent_behavioral",
            signal_data_json: intent,
            signal_strength: 10,
            detected_at: new Date().toISOString(),
          }), { table: "intelligence_signals_log", flow: "intelligence_signals_log_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
        }

        return { success: true, signalId, intent, emailCapture }
      } catch (aiError) {
        console.error("[v0] AI intent analysis error:", aiError)
        return { success: true, signalId, emailCapture }
      }
    }

    return { success: true, signalId, emailCapture }
  } catch (error) {
    console.error("[v0] Error tracking behavior:", error)
    return { success: false, error: String(error) }
  }
}
