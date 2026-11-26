/**
 * lib/listing-presentation/marketing-system.ts
 *
 * WHAT MARKETING THIS BROKERAGE ACTUALLY DELIVERS — as a FUNCTION, not a frozen
 * sentence.
 *
 * ── THE OWNER'S RULING THAT CREATED THIS FILE ───────────────────────────────
 *
 * Verbatim: the default marketing system is part of the listing presentation and
 * should be an active function since it is part of advertisement.
 *
 * It REVERSES a §1 verdict from the previous wave. `DEFAULT_MARKETING_SYSTEM`
 * lived in section-narration.ts as an exported const with zero importers; that
 * wave un-exported it, on the reasoning that the VALUE was live and only the
 * `export` keyword was orphaned. The reasoning was sound and the verdict was
 * wrong, because it answered the wrong question: the census asked "does anything
 * import this?", and the thing actually missing was the WRITER — nothing in the
 * tree ever set `AINarrationInput.marketingSystem`, so one hardcoded English
 * sentence was spoken to every seller of every tenant on every plan. Shrinking
 * the surface to match what happened to be wired is §1.2 answered backwards:
 * the capability was wanted, so the missing half gets BUILT.
 *
 * ── THIS IS ADVERTISING, SPOKEN BY A CLONED VOICE TO A CONSUMER ────────────
 *
 * The output of this module is read aloud in the agent's own cloned voice to a
 * homeowner deciding who lists their house. That makes every clause here a
 * MARKETING CLAIM, and the governing rule is the one the seller portal's
 * marketing card already states in `lib/listings/marketing-channels.ts`: a
 * channel is only ever shown as live when a REAL signal proves it. That module
 * is the doctrine precedent, not the survivor — it answers "what is live for
 * this listing RIGHT NOW", which a PRE-listing presentation cannot ask, because
 * there is no listing, no MLS number, no slug and no published post yet. The
 * question here is the other one: what can this TENANT deliver once they sign.
 *
 * Three properties follow, and all three are load-bearing:
 *
 *   1. EVERY CLAIM IS GATED ON A REAL ENTITLEMENT. A claim is offered to the
 *      writer only when the tenant is entitled to every feature it depends on,
 *      resolved through the ONE entitlement stack
 *      (lib/entitlements/tenant-capabilities.ts → resolveEntitlement →
 *      feature_flags + feature_access_overrides + brokerages.plan_tier). Tiers
 *      are solo agent / team / brokerage / multi-location and ALL of them pay;
 *      a claim a tenant's plan does not include must never reach their seller.
 *   2. EVERY CLAIM SENTENCE IS HUMAN-AUTHORED. The catalogue below is fixed
 *      prose. The function SELECTS from it; it never composes new advertising
 *      copy, and no tenant free text is passed through. A capability-gated
 *      selection of reviewed sentences is auditable in a way generated ad copy
 *      is not.
 *   3. IT FAILS TO SILENCE, NOT TO BOASTING. No capabilities resolved — because
 *      the read refused, or because the tenant genuinely has none — yields the
 *      FLOOR sentence, which promises nothing specific. "We could not check"
 *      must never render as "yes, we do all of that" (§4), and on an
 *      advertising path that is the difference between a vague sentence and a
 *      false claim.
 *
 * ── COMPLIANCE-FIRST (§5), NOT A POST-HOC SCAN ─────────────────────────────
 *
 * §5: video scripts are written compliance-first — fair housing in the WRITING
 * PROMPT, not only in the post-hoc scan. This module's output IS a section of
 * the writing prompt, which is exactly where that rule bites. Every claim is run
 * through the repo's deterministic `detectFairHousingViolations` BEFORE it is
 * offered, and a HIGH-severity hit DROPS the claim rather than letting it into
 * the prompt — the same defence, in the same direction, as
 * lib/contact-promotion/welcome-situation.ts. Medium and low ride through as
 * warnings, because escalating those would put a human in front of every
 * presentation, which the ruling forbids.
 *
 * On the authored catalogue below the screen never fires, and that is the
 * POINT rather than a reason to skip it (§2): the screen is what keeps the
 * property true if a later lane adds a tenant-authored claim, and the simulator
 * carries a positive control proving the screen still bites.
 *
 * ── PURE. NO I/O. ──────────────────────────────────────────────────────────
 * The async half — reading entitlements and the agent's real voice/avatar
 * assets — is lib/listing-presentation/marketing-system-resolver.ts. This half
 * stays pure for the same reason lib/remotion/composition-geometry.ts states:
 * the deterministic narration fallback runs precisely when the AI (and possibly
 * the database) is unavailable, so the sentence it falls back to must be
 * computable with no network.
 */
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { spokenWords, type NarrationBudget } from "@/lib/video/script-structure"

/** Non-entitlement preconditions a claim may additionally depend on. These are
 *  facts about the ACCOUNT rather than about the plan — a tenant can be fully
 *  entitled to avatar video and still have no agent who has recorded a voice. */
export type MarketingFactKey = "hasVoiceClone" | "hasAvatarSource" | "directMailEnabled"

