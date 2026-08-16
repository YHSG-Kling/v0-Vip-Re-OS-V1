"use server"

/**
 * app/actions/team-branding.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MISSING WRITER for a team's own brand.
 *
 * The owner's ruling is "teams also may have a different logo than the
 * brokerage." That capability was already BUILT and already WIRED:
 * `lib/branding/resolve-brand-context.ts:211` cascades
 *
 *     team.logo_url → brokerages.logo_url → global_settings.app_logo_url
 *
 * per ATTRIBUTE (not per row), and every rendered piece — postcard, portal,
 * email, marketing image — reads that one resolver. `teams.logo_url`,
 * `primary_color`, `accent_color`, `tagline`, `website` and `phone` all exist on
 * the live table, and `lib/onboarding/setup-readiness.ts:210` already tells a
 * team lead to "Set your team logo & colors".
 *
 * NOTHING WROTE ANY OF THEM. Every `from("teams")` call in `app/` and `lib/` was
 * a SELECT. The columns were reachable only by hand-editing the database, so the
 * required setup task pointed at a page that redirected to user management and
 * the cascade's top rung was permanently empty. The gap was the SCREEN, not the
 * capability.
 *
 * So this module adds the writer and NOTHING else. It does not re-derive the
 * cascade: the "what you inherit when you leave this blank" values the panel
 * shows come from calling `resolveBrandContext` itself with `teamId: null`,
 * which is by definition the answer the real resolver gives with no team on top.
 * A second copy of the precedence rules here is exactly the duplicate this
 * workstream keeps deleting.
 *
 * ── WHAT ELSE THIS MODULE NOW WRITES ────────────────────────────────────────
 * Two more `teams` columns-with-a-reader-and-no-writer were closed here in W47,
 * because both belong to the same person on the same screen:
 *
 *   1. THE TEAM SPLIT (`team_split_type`, `team_split_percent`,
 *      `team_split_value`, `terms_effective_date`). Read by
 *      `lib/commission/waterfall/08-team-split.ts:30`, which turns them into the
 *      team-lead override deducted from every team agent's net. The app's own
 *      REQUIRED onboarding item `lead_team_splits`
 *      (`lib/onboarding/critical-setup.ts:283`) points a TEAM LEAD at
 *      /dashboard/settings/teams to set them, and m457 deliberately widened the
 *      `teams` UPDATE policy so a lead may write their own row. Nothing on that
 *      page could set them, so the required item pointed at a screen that could
 *      not complete it. See `saveTeamSplits`.
 *
 *   2. THE TEAM EMAIL SIGNATURE (`branding_override.email_signature_html`).
 *      Read by `lib/kernel/communications/assemble-email.ts:67-78` as tier 2 of
 *      the signature waterfall (individual → TEAM → brokerage). Nothing wrote
 *      it. See `saveTeamSignature`.
 *
 * ── WHO MAY WRITE ───────────────────────────────────────────────────────────
 * `teams` RLS UPDATE, re-read from pg_policy on the live database after m457:
 *
 *     teams_tenant_update  USING / WITH CHECK
 *       brokerage_id = current_user_brokerage_id()
 *       AND (is_brokerage_admin() OR team_lead_id = auth.uid())
 *
 * (INSERT and DELETE remain admin-only.) So the database now agrees with the
 * ruling rather than being wider than it — but it still cannot answer "which
 * team is MINE", and it would happily accept a lead writing a nonsense split.
 * The gate here stays the real constraint:
 *
 *   - a TEAM LEAD may write the team they lead, and the team id is resolved from
 *     the SESSION by `resolveLedTeamId` — never taken from the caller.
 *   - a BROKERAGE ADMIN (`is_brokerage_admin()` = user_type in admin/broker/
 *     broker_owner) may write any team in their OWN brokerage, which is what RLS
 *     already permits. There is no session-derivable single team for an admin who
 *     runs several, so that path is the only one that reads a teamId off the
 *     wire — and it does not TRUST it: the tenant comes from the session, the row
 *     is re-read, and `brokerage_id` must match before a single column is written.
 *   - everyone else is refused, even though the database would allow them.
 *
 * Leading a team is a FACT (`teams.team_lead_id = <me>`), never
 * `user_type === 'team_lead'`. On the live data that label is INVERTED on both
 * accounts that carry it: teamlead@vip.demo is user_type='agent' and leads one
 * team, buyer@yourbrokerage.com is user_type='team_lead' and leads none. A role
 * label is not a fact; the FK is. Hence `resolveLedTeamId`.
 *
 * Writes go through the SESSION client, so RLS still applies underneath the app
 * gate and this can never exceed what the database permits. supabase-js RESOLVES
 * a refused write and an RLS refusal on UPDATE is ZERO ROWS with `error: null`,
 * so every write confirms itself with `.select("id")` and a length check. A
 * "Saved" toast over a write that touched nothing is the defect class this repo
 * keeps finding.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { resolveLedTeamId } from "@/lib/kernel/resolve-user-team"
import { resolveBrandContext } from "@/lib/branding/resolve-brand-context"
import { parseCapAmountInput, ensureTeamCapWindows } from "@/lib/commission/cap-resolver"
import { revalidatePath } from "next/cache"

/**
 * THE ALLOW-LISTS. `teams` also carries tenancy (`brokerage_id`,
 * `team_lead_id`) and identity (`name`, `public_slug`), and each writer below
 * names its own columns explicitly. Nothing here ever spreads a client payload
 * into an update: the brand writer cannot touch money, and the money writer
 * cannot touch tenancy.
 */
const TEAM_BRAND_COLUMNS = [
  "logo_url",
  "primary_color",
  "accent_color",
  "tagline",
  "website",
  "phone",
  "bio_text",
] as const

