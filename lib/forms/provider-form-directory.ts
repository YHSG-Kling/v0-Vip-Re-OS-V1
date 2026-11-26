/**
 * lib/forms/provider-form-directory.ts — THE WHOLE PROVIDER-AUTHORIZED FORM LIBRARY, NOT ITS FIRST PAGE (wave 156, lane 156C).
 *
 * Owner (wave 156): "the form packet tool should list all possible forms/packets or have the capability for the user or manager to
 * add more … Otherwise forms can be found and selected from the user's connected transaction provider."
 *
 * WHAT WAS TRUE BEFORE: app/api/forms/provider-library/route.ts asked the connected provider for ONE page (`pageSize: 100`) and
 * returned it as "the library". A provider holding 250 forms showed 100, with nothing on screen saying 150 were missing — the 101st
 * form could not be found or selected. No adapter accepted a cursor and no response carried a total.
 *
 * THE RULES (each is code below and a check in scripts/wave156-c-forms-directory-guard.ts):
 *   · WALK, DO NOT SAMPLE — pages are requested with the provider's own cursor until the provider says there is no next page. Each
 *     request walks a bounded number of pages and hands back the cursor, so a very large library is loaded in chunks and the UI keeps
 *     the cursor until it is exhausted. The real total (when the provider reports one) and the loaded count travel with every chunk.
 *   · A PROVIDER THAT DOES NOT PAGE IS SAID — a full page with no cursor and no total is `unknown_possibly_truncated`, never "complete".
 *   · ONLY WHAT THE PROVIDER AUTHORIZES — a form the provider marks unlicensed for this account (`licensed === false`) is never listed as
 *     selectable and is refused by id with `license_missing`. Provider PDF bytes are never fetched here and never copied into tenant
 *     storage; a tenant that adopts a provider form records a REFERENCE (lib/forms/tenant-form-packets.ts addProviderFormReference).
 *   · RETIRED IS NOT ACTIVE — retired forms are hidden unless asked for, and a retired form is never selectable.
 *   · REFUSALS ARE TENANT WORDS — no provider selected / credentials need attention / provider temporarily unavailable / license missing /
 *     form not in provider library, each with the place to fix it.
 *
 * PURE except for the injected provider. Not server-only, so the guard drives it with a counted stub provider.
 */

import type { ITransactionProvider, ProviderForm } from "@/lib/integrations/providers/transaction-provider.interface"

/** The directory's category vocabulary — the provider's coarse union plus `compliance` (a brokerage checklist / compliance form). */
export const FORM_DIRECTORY_CATEGORIES = ["listing", "offer", "addendum", "disclosure", "agency", "compliance", "other"] as const
export type FormDirectoryCategory = (typeof FORM_DIRECTORY_CATEGORIES)[number]

/**
 * WHAT EACH PROVIDER'S PUBLISHED DOCUMENTATION SAYS ABOUT PAGING ITS FORM / TEMPLATE LIST (read 2026-11-25, wave 156 lane 156C
 * round 2). `verified` = the adapter implements the documented parameters; otherwise the directory labels the library
 * possibly-truncated and says so beside the provider.
 */
export const PROVIDER_PAGING_EVIDENCE: Record<string, { verified: boolean; note: string; source: string | null }> = {
  docusign: { verified: true, note: "GET /v2.1/accounts/{accountId}/templates — count + start_position (zero-based); response startPosition / endPosition / totalSetSize / nextUri; default cap 2,000 without count.", source: "https://developers.docusign.com/docs/esign-rest-api/reference/templates/templates/list/" },
  skyslope: { verified: true, note: "GET /forms (partner API) — page (1-based, default 1) + pageSize (default 10); response totalRecords + forms[].", source: "https://forms.skyslope.com/partner/api/docs (OpenAPI: https://artifacts.apis.io/skyslope/openapi/skyslope-forms-api-openapi.yml)" },
  dotloop: { verified: false, note: "not verified — no public documentation: the v2 guide publishes no /profile/{id}/form endpoint (the adapter's path); its documented library, GET /profile/{id}/loop-template, takes no paging parameters (meta.total only).", source: "https://dotloop.github.io/public-api/" },
  authentisign: { verified: false, note: "not verified — no public documentation for the adapter's /authentisign/v1/forms path; Lone Wolf's published library list (GET /forms-design/api/users/{userId}/forms) takes only libId — no paging parameters are documented.", source: "https://apidocs.lwolf.com/doc/transact-api/operation/operation-getforms" },
  formsimplicity: { verified: false, note: "not verified — no public documentation: the published Form Simplicity API (internal use only) documents no forms-list endpoint (only listTrans / activeUsers paging with batch_size + batch_no).", source: "https://api.formsimplicity.com/docs/fsforms" },
}

