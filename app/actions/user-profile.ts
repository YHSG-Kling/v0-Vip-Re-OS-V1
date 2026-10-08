"use server"

// ★ ACT-AS WRITE SEAM ★ — every write below gates through resolveWriteContext()
// and writes through its `db`: cookie (RLS) client for a normal user, service
// client ONLY under an active FULL impersonation grant re-validated at call
// time (read_only refused). Before this, the writes rode the cookie client
// keyed on the EFFECTIVE userId — under act-as, the staff session's RLS
// matched zero rows on the impersonated user's row and supabase-js resolved
// the refusal as success-over-nothing. Every users-row update now counts its
// rows. Reads ride resolveActingContext for the same reason.
import { resolveActingContext, resolveWriteContext } from "@/lib/platform/acting-context"

/**
 * Save the calling user's personal email signature to users.email_signature.
 * This overrides the brokerage-level signature in assemble-email.ts.
 */
export async function saveAgentEmailSignature(
  signature: string
): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }

  const { data: saved, error } = await ctx.db
    .from("users")
    .update({ email_signature: signature.trim() || null })
    .eq("id", ctx.userId)
    .select("id")

  if (error) {
    return { success: false, error: error.message }
  }
  if (!saved || saved.length === 0) {
    return { success: false, error: "The signature was not saved — the database refused the change." }
  }

  return { success: true }
}

/**
 * Load the calling user's personal email signature.
 */
// TOMBSTONE (orphan tranche 3): getAgentEmailSignature deleted — a one-column
// read wrapper no surface called. The live survivor is
// app/dashboard/profile/page.tsx, which selects users.email_signature directly
// (under RLS, alongside the rest of the profile row) and feeds it to
// AgentSignaturePanel — the panel that also owns the save path. One read, one
// surface, no second vocabulary over the same column.

/**
 * Wave 33 — personal website actions. Distinct from brokerage.website
 * (broker's site) — this is the agent's own real-estate pro site that
 * lives independently of the brokerage. Used as the canonical embed/CSP
 * origin for /embed/blog when set, and surfaced as the byline link on
 * the hosted /blog/[slug] landing page.
 */
export interface UserProfileRow {
  personal_website_url: string | null
}

export async function getMyProfile(): Promise<{ success: boolean; error?: string; profile?: UserProfileRow }> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.userId) return { success: false, error: "Unauthorized" }
  const { data, error } = await ctx.db
    .from("users")
    .select("personal_website_url")
    .eq("id", ctx.userId)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  return { success: true, profile: (data as UserProfileRow | null) ?? { personal_website_url: null } }
}

const URL_RE = /^https?:\/\/\S+$/

export async function updateMyProfile(input: {
  personalWebsiteUrl?: string | null
}): Promise<{ success: boolean; error?: string }> {
  // ACT-AS WRITE SEAM — read_only refused before the write.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  const userId = ctx.userId

  // Normalize empty-string to null so the DB CHECK accepts "clear".
  const cleaned: string | null =
    input.personalWebsiteUrl == null ? null
    : input.personalWebsiteUrl.trim() === "" ? null
    : input.personalWebsiteUrl.trim()
  if (cleaned !== null) {
    if (cleaned.length > 500) return { success: false, error: "Website URL too long (max 500 chars)" }
    if (!URL_RE.test(cleaned)) return { success: false, error: "Website must start with http:// or https://" }
  }

  const { data: saved, error } = await ctx.db.from("users")
    .update({ personal_website_url: cleaned })
    .eq("id", userId)
    .select("id")
  if (error) return { success: false, error: error.message }
  if (!saved || saved.length === 0) {
    return { success: false, error: "The website was not saved — the database refused the change." }
  }
  return { success: true }
}

// ─── AGENT IDENTITY ──────────────────────────────────────────────────────────
//
// Walkthrough [44]: "Profile goes settings". The profile page was a settings page —
// video config, social connections, signature — with a read-only "Account Info" card
// showing only name/email/role and the note "edit via admin". An agent could not edit
// their own professional identity anywhere in the OS.
//
// That identity is not cosmetic in real estate: the photo, license number and state,
// bio, phone and years of experience are what appear on listing presentations, client
// emails, the agent's public site, and compliance-required license disclosure. Making
// an agent file a ticket with their broker to fix a typo in their own license number is
// the wrong shape.
//
// The columns already exist (agents: photo_url, bio, license_number, license_state,
// license_expiry, phone_mobile, phone_office, years_experience, languages; users:
// first_name, last_name, phone) — nothing new is invented here. Self-scoped only: this
// writes the CALLER's own rows, never another user's, so it needs no manager role.

