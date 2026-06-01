/**
 * lib/agents/brokerage-context.ts
 *
 * Composes per-brokerage runtime context that EVERY Managed Agent kickoff needs:
 *
 *   1. Real brokerage NAME (not the UUID slice) + subscription tier label.
 *   2. Brand voice — tone / formality / prohibited words / preferred phrasing /
 *      key brand messages — resolved via lib/kernel/brand-voice.ts:applyBrandVoice
 *      (the same chokepoint the rest of the kernel uses, so agent output is
 *      held to the same voice rules as human-authored content).
 *   3. Compliance posture — the gates that will reject the agent's output if it
 *      strays (Fair Housing + Them-First + TCPA via lib/kernel/compliance.ts).
 *      We tell the agent UP FRONT instead of relying on post-hoc rejection.
 *   4. Email signature reminder — outbound email is auto-signature-wrapped via
 *      lib/kernel/communications/assemble-email.ts; agents must NOT draft a
 *      signature (it duplicates) and must leave the closing one line above
 *      where the wrapper inserts.
 *   5. Preferred lender (when configured) — for the Buyer Concierge's pre-rep phase.
 *
 * Every per-side agent (Buyer Concierge / Listing Concierge / Deal Coordinator)
 * pulls THIS struct at spawn time and embeds it in the kickoff so the system
 * prompt stays generic (no "Vip-RE-OS" hardcoding) and per-brokerage variability
 * flows through context, not prompt rewrites.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { applyBrandVoice }     from "@/lib/kernel/brand-voice"

const TIER_LABEL: Record<string, string> = {
  solo_agent:     "Solo",
  team:           "Team",
  brokerage:      "Brokerage",
  multi_location: "Multi-Location",
}

export interface BrokerageContext {
  brokerageId:        string
  brokerageName:      string
  tierKey:            string
  tierLabel:          string
  brandVoice: {
    tone:             string | null
    formalityLevel:   string | null
    prohibitedWords:  string[]
    preferredWords:   string[]
    keyBrandMessages: string[]
    tagline:          string | null
  }
  /** Compliance gates that will REJECT non-compliant output downstream. The agent
   *  should self-filter against these BEFORE drafting to avoid wasted cycles. */
  complianceGates:    string[]
  /** Preferred lender (when configured for the brokerage / team / agent). NULL when
   *  no preferred lender is set — the agent should recommend the human agent pick one. */
  preferredLender: {
    name:    string
    email?:  string | null
    phone?:  string | null
  } | null
}

/**
 * Build the per-brokerage context for an agent kickoff. Takes journeyType/persona
 * so brand voice resolution returns the right per-segment rules — the kernel's
 * brand-voice resolver respects (brokerage, team, agent) inheritance AND can vary
 * tone by journey type (buyer/seller) or persona (luxury / divorce / probate).
 */