/**
 * THE MONEY ALLOW-LIST — the four columns `08-team-split.ts` actually reads,
 * and no others.
 *
 * WHAT EACH ONE MEANS, read out of the waterfall rather than assumed:
 *
 *   `team_split_type`  text, CHECK IN ('flat','percent'), DEFAULT 'percent'.
 *       `08-team-split.ts:47` is `=== 'flat' ? 'flat' : 'percent'`, so NULL and
 *       every other value read as PERCENT. That is why this writer never stores
 *       NULL: a NULL here does not mean "no split", it means "percent, silently".
 *   `team_split_percent`  numeric(5,2). The percent branch's value —
 *       `08-team-split.ts:50`. `team-lead-split.ts:68` applies it as
 *       `agentNetCents * (value / 100)`, DEDUCTED FROM the closing agent and PAID
 *       TO the lead. So it is the TEAM'S CUT, not the agent's keep.
 *   `team_split_value`  numeric(12,4). The FLAT branch's value —
 *       `08-team-split.ts:49` — in DOLLARS (`team-lead-split.ts:69` multiplies by
 *       100 to reach cents). It is NOT a second copy of the percent.
 *   `terms_effective_date`  date, DEFAULT CURRENT_DATE. `isAgreementEffective`
 *       (`team-lead-split.ts:92`) makes the WHOLE override inert until this date
 *       has arrived; NULL means "always in effect". A future date silently
 *       switches the team split off, so the form states the date it starts.
 *
 * The two value columns are kept MUTUALLY EXCLUSIVE by this writer — the branch
 * that is not in use is set to NULL. That is not tidiness. `08-team-split.ts`
 * picks its column from `team_split_type` alone, so a stale value in the other
 * column becomes live the instant anybody flips the type, and
 * `lib/recruiting/recruiting-pitch-kit.ts:151` prefers `team_split_percent`
 * unconditionally — a leftover percent under a flat agreement would be published
 * as the team's recruiting split.
 *
 * ── AND FROM m461, `cap_amount` ─────────────────────────────────────────────
 *
 * OWNER RULING: "brokerage and teams may also have commission caps."
 *
 *   `cap_amount`  numeric(12,2), NULL = UNCAPPED, which is what every team was
 *       before m461. It is the ceiling on what THE TEAM collects from each of its
 *       agents across an anniversary year, via the split above. The split says
 *       how much per closing; the cap says when the team stops collecting.
 *
 * The asymmetry it closes is real: `07-apply-cap.ts` already stops the BROKERAGE
 * once it has taken its cap, while `08-team-split.ts` applies the team override
 * with no ceiling at all — so a team went on collecting for ever while the
 * brokerage stopped. The per-agent ledger for it is `team_cap_tracking`, the
 * mirror of `agent_cap_tracking`, and the same rule holds one level down: a cap
 * that is only CONFIGURED is not a cap until it reaches its ledger.
 *
 * It belongs on THIS writer, beside the split, because it is the same agreement
 * and the same person's decision — and so it passes the same `resolveWritableTeamId`
 * gate, which is what stops a team lead setting anyone's cap but their own.
 */
const TEAM_SPLIT_COLUMNS = [
  "team_split_type",
  "team_split_percent",
  "team_split_value",
  "terms_effective_date",
  "cap_amount",
] as const

/**
 * NOT WRITTEN HERE, each for a stated reason — a settings form that guesses at a
 * JSONB shape is how a column ends up with two incompatible writers:
 *
 *   `team_fees_json`  jsonb DEFAULT '[]'. The column DEFAULTS to an ARRAY, and
 *       its only reader (`recruiting-pitch-kit.ts:149`) reads it as an OBJECT
 *       with a `monthly_fee` key. Two shapes, no agreed schema, and no reader in
 *       the commission waterfall. It needs a decided shape before it needs a
 *       form; guessing one here would fork it a third way.
 *   `member_overrides_json`  jsonb. PER-MEMBER money — and the per-member write
 *       path already exists and is richer: `team_members` rows carry
 *       `split_percent`, `source_of_funds` and effective dating, are written by
 *       `app/actions/admin/team-members.ts`, and are what
 *       `08-team-split.ts:82-102` actually loops over. This column meanwhile
 *       holds something else entirely on the read side —
 *       `lib/kernel/brand-voice.ts:142` reads `member_overrides_json.brand_voice`
 *       — so a blunt editor here would clobber the team's brand voice.
 */

/**
 * The ONE key this module owns inside `teams.branding_override`. The column is
 * shared JSONB, so every write reads the existing object and merges into it —
 * see `saveTeamSignature`. The name is not ours to choose: it is the key
 * `assemble-email.ts:74` reads.
 */
const SIGNATURE_KEY = "email_signature_html"

export interface TeamBrandValues {
  logoUrl: string | null
  primaryColor: string | null
  accentColor: string | null
  tagline: string | null
  website: string | null
  phone: string | null
  bioText: string | null
}

export type TeamSplitType = "percent" | "flat"

/** The team-lead override agreement as the waterfall reads it. */
export interface TeamSplitValues {
  /** NULL only for a row nobody has written yet; the writer never stores NULL. */
  splitType: TeamSplitType | null
  /** teams.team_split_percent — the team's cut, in percent of the agent's net. */
  percent: number | null
  /** teams.team_split_value — the team's cut as flat DOLLARS per closing. */
  flatDollars: number | null
  /** teams.terms_effective_date, YYYY-MM-DD. NULL = in effect from the start. */
  effectiveDate: string | null
  /**
   * teams.cap_amount — the ceiling on what the TEAM collects from each of its
   * agents per anniversary year. NULL = uncapped. `0` is a different answer
   * meaning the team collects nothing, and the two are not interchangeable.
   */
  capAmount: number | null
}

export interface TeamSignatureValues {
  /** `branding_override.email_signature_html`, or null when the key is absent. */
  html: string | null
  /**
   * The OTHER keys already in `branding_override`. Surfaced so the panel can
   * show what the merge is preserving — this column is shared, and a writer that
   * replaced the object instead of merging into it would silently delete them.
   */
  otherKeys: string[]
  /**
   * True when `branding_override` holds something that is not a JSON object
   * (an array, a string, a number). Merging into that would destroy it, so the
   * writer refuses rather than guessing.
   */
  unmergeable: boolean
}

export interface TeamBrandOption {
  id: string
  name: string
  /** True when the caller is this team's `team_lead_id`. */
  isLed: boolean
  values: TeamBrandValues
  splits: TeamSplitValues
  signature: TeamSignatureValues
}

/** What the piece looks like RIGHT NOW, and what it falls back to when blank.
 *  Both come from `resolveBrandContext`, never from a second cascade here. */
