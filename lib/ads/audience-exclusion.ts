// lib/ads/audience-exclusion.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE EXCLUSION SLOT — an ad campaign says, IN THE PRODUCT, which audiences it
// SUBTRACTS, and every audience it names is gated before it can subtract.
//
// OWNER RULING, VERBATIM: "capability is vital to this os to have not exclude."
//
// Read it the way it is written. The OS must HAVE the capability — so that it
// does NOT exclude protected people. This module is not an exclusion-targeting
// feature; it is the instrument that makes exclusion VISIBLE to the gates that
// already exist. An unguarded exclusion field would be the opposite of the
// ruling.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
// It was published as a blind spot in two places (lib/ads/audience-source-rules.ts
// above EXCLUSION_SOURCE_RULE_TYPES, and lib/ads/audience-persona-basis.ts's
// header) and as an open seam on lib/kernel/manager-registry.ts:
//
//     the product governs exclusion as DECLARED in an audience's own rule
//     (`exclusion_*` source-rule types → `audienceUseOf` → the persona gate's
//     exclusion arm), but `TargetingConfig` had `custom_audience_ids` and NO
//     excluded-audience field, and `facebook_custom_audiences` had no column
//     recording that an audience had been used as a suppression list. So an
//     operator who exported a persona audience and pasted it into Meta's own
//     "Exclude" box was outside anything this system could see.
//
// Three halves were missing and all three are built:
//   1. the FIELD — `TargetingConfig.excluded_audience_ids` (lib/kernel/ads.ts,
//      lib/ads/ad-creator-types.ts) and the wizard control that writes it, so an
//      exclusion an operator intends is EXPRESSED HERE rather than performed
//      invisibly in Meta's UI;
//   2. the GATE — this module, wired at every door that can write or act on that
//      field, so a protected-characteristic persona audience in the exclude slot
//      is REFUSED (CLAUDE.md §4, fail closed);
//   3. the RECORD — `facebook_custom_audiences.used_as_suppression_at` /
//      `used_as_suppression_by_campaign_id` (migration m538), so the fact that an
//      audience was used to suppress is auditable after the fact, and read back
//      onto the audience card in the ads dashboard.
//
// ── WHY THE PLACEMENT, NOT THE RULE TYPE, DECIDES THE OPERATION HERE ────────
// `audienceUseOf(rule)` answers "does this audience's OWN RULE declare that it
// subtracts" — `exclusion_active_pipeline` does, `persona_segment` does not.
// That is the right question at the audience's four define/populate doors and
// the wrong question here: an audience of `senior` reads as an INCLUSION rule
// right up until a campaign drops its id into the exclude slot, at which point
// it withholds housing advertising from the elderly. So this module ESCALATES —
// `resolveAudiencePersonaBasis(rule, "exclusion")` — and the escalation
// parameter is typed so it can only ever make the verdict stricter.
//
// ── IT COINS NO VOCABULARY (CLAUDE.md §6) ───────────────────────────────────
// Nothing here decides which personas are protected, what a source rule means or
// what "exclusion" is. It calls the gates that already own those answers:
//   · `resolveAudiencePersonaBasis(rule, "exclusion")` → `personaAdsEligibility(
//     persona, "exclusion")` → `protectedClassReasonFor` — the fair-housing arm;
//   · `assertAudienceSegmentationAllowed` — the token gate, which still catches
//     a protected class smuggled somewhere other than the personas key
//     (`contact_tags: ["seniors-55plus"]`), and which the persona carve-out does
//     not reach;
//   · `isSourceRuleType` — the one roster.
// Both refusing gates run on every audience in the slot. They do not subsume
// each other: the persona gate is the only one that refuses a CANONICAL persona
// (the token gate carves those out for inclusion rules), and the token gate is
// the only one that refuses a protected class that is not spelled as a persona.
//
// PURE, except for one explicitly-injected loader. The gate itself takes ROWS,
// so the simulator can prove it refuses on fixtures; `verifyExclusionSlot` is
// the thin async wrapper the four doors call, and its tenant scope comes from
// the caller's SESSION-derived brokerage id, never from the request (§4).

import {
  declaresPersonaBasis,
  resolveAudiencePersonaBasis,
} from "@/lib/ads/audience-persona-basis"
import { isSourceRuleType } from "@/lib/ads/audience-source-rules"
import { assertAudienceSegmentationAllowed } from "@/lib/lead-governance/protected-class-signals"

// ─── THE TWO SLOT KEYS ────────────────────────────────────────────────────────

