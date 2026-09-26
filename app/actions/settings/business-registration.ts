"use server"

// app/actions/settings/business-registration.ts
// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS REGISTRATION — a BRANDING SETTING (wave 84, lane 84D; owner verbatim:
// "add the registration info needed for registration in as a branding setting
// so that info is pulled for registration.").
//
// The "Business registration" card on /settings/branding reads and saves here.
// Every export is a public HTTP endpoint (CLAUDE.md §4) and async. The tenant
// comes from the SESSION (acting-context seam), never from the payload; the
// gate runs FIRST (the brokerage finance-admin predicate — registration files a
// legal identity and obligates the brokerage to carrier fees, and the
// brokerages row it co-writes is a finance table under m472), THEN the service
// client. Writes are counted (.select("id")) — zero rows is a refusal, never a
// save.
//
// Two homes, no second copy:
//   · legal name / DBA / address / website / phone / e-mail → the brokerages
//     row, through its ONE allow-listed writer
//     (app/actions/settings/brokerage-identity.ts updateBrokerageIdentity);
//   · EIN, entity type, industry, regions, company type (+ stock listing),
//     privacy / terms / social URLs, authorized representative →
//     brokerage_settings.settings.business_registration
//     (lib/branding/business-registration.ts — also the ONE reader the carrier
//     registration loop, the port-in door and the A2P card pull from).
// The EIN never leaves this file unmasked and is never logged.