export interface TeamBrandCascade {
  /** Resolved with NO team on top — i.e. exactly what a blank field inherits. */
  inherited: {
    logoUrl: string | null
    primaryColor: string
    accentColor: string
    tagline: string | null
    website: string | null
    phone: string | null
  }
  /** Resolved WITH the active team — what the pieces render today. */
  effective: {
    logoUrl: string | null
    primaryColor: string
    accentColor: string
    tagline: string | null
    displayName: string
    /** The resolver's own audit trail: which tier supplied each field. */
    logoSource: string
    colorSource: string
    taglineSource: string
  }
  brokerageName: string
}

export type TeamBrandAccess = "lead" | "admin" | "none"

export interface TeamBrandingSnapshot {
  ok: boolean
  error?: string
  access: TeamBrandAccess
  teams: TeamBrandOption[]
  activeTeamId: string | null
  cascade: TeamBrandCascade | null
  /**
   * How many people the TEAM EMAIL SIGNATURE can actually reach, and it is not
   * the roster. `assemble-email.ts:66` reaches the team tier only via
   * `users.team_id` — not via `teams.team_lead_id`, `team_members` or
   * `agents.team_id`, and not via `resolveUserTeam`'s four-source precedence. So
   * a team with a full roster and no `users.team_id` rows has a signature that
   * nothing will ever read, and the panel says so instead of implying delivery.
   * NULL when the count could not be read.
   */
  signatureReachCount: number | null
}

/** `is_brokerage_admin()` in SQL — the same three types the brokerages policy uses. */
function isBrokerageAdmin(userType: string): boolean {
  return ["admin", "broker", "broker_owner"].includes(userType)
}

const EMPTY_SNAPSHOT: TeamBrandingSnapshot = {
  ok: true,
  access: "none",
  teams: [],
  activeTeamId: null,
  cascade: null,
  signatureReachCount: null,
}

function rowToValues(row: Record<string, unknown>): TeamBrandValues {
  return {
    logoUrl: (row.logo_url as string | null) ?? null,
    primaryColor: (row.primary_color as string | null) ?? null,
    accentColor: (row.accent_color as string | null) ?? null,
    tagline: (row.tagline as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    bioText: (row.bio_text as string | null) ?? null,
  }
}

/** A numeric column arrives from PostgREST as a string, a number, or null. */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function rowToSplits(row: Record<string, unknown>): TeamSplitValues {
  const rawType = row.team_split_type
  return {
    splitType: rawType === "flat" ? "flat" : rawType === "percent" ? "percent" : null,
    percent: numOrNull(row.team_split_percent),
    flatDollars: numOrNull(row.team_split_value),
    effectiveDate: (row.terms_effective_date as string | null) ?? null,
    capAmount: numOrNull(row.cap_amount),
  }
}

/** A plain JSON object — not null, not an array, not a scalar. */
function asJsonObject(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return {}
  if (typeof v !== "object" || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function rowToSignature(row: Record<string, unknown>): TeamSignatureValues {
  const obj = asJsonObject(row.branding_override)
  if (!obj) return { html: null, otherKeys: [], unmergeable: true }
  const html = obj[SIGNATURE_KEY]
  return {
    html: typeof html === "string" && html.trim() ? html : null,
    otherKeys: Object.keys(obj).filter((k) => k !== SIGNATURE_KEY).sort(),
    unmergeable: false,
  }
}

// ── Validation ───────────────────────────────────────────────────────────────
// A malformed value here does not fail loudly — it flows straight out through
// the cascade onto every postcard, email header and public team page, where a
// broken <img> is the first anyone hears of it. So it is refused at the door.

type FieldResult = { ok: true; value: string | null } | { ok: false; error: string }

/** An ABSOLUTE http(s) URL, or null for "inherit". Nothing else. */
function normalizeUrl(raw: string, label: string): FieldResult {
  const t = raw.trim()
  if (!t) return { ok: true, value: null }
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return { ok: false, error: `${label} must be a full web address starting with https:// — "${t}" is not one.` }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `${label} must start with http:// or https:// — "${u.protocol}" is not a web address.` }
  }
  if (!u.hostname || (!u.hostname.includes(".") && u.hostname !== "localhost")) {
    return { ok: false, error: `${label} is missing a domain name — "${t}" will not load anywhere.` }
  }
  return { ok: true, value: u.toString() }
}

/** `#rgb` or `#rrggbb`, lower-cased, or null for "inherit". */
function normalizeHex(raw: string, label: string): FieldResult {
  const t = raw.trim()
  if (!t) return { ok: true, value: null }
  const withHash = t.startsWith("#") ? t : `#${t}`
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(withHash)) {
    return { ok: false, error: `${label} must be a hex colour like #1d4ed8 — "${t}" is not one.` }
  }
  return { ok: true, value: withHash.toLowerCase() }
}

function normalizeText(raw: string, label: string, max: number): FieldResult {
  const t = raw.trim().replace(/\s+/g, " ")
  if (!t) return { ok: true, value: null }
  if (t.length > max) {
    return { ok: false, error: `${label} is ${t.length} characters; the limit is ${max}.` }
  }
  return { ok: true, value: t }
}

function normalizeParagraph(raw: string, label: string, max: number): FieldResult {
  const t = raw.trim()
  if (!t) return { ok: true, value: null }
  if (t.length > max) {
    return { ok: false, error: `${label} is ${t.length} characters; the limit is ${max}.` }
  }
  return { ok: true, value: t }
}

// ── Money validation ─────────────────────────────────────────────────────────
// A percent outside 0-100, or a NaN that reaches the column as NULL, misprices
// every payout the waterfall computes from this row and does it silently: the
// override is applied without complaint and the agent's cheque is simply wrong.
// `resolveTeamLeadOverride` clamps the result so nobody goes negative, which
// means a 900% split does not throw — it takes the agent's entire net. So the
// range check has to happen HERE; there is no downstream error to rely on.

type NumberResult = { ok: true; value: number } | { ok: false; error: string }