export interface AgentIdentity {
  firstName: string | null
  lastName: string | null
  phone: string | null
  photoUrl: string | null
  bio: string | null
  licenseNumber: string | null
  licenseState: string | null
  licenseExpiry: string | null
  phoneMobile: string | null
  phoneOffice: string | null
  yearsExperience: number | null
  languages: string[] | null
}

export async function getMyAgentIdentity(): Promise<
  { success: true; identity: AgentIdentity } | { success: false; error: string }
> {
  const ctx = await resolveActingContext()
  if (!ctx.ok || !ctx.userId) return { success: false, error: "Unauthorized" }
  const userId = ctx.userId

  const supabase = ctx.db
  const [{ data: u }, { data: a }] = await Promise.all([
    supabase.from("users").select("first_name, last_name, phone").eq("id", userId).maybeSingle(),
    supabase
      .from("agents")
      .select("photo_url, bio, license_number, license_state, license_expiry, phone_mobile, phone_office, years_experience, languages")
      .eq("user_id", userId)
      .maybeSingle(),
  ])

  return {
    success: true,
    identity: {
      firstName: (u as any)?.first_name ?? null,
      lastName: (u as any)?.last_name ?? null,
      phone: (u as any)?.phone ?? null,
      photoUrl: (a as any)?.photo_url ?? null,
      bio: (a as any)?.bio ?? null,
      licenseNumber: (a as any)?.license_number ?? null,
      licenseState: (a as any)?.license_state ?? null,
      licenseExpiry: (a as any)?.license_expiry ?? null,
      phoneMobile: (a as any)?.phone_mobile ?? null,
      phoneOffice: (a as any)?.phone_office ?? null,
      yearsExperience: (a as any)?.years_experience ?? null,
      languages: (a as any)?.languages ?? null,
    },
  }
}

const trimOrNull = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim()
  return s === "" ? null : s
}

export async function updateMyAgentIdentity(input: {
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  bio?: string | null
  licenseNumber?: string | null
  licenseState?: string | null
  licenseExpiry?: string | null
  phoneMobile?: string | null
  phoneOffice?: string | null
  yearsExperience?: number | null
}): Promise<{ success: boolean; error?: string }> {
  // ACT-AS WRITE SEAM — read_only refused before either write.
  const ctx = await resolveWriteContext()
  if (!ctx.ok) return { success: false, error: ctx.error }
  const userId = ctx.userId

  const bio = trimOrNull(input.bio)
  if (bio && bio.length > 2000) return { success: false, error: "Bio is too long (max 2000 characters)" }

  // license_state is a 2-letter code — reject anything else rather than storing junk
  // that a license-verification read would later choke on.
  const licenseState = trimOrNull(input.licenseState)?.toUpperCase() ?? null
  if (licenseState && !/^[A-Z]{2}$/.test(licenseState)) {
    return { success: false, error: "License state must be a 2-letter code (e.g. CA)" }
  }

  const licenseExpiry = trimOrNull(input.licenseExpiry)
  if (licenseExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(licenseExpiry)) {
    return { success: false, error: "License expiry must be a date (YYYY-MM-DD)" }
  }

  const years = input.yearsExperience
  if (years != null && (!Number.isFinite(years) || years < 0 || years > 80)) {
    return { success: false, error: "Years of experience must be between 0 and 80" }
  }

  const supabase = ctx.db

  const { data: savedUser, error: uErr } = await supabase
    .from("users")
    .update({
      first_name: trimOrNull(input.firstName),
      last_name: trimOrNull(input.lastName),
      phone: trimOrNull(input.phone),
    })
    .eq("id", userId)
    .select("id")
  if (uErr) return { success: false, error: uErr.message }
  if (!savedUser || savedUser.length === 0) {
    return { success: false, error: "Your profile was not saved — the database refused the change." }
  }

  // The agents row is scoped by user_id, so this can only ever touch the caller's own
  // record. A staff user with no agents row simply updates nothing here.
  const { error: aErr } = await supabase
    .from("agents")
    .update({
      bio,
      license_number: trimOrNull(input.licenseNumber),
      license_state: licenseState,
      license_expiry: licenseExpiry,
      phone_mobile: trimOrNull(input.phoneMobile),
      phone_office: trimOrNull(input.phoneOffice),
      years_experience: years ?? null,
    })
    .eq("user_id", userId)
  if (aErr) return { success: false, error: aErr.message }

  return { success: true }
}
