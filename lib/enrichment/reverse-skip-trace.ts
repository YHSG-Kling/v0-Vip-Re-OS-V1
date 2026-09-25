/**
 * lib/enrichment/reverse-skip-trace.ts — THE REVERSE SKIP TRACE WRAPPER (wave 82 lane A)
 *
 * Owner verbatim (wave 82): "build a reverse skip trace wrapper." Lane 81B's open item: a
 * record keyed by a PERSON (name + phone or email, no property address) could only be traced
 * by People Data Labs at $0.25/match, because BatchData's V3 skip trace is property-keyed and
 * its reverse product ("hand the API a phone number or email and it returns the person behind
 * it", batchdata.io/reverse-skip-trace-api) had no wrapper here. This is that wrapper:
 *
 *   1. ROUTE  — lib/ai-isa/property-lookup-rail.ts::resolveContactProviderRoute (capability
 *               "reverse_contact": BatchData $0.07/match first, PeopleData $0.25/match on a miss).
 *   2. GATE   — THE ONE BatchData gate, resolveBatchDataAccess({ brokerageId, purpose: "skip_trace" })
 *               (tier ≠ off = the platform-wide monthly cap; tenant required, §4). Refused → the
 *               BatchData leg is a miss and the route's next provider is asked.
 *   3. BATCHDATA — lib/external/batchdata-client.ts::reverseSkipTraceBatchData (MCP
 *               `reverse_skip_trace` first, REST fallback), billed per MATCHED record.
 *   4. PEOPLEDATA — ONLY on a BatchData miss, and only when the caller wants the fallback here
 *               (the enrichment drain keeps its own PeopleData step, which also builds the rich
 *               profile, so it passes `peopleData: null`).
 *   5. BOOKING — PLATFORM-PAID (owner, wave 81: "those capabilities and scraping acquisition are
 *               platform paid"): meterVendorSpend → vendor_usage_tracking at the REPORTED cost,
 *               brokerage-attributed for telemetry, never a tenant meter.
 *
 * IDENTITY DISCIPLINE (expert rule, not a guess): a phone or an email is a SHARED key — a
 * household line resolves to a spouse, a recycled number to a stranger. When the input carries
 * a last name, a returned person is accepted ONLY when the last names agree (first name breaks
 * ties); otherwise the BatchData answer is treated as a miss (still billed — BatchData did match
 * someone) and never written onto the record. With no name, city/state break ties between persons.
 */

import type { BatchDataAccess, ContactDataProvider, ContactProviderRoute } from "@/lib/ai-isa/property-lookup-rail"
import type { BatchDataReversePerson, BatchDataReverseSkipTraceInput, BatchDataReverseMatch } from "@/lib/external/batchdata-client"
import type { PeopleDataEnrichment } from "@/lib/external/peopledata-client"

export interface ReverseSkipTraceInput {
  /** Tenant resolved server-side by the caller (queue row, session) — never a body (§4). */
  brokerageId: string | null
  /** Correlation id (lead/contact/raw record id) — echoed to BatchData as requestId. */
  ref: string
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  email?: string | null
  city?: string | null
  state?: string | null
}

export interface ReverseSkipTraceOutcome {
  status: "matched" | "no_match" | "refused"
  provider: ContactDataProvider | null
  route: ContactProviderRoute
  person: { firstName: string | null; lastName: string | null; fullName: string | null } | null
  phones: string[]
  emails: string[]
  propertyAddress: BatchDataReversePerson["propertyAddress"]
  /** Everything this call cost the PLATFORM (both legs), in USD. */
  costUsd: number
  gate: BatchDataAccess | null
  /** The PeopleData record when the fallback leg matched (the drain passes peopleData: null). */
  peopleData: PeopleDataEnrichment | null
  reason: string
}

type MeterFn = (input: {
  vendorName: string; usageType: string; cost: number; brokerageId: string | null
  systemSource?: string; metadata?: Record<string, unknown>
}) => Promise<boolean>

export interface ReverseSkipTraceDeps {
  /** A gate verdict the caller already holds (the drain resolves it once per row). */
  access?: BatchDataAccess
  reverse?: (inputs: readonly BatchDataReverseSkipTraceInput[]) => Promise<{ matches: BatchDataReverseMatch[]; cost: number }>
  /** PeopleData fallback. `null` = the caller runs its own fallback step (no PDL call here). */
  peopleData?: ((p: { name?: string; phone?: string; email?: string }) => Promise<{ data: PeopleDataEnrichment | null; cost: number }>) | null
  meter?: MeterFn
  systemSource?: string
  metadata?: Record<string, unknown>
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z]/g, "")

/**
 * PURE — which returned person (if any) is the one the input names. Last name must agree when
 * the input has one (a shared line is not the same person); first name, then city/state, break
 * ties. No name on the input → city/state tie-break, else the provider's first (highest-ranked).
 */