function normalizeAmount(
  raw: string,
  label: string,
  opts: { min: number; max: number; decimals: number; unit: string },
): NumberResult {
  let t = (raw ?? "").trim().replace(/,/g, "")
  if (t.startsWith("$")) t = t.slice(1).trim()
  if (t.endsWith("%")) t = t.slice(0, -1).trim()

  if (!t) {
    return { ok: false, error: `${label} is required. Enter 0 if the team takes no cut.` }
  }
  // Deliberately stricter than Number(): "1e3", "0x10", "Infinity" and "" all
  // survive Number() and none of them belong in a money column.
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) {
    return { ok: false, error: `${label} must be a plain number — "${raw.trim()}" is not one.` }
  }
  const n = Number(t)
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${label} must be a plain number — "${raw.trim()}" is not one.` }
  }
  const decimals = t.includes(".") ? t.split(".")[1].length : 0
  if (decimals > opts.decimals) {
    // Rounding money on the user's behalf is how a split ends up not being the
    // one that was agreed. Refuse and let them decide.
    return {
      ok: false,
      error: `${label} can have at most ${opts.decimals} decimal place${opts.decimals === 1 ? "" : "s"} — "${raw.trim()}" has ${decimals}.`,
    }
  }
  if (n < opts.min || n > opts.max) {
    return {
      ok: false,
      error: `${label} must be between ${opts.min} and ${opts.max}${opts.unit} — ${n}${opts.unit} would misprice every payout.`,
    }
  }
  return { ok: true, value: n }
}

/** `YYYY-MM-DD`, and a REAL calendar date, or null for "in effect from the start". */
function normalizeDate(raw: string, label: string): FieldResult {
  const t = (raw ?? "").trim()
  if (!t) return { ok: true, value: null }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (!m) return { ok: false, error: `${label} must be a date like 2026-09-01 — "${t}" is not one.` }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // Date.parse accepts 2026-02-31 and rolls it forward to March. Round-trip it
  // so an impossible date is refused rather than silently moved.
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: `${label} is not a real date — there is no ${t}.` }
  }
  if (y < 1990 || y > 2999) {
    return { ok: false, error: `${label} must be a plausible year — "${t}" is not.` }
  }
  return { ok: true, value: t }
}

// ── Email-signature validation ───────────────────────────────────────────────
// THIS VALUE IS PASTED INTO AN OUTGOING EMAIL BODY by assemble-email.ts, and it
// is written by a team lead and read by everyone the team mails. So it cannot be
// stored as typed.
//
// THERE IS NO HTML SANITISER IN THIS REPO — no dompurify, no sanitize-html, no
// xss; the dependency list has none and nothing in app/ or lib/ implements one.
// Saying otherwise, or hand-rolling a STRIPPER, would be the pretence the brief
// warns about: a stripper that misses one case emits the payload, and a
// hand-rolled one will miss cases. So this CONSTRAINS instead, and it REJECTS
// rather than strips — a rejecter that misses a case stores nothing at all,
// which fails safe in the direction that matters.
//
// TWO INPUTS ARE ACCEPTED, and which one you gave is decided by whether the text
// contains a `<` at all:
//   • PLAIN TEXT (no `<`) — escaped, with line breaks turned into <br />. This
//     is what most people actually want and it cannot carry markup by
//     construction.
//   • SIMPLE HTML — every tag must be on the allow-list below, every attribute
//     must be on that tag's allow-list, every attribute value must be quoted,
//     and every href/src must be an absolute http(s)/mailto URL. Anything else
//     is refused BY NAME so the author can fix it.
//
// Deliberately NOT allowed, and the panel says so: `style` and `class` (inline
// style is a real vector in older mail clients and a team's colours are set on
// this same screen), `<table>` layout, comments and conditional comments,
// `data:` URLs, and every `on*` handler.

const SIGNATURE_MAX = 4000

/** tag → the attributes that tag may carry. An empty list means "no attributes". */
const SIGNATURE_TAGS: Record<string, readonly string[]> = {
  a: ["href", "title"],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  small: [],
  br: [],
  p: [],
  div: [],
  span: [],
  ul: [],
  ol: [],
  li: [],
  img: ["src", "alt", "width", "height"],
}

const SIGNATURE_ALLOWED_LIST = Object.keys(SIGNATURE_TAGS)
  .map((t) => `<${t}>`)
  .join(" ")

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** One tag, with quoted attribute values only. Anchored at the `<`. */
const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))?)*)\s*(\/?)>/
const ATTR_RE = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'))?/g

function checkLinkUrl(value: string, attr: string, tag: string, protocols: string[]): string | null {
  const t = value.trim()
  if (!t) return `<${tag} ${attr}> is empty — give it a full address or remove it.`
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return `<${tag} ${attr}="${t}"> must be a full address (${protocols.join(" or ")}) — a relative link does not resolve inside an email.`
  }
  if (!protocols.includes(u.protocol)) {
    return `<${tag} ${attr}> may only use ${protocols.join(" or ")} — "${u.protocol}" is not allowed in an email signature.`
  }
  return null
}

function normalizeSignatureHtml(raw: string): FieldResult {
  const t = (raw ?? "").trim()
  if (!t) return { ok: true, value: null }
  if (t.length > SIGNATURE_MAX) {
    return { ok: false, error: `The signature is ${t.length} characters; the limit is ${SIGNATURE_MAX}.` }
  }
  // Control characters can smuggle a tag past a naive reader downstream.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) {
    return { ok: false, error: "The signature contains control characters. Paste it as plain text and try again." }
  }

  if (!t.includes("<")) {
    // PLAIN TEXT. Escaped, so it can never become markup, with the line breaks
    // the author actually typed preserved as <br />.
    return { ok: true, value: escapeHtml(t).replace(/\r\n|\r|\n/g, "<br />") }
  }

  let i = 0
  while (true) {
    const lt = t.indexOf("<", i)
    if (lt === -1) break
    const rest = t.slice(lt)
    if (rest.startsWith("<!")) {
      return {
        ok: false,
        error: "Comments and <!doctype> declarations are not allowed in a signature — some mail clients treat them as markup.",
      }
    }
    const m = TAG_RE.exec(rest)
    if (!m) {
      return {
        ok: false,
        error: `There is a "<" at character ${lt + 1} that does not open a simple tag. Every attribute must be quoted (href="…"), and a literal "<" must be written as &lt;.`,
      }
    }
    const closing = m[1] === "/"
    const tag = m[2].toLowerCase()
    const attrText = m[3] ?? ""

    const allowedAttrs = SIGNATURE_TAGS[tag]
    if (!allowedAttrs) {
      return {
        ok: false,
        error: `<${tag}> is not allowed in a signature. Allowed tags: ${SIGNATURE_ALLOWED_LIST}.`,
      }
    }
    if (closing && attrText.trim()) {
      return { ok: false, error: `A closing tag cannot carry attributes — found "</${tag} …>".` }
    }

    if (!closing && attrText.trim()) {
      ATTR_RE.lastIndex = 0
      let a: RegExpExecArray | null
      while ((a = ATTR_RE.exec(attrText)) !== null) {
        const name = a[1].toLowerCase()
        const value = a[2] ?? a[3]
        if (name.startsWith("on")) {
          return { ok: false, error: `Event handlers are not allowed — remove ${name} from <${tag}>.` }
        }
        if (name === "style" || name === "class") {
          return {
            ok: false,
            error: `Inline ${name} is not allowed in a signature. Set your team's colours in Team Brand above; mail clients rewrite inline styling anyway.`,
          }
        }
        if (!allowedAttrs.includes(name)) {
          return {
            ok: false,
            error: allowedAttrs.length
              ? `<${tag}> may only carry ${allowedAttrs.join(", ")} — "${name}" is not allowed.`
              : `<${tag}> may not carry attributes — remove "${name}".`,
          }
        }
        if (value === undefined) {
          return { ok: false, error: `<${tag} ${name}> needs a quoted value, e.g. ${name}="…".` }
        }
        if (name === "href") {
          const err = checkLinkUrl(value, name, tag, ["http:", "https:", "mailto:"])
          if (err) return { ok: false, error: err }
        }
        if (name === "src") {
          const err = checkLinkUrl(value, name, tag, ["http:", "https:"])
          if (err) return { ok: false, error: err }
        }
        if ((name === "width" || name === "height") && !/^\d{1,4}$/.test(value.trim())) {
          return { ok: false, error: `<img ${name}> must be a whole number of pixels — "${value}" is not.` }
        }
      }
    }

    i = lt + m[0].length
  }

  return { ok: true, value: t }
}