export async function resolveBrokerageContext(params: {
  brokerageId:  string
  /** Used to seed brand-voice resolution — the resolver returns different rules
   *  per journey type when configured. */
  journeyType:  "buyer" | "seller"
  /** Persona key from contacts.contact_persona (e.g. "first_time_buyer", "investor").
   *  Used by the brand-voice resolver and downstream prompting. */
  persona:      string
}): Promise<BrokerageContext> {
  const svc = createServiceClient()

  // 1. Brokerage name + tier.
  const { data: bk } = await svc
    .from("brokerages")
    .select("name, subscription_tier, plan_tier")
    .eq("id", params.brokerageId)
    .maybeSingle()
  const brokerageName = (bk?.name as string | null)?.trim() || `Brokerage ${params.brokerageId.slice(0, 8)}`
  const tierKey       = ((bk?.subscription_tier ?? bk?.plan_tier) as string | null) ?? "solo_agent"
  const tierLabel     = TIER_LABEL[tierKey] ?? tierKey

  // 2. Brand voice — call the canonical resolver with empty content so we get back
  //    only the resolved settings (tone, prohibited words, etc.) without rewrite.
  const bv = await applyBrandVoice({
    brokerageId: params.brokerageId,
    actorRole:   "agent",
    journeyType: params.journeyType,
    persona:     params.persona,
    messageType: "narrative",
    content:     "",
  }).catch(() => null)

  // 3. Compliance gates — the canonical short-list the agent must self-filter against.
  //    Full enforcement happens at the lib/kernel/compliance.ts:evaluateOutbound chokepoint
  //    on actual outbound; this is the agent's pre-flight checklist.
  const complianceGates = [
    "Fair Housing Act — no references to race, color, religion, national origin, sex, disability, familial status.",
    "Them-First — at least 60% client-focused pronouns; no pushy phrases ('act now', 'limited time', 'don't miss out').",
    "TCPA — no SMS/phone outreach without explicit channel consent. Email is the safe default until consent is verified.",
    "Brand voice — match the brokerage's resolved tone + prohibited-word list (see brandVoice block).",
  ]

  // 4. Preferred lender — read from the canonical vendor_directory (NOT a separate
  //    "preferred_vendors" table — that doesn't exist; the directory itself carries a
  //    `preferred` flag and a `display_priority`). Filter by category='lender' and
  //    preferred=true; tie-break by display_priority ASC.
  let preferredLender: BrokerageContext["preferredLender"] = null
  try {
    const { data: lender } = await svc
      .from("vendor_directory")
      .select("id, name, email, phone, preferred, display_priority")
      .eq("brokerage_id", params.brokerageId)
      .eq("category", "lender")
      .eq("preferred", true)
      // Stable, deterministic tie-break: display_priority ASC (nulls last), then id
      // so a brokerage with multiple equally-prioritized preferred lenders sees the
      // same lender on every spawn instead of a non-deterministic Postgres pick.
      .order("display_priority", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (lender?.name) {
      preferredLender = {
        name:  lender.name as string,
        email: (lender.email as string | null) ?? null,
        phone: (lender.phone as string | null) ?? null,
      }
    }
  } catch {
    // Fail open — preferred lender stays null and the kickoff says so.
  }

  return {
    brokerageId:   params.brokerageId,
    brokerageName,
    tierKey,
    tierLabel,
    brandVoice: {
      tone:             bv?.tone             ?? null,
      formalityLevel:   bv?.formalityLevel   ?? null,
      prohibitedWords:  bv?.prohibitedWords  ?? [],
      preferredWords:   bv?.preferredWords   ?? [],
      keyBrandMessages: bv?.keyBrandMessages ?? [],
      tagline:          bv?.tagline          ?? null,
    },
    complianceGates,
    preferredLender,
  }
}

/**
 * Render a BrokerageContext as a kickoff prefix the agent reads as part of the
 * first user.message. Kept terse — the agent sees this on every spawn, so we
 * pay for tokens directly.
 */
export function renderBrokerageContextForKickoff(ctx: BrokerageContext): string {
  const lines: string[] = []
  lines.push(`Brokerage: ${ctx.brokerageName} (${ctx.tierLabel} tier)`)
  if (ctx.brandVoice.tone || ctx.brandVoice.formalityLevel) {
    lines.push(`Brand voice: tone=${ctx.brandVoice.tone ?? "default"}, formality=${ctx.brandVoice.formalityLevel ?? "default"}`)
  }
  if (ctx.brandVoice.tagline) {
    lines.push(`Tagline: ${ctx.brandVoice.tagline}`)
  }
  if (ctx.brandVoice.keyBrandMessages.length > 0) {
    lines.push(`Key brand messages: ${ctx.brandVoice.keyBrandMessages.slice(0, 3).join(" | ")}`)
  }
  if (ctx.brandVoice.prohibitedWords.length > 0) {
    lines.push(`Prohibited words (DO NOT USE): ${ctx.brandVoice.prohibitedWords.slice(0, 12).join(", ")}`)
  }
  if (ctx.brandVoice.preferredWords.length > 0) {
    lines.push(`Preferred phrasing: ${ctx.brandVoice.preferredWords.slice(0, 8).join(", ")}`)
  }
  lines.push("")
  lines.push("COMPLIANCE GATES (your output will be REJECTED if any fails):")
  for (const g of ctx.complianceGates) lines.push(`  • ${g}`)
  lines.push("")
  lines.push("SIGNATURES: do NOT draft a signature/footer. Outbound email is auto-wrapped by")
  lines.push("lib/kernel/communications/assemble-email.ts with the resolved user/team/brokerage")
  lines.push("signature. End the message body with your closing line ('Best,' / 'Sincerely,'")
  lines.push("/ etc.) — the wrapper inserts the rest.")
  if (ctx.preferredLender) {
    lines.push("")
    lines.push(`PREFERRED LENDER (use for warm intros only — no quotes, no commitments):`)
    lines.push(`  ${ctx.preferredLender.name}${ctx.preferredLender.email ? " · " + ctx.preferredLender.email : ""}${ctx.preferredLender.phone ? " · " + ctx.preferredLender.phone : ""}`)
  } else {
    lines.push("")
    lines.push(`PREFERRED LENDER: none configured for this brokerage. If the buyer needs a lender,`)
    lines.push(`surface in the agent_briefing that a preferred lender should be set up under`)
    lines.push(`brokerage_preferred_vendors before lender-intro outreach.`)
  }
  return lines.join("\n")
}
