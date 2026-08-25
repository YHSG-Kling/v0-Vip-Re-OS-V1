// lib/ai-isa/resolve-isa-settings.ts
// ─────────────────────────────────────────────────────────────────────────────
// AI ISA SETTINGS, RESOLVED PER USER — agent → team → brokerage → platform.
//
// OWNER RULING (2026-08-24), verbatim: "ai customizations are also per user".
//
// ── WHAT WAS THERE, MEASURED LIVE (hrvaqgvukzxfskkcrwbt, 2026-08-24) ────────
// TWO stores for one idea, and neither could say "user":
//
//   ai_isa_settings                              0 rows, 0 readers, 0 writers
//     id, brokerage_id (NOT NULL, UNIQUE), elevenlabs_voice_id, is_active,
//     require_broker_approval, settings, created_at, updated_at
//
//   global_settings.additional_settings->'ai_isa_settings'   0 rows in the table
//     the store app/actions/ai-isa-settings.ts actually read and wrote
//
// Both are keyed by ONE brokerage. `global_settings` holds zero rows live, so
// `getAIISASettings()` has returned DEFAULT_AISA_SETTINGS for every brokerage for
// its whole life and `saveAIISASettings()` has answered "Global settings row not
// found for this brokerage" for every write. The blob store could not express the
// ruling even in principle: `global_settings` is one row per brokerage, so there
// is nowhere to put a second user's answer.
//
// The GRAIN already exists in this repo — `brand_voice_profile` carries
// brokerage_id + team_id + agent_id and lib/ai/pipeline.ts cascades over it. So
// this is CLAUDE.md §1.2: no duplicate of the grain exists, the capability is
// wanted, BUILD the missing half onto the table that survives. m552 does the
// storage half; this file is the resolution half.
//
// ── SURVIVOR: the TABLE. TOMBSTONE for the blob ─────────────────────────────
// `ai_isa_settings` is the survivor because it is the only one of the two that
// CAN hold a per-user row. The `global_settings.additional_settings.ai_isa_settings`
// blob is retired as a store — see the tombstone at
// app/actions/ai-isa-settings.ts, which now delegates here. Nothing was migrated
// because there was nothing to migrate: 0 rows on both sides, verified before the
// change and re-verified after.
//
// ── MOST-SPECIFIC-WINS, NOT LAYERED, AND WHY ────────────────────────────────
// This cascades the way lib/connections/resolve-scoped.ts and
// lib/providers/messaging/resolve-sms-provider.ts already cascade: the first
// owner tier that HAS a row wins outright. It deliberately does NOT merge tier
// over tier the way lib/ai/pipeline.ts::resolveBrandVoice merges brand voice —
// brand voice is additive prose, while these are GATES (enabled, allowed
// channels, enabled_capabilities, touch ceilings). Merging a partial agent row
// onto a brokerage row would let an agent inherit a capability the brokerage
// turned off from a tier they never looked at, which is the same silent
// substitution the credential cascade stops on. One tier answers; the unset keys
// fall to DEFAULT_AISA_SETTINGS, which is a constant, not another tenant's data.
//
// ── A REFUSED READ IS NOT AN ABSENT ROW ─────────────────────────────────────
// supabase-js RESOLVES a refusal (CLAUDE.md §3), and `if (error || !data) continue`
// would walk PAST a tier that could not be read and hand back a LESS specific
// tier's settings — an agent silently governed by the brokerage's (or the
// PLATFORM's) ISA policy because one query was refused. So resolution reports
// three states and STOPS on `unreadable`, exactly as the credential cascade does.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { INTERNAL_CASCADE_ORDER, type ConnectionScope } from "@/lib/connections/scope"
import { DEFAULT_AISA_SETTINGS, type AIISASettings, type IsaCapability, defaultEnabledCapabilities } from "./settings-types"

/** The four tiers `ai_isa_settings` stores. Derived from the ONE cascade order. */
export type IsaSettingsOwnerType = Extract<ConnectionScope, "platform" | "brokerage" | "team" | "agent">