// ── Gate ─────────────────────────────────────────────────────────────────────

interface Gate {
  ok: true
  userId: string
  brokerageId: string
  ledTeamId: string | null
  admin: boolean
  access: TeamBrandAccess
  supabase: Awaited<ReturnType<typeof createClient>>
}

async function gate(): Promise<Gate | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { ok: false, error: "Not authenticated." }
  }
  const supabase = await createClient()
  // THE FACT, not the label. resolveLedTeamId reads teams.team_lead_id and logs
  // a refused read rather than reporting it as "leads nobody".
  const ledTeamId = await resolveLedTeamId(supabase, ctx.userId)
  const admin = isBrokerageAdmin(ctx.userType ?? ctx.role ?? "")
  const access: TeamBrandAccess = ledTeamId ? "lead" : admin ? "admin" : "none"
  return { ok: true, userId: ctx.userId, brokerageId: ctx.brokerageId, ledTeamId, admin, access, supabase }
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Everything the panel renders: the teams this caller may brand, their current
 * values, and — so "blank" reads as "inherit" rather than "nothing" — what the
 * brokerage supplies underneath.
 *
 * Called by `app/dashboard/settings/components/team-branding-panel.tsx`, which
 * renders on `/dashboard/settings/teams`.
 */
export async function loadTeamBranding(): Promise<TeamBrandingSnapshot> {
  const g = await gate()
  if (!g.ok) return { ...EMPTY_SNAPSHOT, ok: false, error: g.error }
  if (g.access === "none") return EMPTY_SNAPSHOT

  const select = `id, name, team_lead_id, branding_override, ${TEAM_BRAND_COLUMNS.join(", ")}, ${TEAM_SPLIT_COLUMNS.join(", ")}`

  // A LEAD gets exactly their own team. An ADMIN gets their brokerage's teams —
  // scoped by brokerage_id in the query as well as by RLS, because `NULL =
  // <uuid>` is NULL and an untenanted team must not appear in anybody's list.
  const query = g.ledTeamId
    ? g.supabase.from("teams").select(select).eq("id", g.ledTeamId)
    : g.supabase.from("teams").select(select).eq("brokerage_id", g.brokerageId).is("deleted_at", null).order("name")

  const { data, error } = await query
  if (error) {
    // supabase-js resolves a refused read as an empty list. Say what happened.
    return { ...EMPTY_SNAPSHOT, ok: false, access: g.access, error: `Could not read your teams: ${error.message}` }
  }

  // Two-step cast, and it is not laziness. `select` above is BUILT AT RUNTIME
  // from TEAM_BRAND_COLUMNS, so supabase-js cannot resolve the column list
  // statically and degrades `data` to GenericStringError[] — a type that does
  // not overlap Record<string, unknown>, which is why the direct cast is a
  // compile error rather than a warning. Going through `unknown` states plainly
  // that the shape is known to us and not to the compiler. The alternative —
  // inlining a literal select so the generated types apply — would fork the
  // column list away from TEAM_BRAND_COLUMNS, and the write path uses that same
  // constant; two lists that must agree is the drift this repo keeps paying for.
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const teams: TeamBrandOption[] = rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string | null) ?? "Untitled team",
    isLed: (r.team_lead_id as string | null) === g.userId,
    values: rowToValues(r),
    splits: rowToSplits(r),
    signature: rowToSignature(r),
  }))

  const activeTeamId = g.ledTeamId ?? teams[0]?.id ?? null
  if (!activeTeamId) {
    return { ...EMPTY_SNAPSHOT, ok: true, access: g.access, teams, activeTeamId: null, cascade: null }
  }

  // THE CASCADE, from the resolver itself. `teamId: null` IS the inheritance —
  // there is no second copy of the precedence rules in this file.
  const [inheritedCtx, effectiveCtx, reach] = await Promise.all([
    resolveBrandContext({ brokerageId: g.brokerageId, teamId: null }),
    resolveBrandContext({ brokerageId: g.brokerageId, teamId: activeTeamId }),
    // WHO THE TEAM SIGNATURE CAN REACH — `users.team_id`, because that is the
    // only column `assemble-email.ts:66` consults before it looks at the team
    // tier at all. Counted, not assumed, and NULL when the read is refused
    // rather than a confident 0.
    g.supabase.from("users").select("id", { count: "exact", head: true }).eq("team_id", activeTeamId),
  ])

  if (reach.error) {
    console.error(`[team-branding] users.team_id count refused for team ${activeTeamId}: ${reach.error.message}`)
  }

  return {
    ok: true,
    access: g.access,
    teams,
    activeTeamId,
    signatureReachCount: reach.error ? null : reach.count ?? 0,
    cascade: {
      inherited: {
        logoUrl: inheritedCtx.visual.logoUrl,
        primaryColor: inheritedCtx.visual.primaryColor,
        accentColor: inheritedCtx.visual.accentColor,
        tagline: inheritedCtx.display.tagline,
        website: inheritedCtx.display.websiteWordmark,
        phone: inheritedCtx.display.phone,
      },
      effective: {
        logoUrl: effectiveCtx.visual.logoUrl,
        primaryColor: effectiveCtx.visual.primaryColor,
        accentColor: effectiveCtx.visual.accentColor,
        tagline: effectiveCtx.display.tagline,
        displayName: effectiveCtx.displayName,
        logoSource: effectiveCtx.source.logo,
        colorSource: effectiveCtx.source.color,
        taglineSource: effectiveCtx.source.tagline,
      },
      brokerageName: effectiveCtx.brokerageName,
    },
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * WHICH ROW AM I ALLOWED TO WRITE — resolved once, for all three writers.
 *
 * Identity first, then authorisation. A team lead's target comes from the
 * SESSION (`resolveLedTeamId`) and no field on the wire can redirect it. Only
 * the brokerage-admin path reads an id off the wire, and it does not TRUST it:
 * the tenant comes from the session, the row is re-read, and `brokerage_id` must
 * match before a single column is written.
 *
 * `noun` only shapes the refusal message — "set the brand for" / "set the splits
 * for" — so a lead who lands on the wrong team is told what they were refused.
 */
async function resolveWritableTeamId(
  g: Gate,
  wireTeamId: string | null | undefined,
  noun: string,
): Promise<{ ok: true; teamId: string } | { ok: false; error: string }> {
  if (g.ledTeamId && (!wireTeamId || wireTeamId === g.ledTeamId)) {
    return { ok: true, teamId: g.ledTeamId }
  }
  if (g.admin && wireTeamId) {
    const { data: row, error: rowErr } = await g.supabase
      .from("teams")
      .select("id, brokerage_id, deleted_at")
      .eq("id", wireTeamId)
      .maybeSingle()
    if (rowErr) return { ok: false, error: `Could not verify that team: ${rowErr.message}` }
    const team = row as { id: string; brokerage_id: string | null; deleted_at: string | null } | null
    if (!team) return { ok: false, error: "That team does not exist in your brokerage." }
    if (team.brokerage_id !== g.brokerageId) return { ok: false, error: "That team belongs to another brokerage." }
    if (team.deleted_at) return { ok: false, error: "That team has been deleted." }
    return { ok: true, teamId: team.id }
  }
  if (g.ledTeamId) {
    return { ok: false, error: `You can only ${noun} the team you lead.` }
  }
  return {
    ok: false,
    error: `Only a team's lead, or a broker or admin at your brokerage, can ${noun} a team.`,
  }
}

/**
 * Apply a patch to one `teams` row and PROVE it landed.
 *
 * supabase-js RESOLVES a refused write, and an RLS refusal on UPDATE is ZERO
 * ROWS with `error: null` — so without the `.select("id")` length check a save
 * that changed nothing would report success and the lead would trust a split
 * that is not there.
 */
async function writeTeamRow(
  g: Gate,
  teamId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: written, error: writeErr } = await g.supabase
    .from("teams")
    .update(patch)
    .eq("id", teamId)
    .select("id")

  if (writeErr) return { ok: false, error: `The database refused the change: ${writeErr.message}` }
  if (!written || written.length === 0) {
    return {
      ok: false,
      error:
        "The database accepted the request but changed no rows — your account is not permitted to edit this team. Nothing was saved.",
    }
  }
  return { ok: true }
}