/** Provider page size we ask for; a provider may cap it lower. */
export const PROVIDER_DIRECTORY_PAGE_SIZE = 100
/** Pages one request walks before it hands the cursor back (the UI continues from it). 10 × 100 = 1,000 forms per chunk. */
export const PROVIDER_DIRECTORY_MAX_PAGES_PER_CHUNK = 10

export interface DirectoryFilter {
  text?: string | null
  stateCode?: string | null
  county?: string | null
  category?: FormDirectoryCategory | null
  /** A legal version label (exact, case-insensitive). */
  version?: string | null
  /** The actor's office (locations.id) and team — a form restricted to other offices / teams is not applicable to them. */
  officeId?: string | null
  teamId?: string | null
  /** "active" (default) hides retired forms; "retired" shows only retired; "all" shows both (retired never selectable). */
  status?: "active" | "retired" | "all"
}

export type ProviderRefusalCode =
  | "no_provider_selected"
  | "credentials_need_attention"
  | "provider_unavailable"
  | "license_missing"
  | "form_not_in_provider_library"

export interface ProviderRefusal {
  code: ProviderRefusalCode
  /** Tenant-friendly sentence. */
  message: string
  /** Where the seat recovers. */
  recoverHref: string
  /** Whether trying again later can succeed without anyone changing anything. */
  retryable: boolean
}

const RECOVER: Record<ProviderRefusalCode, { href: string; retryable: boolean; message: string }> = {
  no_provider_selected: { href: "/settings/integrations", retryable: false, message: "No legal-forms provider is selected for you, your team or your brokerage. Choose and connect one in Settings → Integrations to browse its form library." },
  credentials_need_attention: { href: "/settings/integrations", retryable: false, message: "Your legal-forms provider connection needs attention (it was refused or has expired). Reconnect it in Settings → Integrations." },
  provider_unavailable: { href: "/dashboard/forms", retryable: true, message: "Your legal-forms provider is temporarily unavailable. Nothing was lost — try again in a few minutes." },
  license_missing: { href: "/dashboard/admin/transaction-forms", retryable: false, message: "Your provider account is not licensed for this form. Ask your broker to request access from the provider, or add a licensed copy to the brokerage library." },
  form_not_in_provider_library: { href: "/dashboard/admin/transaction-forms", retryable: false, message: "That form is not in your provider's library for this account. Pick it from the library list, or add a licensed file to the brokerage library." },
}

/** PURE: a refusal by code, with its tenant sentence and recovery route. `detail` is appended for staff diagnostics. */
export function providerRefusal(code: ProviderRefusalCode, detail?: string | null): ProviderRefusal {
  const r = RECOVER[code]
  return { code, message: detail ? `${r.message} (${detail})` : r.message, recoverHref: r.href, retryable: r.retryable }
}

/**
 * PURE: classify why the provider could not be RESOLVED (lib/integrations/resolve-esign-provider.ts throws a sentence). A selected
 * provider with no working connection is `credentials_need_attention`; nothing selected (or a selection that cannot serve a library,
 * e.g. a portal-send choice) is `no_provider_selected`.
 */
export function classifyResolveFailure(message: string | null | undefined): ProviderRefusal {
  const m = String(message ?? "")
  if (/is set to .+ but no active .+ connection was found/i.test(m)) return providerRefusal("credentials_need_attention", m)
  if (/expired|revoked|refresh|unauthori[sz]ed|invalid (api )?key|credential/i.test(m) && !/no .+ connection was found/i.test(m)) return providerRefusal("credentials_need_attention", m)
  return providerRefusal("no_provider_selected", m)
}

/** PURE: classify a provider CALL failure by its status (adapters prefix "<Vendor> listForms <status>: …"). */
export function classifyProviderCallFailure(error: string | null | undefined, status?: number | null): ProviderRefusal {
  const e = String(error ?? "")
  const s = status ?? (Number((/\b([1-5]\d\d)\b/.exec(e) ?? [])[1]) || null)
  if (s === 401) return providerRefusal("credentials_need_attention", e)
  if (s === 402 || s === 403) return providerRefusal("license_missing", e)
  if (s === 404) return providerRefusal("form_not_in_provider_library", e)
  return providerRefusal("provider_unavailable", e)
}

/** PURE: a provider category word → the directory vocabulary (compliance is recognised; unknown is `other`). */
function directoryCategory(form: Pick<ProviderForm, "category" | "name">): FormDirectoryCategory {
  const c = String(form.category ?? "").toLowerCase()
  if ((FORM_DIRECTORY_CATEGORIES as readonly string[]).includes(c) && c !== "other") return c as FormDirectoryCategory
  if (/compliance|checklist|broker review/i.test(form.name)) return "compliance"
  return "other"
}