/**
 * Who is asking. `agentId` is **agents.id** — NOT users.id. The two id spaces are
 * disjoint (CLAUDE.md §3), `ai_isa_settings.agent_id` FKs `agents(id)` exactly as
 * `brand_voice_profile.agent_id` does, and passing a users id here would match no
 * row and fall through to the team's or the brokerage's settings without a word.
 */
export interface IsaSettingsScope {
  agentId?: string | null
  teamId?: string | null
  brokerageId?: string | null
}

/** The owner a resolved settings row came from — so a caller can say WHERE. */
export interface IsaSettingsOwner {
  ownerType: IsaSettingsOwnerType
  /** null for the platform tier, which is a singleton with no id. */
  ownerId: string | null
}

export type IsaSettingsResult =
  | { status: "resolved"; settings: AIISASettings; owner: IsaSettingsOwner }
  /** Every tier answered and none of them has a row. `settings` is the constant default. */
  | { status: "default"; settings: AIISASettings; owner: null }
  /** A tier could not be READ, so nothing below it may be trusted. */
  | { status: "unreadable"; ownerType: IsaSettingsOwnerType; ownerId: string | null; detail: string }

/**
 * The tiers to try, most-specific first, with the id each one is keyed by IN THIS
 * STORE. The ORDER comes from lib/connections/scope.ts so there is one definition
 * of the cascade; the ID MAP is local because this store keys the agent tier by
 * agents.id while platform_credentials keys it by users.id.
 */
export function isaSettingsCascade(scope: IsaSettingsScope): IsaSettingsOwner[] {
  const idFor: Record<IsaSettingsOwnerType, string | null | undefined> = {
    agent: scope.agentId,
    team: scope.teamId,
    brokerage: scope.brokerageId,
    platform: null, // singleton — matched by owner_type alone, not by an id
  }
  const out: IsaSettingsOwner[] = []
  for (const tier of INTERNAL_CASCADE_ORDER) {
    const ownerType = tier as IsaSettingsOwnerType
    if (ownerType === "platform") { out.push({ ownerType, ownerId: null }); continue }
    const id = idFor[ownerType]
    if (typeof id === "string" && id.trim()) out.push({ ownerType, ownerId: id.trim() })
  }
  return out
}

const SELECT = "owner_type, brokerage_id, team_id, agent_id, is_active, require_broker_approval, elevenlabs_voice_id, settings"

/** Column each tier is keyed by. The platform tier has none — owner_type alone identifies it. */
const OWNER_COLUMN: Record<IsaSettingsOwnerType, string | null> = {
  agent: "agent_id",
  team: "team_id",
  brokerage: "brokerage_id",
  platform: null,
}

type OwnerRead =
  | { status: "found"; row: Record<string, unknown> }
  | { status: "absent" }
  | { status: "unreadable"; detail: string }

async function readOwnerSettings(owner: IsaSettingsOwner): Promise<OwnerRead> {
  try {
    const svc = createServiceClient()
    let q = svc.from("ai_isa_settings").select(SELECT).eq("owner_type", owner.ownerType)
    const col = OWNER_COLUMN[owner.ownerType]
    if (col) {
      // A tier with an id MUST carry its predicate. If the id were missing the
      // filter would simply not be applied and the query would return some OTHER
      // owner's row — the exact "optional tenant predicate" defect
      // lib/kernel/tenant-scope.ts exists to end. isaSettingsCascade never emits
      // a non-platform tier without an id, and this refuses rather than trusts it.
      if (!owner.ownerId) {
        return { status: "unreadable", detail: `${owner.ownerType} tier reached with no ${col}; refusing an unfiltered read` }
      }
      q = q.eq(col, owner.ownerId)
    }
    const { data, error } = await q.limit(1).maybeSingle()
    // Error FIRST and on its own: a refusal arrives with data null, which is
    // byte-identical to "no rows" if you only destructure `data`.
    if (error) return { status: "unreadable", detail: `${error.code ?? "no-code"}: ${error.message}` }
    if (!data) return { status: "absent" }
    return { status: "found", row: data as unknown as Record<string, unknown> }
  } catch (err) {
    return { status: "unreadable", detail: `ai_isa_settings read threw for ${owner.ownerType} — ${(err as Error)?.message ?? "unknown error"}` }
  }
}