export interface TeamBrandingInput {
  /** ONLY consulted on the brokerage-admin path, and re-authorised against the
   *  session's brokerage before use. A team lead's target is resolved from the
   *  session and this field cannot redirect it. */
  teamId?: string | null
  logoUrl: string
  primaryColor: string
  accentColor: string
  tagline: string
  website: string
  phone: string
  bioText: string
}

export interface SaveTeamBrandingResult {
  success: boolean
  error?: string
  /** Refreshed cascade, so the panel can show the new inherit/override state. */
  snapshot?: TeamBrandingSnapshot
}

/**
 * Write a team's brand. Every field is optional in the sense that BLANK MEANS
 * INHERIT: the column is set to NULL and `resolveBrandContext` falls through to
 * the brokerage, which is the whole point of a per-attribute cascade.
 */
export async function saveTeamBranding(input: TeamBrandingInput): Promise<SaveTeamBrandingResult> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }

  const target = await resolveWritableTeamId(g, input.teamId, "set the brand for")
  if (!target.ok) return { success: false, error: target.error }
  const targetTeamId = target.teamId

  // ── Validate every field before a single column is written. ───────────────
  const patch: Record<(typeof TEAM_BRAND_COLUMNS)[number] | "updated_at", string | null> = {
    logo_url: null,
    primary_color: null,
    accent_color: null,
    tagline: null,
    website: null,
    phone: null,
    bio_text: null,
    updated_at: new Date().toISOString(),
  }

  const checks: Array<[(typeof TEAM_BRAND_COLUMNS)[number], FieldResult]> = []
  checks.push(["logo_url", normalizeUrl(input.logoUrl ?? "", "Team logo URL")])
  checks.push(["website", normalizeUrl(input.website ?? "", "Team website")])
  checks.push(["primary_color", normalizeHex(input.primaryColor ?? "", "Primary colour")])
  checks.push(["accent_color", normalizeHex(input.accentColor ?? "", "Accent colour")])
  checks.push(["tagline", normalizeText(input.tagline ?? "", "Tagline", 160)])
  checks.push(["phone", normalizeText(input.phone ?? "", "Team phone", 32)])
  checks.push(["bio_text", normalizeParagraph(input.bioText ?? "", "Team bio", 2000)])

  for (const [column, result] of checks) {
    if (!result.ok) return { success: false, error: result.error }
    patch[column] = result.value
  }

  // ── Write, and CONFIRM it. ───────────────────────────────────────────────
  const wrote = await writeTeamRow(g, targetTeamId, patch)
  if (!wrote.ok) return { success: false, error: wrote.error }

  // Every surface that reads the cascade: the panel itself, the settings control
  // centre (setup readiness counts hasTeamBrand), and the public team site.
  revalidatePath("/dashboard/settings/teams")
  revalidatePath("/dashboard/settings")

  const snapshot = await loadTeamBranding()
  return { success: true, snapshot }
}