/** PURE: is this provider form selectable at all (authorized for the account and not retired)? */
function providerFormSelectable(f: ProviderForm): { selectable: boolean; reason: ProviderRefusalCode | "retired" | null } {
  if (f.licensed === false) return { selectable: false, reason: "license_missing" }
  if (f.retired === true) return { selectable: false, reason: "retired" }
  return { selectable: true, reason: null }
}

/** PURE: does the form pass the directory filter? (Unlicensed forms never pass — they are not part of the authorized library.) */
function providerFormMatches(f: ProviderForm, q: DirectoryFilter): boolean {
  if (f.licensed === false) return false
  const status = q.status ?? "active"
  if (status === "active" && f.retired === true) return false
  if (status === "retired" && f.retired !== true) return false
  if (q.stateCode && f.stateCode && f.stateCode.toUpperCase() !== q.stateCode.toUpperCase()) return false
  if (q.county && f.county && f.county.toLowerCase() !== q.county.toLowerCase()) return false
  if (q.category && directoryCategory(f) !== q.category) return false
  if (q.version && String(f.version ?? "").toLowerCase() !== q.version.toLowerCase()) return false
  if (f.officeIds && f.officeIds.length > 0 && !(q.officeId && f.officeIds.includes(q.officeId))) return false
  if (f.teamIds && f.teamIds.length > 0 && !(q.teamId && f.teamIds.includes(q.teamId))) return false
  if (q.text) {
    const hay = [f.name, f.issuer, f.formId, f.version].filter(Boolean).join(" ").toLowerCase()
    if (!q.text.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t))) return false
  }
  return true
}

export interface DirectoryChunk {
  ok: true
  forms: ProviderForm[]
  /** Forms the provider returned in this chunk (before the directory filter). */
  scanned: number
  /** The provider's own total for the query, when it reports one. */
  providerTotal: number | null
  /** Pass this back to continue; null once the provider says there is nothing more. */
  nextCursor: string | null
  exhausted: boolean
  completeness: "complete" | "more_available" | "unknown_possibly_truncated"
  pages: number
}

/**
 * Walk the provider's library from `cursor`, page by page, until the provider reports no next page or `maxPages` were read. The
 * provider-side filters (state, category, text) are forwarded; every filter is re-applied here, because several adapters filter
 * nothing server-side. A failed page is a refusal with its tenant words — never a short list that reads as the whole library.
 */
export async function walkProviderLibrary(
  provider: Pick<ITransactionProvider, "listForms">,
  q: DirectoryFilter,
  opts: { cursor?: string | null; maxPages?: number; pageSize?: number } = {},
): Promise<DirectoryChunk | { ok: false; refusal: ProviderRefusal }> {
  const pageSize = opts.pageSize ?? PROVIDER_DIRECTORY_PAGE_SIZE
  const maxPages = Math.max(1, opts.maxPages ?? PROVIDER_DIRECTORY_MAX_PAGES_PER_CHUNK)
  let cursor: string | null = opts.cursor ?? null
  const forms: ProviderForm[] = []
  let scanned = 0, pages = 0, providerTotal: number | null = null, lastPageFull = false, pagingReported = false
  const seenCursors = new Set<string>()
  // The provider category filter only understands its own coarse words; `compliance` is ours, so it is applied here only.
  const providerCategory = q.category && q.category !== "compliance" && q.category !== "other" ? q.category : undefined
  do {
    const res = await provider.listForms({ stateCode: q.stateCode ?? undefined, category: providerCategory, query: q.text ?? undefined, pageSize, cursor: cursor ?? undefined })
    pages++
    if (!res.success) return { ok: false, refusal: classifyProviderCallFailure(res.error, res.status ?? null) }
    const page = res.forms ?? []
    scanned += page.length
    if (typeof res.total === "number") providerTotal = res.total
    if (res.nextCursor !== undefined || typeof res.total === "number") pagingReported = true
    lastPageFull = page.length >= pageSize
    for (const f of page) if (providerFormMatches(f, q)) forms.push(f)
    const next: string | null = res.nextCursor ?? null
    // A provider that hands back the same cursor twice would loop forever — that is the end of what it can tell us.
    if (next && seenCursors.has(next)) { cursor = null; break }
    if (next) seenCursors.add(next)
    cursor = next
  } while (cursor && pages < maxPages)
  const exhausted = cursor === null
  // A provider that reports a total LARGER than what it handed back, with no next page, has truncated — never "complete".
  const shortOfTotal = providerTotal !== null && scanned < providerTotal && !opts.cursor
  const completeness: DirectoryChunk["completeness"] = !exhausted ? "more_available" : ((!pagingReported && lastPageFull) || shortOfTotal) ? "unknown_possibly_truncated" : "complete"
  return { ok: true, forms, scanned, providerTotal, nextCursor: cursor, exhausted, completeness, pages }
}