/**
 * THE field an operator declares a suppression list in. Named once, here, and
 * imported everywhere else (§6) — a second spelling of this key would be an
 * exclusion nothing gates, which is the defect this module exists to remove.
 */
export const EXCLUDED_AUDIENCE_IDS_KEY = "excluded_audience_ids"

/**
 * Its long-standing opposite. `custom_audience_ids` was declared on both
 * `TargetingConfig`s and written as `[]` by three writers with NO READER
 * ANYWHERE (CLAUDE.md §1 — a writerless-reader orphan on the permissive side:
 * an operator who picked audiences got a campaign that targeted nobody in
 * particular). The reader is built in lib/ads/launch-assembler.ts, which now
 * resolves BOTH slots to platform audience ids and hands them to the Meta
 * payload as `custom_audiences` / `excluded_custom_audiences`.
 */
export const INCLUDED_AUDIENCE_IDS_KEY = "custom_audience_ids"

// ─── READING THE SLOTS OFF A TARGETING CONFIG ─────────────────────────────────

function idListAt(targeting: unknown, key: string): string[] {
  if (!targeting || typeof targeting !== "object" || Array.isArray(targeting)) return []
  const raw = (targeting as Record<string, unknown>)[key]
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== "string") continue
    const id = v.trim()
    if (id.length > 0 && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * PURE. The audience ids this campaign declares as a SUPPRESSION list.
 *
 * Non-string and blank entries are DROPPED rather than carried forward, and
 * that is the safe direction for a suppression list specifically: a dropped
 * entry means somebody is still reached, never that somebody is silently
 * withheld from. `malformedExclusionSlot` below is what refuses the malformed
 * shape outright, so nothing is dropped in silence either.
 */
export function excludedAudienceIdsIn(targeting: unknown): string[] {
  return idListAt(targeting, EXCLUDED_AUDIENCE_IDS_KEY)
}

/** PURE. The audience ids this campaign declares as TARGETS. */
export function includedAudienceIdsIn(targeting: unknown): string[] {
  return idListAt(targeting, INCLUDED_AUDIENCE_IDS_KEY)
}

/**
 * PURE. True when the exclusion slot is PRESENT but is not a clean list of id
 * strings — `excluded_audience_ids: "aud-1"`, `[{id:"aud-1"}]`, `[null]`.
 * A malformed slot is refused rather than read past: "we could not parse who
 * you meant to suppress" must not render as "you suppressed nobody".
 *
 * MODULE-PRIVATE. It is the first thing `verifyExclusionSlot` asks and it has no
 * other honest caller — exporting it would invite a caller to ask the question
 * WITHOUT then refusing on the answer, which is the shape this whole module
 * exists to remove. The simulator proves the three malformed shapes THROUGH the
 * door, which is where the refusal has to happen anyway.
 */
function malformedExclusionSlot(targeting: unknown): boolean {
  if (!targeting || typeof targeting !== "object" || Array.isArray(targeting)) return false
  if (!(EXCLUDED_AUDIENCE_IDS_KEY in (targeting as Record<string, unknown>))) return false
  const raw = (targeting as Record<string, unknown>)[EXCLUDED_AUDIENCE_IDS_KEY]
  if (raw === null || raw === undefined) return false
  if (!Array.isArray(raw)) return true
  return raw.some((v) => typeof v !== "string" || v.trim().length === 0)
}

// ─── THE VERDICT ──────────────────────────────────────────────────────────────

/** The columns this gate needs off `facebook_custom_audiences`. */
export interface ExclusionAudienceRow {
  id: string
  audience_name?: string | null
  source_rule?: unknown
  /** NOT read by the gate — carried so the launch door, which must resolve a
   *  platform id, can type the rows it loads with the same interface. */
  external_audience_id?: string | null
  status?: string | null
}

/**
 * MODULE-PRIVATE ON PURPOSE. This was exported and nothing imported it — the
 * opposite-missing census named it as a one-sided pair, correctly.
 *
 * It is NOT a duplicate of `PersonaAdsEligibility.refusalKind`, so §1 does not
 * call for a merge: that one answers "why is this persona not a valid basis"
 * (three members) while this answers "why did the exclusion SLOT refuse" — a
 * superset that also covers the slot's shape, tenancy and gate availability. The
 * mapping between them is explicit below, and it is a widening, not an alias.
 *
 * The missing half here was a READER, and there is no honest one to build: the
 * exported verdict interface carries the union structurally, so a consumer can
 * branch on it without naming the type. Exporting it anyway would be a name kept
 * alive for a caller that does not exist. Same remedy already applied in this
 * file to `malformedExclusionSlot`.
 */
type ExclusionRefusalKind =
  /** The slot is present but is not a list of id strings. */
  | "malformed_slot"
  /** An id in the slot matches no audience in THIS tenant. */
  | "unknown_audience"
  /** The audience's rule names no type this product can resolve. */
  | "unresolvable_rule"
  /** A protected-characteristic persona used to SUPPRESS. THE fair-housing refusal. */
  | "protected_characteristic"
  /** `other` — a persona basis that names no situation. */
  | "no_basis"
  /** A persona basis that cannot be resolved at all (empty, non-canonical…). */
  | "unresolvable_basis"
  /** A protected class spelled somewhere other than the personas key. */
  | "protected_segmentation"
  /** A gate could not run. FAIL CLOSED — "nobody checked" is not "checked and fine". */
  | "gate_unavailable"

export interface GovernedExclusion {
  audienceId: string
  audienceName: string
  /** The rule type the suppression is built on, for the audit line. */
  ruleType: string
}

export type ExclusionSlotVerdict =
  | {
      ok: true
      /** Every id in the slot, in declared order. Empty when nothing was declared. */
      audienceIds: string[]
      /** One entry per admitted audience — what the audit record is written from. */
      governed: GovernedExclusion[]
    }
  | {
      ok: false
      refusalKind: ExclusionRefusalKind
      /** The audience that tripped it, when one did. */
      audienceId: string | null
      /** A sentence an operator reads, naming the campaign and the fix. */
      refusal: string
    }

/**
 * PURE. May this campaign suppress these audiences?
 *
 * FAILS CLOSED ON EVERY PATH (CLAUDE.md §4). An id with no row, a rule with no
 * resolvable type, a gate that throws something other than its own refusal — all
 * REFUSE. There is no arm that returns `ok: true` because a check could not be
 * performed, and there is deliberately no "warn and continue": a suppression that
 * proceeds while unverified is exactly the invisible exclusion this whole module
 * exists to end.
 *
 * `rows` are the audience rows loaded for `declaredIds` WITHIN THE ACTING
 * TENANT. Scoping is the caller's job because the tenant must come from the
 * session (§4); an id belonging to another brokerage simply produces no row and
 * is refused as `unknown_audience`, which is also the IDOR-shaped answer.
 */
export function resolveExclusionSlot(
  declaredIds: readonly string[],
  rows: readonly ExclusionAudienceRow[],
  campaignLabel: string,
): ExclusionSlotVerdict {
  if (declaredIds.length === 0) return { ok: true, audienceIds: [], governed: [] }

  const byId = new Map<string, ExclusionAudienceRow>()
  for (const r of rows) if (r && typeof r.id === "string") byId.set(r.id, r)

  const governed: GovernedExclusion[] = []
  for (const id of declaredIds) {
    const row = byId.get(id)
    if (!row) {
      return {
        ok: false,
        refusalKind: "unknown_audience",
        audienceId: id,
        refusal:
          `[audience-exclusion] REFUSED: campaign "${campaignLabel}" lists audience ${id} as an ` +
          `EXCLUSION, but no such audience exists in this brokerage. An audience this product ` +
          `cannot read cannot be checked for a protected-characteristic basis, and an unchecked ` +
          `suppression list is the shape this gate exists to refuse — it is not treated as an ` +
          `empty one. Remove the id, or create the audience here first.`,
      }
    }
    const name = (row.audience_name ?? id).toString()
    const rule = row.source_rule
    const ruleType =
      rule && typeof rule === "object" && !Array.isArray(rule)
        ? (rule as { type?: unknown }).type
        : undefined

    if (!isSourceRuleType(ruleType)) {
      return {
        ok: false,
        refusalKind: "unresolvable_rule",
        audienceId: id,
        refusal:
          `[audience-exclusion] REFUSED: campaign "${campaignLabel}" would suppress audience ` +
          `"${name}", whose source rule names ${JSON.stringify(ruleType)} — not a type this product ` +
          `can resolve (lib/ads/audience-source-rules.ts SOURCE_RULE_TYPES). Who an audience ` +
          `contains has to be knowable BEFORE it is used to withhold a housing ad from them.`,
      }
    }

    // ── GATE 1 — THE PERSONA ARM, ESCALATED TO THE OPERATION BEING PERFORMED ──
    // This is the arm the owner's 2026-08-23 ruling left in force: a situation
    // persona may TAILOR an ad (inclusion), and a protected-characteristic
    // persona may not SUPPRESS one. The escalation is what makes it fire on an
    // audience whose own rule type says "inclusion" — which is every persona
    // audience in the catalog.
    if (declaresPersonaBasis(rule)) {
      // `basis` starts NULL and a null basis REFUSES, rather than relying on the
      // control-flow reading of a try/catch. If the gate throws, nothing was
      // decided — and "nothing was decided" must fail closed (CLAUDE.md §4).
      let basis: ReturnType<typeof resolveAudiencePersonaBasis> | null = null
      let gateError: string | null = null
      try {
        basis = resolveAudiencePersonaBasis(rule, "exclusion")
      } catch (err) {
        gateError = err instanceof Error ? err.message : String(err)
      }
      if (!basis) {
        return {
          ok: false,
          refusalKind: "gate_unavailable",
          audienceId: id,
          refusal:
            `[audience-exclusion] REFUSED: campaign "${campaignLabel}" would suppress audience ` +
            `"${name}", but the persona gate could not run (${gateError ?? "no verdict"}). ` +
            `A gate that cannot run must refuse, not pass (CLAUDE.md §4).`,
        }
      }
      if (!basis.ok) {
        return {
          ok: false,
          refusalKind:
            basis.refusalKind === "protected_characteristic" ? "protected_characteristic"
            : basis.refusalKind === "no_basis" ? "no_basis"
            : "unresolvable_basis",
          audienceId: id,
          refusal:
            `[audience-exclusion] REFUSED: campaign "${campaignLabel}" lists audience "${name}" as an ` +
            `EXCLUSION, and ${basis.refusal}`,
        }
      }
    }

    // ── GATE 2 — THE TOKEN ARM, which the persona carve-out does not reach ────
    // `assertAudienceSegmentationAllowed` scans keys AND string values, so it is
    // what still refuses `contact_tags: ["seniors-55plus"]`, `min_owner_age`,
    // `demographics.recentlyDivorced` and `quicklists: ["senior-owner"]` in the
    // exclude slot. It carves out a CANONICAL persona at the personas key of an
    // inclusion rule — which is precisely the shape gate 1 above just refused,
    // so between the two there is no protected shape that passes.
    try {
      assertAudienceSegmentationAllowed(rule, name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        refusalKind: msg.includes("[protected-class-signals]") ? "protected_segmentation" : "gate_unavailable",
        audienceId: id,
        refusal:
          `[audience-exclusion] REFUSED: campaign "${campaignLabel}" would suppress audience ` +
          `"${name}". ${msg}`,
      }
    }

    governed.push({ audienceId: id, audienceName: name, ruleType })
  }

  return { ok: true, audienceIds: [...declaredIds], governed }
}

// ─── THE DOOR HELPER ──────────────────────────────────────────────────────────

/**
 * A supabase client, structurally. Typed loosely ON PURPOSE: the four doors hold
 * three different clients (the request-scoped server client, the service client,
 * and whatever a caller injects in a simulator), and importing any one of their
 * types here would make this module server-only and unimportable by the pure
 * simulator and the dashboard.
 */
export interface AudienceReader {
  from: (table: string) => any
}

/**
 * Load the declared exclusion audiences WITHIN THE ACTING TENANT and gate them.
 *
 * `brokerageId` MUST come from the session (CLAUDE.md §4). Every caller here
 * takes it from `getAgentContext()` or from an already-gated kernel ctx; none of
 * them takes it from a request body.
 *
 * READS THE ERROR (CLAUDE.md §3 — supabase-js RESOLVES refusals). A read that
 * fails is `gate_unavailable`, not "no rows, therefore nothing to check": the
 * second reading is how an RLS refusal becomes a clean bill of health.
 */
export async function verifyExclusionSlot(args: {
  supabase: AudienceReader
  brokerageId: string
  targeting: unknown
  campaignLabel: string
}): Promise<ExclusionSlotVerdict> {
  const { supabase, brokerageId, targeting, campaignLabel } = args

  if (malformedExclusionSlot(targeting)) {
    return {
      ok: false,
      refusalKind: "malformed_slot",
      audienceId: null,
      refusal:
        `[audience-exclusion] REFUSED: campaign "${campaignLabel}" declares ` +
        `${EXCLUDED_AUDIENCE_IDS_KEY} but not as a list of audience ids. A suppression list this ` +
        `product cannot read is refused rather than read past — "we could not parse who you meant ` +
        `to suppress" must never render as "you suppressed nobody".`,
    }
  }

  const ids = excludedAudienceIdsIn(targeting)
  if (ids.length === 0) return { ok: true, audienceIds: [], governed: [] }

  if (!brokerageId) {
    return {
      ok: false,
      refusalKind: "gate_unavailable",
      audienceId: null,
      refusal:
        `[audience-exclusion] REFUSED: campaign "${campaignLabel}" declares an exclusion list but ` +
        `this call carries no tenant, so the audiences cannot be read or checked. Fail closed.`,
    }
  }

  // EXACTLY the three columns the verdict is reached from. The launch door reads
  // `external_audience_id` in its own query, where it resolves the ids: this gate
  // decides whether an audience MAY suppress, not how it is addressed on the
  // platform, and mixing the two would give the gate a reason to care about a
  // column that has nothing to do with its answer.
  const { data, error } = await supabase
    .from("facebook_custom_audiences")
    .select("id, audience_name, source_rule")
    .eq("brokerage_id", brokerageId)
    .in("id", ids)

  if (error) {
    return {
      ok: false,
      refusalKind: "gate_unavailable",
      audienceId: null,
      refusal:
        `[audience-exclusion] REFUSED: campaign "${campaignLabel}" declares an exclusion list, but ` +
        `the audiences could not be read (${error.message ?? "unknown error"}). A gate that cannot ` +
        `run must refuse, not pass (CLAUDE.md §4).`,
    }
  }

  return resolveExclusionSlot(ids, (data ?? []) as ExclusionAudienceRow[], campaignLabel)
}

// ─── THE AUDIT RECORD (migration m538) ────────────────────────────────────────

export interface SuppressionRecordResult {
  /** How many audience rows were stamped. */
  recorded: number
  /**
   * The database's refusal, VERBATIM, when the stamp did not land — most
   * likely PGRST204 until m538 is applied. Surfaced by every caller rather than
   * swallowed (CLAUDE.md §3: supabase-js RESOLVES refusals).
   */
  error: string | null
}

/**
 * Stamp `facebook_custom_audiences` with the fact that these audiences were used
 * as a suppression list, and by which campaign (migration m538).
 *
 * WHY THIS IS BEST-EFFORT WHILE THE GATE IS FAIL-CLOSED, AND WHY THAT IS NOT A
 * CONTRADICTION. The gate decides whether the suppression may happen at all and
 * refuses when it cannot run. This is the AUDIT TRAIL of a suppression that was
 * already permitted — and it writes to columns that do not exist until the
 * integrator applies m538 (CLAUDE.md §3: files are not the database). A
 * PGRST204 here means "the record is not yet auditable", not "this exclusion was
 * not checked", so it degrades VISIBLY — the error is returned and every caller
 * surfaces it — rather than failing a campaign the gate already cleared.
 *
 * EXPECTED GUARD FINDING UNTIL m538 IS APPLIED. `scripts/schema-drift-guard.ts`
 * checks every written column against `scripts/schema-snapshot.ts`, which is
 * GENERATED FROM THE LIVE DATABASE and must never be hand-edited (CLAUDE.md §3).
 * So this update reports exactly two findings — `used_as_suppression_at` and
 * `used_as_suppression_by_campaign_id` — and they clear the moment the
 * integrator applies m538 and regenerates the snapshot. The names are written
 * LITERALLY, on purpose: building the update object dynamically would hide the
 * write from the guard, and a guard that cannot see the code it judges is worse
 * than no guard (§2). Same idiom as lib/finance/scoped-accounting-export.ts.
 */
export async function recordSuppressionUse(args: {
  supabase: AudienceReader
  brokerageId: string
  campaignId: string | null
  governed: readonly GovernedExclusion[]
}): Promise<SuppressionRecordResult> {
  const { supabase, brokerageId, campaignId, governed } = args
  if (governed.length === 0) return { recorded: 0, error: null }

  const { error } = await supabase
    .from("facebook_custom_audiences")
    .update({
      used_as_suppression_at: new Date().toISOString(),
      used_as_suppression_by_campaign_id: campaignId,
    })
    .eq("brokerage_id", brokerageId)
    .in("id", governed.map((g) => g.audienceId))

  if (error) {
    return {
      recorded: 0,
      error:
        `suppression-use audit not recorded (${error.message ?? "unknown error"}). The exclusion ` +
        `itself WAS gated; migration m538 adds the columns this record needs.`,
    }
  }
  return { recorded: governed.length, error: null }
}