/** Fold one stored row onto the constant defaults. The row's own keys win. */
function rowToSettings(row: Record<string, unknown>): AIISASettings {
  const blob = (row.settings as Partial<AIISASettings> | null) ?? {}
  return {
    ...DEFAULT_AISA_SETTINGS,
    ...blob,
    // `is_active` is the column spelling of `enabled` — ONE idea, and the column
    // is authoritative over anything stale inside the blob (§6).
    enabled: row.is_active === false ? false : (row.is_active === true ? true : (blob.enabled ?? DEFAULT_AISA_SETTINGS.enabled)),
    // THE AUTO-SEND GATE, finally READ. `require_broker_approval` was in this
    // file's SELECT list from the start and was then dropped on the floor here:
    // the fold returned only `settings` + `is_active`, so the column that decides
    // whether an AI may send on a brokerage's behalf reached no caller, ever.
    // Same treatment as `is_active` — the COLUMN wins over a stale blob copy (§6),
    // and an absent/unknown column value falls to the constant default (true).
    require_broker_approval:
      row.require_broker_approval === false
        ? false
        : row.require_broker_approval === true
          ? true
          : (blob.require_broker_approval ?? DEFAULT_AISA_SETTINGS.require_broker_approval),
  }
}

/**
 * Resolve the ISA settings that govern this actor, HONESTLY.
 *
 * Never throws — `unreadable` is a value the caller branches on, because the
 * fail-closed answer for "we could not read the policy" is not "use the
 * brokerage's" and it is certainly not "use the platform's".
 */
export async function resolveIsaSettingsResult(scope: IsaSettingsScope): Promise<IsaSettingsResult> {
  for (const owner of isaSettingsCascade(scope)) {
    const read = await readOwnerSettings(owner)
    if (read.status === "found") return { status: "resolved", settings: rowToSettings(read.row), owner }
    if (read.status === "unreadable") {
      // STOP. Do NOT descend — see the header. A tier we could not read may hold
      // this actor's OWN settings, and continuing hands back a less specific
      // tier's policy as if it were theirs.
      return { status: "unreadable", ownerType: owner.ownerType, ownerId: owner.ownerId, detail: read.detail }
    }
  }
  return { status: "default", settings: DEFAULT_AISA_SETTINGS, owner: null }
}

/**
 * Compatibility shape for callers that only want the settings.
 *
 * `unreadable` maps to the DEFAULTS — a constant, never another owner's row —
 * and the reason is logged rather than swallowed. That is the fail-CLOSED
 * direction for this shape: DEFAULT_AISA_SETTINGS enables only the capabilities
 * marked defaultEnabled, so an unreadable tier cannot switch anything ON that a
 * tier had turned off. Callers that must tell "nobody configured this" from "we
 * could not look" call `resolveIsaSettingsResult` directly.
 */
export async function resolveIsaSettings(scope: IsaSettingsScope): Promise<AIISASettings> {
  const result = await resolveIsaSettingsResult(scope)
  if (result.status === "unreadable") {
    console.error(
      `[ai-isa] settings unreadable at the ${result.ownerType} tier (${result.ownerId ?? "platform"}) — ${result.detail}. Falling back to DEFAULT_AISA_SETTINGS, not to another owner's row.`,
    )
    return DEFAULT_AISA_SETTINGS
  }
  return result.settings
}

/**
 * Is a capability enabled for THIS actor? The per-user half of the ruling: an
 * agent with their own row is governed by their own row, not the brokerage's.
 *
 * An UNREADABLE tier answers false. A capability gate that cannot read its policy
 * must refuse, not permit (CLAUDE.md §4).
 */