// ── Write: THE TEAM SPLIT ────────────────────────────────────────────────────

export interface TeamSplitsInput {
  /** Admin path only, re-authorised against the session's brokerage. */
  teamId?: string | null
  /** EXPLICIT. There is no "either/or" default — see the note in saveTeamSplits. */
  splitType: TeamSplitType
  /** Percent of each team agent's net that goes to the team. Read only when splitType === 'percent'. */
  percent: string
  /** Flat dollars per closing. Read only when splitType === 'flat'. */
  flatDollars: string
  /** YYYY-MM-DD, or "" for "in effect from the start". */
  effectiveDate: string
  /**
   * The team's cap in DOLLARS as typed. "" clears it, which means UNCAPPED —
   * what every team was before m461. Two decimal places at most; more is
   * refused, never rounded.
   */
  capAmount: string
}

export interface SaveTeamSplitsResult {
  success: boolean
  error?: string
  snapshot?: TeamBrandingSnapshot
  /**
   * What happened to the TEAM CAP LEDGER when the cap was saved.
   *
   * A cap on the `teams` row is not a cap: `waterfall/08-team-split.ts` reads
   * `team_cap_tracking` and nothing else, so a ceiling with no ledger row is a
   * ceiling the payout engine never applies — the m461 defect one level down.
   * This reports whether the ledger actually opened, because "saved" and
   * "enforced" were exactly the two things that came apart last time.
   */
  capLedger?: {
    /** Rows opened by this save. */
    seeded: number
    /** Agents already inside a live window — never overwritten, so a mid-year
     *  cap change applies from the NEXT window and this says how many. */
    alreadyCovered: number
    /** Agents on the team at the time of the save. */
    agentsConsidered: number
    /** Present when the ledger did not fully open. The cap is then only partly
     *  in force, and the surface must not imply otherwise. */
    error?: string
  }
}

/**
 * Write the team-lead commission agreement — the four columns
 * `lib/commission/waterfall/08-team-split.ts` reads on every closing.
 *
 * WHY THE TYPE IS EXPLICIT AND NEVER INFERRED. The waterfall chooses its value
 * column from `team_split_type` ALONE, and reads anything that is not the exact
 * string 'flat' as PERCENT. So "20" with the type left unstated is not an
 * ambiguous input, it is a 20% cut of every team agent's net — which is why the
 * form makes the caller name the type and this action writes the unused column
 * back to NULL rather than leaving a value that changes meaning if the type is
 * ever flipped.
 *
 * WHY 0 IS ALLOWED AND NULL IS NOT. `resolveTeamLeadOverride` treats a
 * non-positive value as no agreement at all, so 0 IS "the team takes no cut" and
 * it is expressible. NULL in `team_split_type` is not the same thing — it reads
 * as percent — so it is never written here. This also keeps the REQUIRED
 * onboarding item `lead_team_splits` honest: its checker
 * (`critical-setup.ts:564`) tests `team_split_type` for non-null, and after this
 * action that column is a deliberate choice rather than a column default.
 *
 * WHY THE CAP IS WRITTEN HERE TOO. It is the ceiling on the very cut these four
 * columns describe — the split says how much per closing, the cap says when the
 * team stops collecting — so it is one agreement and one decision by one person.
 * Writing it through this action means it passes `resolveWritableTeamId`, which
 * is the gate that lets a team lead set their OWN team's cap and no other team's:
 * a lead's target is resolved from the SESSION and no field on the wire can
 * redirect it, and the brokerage-admin path re-reads the row and re-checks
 * `brokerage_id` before a column is touched.
 */