export interface MarketingClaim {
  id: string
  /** EVERY feature key must be entitled before this claim may be spoken. */
  requires: readonly string[]
  /** EVERY fact must be true as well. */
  requiresFacts: readonly MarketingFactKey[]
  /** The authored sentence fragment, first person, seller-facing. */
  claim: string
  /** Spoken order, and the order claims are dropped in when the composition is
   *  too short to carry them all — highest rank goes first. */
  rank: number
  /** WHERE the capability actually lives, so a future reader can re-verify the
   *  claim is still true rather than trusting this comment. */
  wiredAt: string
}

/**
 * THE CLAIM CATALOGUE — the six claims the retired `DEFAULT_MARKETING_SYSTEM`
 * string made, each one re-attached to the entitlement that makes it true.
 *
 * Every `requires` key was checked against the live `feature_flags` table on
 * 2026-08-26; every `wiredAt` path was opened and confirmed to be a real
 * surface. A claim whose key does not exist in `feature_flags` can never be
 * entitled — resolveEntitlement answers "Feature does not exist" — so a typo
 * here fails to SILENCE, which is the safe direction on an advertising path.
 *
 * THE GUARD'S REACH, STATED HONESTLY (§2). The simulator checks these keys
 * against a DATED SNAPSHOT of the live flag table, not against the database: it
 * is a pure proof with no credentials. So it catches a typo and a key that never
 * existed, and it CANNOT catch a key that was real on 2026-08-26 and has since
 * been renamed or retired. Re-snapshot it when the flag table changes; the SQL
 * is in the simulator's header beside the snapshot.
 */
export const MARKETING_SYSTEM_CLAIMS: readonly MarketingClaim[] = Object.freeze([
  {
    id:            "cinematic_listing_video",
    requires:      ["video_generation"],
    requiresFacts: [],
    rank:          100,
    claim:         "a cinematic video of your home",
    wiredAt:       "lib/video/listing-promo-reactor.ts + remotion/JustListedReel.tsx / PhotoWalkthroughReel.tsx",
  },
  {
    id:            "omnipresent_channels",
    requires:      ["social_media_posting"],
    requiresFacts: [],
    rank:          90,
    claim:         "your home in front of buyers on every channel they actually use",
    wiredAt:       "lib/workflow/adapters/social-post.ts + lib/repurpose/actions.ts",
  },
  {
    id:            "market_data_reels",
    requires:      ["video_generation", "cma_presentation"],
    requiresFacts: [],
    rank:          80,
    claim:         "animated market-data reels built from real comparable sales",
    wiredAt:       "lib/video/cma-reel-orchestrator.ts + remotion/CMAReel.tsx / MarketUpdateReel.tsx",
  },
  {
    id:            "ai_search_pages",
    requires:      ["seo_blog_engine"],
    requiresFacts: [],
    rank:          70,
    claim:         "a property page built to be found by AI search",
    wiredAt:       "app/listing/[slug]/page.tsx (RealEstateListing JSON-LD) + app/llms.txt/route.ts + lib/geo/video-landing.ts",
  },
  {
    id:            "direct_mail_email",
    requires:      ["direct_mail", "email_campaigns"],
    // brokerages.farm_mail_enabled is the tenant's OWN switch for outbound mail.
    // Entitlement says the plan includes it; this says the brokerage turned it
    // on. Both are required before a seller is promised mail will go out.
    requiresFacts: ["directMailEnabled"],
    rank:          60,
    claim:         "a coordinated mail and email campaign",
    wiredAt:       "lib/direct-mail/draft-copy.ts + brokerages.farm_mail_enabled",
  },
  {
    id:            "avatar_video_series",
    requires:      ["ai_video_generation", "voice_clone"],
    // THE CLAIM THAT MOST NEEDED A FACT, not just an entitlement. Every tier is
    // entitled to avatar video, and on the live database NO agent has a voice
    // profile or an avatar asset — so the entitlement alone would have promised
    // every seller a personal video series in their agent's voice that the
    // narration orchestrator then degrades to on_screen_only. The assets are
    // per-AGENT; the plan cannot speak for them.
    requiresFacts: ["hasVoiceClone", "hasAvatarSource"],
    rank:          50,
    claim:         "a personal video series recorded in my own voice",
    wiredAt:       "lib/listing-presentation/section-narration-orchestrator.ts (agent_voice_profiles + agent_avatar_assets)",
  },
])

/**
 * The sentence used when NOTHING can be claimed — an unreadable entitlement, a
 * tenant with none of the capabilities, or a composition with no room.
 *
 * It names no capability, so it can never be false, and it still gives the
 * writer something to aim at. This is the fail-closed direction for advertising:
 * vague beats untrue.
 */
export const MARKETING_SYSTEM_FLOOR =
  "The full marketing plan this brokerage runs for its listings — walked through in person at the appointment."

