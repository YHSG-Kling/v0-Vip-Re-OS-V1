"use server"

/**
 * VENDOR SERVICE AREAS — declaring where a company works, and surfacing a bench
 * that respects it.
 *
 * m551 built the model (`vendor_service_areas` on the GLOBAL identity
 * `vendor_marketplace_profiles`) and the compliance gate
 * (`public.vendor_bookable_in_state` + a trigger on `vendor_bookings`). This file
 * is the half that makes it reachable: without it the table would be a read with
 * no writer and the intersection rule would live only in SQL — CLAUDE.md §1.2,
 * build the missing half.
 *
 * THREE EXPORTS, and in a `"use server"` file every one of them is a public HTTP
 * endpoint (CLAUDE.md §4), so each gates before it touches the service client:
 *
 *   declareVendorServiceAreaAction   the WRITER — a company (or platform staff)
 *                                    declares a state, optionally one ZIP, with
 *                                    the licence backing it
 *   withdrawVendorServiceAreaAction  the opposite half — coverage ends
 *   listSurfaceableBenchAction       the tenant-side READER — the bench, filtered
 *                                    to vendors whose coverage MEETS this
 *                                    tenant's own service area
 *
 * WHO MAY WRITE COVERAGE. Not the tenant. Coverage is a fact about the COMPANY,
 * and a brokerage asserting that a title company is licensed in Nevada is a
 * brokerage asserting someone else's licensure. So the writer admits the vendor
 * themselves (via the marketplace profile they own) or PLATFORM staff — the same
 * two writers the m551 RLS policies name, so the application gate and RLS agree
 * rather than each having its own opinion.
 *
 * NOTHING HERE PRICES ANYTHING. Declaring coverage raises no charge on any lane,
 * and m549's single-platform-use trigger is untouched. The pricing shape this
 * model implies is written down for the owner in
 * lib/vendors/vendor-service-area.ts :: VENDOR_COVERAGE_PRICING_IMPLICATIONS.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { requirePlatformStaff } from "@/lib/auth/platform-guard"
import { isVendorCategory } from "@/lib/kernel/vendor-categories"
import {
  VENDOR_SERVICE_AREA_STATUSES,
  isStateLicensedTrade,
  normalizeState,
  normalizeZip,
  vendorGeoVerdict,
  type TenantServiceArea,
  type VendorCoverageRow,
  type VendorGeoVerdict,
} from "@/lib/vendors/vendor-service-area"

// ─── Who may declare coverage for a company ──────────────────────────────────

type CoverageWriter =
  | { ok: true; userId: string; via: "vendor" | "platform" }
  | { ok: false; error: string }

/**
 * Gate first, then the service client (the lib/kernel/manager-registry.ts
 * pattern). Two admissible writers, checked in the cheap order.
 *
 * FAIL CLOSED: every read here is error-checked, because a refused read that
 * degrades to `data: null` would read as "you do not own this profile" — an
 * outage spoken as a permissions answer (CLAUDE.md §3, §4).
 */
async function requireCoverageWriter(platformVendorId: string): Promise<CoverageWriter> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  // The vendor's own profile. `user_id` is the profile's owner and is NOT NULL.
  const { data: profile, error: profileErr } = await supabase
    .from("vendor_marketplace_profiles")
    .select("id, user_id")
    .eq("id", platformVendorId)
    .maybeSingle()
  if (profileErr) {
    console.error("[vendor-service-areas] profile read failed:", profileErr)
    return { ok: false, error: "Could not verify this vendor profile — please retry" }
  }
  if (!profile) return { ok: false, error: "Vendor profile not found" }
  if (profile.user_id === user.id) return { ok: true, userId: user.id, via: "vendor" }

  const staff = await requirePlatformStaff()
  if (staff.ok) return { ok: true, userId: staff.userId, via: "platform" }

  return {
    ok: false,
    error:
      "Only the vendor themselves or platform staff may declare where that company works — " +
      "a brokerage cannot assert another company's licensure.",
  }
}

// ─── WRITE: declare coverage ─────────────────────────────────────────────────

export interface DeclareVendorServiceAreaInput {
  platformVendorId: string
  /** Two-letter state. Required — there is no such thing as coverage nowhere. */
  state: string
  /** Omit for STATEWIDE coverage, which is a real declaration, not a blank. */
  zipCode?: string | null
  /** `vendors.category` vocabulary — the ONE 38-value taxonomy. */
  tradeCategory: string
  /** The licence backing this coverage, in the shape
   *  vendors.compliance_credentials -> 'license' already uses. */
  license?: {
    policy_number?: string
    effective_date?: string
    expiry?: string
    url?: string
    verified_at?: string
    verified_by?: string
  } | null
  notes?: string
}