export function selectReversePerson(
  persons: readonly BatchDataReversePerson[],
  input: Pick<ReverseSkipTraceInput, "firstName" | "lastName" | "city" | "state">,
): { person: BatchDataReversePerson | null; reason: string } {
  if (persons.length === 0) return { person: null, reason: "no person returned" }
  const inState = norm(input.state), inCity = norm(input.city)
  const placeScore = (p: BatchDataReversePerson) => {
    const places = [p.propertyAddress, ...p.addresses].filter(Boolean) as NonNullable<BatchDataReversePerson["propertyAddress"]>[]
    let best = 0
    for (const a of places) {
      const s = (inState && norm(a.state) === inState ? 1 : 0) + (inCity && norm(a.city) === inCity ? 1 : 0)
      if (s > best) best = s
    }
    return best
  }
  let pool = [...persons]
  const last = norm(input.lastName)
  if (last) {
    pool = pool.filter((p) => norm(p.lastName) === last || (!p.lastName && norm(p.fullName).endsWith(last)))
    if (pool.length === 0) return { person: null, reason: `name mismatch — the phone/email resolved to someone other than "${input.lastName}" (not written)` }
    const first = norm(input.firstName)
    if (first) {
      const exact = pool.filter((p) => norm(p.firstName) === first || norm(p.fullName).startsWith(first))
      if (exact.length > 0) pool = exact
    }
  }
  pool.sort((a, b) => placeScore(b) - placeScore(a))
  return { person: pool[0], reason: last ? "last name agrees" : inState || inCity ? "no name on the input — best place match" : "no name on the input — provider's top-ranked person" }
}

/** THE wrapper. Never throws; every refusal/miss comes back as data. */
export async function reverseSkipTracePerson(
  input: ReverseSkipTraceInput,
  deps: ReverseSkipTraceDeps = {},
): Promise<ReverseSkipTraceOutcome> {
  const { resolveContactProviderRoute, resolveBatchDataAccess } = await import("@/lib/ai-isa/property-lookup-rail")
  const hasName = !!(input.firstName?.trim() || input.lastName?.trim())
  const hasEmailOrPhone = !!(input.phone?.trim() || input.email?.trim())
  const route = resolveContactProviderRoute({ hasName, hasPropertyAddress: false, hasEmailOrPhone, hasProfileUrl: false })
  const base: ReverseSkipTraceOutcome = {
    status: "no_match", provider: null, route, person: null, phones: [], emails: [], propertyAddress: null,
    costUsd: 0, gate: null, peopleData: null, reason: route.reason,
  }
  if (route.capability !== "reverse_contact" || !hasEmailOrPhone) {
    return { ...base, status: "refused", reason: "a reverse skip trace needs a phone or an email — " + route.reason }
  }
  if (!input.brokerageId) return { ...base, status: "refused", reason: "no tenant on the request — a tenant-less billed trace is refused (§4)" }
  const meter: MeterFn = deps.meter ?? (async (m) => {
    const { meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
    return meterVendorSpend(m)
  })
  const systemSource = deps.systemSource ?? "skip_trace"

  // ── BatchData leg — THE ONE GATE first ──
  const gate = deps.access ?? (await resolveBatchDataAccess({ brokerageId: input.brokerageId, purpose: "skip_trace" }))
  let costUsd = 0
  let missReason = gate.allowed ? "" : `BatchData not asked: ${gate.reason}`
  if (gate.allowed) {
    try {
      const ask = [{ ref: input.ref, phone: input.phone ?? null, email: input.email ?? null }]
      const { reverseSkipTraceBatchData } = await import("@/lib/external/batchdata-client")
      const { matches, cost } = deps.reverse ? await deps.reverse(ask) : await reverseSkipTraceBatchData(ask)
      costUsd += cost
      if (cost > 0) {
        await meter({
          vendorName: "batchdata", usageType: "reverse_skip_trace", cost, brokerageId: input.brokerageId, systemSource,
          metadata: { ref: input.ref, matched: !!matches[0]?.matched, route: route.providers.join(">"), ...(deps.metadata ?? {}) },
        }).catch(() => false)
      }
      const pick = selectReversePerson(matches[0]?.persons ?? [], input)
      if (pick.person && (pick.person.phones.length > 0 || pick.person.emails.length > 0)) {
        return {
          ...base, status: "matched", provider: "batchdata", gate, costUsd,
          person: { firstName: pick.person.firstName, lastName: pick.person.lastName, fullName: pick.person.fullName },
          phones: pick.person.phones, emails: pick.person.emails, propertyAddress: pick.person.propertyAddress,
          reason: `BatchData reverse skip trace matched (${pick.reason})`,
        }
      }
      missReason = `BatchData reverse skip trace: ${pick.reason}`
    } catch (e) {
      missReason = `BatchData reverse skip trace failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // ── PeopleData leg — ONLY on a BatchData miss, only when the route names it ──
  if (deps.peopleData === null || !route.providers.includes("peopledata")) {
    return { ...base, gate, costUsd, reason: missReason || base.reason }
  }
  try {
    const pdl = deps.peopleData ?? (await import("@/lib/external/peopledata-client")).skipTraceWithPeopleData
    const name = [input.firstName, input.lastName].filter((v) => v && v.trim()).join(" ") || undefined
    const { data, cost } = await pdl({ name, phone: input.phone ?? undefined, email: input.email ?? undefined })
    costUsd += cost
    if (cost > 0) {
      await meter({
        vendorName: "peopledata", usageType: "reverse_skip_trace_fallback", cost, brokerageId: input.brokerageId, systemSource,
        metadata: { ref: input.ref, matched: !!data, ...(deps.metadata ?? {}) },
      }).catch(() => false)
    }
    if (data && ((data.phones?.length ?? 0) > 0 || (data.emails?.length ?? 0) > 0)) {
      return {
        ...base, status: "matched", provider: "peopledata", gate, costUsd, peopleData: data,
        person: { firstName: data.firstName ?? null, lastName: data.lastName ?? null, fullName: data.fullName ?? null },
        phones: data.phones ?? [], emails: data.emails ?? [],
        reason: `${missReason}; PeopleData matched`,
      }
    }
    return { ...base, gate, costUsd, reason: `${missReason}; PeopleData found nothing` }
  } catch (e) {
    return { ...base, gate, costUsd, reason: `${missReason}; PeopleData failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
