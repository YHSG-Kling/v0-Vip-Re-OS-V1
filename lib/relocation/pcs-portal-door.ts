// lib/relocation/pcs-portal-door.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PERSON-MODE DOOR OF THE PCS / RELOCATION PLANNER (wave 153, lane 153K — convergence row 61; owner ruling 16:
// "built but not finished needs finishing").
//
// SURVIVOR VERDICT (CLAUDE.md §1): the planner (lib/relocation/pcs-planner.ts planRelocation, person mode) and its manager
// owner (MAINTENANCE_DOMAINS relocation_planner → shopping_agent) were BUILT in wave 150 with no consumer entry surface — no
// screen asked the person for consent and their volunteered facts, so the person mode was unreachable. This module is that
// door, placed on the EXISTING portal journey (the military persona's "PCS Planning" stage, app/portal/[contactId]/journey) —
// no parallel military user type, no second relocation planner, no new table.
//
// RULES (the planner's own boundaries, enforced at the door):
//   · THE PERSON ONLY. The consent basis is the person's own: a staff seat that may open the portal (requireContactAccess's
//     staff branch) is REFUSED here — staff record what a person told them through the lead desk's stated-date door.
//   · CONSENT FIRST. No plan without the person ticking the consent statement; nothing is read or written before it.
//   · VOLUNTEERED FACTS ONLY. Destination, report date, BAH (their own figure), VA interest, a spouse's licensed occupation,
//     their own home numbers. Never orders, never service history. The BAH and home numbers are used for this answer and NOT
//     stored.
//   · ONE WRITE, THROUGH THE CANONICAL WRITER. A stated report date is recorded through lib/intent/movement-signals.ts
//     reassessExistingContact (change `stated_date`, deadline `relocation_start`, captured by the PERSON, a deterministic
//     reference so a resubmit replays) — the movement loop then places the decision window on the stated date and the
//     life-change manager / arbiter take it from there (respondToLifeChangeSignal → arbitrateAndRecordExperience).
//   · LICENSE HONESTY. The destination-vs-licensed-states referral reads the assigned agent's ACTIVE agent_licenses rows in the
//     contact's tenant; an unreadable roster makes NO referral judgment and says so (never a guessed "your agent serves it").
//
// Consumer: app/actions/portal-pcs-plan.ts planMyPcsMove (the portal session gate). Proof: scripts/relocation-planner-guard.ts §G.

import type { SupabaseClient } from "@supabase/supabase-js"
import { planRelocation } from "./pcs-planner"
import { personaJourneyTools } from "@/lib/kernel/types"

type Svc = SupabaseClient<any, any, any>

/** The farthest ahead a stated report date may sit (two years) — the lead desk's stated-date door uses the same bound. */
const REPORT_DATE_MAX_DAYS_AHEAD = 730

interface PortalPcsPlanInput {
  consentGiven: boolean
  destinationLabel: string
  installationName?: string | null
  destinationState?: string | null
  /** The report / move date the person stated (YYYY-MM-DD). */
  reportDate?: string | null
  bahMonthly?: number | null
  vaInterest?: boolean
  spouseLicensedOccupation?: string | null
  currentHome?: { value?: number | null; mortgageBalance?: number | null; monthlyPayment?: number | null; expectedRent?: number | null } | null
}

interface PortalPcsAccess { brokerageId: string; contactId: string; userId: string; isContactSelf: boolean }

type StatedDateOutcome = { status: "recorded" | "replayed" | "not_stated" | "refused"; detail: string }

type RecordStatedDate = (svc: Svc, a: {
  brokerageId: string; contactId: string; capturedBy: "person"
  change: { kind: "stated_date"; deadline: { kind: "relocation_start"; at: string }; quote: string; referenceId: string; at: string }
}) => Promise<{ status: "reassessed" | "recorded_no_decision" | "replayed" | "refused"; reason: string }>

type PersonPlan = Extract<ReturnType<typeof planRelocation>, { ok: true; mode: "person" }>

