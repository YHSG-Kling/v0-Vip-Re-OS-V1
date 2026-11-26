// lib/providers/outbound-sender.ts
// ─────────────────────────────────────────────────────────────────────────────
// ONE FROM ADDRESS, AND IT IS NEVER INVENTED.
//
// WHAT THE SWEEP FOUND. Five call sites each grew their own idea of who an
// email is from, and four of them ended in a fabricated address:
//
//   email-campaign-sender   agent's user email        else noreply@example.com
//   send-isa-email          OUTBOUND_EMAIL_FROM       else noreply@example.com
//   vendors/w9              SENDGRID_FROM_EMAIL       else noreply@vip-re.com
//   property-alerts         tenant credential         else SENDGRID_FROM_EMAIL
//                                                     else alerts@vip-re.com
//   messaging/sendEmail     params.from               else SENDGRID_FROM_EMAIL
//                                                     else noreply@yourdomain.com
//
// THE BUG IS NOT THE PLACEHOLDER — it is that the placeholder WINS. sendEmail
// resolves `params.from || SENDGRID_FROM_EMAIL`, so a caller that passes
// "noreply@example.com" as its own fallback OVERRIDES the tenant's real,
// verified, configured sender. A brokerage can have SendGrid fully set up and
// still have its campaign go out from example.com — and SendGrid rejects an
// unverified sender identity, so the whole campaign fails at the provider with
// an opaque 403 instead of being refused up front with a reason a human can act
// on. Only ONE of the five sites ever read platform_credentials.config
// .from_email, which is where the tenant actually configures this.
//
// Same shape as the render contract in the same pass: the OS collected the
// answer and then silently used something else.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// This resolver returns null when it cannot establish a real sender. Null means
// REFUSE. Sending as example.com is not a degraded send, it is an undeliverable
// one that also spends the tenant's provider quota and reputation to fail.
//
// PURE HELPERS + one read. No provider calls.

/** Where the address came from — surfaced so a human can fix the right thing. */
export type SenderSource = "tenant_credential" | "platform_env" | "agent_mailbox"

export interface OutboundSender {
  email: string
  /** Display name, when the tenant configured one. */
  name: string | null
  source: SenderSource
}

/**
 * Domains that can never receive mail, and must never be sent FROM.
 *
 * RFC 2606 / RFC 6761 reserve example.* precisely so they cannot resolve, and
 * "yourdomain.com" is a documentation placeholder. An address on any of these
 * is a bug, never a configuration choice, so it is rejected wherever it appears
 * — including when it arrives from an environment variable, because a typo'd
 * env var is exactly how a placeholder reaches production.
 */
const UNSENDABLE_DOMAINS = [
  "example.com", "example.org", "example.net", "example.edu",
  "yourdomain.com", "yourbrokerage.com", "domain.com",
  "test.com", "localhost", "invalid",
]

/** Is this address a documentation placeholder rather than a real mailbox? */
export function isUnsendableAddress(address: string | null | undefined): boolean {
  const a = (address ?? "").trim().toLowerCase()
  if (!a) return true
  // Accept "Name <addr@host>" as well as a bare address.
  const bare = a.includes("<") ? a.slice(a.lastIndexOf("<") + 1, a.lastIndexOf(">")) : a
  const at = bare.lastIndexOf("@")
  if (at <= 0 || at === bare.length - 1) return true
  const domain = bare.slice(at + 1)
  if (!domain.includes(".") && domain !== "localhost") return true
  return UNSENDABLE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
}

/** RFC-shaped enough to hand a provider. Deliberately permissive on the local part. */
export function isPlausibleAddress(address: string | null | undefined): boolean {
  const a = (address ?? "").trim()
  if (!a || /\s/.test(a.includes("<") ? a.slice(a.lastIndexOf("<") + 1, a.lastIndexOf(">")) : a)) return false
  const bare = a.includes("<") ? a.slice(a.lastIndexOf("<") + 1, a.lastIndexOf(">")) : a
  return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(bare)
}

/** A usable sender is one a provider will accept AND a reply can reach. */
export function isUsableSender(address: string | null | undefined): boolean {
  return isPlausibleAddress(address) && !isUnsendableAddress(address)
}

/** "Harbour & Co. <hello@harbour.com>", or the bare address when unnamed. */
export function formatSender(sender: OutboundSender): string {
  const name = (sender.name ?? "").trim()
  return name ? `${name} <${sender.email}>` : sender.email
}

/** The bare address out of either shape, for comparisons and logging. */
export function bareAddress(address: string): string {
  const a = address.trim()
  return a.includes("<") ? a.slice(a.lastIndexOf("<") + 1, a.lastIndexOf(">")).trim() : a
}

type AnyClient = { from: (t: string) => any }

/**
 * The tenant's outbound sender, or null when none is established.
 *
 * The cascade, most specific first:
 *   1. the brokerage's OWN active SendGrid credential (config.from_email) —
 *      the surface where a tenant actually configures this, and the only one
 *      that keeps a brokerage's mail on its own verified domain;
 *   2. the platform's SENDGRID_FROM_EMAIL / OUTBOUND_EMAIL_FROM env, for
 *      single-tenant and transactional platform mail;
 *   3. null.
 *
 * Step 3 is the point of the module. Every level is validated, so a placeholder
 * sitting in an env var is treated as absent rather than sent from.
 *
 * NOTE ON THE AGENT MAILBOX: when an agentUserId is available, sendEmail
 * already prefers the agent's connected Gmail/Outlook, which sets its own From
 * and never consults this resolver. That path is untouched — this is the
 * fallback lane, which is exactly the lane that was fabricating.
 */
export async function resolveOutboundSender(
  svc: AnyClient,
  brokerageId: string | null | undefined,
): Promise<OutboundSender | null> {
  if (brokerageId) {
    try {
      const { data } = await svc.from("platform_credentials")
        .select("config")
        .eq("brokerage_id", brokerageId)
        .eq("platform", "sendgrid")
        .eq("is_active", true)
        .maybeSingle()
      const cfg = (data as { config?: Record<string, unknown> | null } | null)?.config ?? null
      const email = typeof cfg?.from_email === "string" ? cfg.from_email.trim() : ""
      if (isUsableSender(email)) {
        const name = typeof cfg?.from_name === "string" && cfg.from_name.trim() ? cfg.from_name.trim() : null
        return { email: bareAddress(email), name, source: "tenant_credential" }
      }
    } catch { /* fall through to the platform env */ }
  }

  for (const env of [process.env.SENDGRID_FROM_EMAIL, process.env.OUTBOUND_EMAIL_FROM]) {
    const v = (env ?? "").trim()
    if (isUsableSender(v)) return { email: bareAddress(v), name: null, source: "platform_env" }
  }

  return null
}

/** The machine-readable refusal, so a caller's error is greppable. */
export const NO_SENDER_ERROR =
  "no_verified_sender: this brokerage has no verified from-address. Configure " +
  "SendGrid (Settings → Integrations) with a verified sender, or connect the " +
  "agent's own mailbox, before sending."

/**
 * The formatted sender, or undefined when none is established.
 *
 * For call sites that pass `from` straight into dispatchEmail/sendEmail:
 * undefined lets sendEmail's own resolution run and, if that also comes up
 * empty, REFUSE with NO_SENDER_ERROR. That is the correct handoff — a caller
 * substituting a placeholder here is precisely the bug, because
 * `params.from || SENDGRID_FROM_EMAIL` means the caller's guess would beat the
 * tenant's real configured sender.
 */
export function formatSenderOrUndefined(sender: OutboundSender | null): string | undefined {
  return sender ? formatSender(sender) : undefined
}
