// lib/voice/inbound-number-binding.ts
// ─────────────────────────────────────────────────────────────────────────────
// INBOUND CALL IDENTITY + BINDING (Twilio-native lane — the single voice engine).
// Historically this module also created Vapi assistants and imported numbers into
// Vapi; that legacy lane is retired (VAPI fully removed). What remains is the
// engine-agnostic INBOUND IDENTITY the reception brain reads (assistant name,
// welcome message, tone, cloned voice, office-hours behavior) plus the toggle
// that binds a tenant's numbers to our own Twilio reception webhook when
// ai_answer_calls is ON. (Filename kept for now to avoid churn on its importers;
// it no longer touches Vapi.)

export interface BusinessHours {
  timezone?: string | null
  start?: string | null // "09:00"
  end?: string | null   // "18:00"
  days?: number[] | null // 1=Mon … 7=Sun
}

export interface InboundIdentity {
  assistantName: string | null
  welcomeMessage: string | null
  tone: string | null
  brokerageName: string | null
  agentName: string | null
  prohibitedLanguage: string[] | null
  elevenlabsVoiceId: string | null
  forwardNumber: string | null
  /** 'always' = the AI owns every call; 'after_hours' = office hours → offer an
   *  immediate transfer to the human, after hours → full reception. */
  answerMode?: "always" | "after_hours" | null
  businessHours?: BusinessHours | null
}

const DAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

/** PURE: the hour-aware behavior rule for the reception prompt. The reception
 *  brain gets the office hours in plain language and branches in-conversation,
 *  no re-provisioning at 9am/6pm. Empty when mode is 'always' (AI owns every
 *  call). {{now}} is substituted with the current time per turn. */
export function composeBusinessHoursRule(mode: string | null | undefined, hours: BusinessHours | null | undefined): string {
  if (mode !== "after_hours" || !hours?.start || !hours?.end) return ""
  const days = (hours.days ?? [1, 2, 3, 4, 5]).map((d) => DAY_NAMES[d] ?? "").filter(Boolean).join(", ")
  const tz = hours.timezone ?? "the office's local time"
  return [
    `OFFICE HOURS: ${hours.start}–${hours.end} (${tz}), ${days}. The current time is {{now}}.`,
    `DURING office hours: greet briefly, then offer to connect the caller to the agent right away. Take a message and full contact details only if they'd rather not be transferred.`,
    `OUTSIDE office hours: handle the call fully yourself — qualify what they need, book showings or appointments, and reassure them the agent will follow up first thing next business day. Never tell a caller to call back later.`,
  ].join("\n")
}

export interface ApplyBindingResult {
  ok: boolean
  applied: boolean
  numbersBound?: number
  error?: string
  notConfigured?: boolean
}

/** The toggle made real: when ai_answer_calls is ON for a profile, bind every
 *  active number in the profile's scope to our own Twilio reception webhook —
 *  no vendor assistant object; the reception brain builds the prompt live from
 *  this profile, so editing the profile IS re-provisioning. When the toggle is
 *  OFF, nothing is changed (numbers keep working as plain lines). */
export async function applyInboundCallBinding(svc: any, profileId: string): Promise<ApplyBindingResult> {
  const { data: profile } = await svc.from("ai_identity_profiles")
    .select("id, brokerage_id, scope_type, scope_id, ai_answer_calls")
    .eq("id", profileId).maybeSingle()
  if (!profile) return { ok: false, applied: false, error: "Profile not found" }
  const p = profile as any
  if (!p.ai_answer_calls) return { ok: true, applied: false }

  // Twilio-native lane: no assistant to ensure — bind the scope's numbers.
  let nq = svc.from("tenant_phone_numbers").select("id").eq("brokerage_id", p.brokerage_id).eq("is_active", true)
  if (p.scope_type === "agent") {
    const { data: agent } = await svc.from("agents").select("user_id").eq("id", p.scope_id).maybeSingle()
    const userId = (agent as any)?.user_id
    if (!userId) return { ok: false, applied: false, error: "Agent has no user account" }
    nq = nq.eq("agent_user_id", userId)
  } else {
    nq = nq.eq("scope_type", "brokerage")
  }
  const { data: nums } = await nq.limit(10)
  const { bindNumberToTwilioLane } = await import("@/lib/voice/twilio-voice")
  let bound = 0
  let lastErr: string | undefined
  for (const num of (nums ?? []) as any[]) {
    const r = await bindNumberToTwilioLane(svc, num.id)
    if (r.ok) bound += 1
    else lastErr = r.error
  }
  if (bound === 0 && lastErr) return { ok: false, applied: false, error: lastErr }
  return { ok: true, applied: true, numbersBound: bound }
}
