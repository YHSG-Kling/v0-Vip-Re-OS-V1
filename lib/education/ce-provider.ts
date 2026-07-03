// lib/education/ce-provider.ts
//
// ACCREDITED CE PROVIDER INTEGRATION (recruiting_manager) — the honest way to let agents complete
// Continuing Education INSIDE the app. VIP Agents is NOT an accreditation body, so the platform never
// issues CE credit itself. Instead it INTEGRATES an accredited CE provider: it surfaces the provider's
// accredited course catalog, launches the course in-app (deep-link / SSO), and records the completion +
// credit the PROVIDER reports back — writing into the existing agent_ce_completions ledger that the
// license-readiness engine already reads. The accreditation always comes from the connected provider.
//
// Distinction the code enforces: platform learning_modules are PROFESSIONAL DEVELOPMENT (never CE); only a
// verified completion from a connected accredited provider becomes a CE credit. No fabricated accreditation.
//
// Pure core (catalog/progress/normalize/signature) is testable; the launch/record wiring lives in the
// actions + webhook route.

import { createHmac, timingSafeEqual } from "node:crypto"

/** A connected accredited-CE provider, stored on brokerage_settings.settings.ce_provider. */
export interface CeProviderConfig {
  name: string
  connected: boolean
  /** Where an agent is sent to take a course (SSO / deep-link base). */
  launchBaseUrl?: string | null
  /** The provider's accredited course catalog (cached from the provider). */
  catalog?: CeCourse[]
}

export interface CeCourse {
  id: string
  title: string
  category: string          // ethics | fair_housing | contracts | core | elective
  hours: number
  /** State the accreditation applies to (null = multi-state). */
  state?: string | null
}

export interface CeCompletionPayload {
  agent_external_id?: string | null
  agent_id?: string | null
  course_id: string
  course_name: string
  category: string
  hours: number
  completed_on: string      // ISO date
  certificate_url?: string | null
}

/** PURE: is an accredited provider actually connected (so in-app CE is available)? */
export function isCeProviderConnected(config: CeProviderConfig | null | undefined): boolean {
  return !!config && config.connected === true && typeof config.name === "string" && config.name.trim().length > 0
}

/** PURE: the courses an agent can take in-app — only when a provider is connected; honestly empty otherwise. */
export function availableCourses(config: CeProviderConfig | null | undefined, agentState?: string | null): CeCourse[] {
  if (!isCeProviderConnected(config)) return []
  const catalog = config!.catalog ?? []
  if (!agentState) return catalog
  return catalog.filter((c) => !c.state || c.state === agentState)
}

/** PURE: normalize a provider completion payload into an agent_ce_completions insert row. */
export function normalizeCeCompletion(
  payload: CeCompletionPayload,
  ctx: { agentId: string; brokerageId: string | null; providerName: string },
): { agent_id: string; brokerage_id: string | null; course_name: string; provider: string; category: string; hours: number; completed_on: string; certificate_url: string | null; notes: string } {
  return {
    agent_id: ctx.agentId,
    brokerage_id: ctx.brokerageId,
    course_name: payload.course_name,
    provider: ctx.providerName,
    category: payload.category,
    hours: Number(payload.hours) || 0,
    completed_on: payload.completed_on,
    certificate_url: payload.certificate_url ?? null,
    notes: `Accredited CE completed in-app via ${ctx.providerName} (course ${payload.course_id}).`,
  }
}

/** PURE: sum verified CE hours from completion rows (drives agents.ce_hours_completed). */
export function sumCeHours(rows: Array<{ hours: number | null }>): number {
  return Math.round(rows.reduce((a, r) => a + (Number(r.hours) || 0), 0) * 10) / 10
}

export interface CeProgress { required: number; completed: number; remaining: number; pct: number; complete: boolean }

/** PURE: an agent's CE progress toward their renewal cycle requirement. Honest zeros when data is thin. */
export function ceProgress(required: number | null | undefined, completed: number | null | undefined): CeProgress {
  const req = Math.max(0, Number(required) || 0)
  const done = Math.max(0, Number(completed) || 0)
  const remaining = Math.max(0, req - done)
  const pct = req > 0 ? Math.min(100, Math.round((done / req) * 100)) : 0
  return { required: req, completed: done, remaining, pct, complete: req > 0 && done >= req }
}

/** Build the in-app launch URL for a course (deep-link into the connected provider). */
export function buildLaunchUrl(config: CeProviderConfig, courseId: string, agentExternalRef: string): string | null {
  if (!isCeProviderConnected(config) || !config.launchBaseUrl) return null
  const base = config.launchBaseUrl.replace(/\/+$/, "")
  return `${base}/launch?course=${encodeURIComponent(courseId)}&ref=${encodeURIComponent(agentExternalRef)}`
}

/** PURE: verify a provider completion webhook signature (HMAC-SHA256). Never throws; false on any mismatch. */
export function verifyCeSignature(rawBody: string, signature: string | null | undefined, secret: string | null | undefined): boolean {
  if (!signature || !secret) return false
  try {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}
