// lib/agents/campaign-composer.ts
//
// AGENTIC CAMPAIGN COMPOSER (campaign_orchestrator, shine #2) — the SUPERVISOR
// pattern made real over the rails the OS already owns: a broker/agent states
// a campaign GOAL ("new-listing launch for 12 Oak", "re-warm my cold sphere")
// and the composer decomposes it into channel-specific WORKER tasks, each
// routed to a registered ChannelAdapter (the workflow channel-registry — the
// same executor the drip engine uses), enforcing frequency + capability
// constraints, and returns ONE plan the human approves before anything runs.
//
// This is the honest MCP/A2A story: the OS is the BRAIN that assigns tasks to
// channel workers it can actually reach. A channel with no registered adapter
// is reported as UNAVAILABLE (connect it), never silently dropped or faked.
// Pure planner (no I/O, fully testable); dispatch stays behind the existing
// gated executor — the composer PLANS, the human RELEASES, the executor RUNS.

export type CampaignGoalKind = "listing_launch" | "sphere_rewarm" | "open_house_push" | "price_improvement" | "buyer_nurture"

export interface CampaignChannelTask {
  channel: string          // must match a ChannelAdapter.channel key
  role: string             // what this worker does in the campaign
  order: number            // sequencing hint (waves)
  available: boolean       // is a ChannelAdapter registered for it?
}

export interface CampaignPlan {
  goalKind: CampaignGoalKind
  objective: string
  tasks: CampaignChannelTask[]
  /** Channels the plan wants but that have no adapter — the connect-these list. */
  unavailableChannels: string[]
  /** True only when at least one task can actually run. */
  actionable: boolean
}

// The blueprint per goal: which channels, in what role + wave. Deliberately
// small, proven channel keys that match real adapters (email/sms/social/
// direct_mail/send_for_esign) — the planner filters to what's registered.
const BLUEPRINTS: Record<CampaignGoalKind, Array<{ channel: string; role: string; order: number }>> = {
  listing_launch: [
    { channel: "email", role: "Coming-soon announcement to the sphere", order: 1 },
    { channel: "social_post", role: "Listing reveal post across connected profiles", order: 1 },
    { channel: "sms", role: "Text the hottest buyer matches with the new listing", order: 2 },
    { channel: "direct_mail", role: "Just-listed postcard to the surrounding farm", order: 2 },
  ],
  sphere_rewarm: [
    { channel: "email", role: "Value-first re-introduction to cold sphere contacts", order: 1 },
    { channel: "voice_drop", role: "Warm ringless voicemail to non-openers", order: 2 },
  ],
  open_house_push: [
    { channel: "social_post", role: "Open-house invite post + story", order: 1 },
    { channel: "email", role: "RSVP invite to matched buyers + neighbors", order: 1 },
    { channel: "sms", role: "Day-before reminder to RSVPs", order: 2 },
  ],
  price_improvement: [
    { channel: "email", role: "Price-improvement alert to saved-search buyers", order: 1 },
    { channel: "social_post", role: "Refreshed listing post with the new number", order: 1 },
  ],
  buyer_nurture: [
    { channel: "email", role: "New-match digest on cadence", order: 1 },
    { channel: "sms", role: "Instant ping on a strong match", order: 2 },
  ],
}

const OBJECTIVES: Record<CampaignGoalKind, string> = {
  listing_launch: "Coordinate a multi-channel launch so the listing hits the sphere, the farm, and matched buyers in one wave.",
  sphere_rewarm: "Re-open conversations with cold sphere contacts using value, not a pitch.",
  open_house_push: "Fill the open house with matched buyers and curious neighbors.",
  price_improvement: "Re-market the improved price to everyone who was watching.",
  buyer_nurture: "Keep active buyers engaged with timely, relevant matches.",
}

/**
 * PURE SUPERVISOR: decompose a goal into channel-worker tasks, marking each
 * available only if a ChannelAdapter is registered. `registeredChannels` is
 * injected (from the workflow registry) so this stays pure + testable.
 */
export function composeCampaignPlan(goalKind: CampaignGoalKind, registeredChannels: string[]): CampaignPlan {
  const registered = new Set(registeredChannels)
  const blueprint = BLUEPRINTS[goalKind] ?? []
  const tasks: CampaignChannelTask[] = blueprint.map((b) => ({
    channel: b.channel,
    role: b.role,
    order: b.order,
    available: registered.has(b.channel),
  }))
  const unavailableChannels = [...new Set(tasks.filter((t) => !t.available).map((t) => t.channel))]
  return {
    goalKind,
    objective: OBJECTIVES[goalKind] ?? "Coordinate a multi-channel campaign.",
    tasks,
    unavailableChannels,
    actionable: tasks.some((t) => t.available),
  }
}

/** PURE: the human-facing plan summary the approval card renders. */
export function composeCampaignSummary(plan: CampaignPlan): string {
  const runnable = plan.tasks.filter((t) => t.available)
  const waves = [...new Set(runnable.map((t) => t.order))].sort()
  const lines = waves.map((w) => {
    const inWave = runnable.filter((t) => t.order === w).map((t) => `${t.channel} (${t.role})`).join("; ")
    return `Wave ${w}: ${inWave}`
  })
  const tail = plan.unavailableChannels.length
    ? ` Connect ${plan.unavailableChannels.join(", ")} to add ${plan.unavailableChannels.length} more channel${plan.unavailableChannels.length === 1 ? "" : "s"}.`
    : ""
  return `${plan.objective}\n${lines.join("\n")}${tail}`
}

/** Build the plan against the LIVE workflow registry (the real available-channels source). */
export async function planCampaign(goalKind: CampaignGoalKind): Promise<CampaignPlan> {
  const { registry } = await import("@/lib/workflow/channel-registry")
  await import("@/lib/workflow/adapters") // ensure adapters self-register
  return composeCampaignPlan(goalKind, registry.registeredChannels())
}