/**
 * Find ONE provider form by id in the authorized library (walks every page). Refused, by code: not in the library; unlicensed;
 * retired (with its replacement named when the provider gives one).
 */
export async function findProviderFormById(
  provider: Pick<ITransactionProvider, "listForms">,
  formId: string,
  opts: { maxPages?: number } = {},
): Promise<{ ok: true; form: ProviderForm } | { ok: false; refusal: ProviderRefusal }> {
  let cursor: string | null = null
  let pages = 0
  const maxPages = opts.maxPages ?? 200
  do {
    const res = await provider.listForms({ pageSize: PROVIDER_DIRECTORY_PAGE_SIZE, cursor: cursor ?? undefined })
    pages++
    if (!res.success) return { ok: false, refusal: classifyProviderCallFailure(res.error, res.status ?? null) }
    const hit = (res.forms ?? []).find((f) => f.formId === formId)
    if (hit) {
      const sel = providerFormSelectable(hit)
      if (sel.reason === "license_missing") return { ok: false, refusal: providerRefusal("license_missing", `form ${formId}`) }
      if (sel.reason === "retired") return { ok: false, refusal: providerRefusal("form_not_in_provider_library", `form ${formId} is retired${hit.replacedByFormId ? `; its replacement is ${hit.replacedByFormId}` : ""}`) }
      return { ok: true, form: hit }
    }
    cursor = res.nextCursor ?? null
  } while (cursor && pages < maxPages)
  return { ok: false, refusal: providerRefusal("form_not_in_provider_library", `form ${formId}`) }
}

// ── ONE PICKER: the tenant's library and the provider's forms, merged without duplicates ─────────────────────────────────────────

/** Where an entry in the picker comes from — the five sources the owner named. */
export const FORM_SOURCE_KINDS = ["brokerage", "office", "team", "agent", "connected_provider"] as const
export type FormSourceKind = (typeof FORM_SOURCE_KINDS)[number]

export interface TenantDirectoryRow {
  packetId: string
  name: string
  path: string | null
  scope: "brokerage" | "office" | "team" | "agent"
  providerName: string | null
  providerFormId: string | null
  state: string | null
  formCode: string | null
}

export interface DirectoryEntry {
  key: string
  name: string
  source: FormSourceKind
  /** A tenant library row (null for a provider form the tenant has not adopted). */
  packetId: string | null
  /** The tenant master path (null for a provider form: the bytes stay with the provider). */
  path: string | null
  providerName: string | null
  providerFormId: string | null
  stateCode: string | null
  category: FormDirectoryCategory | null
  version: string | null
  /** True when the provider form is also adopted into the tenant library (shown once, as the tenant entry). */
  adoptedFromProvider: boolean
}

/**
 * PURE: one list. A tenant row that REFERENCES a provider form (provider_form_id) and the provider's own listing of that form are ONE
 * entry — the tenant row wins (it carries the checklist mapping and scope) and is marked adopted. Two tenant rows never collapse into
 * each other (different scopes are different records); two provider listings of the same id collapse.
 */
export function mergeFormDirectory(tenant: TenantDirectoryRow[], provider: Array<ProviderForm & { providerName: string }>): DirectoryEntry[] {
  const out: DirectoryEntry[] = []
  const adopted = new Set<string>()
  for (const t of tenant) {
    const refKey = t.providerFormId && t.providerName ? `${t.providerName}:${t.providerFormId}` : null
    if (refKey) adopted.add(refKey)
    out.push({
      key: `tenant:${t.packetId}`, name: t.name, source: t.scope, packetId: t.packetId, path: t.path, providerName: t.providerName,
      providerFormId: t.providerFormId, stateCode: t.state, category: null, version: null, adoptedFromProvider: !!refKey,
    })
  }
  const seen = new Set<string>()
  for (const p of provider) {
    const k = `${p.providerName}:${p.formId}`
    if (adopted.has(k) || seen.has(k)) continue
    seen.add(k)
    out.push({
      key: `provider:${k}`, name: p.name, source: "connected_provider", packetId: null, path: null, providerName: p.providerName,
      providerFormId: p.formId, stateCode: p.stateCode ?? null, category: directoryCategory(p), version: p.version ?? null, adoptedFromProvider: false,
    })
  }
  return out
}
