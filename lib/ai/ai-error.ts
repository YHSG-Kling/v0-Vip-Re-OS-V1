// lib/ai/ai-error.ts
//
// One place to turn a raw AI-provider/gateway error into an honest, user-safe
// message. AI generation routes through the Vercel AI Gateway; when that account
// is out of credits or unfunded, the gateway throws a raw billing error (e.g.
// "-1 … free plan") that must NOT leak verbatim into a user-facing toast. This
// classifies the known infra/billing failures and returns a clear line, while
// passing genuine content errors through untouched.

/** True when the error looks like an AI gateway/provider BILLING or CREDIT failure. */
export function isAiBillingError(err: unknown): boolean {
  const msg = errMessage(err).toLowerCase()
  if (!msg) return false
  return (
    /\bcredit(s)?\b/.test(msg) ||
    msg.includes("billing") ||
    msg.includes("payment") ||
    msg.includes("free plan") ||
    msg.includes("free tier") ||
    msg.includes("do not have access to this model") ||
    msg.includes("upgrade to paid") ||
    msg.includes("insufficient") ||
    msg.includes("quota") ||
    msg.includes("out of funds") ||
    msg.includes("balance") ||
    /\b402\b/.test(msg) // Payment Required
  )
}

/** True when the error is a missing/invalid API key/config (vs a content error). */
export function isAiConfigError(err: unknown): boolean {
  const msg = errMessage(err).toLowerCase()
  if (!msg) return false
  return (
    msg.includes("api key") ||
    msg.includes("api_key") ||
    msg.includes("unauthorized") ||
    msg.includes("not configured") ||
    /\b401\b/.test(msg)
  )
}

/**
 * Map any AI error to an honest, user-facing message. Infra/billing/config
 * failures get a clear, non-leaky line; anything else returns its own message
 * (or a safe fallback) so real content problems still surface.
 */
export function friendlyAiError(err: unknown, fallback = "AI generation failed. Please try again."): string {
  if (isAiBillingError(err)) {
    return "AI is temporarily unavailable — the AI gateway is out of credits. An admin needs to add credits/billing to the AI gateway account."
  }
  if (isAiConfigError(err)) {
    return "AI is not configured — the AI gateway API key is missing or invalid. An admin needs to set it up."
  }
  const msg = errMessage(err)
  return msg || fallback
}

function errMessage(err: unknown): string {
  if (!err) return ""
  if (typeof err === "string") return err
  if (err instanceof Error) return err.message
  if (typeof err === "object" && "message" in err) return String((err as { message: unknown }).message ?? "")
  return String(err)
}
