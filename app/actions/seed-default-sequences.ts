"use server"

/**
 * Seed default campaign sequences for a brokerage so day-one experience
 * has automation working without anyone authoring workflows. Each sequence
 * has a trigger_event that hooks into the kernel event-fanout — when the
 * matching event fires, the contact is auto-enrolled.
 *
 * Brokerages can edit, disable, or delete any of these from the Workflow
 * Builder — they're just defaults.
 *
 * Idempotent: skips creation if a sequence with the same name already
 * exists for the brokerage.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { resolveActingContext, resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { KernelEvent } from "@/lib/kernel/events"

/**
 * "Is this caller the platform superadmin?" — BOTH identity columns.
 *
 * WriteContext carries only `user_type`, and `ctx.userType !== "superadmin"` is
 * TRUE for the platform's only superadmin, whose row is
 * (user_type='admin', platform_role='superadmin'). Both cross-tenant escape
 * hatches below were therefore dead: the platform owner could neither read nor
 * seed another brokerage's default sequences, and got "Cannot seed for another
 * brokerage" on the one account that is allowed to. This mirrors
 * public.is_platform_admin() in RLS and requireSuperadmin() in
 * lib/auth/platform-guard.ts — see app/actions/vendor-budget.ts:136-147.
 *
 * Deliberately superadmin-ONLY, not the four-role platform-staff roster: seeding
 * writes campaign automation INTO a tenant, which support/marketing staff do not do.
 *
 * Called only on the branch that would otherwise refuse (caller asked for a
 * brokerage that is not their own), so the common path costs no extra query.
 */
async function callerIsSuperadmin(userId: string, userType: string): Promise<boolean> {
  if (userType === "superadmin") return true
  const { data } = await createServiceClient()
    .from("users")
    .select("platform_role")
    .eq("id", userId)
    .maybeSingle()
  return (data as { platform_role?: string | null } | null)?.platform_role === "superadmin"
}

interface SeqSeed {
  name:         string
  description:  string
  triggerEvent: string
  sequenceType: string
  steps: Array<{
    name:    string
    channel: "email" | "sms" | "wait" | "task" | "video" | "direct_mail"
    delayDays: number
    subject?: string
    body?:    string
  }>
}