import { createServiceClient } from "@/lib/supabase/service"
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"
import { resolveBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { updateBrokerageIdentity, type UpdateBrokerageIdentityInput } from "@/app/actions/settings/brokerage-identity"
import {
  loadBusinessRegistrationSources, validateBusinessRegistrationInput, maskEin,
  BUSINESS_REGISTRATION_SETTINGS_KEY, type BusinessRegistration, type RegistrationInput,
} from "@/lib/branding/business-registration"
import { deriveA2pProfile, type A2pFieldSource } from "@/lib/voice/a2p-registration"

/** The brokerages-row facts the card shows and saves through updateBrokerageIdentity. */
const IDENTITY_KEYS = ["name", "dba", "address", "address_line2", "city", "state", "zip", "website", "phone", "email"] as const
type IdentityKey = (typeof IDENTITY_KEYS)[number]

export interface BusinessRegistrationView {
  canEdit: boolean
  identity: Record<IdentityKey, string>
  /** The registration record — EIN REMOVED (see einMasked / einOnFile). */
  registration: Omit<Partial<BusinessRegistration>, "ein">
  einOnFile: boolean
  /** ••-•••6789 — the only EIN form a browser ever receives. */
  einMasked: string
  /** What carrier registration still needs — the SAME list the hourly loop rings with. */
  missing: string[]
  /** Where each field of the filing comes from (registration | brokerage | owner_seat | default | storefront). */
  sources: Record<string, A2pFieldSource>
  lastSavedAt: string | null
}

async function gate(mode: "read" | "write"): Promise<{ ok: true; brokerageId: string; canEdit: boolean } | { ok: false; error: string }> {
  const ctx = mode === "write" ? await resolveWriteContext() : await resolveActingContext()
  if (!ctx.ok) return { ok: false, error: ctx.error ?? "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "Your account is not attached to a brokerage." }
  const admin = await resolveBrokerageFinanceAdmin(ctx.db, ctx.userId, { user_type: ctx.userType, brokerage_id: ctx.brokerageId })
  // Fail closed: a permission read that could not run refuses.
  if (!admin.ok) return { ok: false, error: `Could not resolve your permissions for business registration: ${admin.error}` }
  if (!admin.isFinanceAdmin) return { ok: false, error: "Only a broker / owner / admin can view or edit business registration" }
  const readOnly = "readOnly" in ctx ? Boolean((ctx as { readOnly?: boolean }).readOnly) : false
  return { ok: true, brokerageId: ctx.brokerageId, canEdit: mode === "write" || !readOnly }
}

function buildView(src: Extract<Awaited<ReturnType<typeof loadBusinessRegistrationSources>>, { ok: true }>, canEdit: boolean): BusinessRegistrationView {
  const b = (src.brokerage ?? {}) as Record<string, unknown>
  const identity = {} as Record<IdentityKey, string>
  for (const k of IDENTITY_KEYS) identity[k] = typeof b[k] === "string" ? (b[k] as string) : ""
  const { ein, ...registration } = src.registration
  const d = deriveA2pProfile({ registration: src.registration, brokerage: src.brokerage, owner: src.owner, appUrl: process.env.NEXT_PUBLIC_APP_URL ?? null })
  return {
    canEdit,
    identity,
    registration,
    einOnFile: !!ein,
    einMasked: maskEin(ein),
    missing: d.validation.ok ? [] : d.validation.missing,
    sources: d.sources,
    lastSavedAt: src.registration.updatedAt ?? null,
  }
}

/** READ — the card's data. A read_only support grant may see it (masked EIN). */
export async function getBusinessRegistrationAction(): Promise<{ ok: true; view: BusinessRegistrationView } | { ok: false; error: string }> {
  const g = await gate("read")
  if (!g.ok) return g
  const svc = createServiceClient()
  const src = await loadBusinessRegistrationSources(svc, g.brokerageId)
  if (!src.ok) return { ok: false, error: src.error }
  return { ok: true, view: buildView(src, g.canEdit) }
}

export interface SaveBusinessRegistrationInput {
  /** brokerages-row facts; only keys present are written (via updateBrokerageIdentity). */
  identity?: Partial<Record<IdentityKey, string>>
  /** Registration-only facts. A blank EIN keeps the one on file. */
  registration: RegistrationInput
}

/** WRITE — validate everything first, then the identity row, then the registration record. */
export async function saveBusinessRegistrationAction(
  input: SaveBusinessRegistrationInput,
): Promise<{ ok: true; view: BusinessRegistrationView } | { ok: false; error: string; errors?: string[] }> {
  const g = await gate("write")
  if (!g.ok) return g
  const svc = createServiceClient()
  const src = await loadBusinessRegistrationSources(svc, g.brokerageId)
  if (!src.ok) return { ok: false, error: `${src.error} — nothing was saved` }

  const v = validateBusinessRegistrationInput(input?.registration, src.registration)
  if (!v.ok) return { ok: false, error: "Business registration not saved — fix the fields below", errors: v.errors }

  // 1. The brokerages row, through its ONE writer (its own gate, allow-list,
  //    validation and counted update).
  const idIn = (input?.identity ?? {}) as Record<string, unknown>
  const identity: Record<string, string> = {}
  for (const k of IDENTITY_KEYS) if (typeof idIn[k] === "string") identity[k] = idIn[k] as string
  if (Object.keys(identity).length > 0) {
    const r = await updateBrokerageIdentity(identity as UpdateBrokerageIdentityInput)
    if (r.error) return { ok: false, error: `Business details not saved: ${r.error}` }
  }

  // 2. The registration record — the whole key replaced (a blank field clears),
  //    every other settings key carried as read.
  const settings = { ...src.settings, [BUSINESS_REGISTRATION_SETTINGS_KEY]: v.value }
  const write = src.settingsRowId
    ? await svc.from("brokerage_settings").update({ settings, updated_at: new Date().toISOString() }).eq("id", src.settingsRowId).eq("brokerage_id", g.brokerageId).select("id")
    : await svc.from("brokerage_settings").insert({ brokerage_id: g.brokerageId, settings }).select("id")
  if (write.error) return { ok: false, error: `Business registration not saved (${write.error.message})${Object.keys(identity).length ? " — the business details above WERE saved" : ""}` }
  if (!Array.isArray(write.data) || write.data.length === 0) {
    return { ok: false, error: `Business registration not saved — the database matched no settings row for this brokerage${Object.keys(identity).length ? " (the business details above WERE saved)" : ""}` }
  }

  const after = await loadBusinessRegistrationSources(svc, g.brokerageId)
  if (!after.ok) return { ok: false, error: `Saved, but the registration could not be re-read (${after.error})` }
  return { ok: true, view: buildView(after, true) }
}