export async function declareVendorServiceAreaAction(
  input: DeclareVendorServiceAreaInput,
): Promise<{ ok: boolean; error?: string; serviceAreaId?: string }> {
  const auth = await requireCoverageWriter(input.platformVendorId)
  if (!auth.ok) return auth

  // Normalise BEFORE validating, so 'az' and '85001-1234' are accepted as the
  // values they plainly are — and reject what cannot be normalised rather than
  // storing a variant the matcher will never match.
  const state = normalizeState(input.state)
  if (!state) return { ok: false, error: "State must be a two-letter code, e.g. AZ" }

  let zipCode: string | null = null
  if (input.zipCode !== null && input.zipCode !== undefined && String(input.zipCode).trim() !== "") {
    zipCode = normalizeZip(String(input.zipCode))
    if (!zipCode) {
      return { ok: false, error: "ZIP must be five digits (ZIP+4 is accepted and stored as its five-digit prefix)" }
    }
  }

  if (!isVendorCategory(input.tradeCategory)) {
    return { ok: false, error: "Unknown trade — it must be one of the platform's vendor categories" }
  }

  // THE COMPLIANCE GATE, AT THE POINT OF DECLARATION. A state-licensed trade
  // declaring coverage with no licence would create a row that
  // vendor_bookable_in_state refuses forever — a coverage area that looks
  // declared and can never be booked. Refusing here says why, once, at the only
  // moment a human is present to fix it.
  if (isStateLicensedTrade(input.tradeCategory)) {
    const lic = input.license
    if (!lic || typeof lic !== "object" || !lic.policy_number) {
      return {
        ok: false,
        error:
          `${input.tradeCategory} is a state-licensed trade — coverage in ${state} needs the licence ` +
          `number that authorises it. Without one this vendor cannot be booked there.`,
      }
    }
    if (lic.expiry) {
      const t = Date.parse(lic.expiry)
      if (Number.isNaN(t)) return { ok: false, error: "Licence expiry is not a valid date" }
      if (t <= Date.now()) {
        return { ok: false, error: "That licence has already expired — coverage on it would be dark from the moment it is saved" }
      }
    }
  }

  const svc = createServiceClient()

  // One declaration per (company, trade, place): the partial uniques in m551
  // enforce it, and reusing an existing row rather than colliding is what makes
  // re-declaring after a withdrawal work instead of raising a raw 23505.
  let existingQ = svc
    .from("vendor_service_areas")
    .select("id")
    .eq("platform_vendor_id", input.platformVendorId)
    .eq("trade_category", input.tradeCategory)
    .eq("state", state)
  // `.eq(col, null)` renders as `col=eq.null` and matches NO rows — SQL NULL is
  // never equal to anything. The statewide branch MUST use `.is`. (This is the
  // exact bug app/actions/vendor-contact-access.ts records paying for.)
  existingQ = zipCode ? existingQ.eq("zip_code", zipCode) : existingQ.is("zip_code", null)
  const { data: existing, error: existingErr } = await existingQ.limit(1)
  if (existingErr) return { ok: false, error: existingErr.message }

  const payload = {
    platform_vendor_id: input.platformVendorId,
    state,
    zip_code: zipCode,
    trade_category: input.tradeCategory,
    license: input.license ?? null,
    status: "active",
    notes: input.notes ?? null,
    updated_at: new Date().toISOString(),
  }

  let serviceAreaId: string
  if (existing?.[0]) {
    // count:"exact" — an UPDATE matching zero rows RESOLVES as success, so
    // without it a re-declaration that hit nothing would report "saved".
    const { error, count } = await svc
      .from("vendor_service_areas")
      .update(payload, { count: "exact" })
      .eq("id", existing[0].id as string)
    if (error) return { ok: false, error: error.message }
    if ((count ?? 0) === 0) {
      return { ok: false, error: "Could not update that service area — nothing was saved." }
    }
    serviceAreaId = existing[0].id as string
  } else {
    const { data: inserted, error } = await svc
      .from("vendor_service_areas")
      .insert(payload)
      .select("id")
      .single()
    if (error || !inserted) return { ok: false, error: error?.message ?? "Insert failed" }
    serviceAreaId = inserted.id as string
  }

  // Declaring where a licensed company may work is an auditable event: it is the
  // fact the booking gate will later refuse or permit on.
  await svc.from("audit_log").insert({
    after: { ...payload, declared_via: auth.via },
    user_id: auth.userId,
    action: "vendor_service_area.declared",
    entity_type: "vendor_service_area",
    entity_id: serviceAreaId,
  })

  revalidatePath("/dashboard/vendors")
  revalidatePath("/portal/vendor")
  return { ok: true, serviceAreaId }
}

