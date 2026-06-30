// ─── LIFETIME SEGMENT (local owner vs relocated) ─────────────────────────────
// Pure, import-free logic for WHICH lifetime nurture a past client gets.
//
// A 'local_owner' still owns a home in our market → equity story, seasonal
// maintenance, "your next move" radar all apply. A 'relocated' client has LEFT
// our market (moved away, downsized out of area, entered senior living, etc.) —
// pestering them with equity/maintenance/next-move would be tone-deaf and useless.
// Their value to the relationship is different: they're a REFERRAL SOURCE for
// people still here, and they may need a great agent in their NEW area (a
// referral-OUT — goodwill + a referral fee). So they get a stay-in-touch +
// referral lane instead.
//
// FAIR HOUSING: the segment is the neutral market fact only. The REASON someone
// relocated (age, health, family) is never stored, inferred, or surfaced here.

export type LifetimeSegment = "local_owner" | "relocated"

export function normalizeLifetimeSegment(v: unknown): LifetimeSegment {
  return v === "relocated" ? "relocated" : "local_owner"
}

export function isRelocatedSegment(v: unknown): boolean {
  return normalizeLifetimeSegment(v) === "relocated"
}

export interface LifetimeCardPlan {
  /** Home-ownership-centric cards (only meaningful for a local owner). */
  showWealthStory: boolean
  showMaintenance: boolean
  showNextMove: boolean
  showAskYourHome: boolean
  /** Relationship cards (apply to everyone). */
  showReferralAsk: boolean
  showTestimonial: boolean
  /** Relocated-only lane. */
  showRelocationReferral: boolean
  showStayInTouch: boolean
}

export function lifetimeCardPlan(segment: LifetimeSegment): LifetimeCardPlan {
  if (segment === "relocated") {
    return {
      showWealthStory: false,
      showMaintenance: false,
      showNextMove: false,
      showAskYourHome: false,
      showReferralAsk: true,
      showTestimonial: true,
      showRelocationReferral: true,
      showStayInTouch: true,
    }
  }
  return {
    showWealthStory: true,
    showMaintenance: true,
    showNextMove: true,
    showAskYourHome: true,
    showReferralAsk: true,
    showTestimonial: true,
    showRelocationReferral: false,
    showStayInTouch: false,
  }
}