const DEFAULT_SEQUENCES: SeqSeed[] = [
  // ─── 1. Buyer captured — entry-point nurture ────────────────────────────
  {
    name:         "Buyer captured — welcome drip",
    description:  "Activates on every new buyer contact. Seven-day welcome arc with portal invite, SMS check-in, and a buying-prep guide.",
    triggerEvent: KernelEvent.CONTACT_CAPTURED,
    sequenceType: "buyer_nurture",
    steps: [
      {
        name: "Welcome email + portal invite",
        channel: "email", delayDays: 0,
        subject: "Welcome — let's find your home",
        body: "Hi {{first_name}},\n\nThanks for reaching out. I built you a private portal where you can save homes, track tours, and message me anytime.\n\n{{portal_invite_link}}\n\nTalk soon,\n{{agent_name}}",
      },
      {
        name: "Day-2 SMS check-in",
        channel: "sms", delayDays: 2,
        body: "Hi {{first_name}}, did you have a chance to look at your portal? Anything I can help dial in on your search? — {{agent_name}}",
      },
      {
        name: "Day-7 buyer's guide",
        channel: "email", delayDays: 7,
        subject: "How to prepare to buy in this market",
        body: "Hi {{first_name}},\n\nI put together a quick buyer's guide covering financing, what to expect from a tour, and how offers work today. Saving you a 30-min call:\n\n{{buyers_guide_link}}\n\nWhen you're ready to look at homes, just message me through the portal.\n\n{{agent_name}}",
      },
    ],
  },

  // ─── 2. Offer accepted → under-contract drip ─────────────────────────────
  {
    name:         "Buyer under contract — due-diligence drip",
    description:  "Activates when a buyer's offer is accepted. Walks them through inspection, appraisal, financing milestones over 14 days.",
    triggerEvent: KernelEvent.OFFER_ACCEPTED,
    sequenceType: "buyer_under_contract",
    steps: [
      {
        name: "Day-0 congrats + checklist",
        channel: "email", delayDays: 0,
        subject: "Under contract! Here's what happens next",
        body: "{{first_name}}, your offer was accepted!\n\nThe due-diligence phase covers three big checkpoints: inspection, appraisal, and financing. Your portal now has a real-time timeline showing where each one stands.\n\n{{portal_link}}\n\nI'll be in touch as each milestone hits.\n\n{{agent_name}}",
      },
      {
        name: "Day-3 inspection-prep SMS",
        channel: "sms", delayDays: 3,
        body: "{{first_name}}, the inspection is coming up. I'll send you the report as soon as it lands and we can walk through any items together. — {{agent_name}}",
      },
      {
        name: "Day-7 appraisal explainer",
        channel: "email", delayDays: 7,
        subject: "Quick note on the appraisal",
        body: "Hi {{first_name}},\n\nThe appraisal is the bank's check that the home is worth what you're paying. It's almost always fine, and if it isn't we have options — I'll handle that with you.\n\nPortal: {{portal_link}}\n\n{{agent_name}}",
      },
      {
        name: "Day-14 financing reminder",
        channel: "email", delayDays: 14,
        subject: "Final financing checklist",
        body: "Hi {{first_name}},\n\nWe're approaching the financing deadline. Make sure your lender has everything they need — pay stubs, bank statements, anything they requested. The portal has the deadline on your timeline.\n\n{{agent_name}}",
      },
    ],
  },

  // ─── 3. Listing live — seller drip ───────────────────────────────────────
  {
    name:         "Listing live — seller activity drip",
    description:  "Activates when a listing publishes. Weekly market + activity recaps, automated for the full active period.",
    triggerEvent: KernelEvent.LISTING_PUBLISHED,
    sequenceType: "seller_active",
    steps: [
      {
        name: "Day-0 seller welcome + share link",
        channel: "email", delayDays: 0,
        subject: "Your home is live — here's how to share it",
        body: "{{first_name}}, your home is officially on the market.\n\nYou can see real-time activity — showings, feedback, online traffic — in your portal:\n\n{{portal_link}}\n\nIf you'd like to share the listing on social, I've put one-click share buttons in the portal too.\n\n{{agent_name}}",
      },
      {
        name: "Day-3 showing-activity update",
        channel: "email", delayDays: 3,
        subject: "First-week activity on your listing",
        body: "Hi {{first_name}},\n\nQuick recap of the first few days: showings, online views, and any feedback are in the portal. Let me know if you'd like me to walk through anything.\n\n{{agent_name}}",
      },
      {
        name: "Weekly market update",
        channel: "email", delayDays: 7,
        subject: "{{week_count}}-week update on your listing",
        body: "Hi {{first_name}},\n\nWeekly market update for your listing:\n- Showings this week\n- Online traffic\n- Comparable activity in your area\n\nFull details in your portal: {{portal_link}}\n\n{{agent_name}}",
      },
    ],
  },

  // ─── 4. Listing under contract — seller transparency drip ───────────────
  {
    name:         "Seller under contract — transparency drip",
    description:  "Keeps the seller informed during the buyer's due diligence period.",
    triggerEvent: KernelEvent.LISTING_UNDER_CONTRACT,
    sequenceType: "seller_under_contract",
    steps: [
      {
        name: "Day-0 under-contract email",
        channel: "email", delayDays: 0,
        subject: "We're under contract!",
        body: "{{first_name}}, your home is under contract!\n\nFrom here the buyer's team will run inspection, appraisal, and financing. I'll keep you posted as each milestone clears.\n\nPortal: {{portal_link}}\n\n{{agent_name}}",
      },
      {
        name: "Day-7 due-diligence check-in",
        channel: "sms", delayDays: 7,
        body: "{{first_name}}, we're a week into due diligence. Inspection results coming soon — I'll loop you in. — {{agent_name}}",
      },
    ],
  },

  // ─── 5. Lifetime onboard — post-close retention ──────────────────────────
  {
    name:         "Lifetime customer — welcome + retention",
    description:  "Activates when a transaction closes. Welcomes the contact as a lifetime customer with retention touchpoints.",
    triggerEvent: "transaction_closed",
    sequenceType: "lifetime_onboard",
    steps: [
      {
        name: "Day-3 welcome to lifetime",
        channel: "email", delayDays: 3,
        subject: "Welcome home — and welcome to your lifetime portal",
        body: "{{first_name}}, congratulations on closing!\n\nYour portal has now switched to your lifetime customer view. Inside you'll find:\n  - Live home value estimate\n  - Equity tracker\n  - Neighborhood activity\n  - Refinance opportunity alerts\n\n{{portal_link}}\n\nI'm here for the long haul — refer me anytime.\n\n{{agent_name}}",
      },
      {
        name: "Day-30 settling-in SMS",
        channel: "sms", delayDays: 30,
        body: "{{first_name}}, hope you're settling in! Reach out if there's anything I can help with — vendors, contractors, anything. — {{agent_name}}",
      },
      {
        name: "6-month home anniversary",
        channel: "email", delayDays: 180,
        subject: "Six months in your new home",
        body: "{{first_name}}, hard to believe it's been 6 months. Your home value has been tracking steadily — your portal shows the latest estimate.\n\n{{portal_link}}\n\nAnyone you know thinking about buying or selling? I'd love an introduction.\n\n{{agent_name}}",
      },
      {
        name: "1-year anniversary",
        channel: "email", delayDays: 365,
        subject: "One year in your home — congrats!",
        body: "{{first_name}}, happy one-year homeowner anniversary!\n\nYou've built equity over the past year — your portal shows the breakdown. If interest rates ever drop into refinance territory I'll let you know first.\n\n{{portal_link}}\n\n{{agent_name}}",
      },
    ],
  },
]