// ─── WRITE: withdraw coverage ────────────────────────────────────────────────

export async function withdrawVendorServiceAreaAction(params: {
  platformVendorId: string
  serviceAreaId: string
  /** 'withdrawn' = the vendor leaving a market. 'suspended' = the platform
   *  holding them out of it. Distinct on purpose; both stop the work. */
  status?: "withdrawn" | "suspended"
}): Promise<{ ok: boolean; error?: string }> {
  const auth = await requireCoverageWriter(params.platformVendorId)
  if (!auth.ok) return auth

  // Read as an untyped string ON PURPOSE. In a `"use server"` file every export
  // is a public HTTP endpoint (CLAUDE.md §4) and its arguments arrive over the
  // network, so the declared parameter type is documentation, not a guarantee —
  // TypeScript would otherwise "prove" these checks unreachable and they are the
  // only thing standing between a hand-rolled POST and a 23514 from the column.
  const status: string = (params.status as string) ?? "withdrawn"
  if (!(VENDOR_SERVICE_AREA_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: "Unknown status — withdrawing means 'withdrawn' or 'suspended'" }
  }
  if (status === "active") {
    return { ok: false, error: "Withdrawing means 'withdrawn' or 'suspended' — use declare to reinstate coverage" }
  }
  // Only platform staff may SUSPEND — that is an enforcement action, and a
  // vendor suspending itself would erase the distinction the vocabulary exists
  // to keep.
  if (status === "suspended" && auth.via !== "platform") {
    return { ok: false, error: "Only platform staff may suspend a service area; a vendor withdraws from one." }
  }

  const svc = createServiceClient()
  // COUNT THE ROWS. An UPDATE matching nothing resolves as success, so without
  // this an operator would be told a company had been pulled out of a state
  // while it was still bookable there.
  const { error, count } = await svc
    .from("vendor_service_areas")
    .update({ status, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", params.serviceAreaId)
    .eq("platform_vendor_id", params.platformVendorId)
    .eq("status", "active")

  if (error) return { ok: false, error: error.message }
  if ((count ?? 0) === 0) {
    return {
      ok: false,
      error: "No ACTIVE service area matched — coverage was NOT changed. It may already be withdrawn, or belong to another company.",
    }
  }

  await svc.from("audit_log").insert({
    after: { platform_vendor_id: params.platformVendorId, service_area_id: params.serviceAreaId, status, via: auth.via },
    user_id: auth.userId,
    action: "vendor_service_area.withdrawn",
    entity_type: "vendor_service_area",
    entity_id: params.serviceAreaId,
  })

  revalidatePath("/dashboard/vendors")
  revalidatePath("/portal/vendor")
  return { ok: true }
}

// ─── READ: the bench a tenant may actually surface ───────────────────────────

export interface SurfaceableBenchRow {
  vendor_id: string
  vendor_name: string
  category: string | null
  /** TRUE only when the vendor may be surfaced AND booked here. */
  bookable: boolean
  /** The verdict's reason code — 'covered' / 'local_bench_row' on success, or
   *  the named refusal. Carried through so the UI can explain a gap instead of
   *  silently showing a shorter list. */
  reason: string
  /** Operator-facing sentence for a refusal. */
  message?: string
}

/**
 * The bench for the CALLER'S OWN tenant, with each row judged against the
 * tenant's declared service area and the vendor's declared coverage.
 *
 * TENANT COMES FROM THE SESSION (CLAUDE.md §4) — never from a parameter. There
 * is deliberately no brokerageId argument on this endpoint.
 *
 * FAIL CLOSED, AND SAY SO. Rows that cannot be surfaced come back with
 * `bookable: false` and the reason, rather than being dropped: a silently
 * shorter bench is indistinguishable from a bench that is genuinely thin, and
 * the tenant can only fix "you have declared no service area" if somebody tells
 * them that is what happened.
 */
export async function listSurfaceableBenchAction(params?: {
  /** Optional job location. When omitted the tenant's PRIMARY service area is
   *  used, so the answer is "who can work where I work". */
  jobState?: string
  jobZip?: string
}): Promise<{ ok: true; rows: SurfaceableBenchRow[] } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthenticated" }

  const { data: me, error: meErr } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (meErr) {
    console.error("[vendor-service-areas] caller read failed:", meErr)
    return { ok: false, error: "Could not verify your account — please retry" }
  }
  if (!me?.brokerage_id) return { ok: false, error: "Brokerage not configured" }
  const brokerageId = me.brokerage_id as string

  const svc = createServiceClient()

  // THE TENANT'S OWN SERVICE AREA. `subscriber_service_areas` is the live table
  // that already answers "where does this tenant work"; nothing new is minted
  // beside it (§6). A tenant that has declared none produces an empty list, and
  // the verdict then refuses with `tenant_service_area_unknown` — which is the
  // fail-closed answer, not "everywhere".
  const { data: areaRows, error: areaErr } = await svc
    .from("subscriber_service_areas")
    .select("state, zip_code, is_primary, active")
    .eq("brokerage_id", brokerageId)
    .eq("active", true)
  if (areaErr) {
    console.error("[vendor-service-areas] tenant service-area read failed:", areaErr)
    return { ok: false, error: "Could not read your service areas — please retry" }
  }
  const tenantAreas: TenantServiceArea[] = (areaRows ?? []).map((r: any) => ({
    state: r.state,
    zipCode: r.zip_code ?? null,
  }))
  const primary = (areaRows ?? []).find((r: any) => r.is_primary) ?? (areaRows ?? [])[0]

  const jobState = params?.jobState ?? (primary as any)?.state ?? null
  const jobZip = params?.jobZip ?? (primary as any)?.zip_code ?? null

  const { data: bench, error: benchErr } = await svc
    .from("vendors")
    .select("id, name, category, platform_vendor_id, compliance_credentials")
    .eq("brokerage_id", brokerageId)
    .eq("status", "active")
    .eq("visible_in_portal", true)
  if (benchErr) return { ok: false, error: benchErr.message }

  const platformIds = [...new Set((bench ?? [])
    .map((v: any) => v.platform_vendor_id)
    .filter(Boolean))] as string[]

  // ONE read for every coverage row behind this bench, rather than one per
  // vendor. `resolved` below records whether it actually happened: a refused
  // coverage read must not be scored as "these vendors declared nothing", which
  // would blame the vendors for an outage.
  let coverageByVendor = new Map<string, VendorCoverageRow[]>()
  let coverageResolved = true
  if (platformIds.length > 0) {
    const { data: cov, error: covErr } = await svc
      .from("vendor_service_areas")
      .select("platform_vendor_id, state, zip_code, trade_category, status, license")
      .in("platform_vendor_id", platformIds)
    if (covErr) {
      console.error("[vendor-service-areas] coverage read failed:", covErr)
      coverageResolved = false
    } else {
      coverageByVendor = (cov ?? []).reduce((m, r: any) => {
        const list = m.get(r.platform_vendor_id) ?? []
        list.push({
          state: r.state,
          zipCode: r.zip_code ?? null,
          tradeCategory: r.trade_category,
          status: r.status,
          license: r.license ?? null,
        })
        m.set(r.platform_vendor_id, list)
        return m
      }, new Map<string, VendorCoverageRow[]>())
    }
  }

  const rows: SurfaceableBenchRow[] = (bench ?? []).map((v: any) => {
    const verdict: VendorGeoVerdict = vendorGeoVerdict({
      resolved: coverageResolved,
      tradeCategory: v.category ?? null,
      jobState,
      jobZip,
      localBenchRow: !v.platform_vendor_id,
      coverage: v.platform_vendor_id ? coverageByVendor.get(v.platform_vendor_id) ?? [] : [],
      tenantAreas,
      benchLicense: v.compliance_credentials?.license ?? null,
    })
    return {
      vendor_id: v.id,
      vendor_name: v.name,
      category: v.category ?? null,
      bookable: verdict.ok,
      reason: verdict.ok ? verdict.reason : verdict.reason,
      message: verdict.ok ? undefined : verdict.message,
    }
  })

  return { ok: true, rows }
}
