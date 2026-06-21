// lib/intelligence/partners-meeting-reel-props.ts
//
// PURE data→video contract for the Partners' Meeting RECAP REEL (remotion/PartnersMeetingReel.tsx) —
// the AI team's weekly "show" the broker watches. Maps the real WeekInBusiness numbers into branded
// stat cards, EARNED LINES ONLY (a quiet week shows fewer cards, never fabricated wins), and reuses
// composePartnersMeetingScript for the avatar narration so the spoken + visual layers can't drift.
//
// No server imports — testable, and importable by the render endpoint without dragging server deps.

import { composePartnersMeetingScript, type WeekInBusiness } from "@/lib/intelligence/partners-meeting"

export type ReelCardKind = "team" | "finance" | "compliance"
export interface ReelCard {
  value: string
  label: string
  sub?: string
  kind: ReelCardKind
}

export interface PartnersMeetingReelBrand {
  primaryColor: string
  accentColor: string
  brokerageName: string
  showEhoMark?: boolean
  logoUrl?: string | null
}

export interface PartnersMeetingReelProps {
  weekLabel: string
  /** Earned stat cards (deals / plays / drills / whispers / handoffs / finance / compliance). */
  cards: ReelCard[]
  /** The one thing waiting on the human (or the clear-queue line). */
  oneAsk: string
  /** The avatar narration script (same source as the spoken meeting). */
  narration: string
  agentName: string
  avatarVideoUrl: string | null
  agentPhotoUrl: string | null
  brand: PartnersMeetingReelBrand
}

const fmtUsd = (n: number) => {
  const v = Math.round(Math.max(0, n))
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (v >= 10_000) return `$${Math.round(v / 1000)}K`
  return `$${v.toLocaleString("en-US")}`
}

/**
 * PURE: WeekInBusiness → reel props. Cards appear ONLY when earned (count/amount > 0); the Finance
 * and Compliance cards are the differentiators (no competitor's weekly recap shows a Fair-Housing /
 * consent disposition). Honest zero-week: only the clear-queue ask renders.
 */
export function buildPartnersMeetingReelProps(
  w: WeekInBusiness,
  opts: {
    audienceName?: string | null
    agentName?: string
    avatarVideoUrl?: string | null
    agentPhotoUrl?: string | null
    brand?: Partial<PartnersMeetingReelBrand>
  } = {},
): PartnersMeetingReelProps {
  const cards: ReelCard[] = []
  const team = (value: number, label: string, sub: string) => {
    if (value > 0) cards.push({ value: String(value), label, sub, kind: "team" })
  }
  if (w.dealsClosed > 0) cards.push({ value: String(w.dealsClosed), label: "DEALS CLOSED", sub: "this week", kind: "team" })
  team(w.teamPlays, "TEAM PLAYS", "managers coordinated, not scattered")
  team(w.fireDrills, "DEADLINES SAVED", "caught before they burned a deal")
  team(w.whispers, "APPOINTMENT BRIEFINGS", "whispered before you walked in")
  team(w.handoffs, "MANAGER HANDOFFS", "crossed the bus, hands-free")

  if (w.gciClosedThisWeek > 0 || w.gciWeightedPipeline > 0) {
    cards.push({
      value: fmtUsd(w.gciClosedThisWeek),
      label: "GROSS COMMISSION BOOKED",
      sub: w.gciWeightedPipeline > 0 ? `${fmtUsd(w.gciWeightedPipeline)} weighted in the pipeline` : "by the Finance Manager",
      kind: "finance",
    })
  }
  if (w.complianceReviewed > 0) {
    const fixes = w.complianceAdvisories > 0 ? `${w.complianceAdvisories} Fair-Housing/consent fix${w.complianceAdvisories === 1 ? "" : "es"} caught` : "all cleared Fair Housing & consent"
    const over = w.complianceReleasedOverObjection > 0 ? ` · ${w.complianceReleasedOverObjection} released over objection` : ""
    cards.push({
      value: String(w.complianceReviewed),
      label: "OUTBOUND PRE-FLIGHTED",
      sub: `${fixes}${over}`,
      kind: "compliance",
    })
  }

  const oneAsk = w.proposalsPending > 0
    ? `${w.proposalsPending} proposal${w.proposalsPending === 1 ? "" : "s"} waiting on you`
    : "Your approval queue is clear"

  return {
    weekLabel: w.weekLabel,
    cards,
    oneAsk,
    narration: composePartnersMeetingScript(w, opts.audienceName ?? null),
    agentName: opts.agentName ?? "Your Team",
    avatarVideoUrl: opts.avatarVideoUrl ?? null,
    agentPhotoUrl: opts.agentPhotoUrl ?? null,
    brand: {
      primaryColor: opts.brand?.primaryColor ?? "#0F172A",
      accentColor: opts.brand?.accentColor ?? "#F59E0B",
      brokerageName: opts.brand?.brokerageName ?? "Your Brokerage",
      showEhoMark: opts.brand?.showEhoMark ?? true,
      logoUrl: opts.brand?.logoUrl ?? null,
    },
  }
}