export async function isIsaCapabilityEnabledForScope(
  scope: IsaSettingsScope,
  capability: IsaCapability,
): Promise<boolean> {
  const result = await resolveIsaSettingsResult(scope)
  if (result.status === "unreadable") {
    console.error(
      `[ai-isa] capability '${capability}' refused: settings unreadable at the ${result.ownerType} tier — ${result.detail}`,
    )
    return false
  }
  const settings = result.settings
  if (settings.enabled === false) return false
  const enabled = (settings.enabled_capabilities as IsaCapability[] | undefined) ?? defaultEnabledCapabilities()
  return enabled.includes(capability)
}

/**
 * Write one owner's settings row. The owner tier is NAMED, never inferred from
 * which id happens to be non-null — that inference is how a row with a dropped
 * brokerage_id would become the platform default for everybody.
 *
 * Returns the refusal rather than throwing, and READS the error: a swallowed
 * refusal here means a broker watches their settings "save" and nothing changes,
 * which is what the retired blob store did for its whole life.
 */
export async function writeIsaSettings(args: {
  owner: IsaSettingsOwner
  /** The tenant this row belongs to. Required for every non-platform tier. */
  brokerageId: string | null
  teamId?: string | null
  updates: Partial<AIISASettings>
}): Promise<{ success: boolean; error?: string }> {
  const { owner, updates } = args
  if (owner.ownerType !== "platform" && !args.brokerageId) {
    return { success: false, error: `an ${owner.ownerType}-scoped ISA settings row must name its brokerage` }
  }
  if (owner.ownerType !== "platform" && !owner.ownerId) {
    return { success: false, error: `an ${owner.ownerType}-scoped ISA settings row must name its ${OWNER_COLUMN[owner.ownerType]}` }
  }

  const svc = createServiceClient()
  const existing = await readOwnerSettings(owner)
  if (existing.status === "unreadable") return { success: false, error: existing.detail }

  const current = existing.status === "found" ? rowToSettings(existing.row) : DEFAULT_AISA_SETTINGS
  const merged: AIISASettings = { ...current, ...updates }
  const now = new Date().toISOString()

  const row = {
    owner_type: owner.ownerType,
    brokerage_id: owner.ownerType === "platform" ? null : args.brokerageId,
    team_id: owner.ownerType === "team" ? owner.ownerId : null,
    agent_id: owner.ownerType === "agent" ? owner.ownerId : null,
    is_active: merged.enabled,
    // THE WRITER HALF for the auto-send gate. Before this the column had no
    // writer anywhere in the tree, so it sat at its `DEFAULT TRUE` forever and a
    // brokerage that WANTED the ISA to send could not say so. Written to the
    // COLUMN (not only into the blob) because `rowToSettings` reads the column
    // first — writing one and not the other is how the two spellings drift.
    require_broker_approval: merged.require_broker_approval,
    settings: merged,
    updated_at: now,
  }

  if (existing.status === "found") {
    let q = svc.from("ai_isa_settings").update(row).eq("owner_type", owner.ownerType)
    const col = OWNER_COLUMN[owner.ownerType]
    if (col && owner.ownerId) q = q.eq(col, owner.ownerId)
    // .select() the write and COUNT what came back — an UPDATE that matched
    // NOTHING resolves with error null and an empty result, byte-identical to one
    // that worked (CLAUDE.md §3).
    const { data, error } = await q.select("id")
    if (error) return { success: false, error: error.message }
    if (!data || data.length === 0) {
      return { success: false, error: `ISA settings update matched no row for ${owner.ownerType}:${owner.ownerId ?? "platform"}` }
    }
    return { success: true }
  }

  const { data, error } = await svc
    .from("ai_isa_settings")
    .insert({ ...row, created_at: now })
    .select("id")
  if (error) return { success: false, error: error.message }
  if (!data || data.length === 0) {
    return { success: false, error: `ISA settings insert returned no row for ${owner.ownerType}:${owner.ownerId ?? "platform"}` }
  }
  return { success: true }
}