type PortalPcsPlanResult =
  | { ok: true; plan: PersonPlan; statedDate: StatedDateOutcome; notes: string[] }
  | { ok: false; code: "not_the_person" | "no_consent" | "invalid" | "read_refused" | "not_this_persona"; message: string }

const finiteNonNeg = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/**
 * The door. `access` is the portal session gate's verdict (the caller ran requireContactAccess; the tenant is the CONTACT
 * ROW's, never a request field). Never throws; every refusal names what to do next.
 */
export async function planPcsMoveForPortalContact(
  svc: Svc,
  access: PortalPcsAccess,
  input: PortalPcsPlanInput,
  deps: { now?: Date; recordStatedDate?: RecordStatedDate } = {},
): Promise<PortalPcsPlanResult> {
  if (!access.isContactSelf) {
    return { ok: false, code: "not_the_person", message: "Only the person moving can share these details and agree to how they are used. If they told you a report date, record it from the lead desk with their own words." }
  }
  if (input?.consentGiven !== true) {
    return { ok: false, code: "no_consent", message: "Nothing was saved. Tick the box to agree that we use the details you share to plan your move, then plan it again." }
  }
  const now = deps.now ?? new Date()
  const destination = String(input.destinationLabel ?? "").trim().slice(0, 120)
  if (destination.length < 2) return { ok: false, code: "invalid", message: "Tell us where you are moving (a city or the installation's name) so the plan can be built around it." }
  const state = String(input.destinationState ?? "").trim().toUpperCase()
  if (state && !/^[A-Z]{2}$/.test(state)) return { ok: false, code: "invalid", message: "Use the two-letter state code for the destination (for example, VA)." }
  let reportDate: string | null = null
  if (input.reportDate) {
    const d = String(input.reportDate).slice(0, 10)
    const at = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN
    if (!Number.isFinite(at)) return { ok: false, code: "invalid", message: "That report date could not be read. Pick it from the calendar." }
    if (at < now.getTime() - 86_400_000) return { ok: false, code: "invalid", message: "That report date has already passed. Enter your next report date, or leave it blank." }
    if (at > now.getTime() + REPORT_DATE_MAX_DAYS_AHEAD * 86_400_000) return { ok: false, code: "invalid", message: "That report date is more than two years out. Leave it blank for now and add it when your dates firm up." }
    reportDate = d
  }
  const bah = finiteNonNeg(input.bahMonthly)
  if (Number.isNaN(bah) || (bah !== null && bah > 20_000)) return { ok: false, code: "invalid", message: "Enter your monthly BAH as a dollar amount from your LES or the DTMO lookup, or leave it blank." }
  const home = input.currentHome ?? null
  const homeNums = home ? { value: finiteNonNeg(home.value), mortgageBalance: finiteNonNeg(home.mortgageBalance), monthlyPayment: finiteNonNeg(home.monthlyPayment), expectedRent: finiteNonNeg(home.expectedRent) } : null
  if (homeNums && Object.values(homeNums).some((n) => Number.isNaN(n))) return { ok: false, code: "invalid", message: "The home numbers must be dollar amounts. Leave any you do not know blank." }

  // The assigned agent's licensed states — pinned to the contact's tenant (the gate's verdict), never a request field.
  const notes: string[] = []
  const { data: contact, error: contactErr } = await svc.from("contacts").select("id, agent_id, contact_persona").eq("id", access.contactId).eq("brokerage_id", access.brokerageId).maybeSingle()
  if (contactErr) return { ok: false, code: "read_refused", message: "Your plan could not be built just now because your record could not be read. Nothing was saved. Try again in a moment." }
  if (!contact) return { ok: false, code: "read_refused", message: "We could not find your client record. Nothing was saved. Reply to your agent's last message and they will get this to the right place." }
  // Wave 153 (lane 153N — owner ruling B6): the PCS journey is a tool of the military persona (lib/kernel/types.ts
  // PERSONA_JOURNEY_TOOLS) — only a Contact whose persona carries it may run it (a prospect has no Contact row at all).
  if (!personaJourneyTools((contact as { contact_persona?: string | null }).contact_persona).includes("pcs_move_plan")) {
    return { ok: false, code: "not_this_persona", message: "This move planner is part of the military journey. If you are moving on military orders, ask your agent to update your profile, then plan your move here." }
  }
  let agentLicensedStates: string[] | undefined
  const agentId = (contact as { agent_id?: string | null }).agent_id ?? null
  if (agentId) {
    const { data: lic, error: licErr } = await svc.from("agent_licenses").select("license_state, license_status").eq("agent_id", agentId).eq("brokerage_id", access.brokerageId)
    if (licErr) notes.push("We could not confirm the states your agent is licensed in, so the plan makes no referral judgment — ask your agent whether they can serve your destination.")
    else agentLicensedStates = ((lic ?? []) as Array<{ license_state?: string | null; license_status?: string | null }>)
      .filter((l) => l.license_status === "active" && !!l.license_state).map((l) => String(l.license_state))
    if (agentLicensedStates && agentLicensedStates.length === 0) { agentLicensedStates = undefined; notes.push("Your agent has no active license on file here, so the plan makes no referral judgment — ask your agent whether they can serve your destination.") }
  } else notes.push("No agent is assigned to you yet, so the plan makes no referral judgment for your destination.")

  const plan = planRelocation({
    mode: "person",
    consent: { basis: "portal_self_stated", ref: `portal:${access.userId}`, capturedAt: now.toISOString() },
    destination: { label: destination, installationName: String(input.installationName ?? "").trim().slice(0, 120) || null, state: state || null },
    statedMoveDate: reportDate,
    now,
    currentHome: homeNums ? { value: homeNums.value, valueSource: homeNums.value != null ? "as you told us" : null, mortgageBalance: homeNums.mortgageBalance, monthlyPayment: homeNums.monthlyPayment, expectedRent: homeNums.expectedRent, rentSource: homeNums.expectedRent != null ? "as you told us" : null } : null,
    bahMonthly: bah != null && bah > 0 ? { amount: bah, source: "self_stated" } : null,
    vaInterestStated: input.vaInterest === true,
    spouseLicensedOccupation: String(input.spouseLicensedOccupation ?? "").trim().slice(0, 80) || null,
    agentLicensedStates,
  })
  if (!plan.ok || plan.mode !== "person") return { ok: false, code: "invalid", message: "Your plan could not be built from those details. Nothing was saved. Check the destination and try again." }

  // The ONE write: the report date the person stated, through the canonical movement writer.
  let statedDate: StatedDateOutcome = { status: "not_stated", detail: "no report date was given, so nothing was recorded" }
  if (reportDate) {
    const record: RecordStatedDate = deps.recordStatedDate ?? (async (s, a) => {
      const { reassessExistingContact } = await import("@/lib/intent/movement-signals")
      return reassessExistingContact(s as never, a as never)
    })
    const nowIso = now.toISOString()
    try {
      const r = await record(svc, {
        brokerageId: access.brokerageId, contactId: access.contactId, capturedBy: "person",
        change: {
          kind: "stated_date",
          deadline: { kind: "relocation_start", at: `${reportDate}T00:00:00.000Z` },
          quote: `Entered in the portal move planner: report date ${reportDate}, destination ${destination}`,
          referenceId: `portal_pcs_plan:${access.contactId}:${reportDate}`,
          at: nowIso,
        },
      })
      statedDate = r.status === "refused" ? { status: "refused", detail: r.reason }
        : r.status === "replayed" ? { status: "replayed", detail: "this report date was already on file — nothing new was recorded" }
        : { status: "recorded", detail: "your report date is on file, so your agent's timing follows it" }
    } catch (e) {
      statedDate = { status: "refused", detail: `the report date could not be recorded: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  return { ok: true, plan, statedDate, notes }
}