export async function saveTeamSplits(input: TeamSplitsInput): Promise<SaveTeamSplitsResult> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }

  const target = await resolveWritableTeamId(g, input.teamId, "set the splits for")
  if (!target.ok) return { success: false, error: target.error }

  if (input.splitType !== "percent" && input.splitType !== "flat") {
    // Also the live CHECK constraint (teams_team_split_type_check), enforced here
    // so the user gets a sentence instead of a Postgres error.
    return { success: false, error: 'Choose how the team is paid: a percentage, or a flat amount. Nothing else is valid.' }
  }

  const effective = normalizeDate(input.effectiveDate ?? "", "The date these terms start")
  if (!effective.ok) return { success: false, error: effective.error }

  // THE TEAM CAP. `teams.cap_amount` is numeric(12,2) and the SAME parser the
  // brokerage default cap uses (`lib/commission/cap-resolver.ts`), so the two
  // levels of the same setting cannot drift in what they accept. Refused rather
  // than rounded: a cap silently moved by a fraction of a cent is not the cap
  // that was agreed. Blank means UNCAPPED, which is a real and common answer —
  // it is what every team was before m461 — and `0` means "the team collects
  // nothing", which is a different one.
  const cap = parseCapAmountInput(input.capAmount ?? "", "The team's commission cap")
  if (!cap.ok) return { success: false, error: cap.error }

  // numeric(5,2) and numeric(12,4) on the live table; 2 decimals is what a split
  // agreement is written in, and more precision than that is refused rather than
  // silently rounded.
  const patch: Record<string, unknown> = {
    team_split_type: input.splitType,
    terms_effective_date: effective.value,
    cap_amount: cap.value,
    updated_at: new Date().toISOString(),
  }

  if (input.splitType === "percent") {
    const pct = normalizeAmount(input.percent, "The team's percentage", {
      min: 0,
      max: 100,
      decimals: 2,
      unit: "%",
    })
    if (!pct.ok) return { success: false, error: pct.error }
    patch.team_split_percent = pct.value
    patch.team_split_value = null
  } else {
    const flat = normalizeAmount(input.flatDollars, "The team's flat amount", {
      min: 0,
      max: 1_000_000,
      decimals: 2,
      unit: "",
    })
    if (!flat.ok) return { success: false, error: flat.error }
    patch.team_split_value = flat.value
    patch.team_split_percent = null
  }

  const wrote = await writeTeamRow(g, target.teamId, patch)
  if (!wrote.ok) return { success: false, error: wrote.error }

  // ── OPEN THE LEDGER, OR THE CAP IS DECORATIVE ─────────────────────────────
  //
  // `teams.cap_amount` is now saved. That is NOT the same as the cap being in
  // force: `lib/commission/waterfall/08-team-split.ts` bounds the team's cut by
  // reading `team_cap_tracking`, and a ceiling with no ledger row covering today
  // is read as UNCAPPED. m461 found this exact shape one level up — four agents
  // carried a cap and three had no ledger row, so the engine had never applied
  // one of them.
  //
  // SERVICE CLIENT, DELIBERATELY. `team_cap_tracking`'s INSERT policy admits
  // brokerage admins only, because it is a money ledger and a team lead moving
  // their own collections counter is the thing that policy exists to stop. But a
  // lead IS allowed to set their team's cap — `resolveWritableTeamId` above just
  // proved they lead this team — and opening the ledger is a CONSEQUENCE of that
  // authorised act, not a ledger edit in its own right. On the session client
  // this write would come back as zero rows with error:null, which is silence.
  //
  // BEST EFFORT, NEVER SILENT. The agreement is saved and that is what the lead
  // asked for; a ledger failure must not roll it back. But it is reported, both
  // to the caller and to the log, because a cap that looks saved and is not
  // enforced is precisely the failure this whole change exists to end.
  let capLedger: SaveTeamSplitsResult["capLedger"]
  {
    const { createServiceClient } = await import("@/lib/supabase/service")
    const seeded = await ensureTeamCapWindows(createServiceClient() as never, {
      teamId: target.teamId,
      brokerageId: g.brokerageId,
    })
    if (!seeded.ok) {
      console.error(`[team-branding] team cap ledger not opened for team ${target.teamId}: ${seeded.error}`)
      capLedger = {
        seeded: 0, alreadyCovered: 0, agentsConsidered: 0,
        error: `The team's terms were saved, but the cap ledger the payout engine reads could not be opened, so the cap is not yet enforced: ${seeded.error}`,
      }
    } else {
      capLedger = {
        seeded: seeded.result.seeded,
        alreadyCovered: seeded.result.alreadyCovered,
        agentsConsidered: seeded.result.agentsConsidered,
        error: seeded.result.errors.length > 0
          ? `The cap is in force for ${seeded.result.seeded + seeded.result.alreadyCovered} of ${seeded.result.agentsConsidered} agents on this team. Not opened for: ${seeded.result.errors.join("; ")}`
          : undefined,
      }
      if (capLedger.error) console.error(`[team-branding] partial team cap ledger: ${capLedger.error}`)
    }
  }

  revalidatePath("/dashboard/settings/teams")
  revalidatePath("/dashboard/settings")
  // The onboarding checklist that sent the lead here reads team_split_type.
  revalidatePath("/dashboard")

  const snapshot = await loadTeamBranding()
  return { success: true, snapshot, capLedger }
}

// ── Write: THE TEAM EMAIL SIGNATURE ──────────────────────────────────────────

export interface TeamSignatureInput {
  /** Admin path only, re-authorised against the session's brokerage. */
  teamId?: string | null
  /** Plain text, or simple HTML. Blank REMOVES the team signature. */
  signature: string
}

export interface SaveTeamSignatureResult {
  success: boolean
  error?: string
  snapshot?: TeamBrandingSnapshot
}

/**
 * Write `teams.branding_override.email_signature_html` — tier 2 of the signature
 * waterfall in `lib/kernel/communications/assemble-email.ts:67-78`.
 *
 * THE MERGE IS THE POINT. `branding_override` is a SHARED JSONB column: this
 * module owns exactly one key inside it and has no idea what else a future
 * feature will put there. So the write is read-modify-write — the existing
 * object is fetched, one key is set (or deleted), and the merged object is
 * stored. An `update({ branding_override: { email_signature_html } })` would
 * silently delete every sibling key, which is the exact class of silent loss
 * this workstream keeps fixing.
 *
 * If the column holds something that is NOT a JSON object — an array, a string —
 * there is no safe merge, so the write is REFUSED rather than guessed at.
 *
 * The value itself is validated by `normalizeSignatureHtml`, which constrains
 * rather than sanitises, because this repo has no sanitiser. See the note there.
 */
export async function saveTeamSignature(input: TeamSignatureInput): Promise<SaveTeamSignatureResult> {
  const g = await gate()
  if (!g.ok) return { success: false, error: g.error }

  const target = await resolveWritableTeamId(g, input.teamId, "set the email signature for")
  if (!target.ok) return { success: false, error: target.error }

  const value = normalizeSignatureHtml(input.signature ?? "")
  if (!value.ok) return { success: false, error: value.error }

  // ── READ before MODIFY before WRITE. ─────────────────────────────────────
  const { data: row, error: readErr } = await g.supabase
    .from("teams")
    .select("branding_override")
    .eq("id", target.teamId)
    .maybeSingle()

  if (readErr) {
    return { success: false, error: `Could not read the team's existing branding: ${readErr.message}` }
  }
  if (!row) {
    // A refused SELECT resolves as no row. Never merge into an assumed {}.
    return {
      success: false,
      error: "The team's existing branding could not be read, so nothing was written — merging into it blind could delete other settings.",
    }
  }

  const existing = asJsonObject((row as { branding_override: unknown }).branding_override)
  if (!existing) {
    return {
      success: false,
      error:
        "This team's branding_override holds something other than a settings object, so the signature was not written — overwriting it would destroy whatever is in there. An administrator should inspect that column first.",
    }
  }

  const merged: Record<string, unknown> = { ...existing }
  if (value.value === null) {
    delete merged[SIGNATURE_KEY]
  } else {
    merged[SIGNATURE_KEY] = value.value
  }

  const wrote = await writeTeamRow(g, target.teamId, {
    branding_override: merged,
    updated_at: new Date().toISOString(),
  })
  if (!wrote.ok) return { success: false, error: wrote.error }

  revalidatePath("/dashboard/settings/teams")
  revalidatePath("/dashboard/settings")

  const snapshot = await loadTeamBranding()
  return { success: true, snapshot }
}