export interface MarketingSystemFacts {
  /** Feature keys the TENANT is entitled to (from resolveTenantCapabilities). */
  capabilities: ReadonlySet<string>
  hasVoiceClone: boolean
  hasAvatarSource: boolean
  directMailEnabled: boolean
  /**
   * The composition the narration will be spoken over. The claim list is packed
   * to fit it, so a shorter composition offers FEWER claims rather than offering
   * six and having five of them trimmed off mid-sentence.
   */
  budget: NarrationBudget
}

export interface ComposedMarketingSystem {
  /** The text handed to the writing prompt. Never empty. */
  text: string
  /** Claim ids actually offered, in spoken order. */
  offered: string[]
  /** Claim ids the tenant is not entitled to / has no assets for. */
  withheld: string[]
  /** Claim ids the tenant HAS but the composition had no room to carry (§2 —
   *  the blind spot published beside the number). */
  droppedForBudget: string[]
  /** Claim ids dropped by the fair-housing screen before reaching the prompt. */
  droppedForCompliance: string[]
  /** True when nothing survived and MARKETING_SYSTEM_FLOOR was used. */
  usedFloor: boolean
}

/**
 * PURE — compose the marketing-system text for one tenant and one composition.
 *
 * ── WHY THE CLAIM LIST IS PACKED AGAINST THE NARRATION BUDGET ──────────────
 *
 * This text is PROMPT INPUT, not narration, so nothing trims it directly. That
 * makes the interaction easy to get wrong in a way nothing would report: the
 * model is asked to sell N claims and simultaneously told (by
 * narrationLengthDirective) to finish inside `budget.maxWords`. Offer more claim
 * words than the whole narration can hold and the model must either cram or
 * overrun, and `fitNarrationToBudget` then cuts at a sentence boundary — losing
 * whole claims, silently as far as the seller is concerned. A richer sentence
 * that gets trimmed mid-claim is WORSE than the frozen string it replaced.
 *
 * So the offered claims are packed greedily by rank until their combined spoken
 * word count would exceed `budget.maxWords`. That ceiling is DERIVED — it moves
 * with ListingSectionReel's geometry and there is no number written down here.
 * At the current 300 frames / 30fps = 10s composition the budget is 20 words, so
 * roughly the top two claims are offered; lengthen the composition and more
 * appear automatically. It is a CEILING on what is offered, not a target: the
 * model still needs words for the sentence around the claims, which is why
 * offering less than the full budget is the intended, safe outcome.
 */
export function composeMarketingSystem(
  facts: MarketingSystemFacts,
  /**
   * The claim catalogue. Defaults to the real one; overridable ONLY so the
   * proof can drive a deliberately poisoned claim through the REAL screen on
   * the REAL path. §2 requires a positive control for the fair-housing drop,
   * and the authored catalogue is clean by design — so without an injection
   * point a broken screen and a clean catalogue would report the same zero.
   * No production caller passes this.
   */
  catalogue: readonly MarketingClaim[] = MARKETING_SYSTEM_CLAIMS,
): ComposedMarketingSystem {
  const factHolds: Record<MarketingFactKey, boolean> = {
    hasVoiceClone:     facts.hasVoiceClone,
    hasAvatarSource:   facts.hasAvatarSource,
    directMailEnabled: facts.directMailEnabled,
  }

  const withheld: string[] = []
  const droppedForCompliance: string[] = []
  const eligible: MarketingClaim[] = []

  for (const claim of [...catalogue].sort((a, b) => b.rank - a.rank)) {
    const entitled = claim.requires.every((key) => facts.capabilities.has(key))
    const factual = claim.requiresFacts.every((f) => factHolds[f])
    if (!entitled || !factual) { withheld.push(claim.id); continue }
    // COMPLIANCE-FIRST: screened BEFORE it can enter the writing prompt.
    // A hard fair-housing hit drops the claim; medium/low ride through (§5).
    if (detectFairHousingViolations(claim.claim).some((v) => v.severity === "high")) {
      droppedForCompliance.push(claim.id)
      continue
    }
    eligible.push(claim)
  }

  const offered: string[] = []
  const droppedForBudget: string[] = []
  let words = 0
  for (const claim of eligible) {
    const n = spokenWords(claim.claim).length
    if (words + n > facts.budget.maxWords) { droppedForBudget.push(claim.id); continue }
    offered.push(claim.id)
    words += n
  }

  if (offered.length === 0) {
    return { text: MARKETING_SYSTEM_FLOOR, offered: [], withheld, droppedForBudget, droppedForCompliance, usedFloor: true }
  }

  const byId = new Map(catalogue.map((c) => [c.id, c]))
  const parts = offered.map((id) => byId.get(id)!.claim)
  const joined = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`

  return {
    text: `You get ${joined}.`,
    offered,
    withheld,
    droppedForBudget,
    droppedForCompliance,
    usedFloor: false,
  }
}

/** Every feature key any claim depends on — what the resolver must ask the
 *  entitlement stack about. DERIVED from the catalogue so a claim added above
 *  cannot be silently un-resolvable. */
export function marketingSystemFeatureKeys(): string[] {
  return [...new Set(MARKETING_SYSTEM_CLAIMS.flatMap((c) => c.requires))].sort()
}
