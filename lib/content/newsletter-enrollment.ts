// lib/content/newsletter-enrollment.ts
// ─────────────────────────────────────────────────────────────────────────────
// AUTO-ENROLL into the brokerage's CONTENT channel (newsletter / blog / podcast) at each
// lifecycle stage — the passive "stay top of mind" tool that paralleled the FB audience
// sync but had NO lifecycle hook (subscribers came only from manual adds / signup forms).
//
// SCOPING RULE (owner's directive):
//   • LEADS              → the BROKERAGE / TEAM / SOLO-AGENT subscription, by tier:
//                          solo_agent tier → the solo agent's list; team / brokerage / multi
//                          → the brokerage-scope list (agent_id null). (newsletter_subscribers
//                          has no team column; a team newsletter is brokerage-scoped + team-branded.)
//   • CONTACTS + LIFETIME → the ASSIGNED AGENT's list (agent_id = the contact's agent).
//
// newsletter_subscribers is UNIQUE (brokerage_id, email): a lead's brokerage-scope row is
// RE-KEYED to the agent on conversion (same email, agent_id + contact_id filled). NEVER
// re-subscribes an email that previously UNSUBSCRIBED (CAN-SPAM). Leads gate on a VERIFIED
// email (deliverability + honesty — unverified scraped emails are skipped); contacts are
// post-conversion (email known good) and gate only on !email_opt_out.
//
// NOT a hard dependency of any lifecycle write — every caller fires it best-effort.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface NewsletterEnrollOutcome {
  enrolled: boolean
  reason: "enrolled" | "rekeyed" | "already_subscribed" | "previously_unsubscribed"
    | "no_email" | "email_opt_out" | "email_unverified" | "not_found" | "error"
  scope?: "agent" | "brokerage"
}

/** Look up the existing subscriber for (brokerage, email). */
async function existingSubscriber(svc: Svc, brokerageId: string, email: string) {
  const { data } = await svc.from("newsletter_subscribers")
    .select("id, status, agent_id, contact_id").eq("brokerage_id", brokerageId).eq("email", email).maybeSingle()
  return data as { id: string; status: string | null; agent_id: string | null; contact_id: string | null } | null
}

/**
 * enrollLeadInNewsletter — enroll a captured LEAD into the brokerage/team/solo subscription
 * (by tier). Verified email + not opted out; never re-subscribes an unsubscribed email.
 */
export async function enrollLeadInNewsletter(
  args: { leadId: string; brokerageId: string }, client?: Svc,
): Promise<NewsletterEnrollOutcome> {
  const svc = client ?? createServiceClient()
  const { data: lead } = await svc.from("leads")
    .select("id, email, email_verified, email_opt_out, first_name, last_name, brokerage_id")
    .eq("id", args.leadId).eq("brokerage_id", args.brokerageId).maybeSingle()
  const l = lead as Record<string, any> | null
  if (!l) return { enrolled: false, reason: "not_found" }
  if (!l.email) return { enrolled: false, reason: "no_email" }
  if (l.email_opt_out === true) return { enrolled: false, reason: "email_opt_out" }
  if (l.email_verified !== true) return { enrolled: false, reason: "email_unverified" }

  const existing = await existingSubscriber(svc, args.brokerageId, l.email)
  if (existing?.status === "unsubscribed") return { enrolled: false, reason: "previously_unsubscribed" }

  // Scope by tier: solo_agent → the solo agent's list; else brokerage-scope (agent_id null).
  let agentId: string | null = null
  const { data: brokerage } = await svc.from("brokerages").select("plan_tier").eq("id", args.brokerageId).maybeSingle()
  if ((brokerage as { plan_tier?: string } | null)?.plan_tier === "solo_agent") {
    const { data: solo } = await svc.from("agents").select("id")
      .eq("brokerage_id", args.brokerageId).eq("is_active", true).order("created_at", { ascending: true }).limit(1).maybeSingle()
    agentId = (solo as { id: string } | null)?.id ?? null
  }

  // A lead already enrolled (e.g. re-capture) → leave as-is (don't clobber an agent re-key).
  if (existing) return { enrolled: false, reason: "already_subscribed", scope: agentId ? "agent" : "brokerage" }

  const { error } = await svc.from("newsletter_subscribers").insert({
    brokerage_id: args.brokerageId, email: l.email, agent_id: agentId,
    first_name: l.first_name ?? null, last_name: l.last_name ?? null,
    status: "subscribed", source: "auto_lead_capture", subscribed_at: new Date().toISOString(),
  })
  if (error) return { enrolled: false, reason: "error" }
  return { enrolled: true, reason: "enrolled", scope: agentId ? "agent" : "brokerage" }
}

/**
 * enrollContactInNewsletter — enroll/RE-KEY a CONTACT or LIFETIME customer into the ASSIGNED
 * AGENT's subscription (agent_id = the contact's agent, contact_id linked). Re-keys a lead's
 * brokerage-scope row to the agent on the same email. Never re-subscribes an unsubscribed email.
 */
export async function enrollContactInNewsletter(
  args: { contactId: string; brokerageId: string; tier?: "contact" | "lifetime" }, client?: Svc,
): Promise<NewsletterEnrollOutcome> {
  const svc = client ?? createServiceClient()
  const { data: contact } = await svc.from("contacts")
    .select("id, email, email_opt_out, first_name, last_name, agent_id, brokerage_id")
    .eq("id", args.contactId).eq("brokerage_id", args.brokerageId).maybeSingle()
  const c = contact as Record<string, any> | null
  if (!c) return { enrolled: false, reason: "not_found" }
  if (!c.email) return { enrolled: false, reason: "no_email" }
  if (c.email_opt_out === true) return { enrolled: false, reason: "email_opt_out" }

  const existing = await existingSubscriber(svc, args.brokerageId, c.email)
  if (existing?.status === "unsubscribed") return { enrolled: false, reason: "previously_unsubscribed" }

  const agentId = (c.agent_id as string | null) ?? null // agents.id (assignment FK)
  const source = args.tier === "lifetime" ? "auto_lifetime" : "auto_contact"

  // Upsert on (brokerage_id, email): inserts a new agent-scoped subscriber OR re-keys the
  // lead's brokerage-scope row to the agent + links the contact. subscribed_at preserved on
  // an existing row by upsert's default (it updates provided columns).
  const { error } = await svc.from("newsletter_subscribers").upsert({
    brokerage_id: args.brokerageId, email: c.email, agent_id: agentId, contact_id: args.contactId,
    first_name: c.first_name ?? null, last_name: c.last_name ?? null,
    status: "subscribed", source,
    ...(existing ? {} : { subscribed_at: new Date().toISOString() }),
  }, { onConflict: "brokerage_id,email" })
  if (error) return { enrolled: false, reason: "error", scope: "agent" }
  return { enrolled: true, reason: existing ? "rekeyed" : "enrolled", scope: "agent" }
}