/**
 * The default-sequence catalog with its install state for a brokerage, so the
 * UI can SHOW the defaults and let the user pick which to install (instead of a
 * blind "install all"). Read-only; auth-gated + brokerage-scoped.
 */
export async function getDefaultSequenceCatalog(brokerageId?: string): Promise<{
  success: boolean
  error?: string
  items: Array<{ name: string; description: string; sequenceType: string; triggerLabel: string; stepCount: number; installed: boolean }>
}> {
  const ctx = await resolveActingContext()
  if (!ctx.ok) return { success: false, error: "Unauthorized", items: [] }
  const targetBrokerageId = brokerageId ?? ctx.brokerageId
  if (!targetBrokerageId) return { success: false, error: "No brokerage in scope", items: [] }
  // Same tenant boundary as seedDefaultSequences: a client-supplied brokerageId
  // must be the caller's own (service client bypasses RLS) — only superadmin may
  // read another tenant's install state.
  if (brokerageId && brokerageId !== ctx.brokerageId && !(await callerIsSuperadmin(ctx.userId, ctx.userType))) {
    return { success: false, error: "Cannot read another brokerage", items: [] }
  }

  const supabase = createServiceClient()
  const { data: existing } = await supabase
    .from("campaign_sequences")
    .select("name")
    .eq("brokerage_id", targetBrokerageId)
    .in("name", DEFAULT_SEQUENCES.map((s) => s.name))
  const installedNames = new Set((existing ?? []).map((r: { name: string }) => r.name))

  const { findTrigger } = await import("@/lib/workflow/triggers")
  const items = DEFAULT_SEQUENCES.map((s) => ({
    name: s.name,
    description: s.description,
    sequenceType: s.sequenceType,
    triggerLabel: findTrigger(s.triggerEvent)?.label ?? s.triggerEvent,
    stepCount: s.steps.length,
    installed: installedNames.has(s.name),
  }))
  return { success: true, items }
}

export async function seedDefaultSequences(
  brokerageId?: string,
  /** When provided, install ONLY these catalog names; otherwise install all. */
  names?: string[],
): Promise<{
  success: boolean
  error?: string
  created: number
  skipped: number
}> {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) {
    return { success: false, error: "Unauthorized", created: 0, skipped: 0 }
  }
  // Default to caller's brokerage; allow superadmin to seed any.
  const targetBrokerageId = brokerageId ?? ctx.brokerageId
  if (!targetBrokerageId) {
    return { success: false, error: "No brokerage in scope", created: 0, skipped: 0 }
  }
  if (brokerageId && brokerageId !== ctx.brokerageId && !(await callerIsSuperadmin(ctx.userId, ctx.userType))) {
    return { success: false, error: "Cannot seed for another brokerage", created: 0, skipped: 0 }
  }

  const supabase = createServiceClient()
  let created = 0
  let skipped = 0

  // Optionally narrow to a selected subset (the picker passes chosen names).
  const selected = names && names.length > 0 ? new Set(names) : null
  const catalog = selected ? DEFAULT_SEQUENCES.filter((s) => selected.has(s.name)) : DEFAULT_SEQUENCES

  for (const seed of catalog) {
    // Idempotency — skip if name already exists for the brokerage.
    const { data: existing } = await supabase
      .from("campaign_sequences")
      .select("id")
      .eq("brokerage_id", targetBrokerageId)
      .eq("name", seed.name)
      .maybeSingle()

    if (existing) { skipped++; continue }

    const { data: seq, error: seqError } = await supabase
      .from("campaign_sequences")
      .insert({
        brokerage_id:  targetBrokerageId,
        name:          seed.name,
        description:   seed.description,
        trigger_event: seed.triggerEvent,
        sequence_type: seed.sequenceType,
        is_active:     true,
        is_ab_test:    false,
        compliance_gated: true,
        created_by:    ctx.userId,
      })
      .select("id")
      .single()

    if (seqError || !seq) continue

    // Insert steps in order.
    const stepRows = seed.steps.map((s, i) => ({
      sequence_id: seq.id,
      step_number: i + 1,
      step_name:   s.name,
      channel:     s.channel,
      delay_days:  s.delayDays,
      delay_hours: 0,
      subject:     s.subject ?? null,
      body:        s.body ?? null,
      is_active:   true,
    }))
    await supabase.from("campaign_sequence_steps").insert(stepRows)

    created++
  }

  return { success: true, created, skipped }
}
