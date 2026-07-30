// lib/kernel/coordination-kind.ts
//
// Classify an inter-manager signal into a COORDINATION KIND so the Command Center's "managers
// talking" feed renders the negotiation, not a flat log: who YIELDED a channel (deferral), who
// HANDED work to whom (handoff), who raised the alarm (escalation/alert). This is what makes the
// multi-manager coordination legible — "Campaign Orchestrator deferred to AI ISA" reads as a team
// working together, the differentiator no competitor surfaces. Pure (no I/O), unit-tested directly.

export type CoordinationKind = "deferral" | "handoff" | "escalation" | "alert" | "update"

/** Bucket a signal_type into the coordination kind the feed should emphasize. Pure. */
export function classifyCoordination(signalType: string | null | undefined): CoordinationKind {
  const t = (signalType ?? "").toLowerCase()
  // A manager stood down / yielded a channel to another (soft dissent — "you've got this").
  if (/defer|stand.?down|yield|first_touch_deferred/.test(t)) return "deferral"
  // Something needs human/senior attention NOW.
  if (/escalat|fire_drill|overload|war_room|crushed_cap|stalling|risk_escalated|convened|huddle|deal_save|action_pending|lapsing/.test(t)) return "escalation"
  // A compliance/quality flag was raised (not an emergency, but needs review).
  // capability_dark is named EXPLICITLY, not by a loose /dark/ pattern: a
  // capability the OS cannot run is a condition that needs review, which is
  // exactly what this bucket means — but a broad match would sweep up any future
  // signal that happens to contain the word.
  if (/violation|compliance_failed|surprise|finding|regulatory|fatigue|autopsy|withdrawn|endpoint_dead|custom_domain_error|capability_dark|outcome_contradicted/.test(t)) return "alert"
  // One manager handed work/an asset to another (claimed, ready, routed).
  if (/claim|ready|appointment|recovery|watch|handoff|candidate|reengage|call_|next_move|relocation|certification_issued|voice_command_dispatched/.test(t)) return "handoff"
  return "update"
}
