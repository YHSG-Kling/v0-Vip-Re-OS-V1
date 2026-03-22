// Pure, synchronous opt-out detection utilities.
// No "use server" — safe to import from both client components and route handlers.

export type OptOutChannel = "email" | "sms" | "phone" | "direct_mail" | "all"

export interface DetectOptOutResult {
  isOptOut: boolean
  channel: OptOutChannel
  confidence: "high" | "medium"
}

export function detectOptOutIntent(text: string): DetectOptOutResult {
  const lower = text.toLowerCase().trim()

  // TCPA-standard single-word commands — highest confidence
  if (/^(stop|stopall|unsubscribe|cancel|end|quit|optout)$/i.test(lower)) {
    return { isOptOut: true, channel: "all", confidence: "high" }
  }

  // High-confidence global phrases
  const globalPhrases = [
    "do not contact me",
    "do not call me",
    "remove me from your list",
    "stop all messages",
    "unsubscribe from all",
    "take me off your list",
    "stop contacting me",
    "please stop",
    "leave me alone",
    "i do not want to be contacted",
    "do not reach out",
  ]
  if (globalPhrases.some((p) => lower.includes(p))) {
    return { isOptOut: true, channel: "all", confidence: "high" }
  }

  // Channel-specific patterns
  if (/stop.*email|no.*email|unsubscribe.*email|email.*stop/i.test(lower)) {
    return { isOptOut: true, channel: "email", confidence: "medium" }
  }
  if (/stop.*text|stop.*sms|no.*text|no.*sms|stop.*message/i.test(lower)) {
    return { isOptOut: true, channel: "sms", confidence: "high" }
  }
  if (/stop.*call|no.*call|do not call|don't call/i.test(lower)) {
    return { isOptOut: true, channel: "phone", confidence: "high" }
  }
  if (/stop.*mail|no.*mail|remove.*mail/i.test(lower)) {
    return { isOptOut: true, channel: "direct_mail", confidence: "medium" }
  }

  return { isOptOut: false, channel: "all", confidence: "high" }
}
