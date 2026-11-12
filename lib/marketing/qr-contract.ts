/**
 * lib/marketing/qr-contract.ts — THE QR CONTRACT (wave 141, lane 141F). PURE: no
 * server-only, no I/O, no React — importable by the server minter
 * (lib/marketing/tracked-qr.ts), the scan door (app/api/qr/scan), the public
 * landing (app/qr/[slug]), every CLIENT encoder (the agent QR board, the mobile
 * open-house panel, the listing share page) and the proof
 * (scripts/qr-and-card-scanner-guard.ts).
 *
 * Two rules the owner asked to be PROVED, not assumed (wave 141 ruling, verbatim:
 * "generate → intended encoded destination/action → scan → correct tenant →
 * attribution → intended action → analytics. No cross-tenant resolution, no open
 * redirect, no broken mobile route."):
 *
 *  1. ONE ENCODING. Every QR the OS draws used its own option literal — margin 1
 *     on the postcards and the minter, margin 2 on the agent board and the mobile
 *     panel, a slate-800 dark on the share page. ISO/IEC 18004 asks for a QUIET
 *     ZONE of four modules on every side; the `qrcode` package's `margin` IS that
 *     quiet zone, in modules. Phone cameras usually tolerate less on a bright
 *     screen; a printed flyer at arm's length in a hallway does not. Error
 *     correction M (15%) is the print-safe level for a code with no logo overlay
 *     (H wastes modules and grows the symbol); black on white is the maximum
 *     printable contrast. `qrEncodeOptions(width)` is the ONE option builder.
 *
 *  2. THE SCAN GOES WHERE THE CODE SAYS — ON AN ALLOW-LIST. /api/qr/scan recorded
 *     the scan and then ALWAYS redirected to the generic /qr/<slug> capture form,
 *     never reading `target_url`: a lead-magnet code never reached its magnet, an
 *     open-house code never reached the sign-in kiosk, a listing code never reached
 *     the listing. (The agent board even told users "updating the URL reroutes every
 *     printed copy" — the route handler's own comment admitted it did not.)
 *     resolveQrScanDestination() is the one decision: an IN-APP public path (same
 *     origin as the app, under QR_IN_APP_PUBLIC_PREFIXES — every prefix a real
 *     app/<segment> directory, held by the proof) is redirected to with the code's
 *     slug appended as `qr=` for attribution; anything else lands on the in-app
 *     landing page, which OFFERS an https external destination as a link the person
 *     taps (never an automatic redirect to a host we do not own — no open redirect
 *     by construction, and a tenant-typed URL can never bounce a scanner through
 *     a `javascript:` / `data:` / plain-http destination).
 */

// ─── 1 · encoding ─────────────────────────────────────────────────────────────

type QrErrorCorrection = "L" | "M" | "Q" | "H"

/** The one encoding contract. `margin` is the quiet zone in MODULES (ISO/IEC 18004 §5.3.7: 4). */
export const QR_RENDER_DEFAULTS = {
  errorCorrectionLevel: "M" as QrErrorCorrection,
  /** Quiet zone, in modules — the spec's four. Never below it for a printed piece. */
  margin: 4,
  /** Default raster size for a PRINT asset (a 600 px PNG prints at ~2 in / 300 dpi). */
  printWidth: 600,
  /** Default raster size for an on-screen preview. */
  screenWidth: 220,
  dark: "#000000",
  light: "#ffffff",
} as const

interface QrEncodeOptions {
  width: number
  margin: number
  errorCorrectionLevel: QrErrorCorrection
  color: { dark: string; light: string }
}

/**
 * The ONE option object every `qrcode` call (toDataURL / toCanvas) takes. The only
 * knob a caller may turn is the error-correction level UP (the per-recipient
 * opt-out QR uses Q — its reason stands in lib/direct-mail/mail-opt-out-affordance.ts);
 * quiet zone and contrast are not negotiable per caller.
 */
export function qrEncodeOptions(
  width: number = QR_RENDER_DEFAULTS.printWidth,
  overrides?: { errorCorrectionLevel?: Exclude<QrErrorCorrection, "L"> },
): QrEncodeOptions {
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : QR_RENDER_DEFAULTS.printWidth,
    margin: QR_RENDER_DEFAULTS.margin,
    errorCorrectionLevel: overrides?.errorCorrectionLevel ?? QR_RENDER_DEFAULTS.errorCorrectionLevel,
    color: { dark: QR_RENDER_DEFAULTS.dark, light: QR_RENDER_DEFAULTS.light },
  }
}

// ─── 2 · destinations ─────────────────────────────────────────────────────────

/**
 * Public, session-free app routes a scan may be redirected INTO. Each entry is
 * `/<first segment>/`; the proof derives `app/<first segment>` from this list and
 * refuses a prefix with no route directory, and refuses `/api/` or `/dashboard/`
 * (a scanner has no session — a redirect there is a login wall, not a destination).
 * @proofSeam the allow-list itself is what scripts/qr-and-card-scanner-guard.ts and
 * scripts/marketing-qr-simulator.ts hold to real route directories; the product reads
 * it through isQrInAppPublicPath / resolveQrScanDestination below.
 */
export const QR_IN_APP_PUBLIC_PREFIXES: readonly string[] = [
  "/qr/",         // the code's own capture landing (app/qr/[slug])
  "/lm/",         // lead-magnet landing (app/lm/[slug])
  "/listings/",   // public listing page with the showing-request form; admits sold listings (app/listings/[listingId])
  "/listing/",    // public listing marketing landing by mls/id (app/listing/[slug]; active only)
  "/home-value/", // the home-value / CMA funnel (app/home-value, app/home-value/[agentSlug])
  "/p/",          // agent public profile with its lead-capture form (app/p/[agentSlug])
  "/v/",          // tenant video landing (app/v/[slug])
  "/open-house/", // open-house sign-in kiosk + RSVP (app/open-house/[eventId]/…)
  "/forms/",      // tenant lead-capture forms (app/forms/[slug])
  "/site/",       // tenant website (app/site/[slug])
] as const

/** PURE — is `path` (no origin) under one of the in-app public prefixes? `/home-value` alone counts.
 *  @proofSeam asserted directly by the proofs (allow-list membership of every default path); the
 *  product reaches it through resolveQrScanDestination. */
export function isQrInAppPublicPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false
  const pathname = path.split(/[?#]/)[0]
  return QR_IN_APP_PUBLIC_PREFIXES.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p))
}

/** qr_codes.destination_type (m148 CHECK) — restated here only as the parameter type; the live
 *  vocabulary and its guard live beside the minter (lib/marketing/tracked-qr.ts QR_DESTINATION_TYPES). */
type QrDefaultDestinationType =
  | "landing_page" | "cma_form" | "book_meeting" | "listing_detail"
  | "video_avatar_tour" | "podcast_episode" | "anniversary_video" | "other"

/**
 * PURE — the app-hosted DEFAULT path for a destination type when the person minting
 * the code typed no URL. ONE table (it used to be two: app/api/admin/qr-codes held
 * `/qr/<slug>/landing`, `/forms/cma`, `/book` — three routes that do not exist — and
 * lib/marketing/marketing-qr.ts held `/listings/<id>/rsvp`, a fourth). Null = there is
 * no app-hosted default; an external type needs the caller's URL, and `landing_page`
 * resolves to the code's own landing, which the minter already defaults to.
 */
export function qrInAppDefaultPath(input: {
  destinationType: QrDefaultDestinationType | string | null | undefined
  listingId?: string | null
  agentSlug?: string | null
}): string | null {
  const listingId = (input.listingId ?? "").trim() || null
  const agentSlug = (input.agentSlug ?? "").trim() || null
  switch (input.destinationType) {
    case "landing_page":   return null // the code's own /qr/<slug> — the minter's default
    case "cma_form":       return agentSlug ? `/home-value/${encodeURIComponent(agentSlug)}` : "/home-value"
    case "listing_detail": return listingId ? `/listings/${encodeURIComponent(listingId)}` : null
    case "book_meeting":
      // A listing's public page carries the showing-request form; an agent's profile carries
      // the lead-capture form; with neither, the code's own landing is the request form.
      if (listingId) return `/listings/${encodeURIComponent(listingId)}`
      if (agentSlug) return `/p/${encodeURIComponent(agentSlug)}`
      return null
    default:               return null
  }
}

type QrScanDestination =
  | { kind: "in_app"; path: string; reason: "allow_listed" }
  | {
      kind: "landing"
      path: string
      /** An https destination the landing may OFFER as a tap-through link. Never auto-followed. */
      external: { url: string; host: string } | null
      reason: "no_target" | "landing_is_target" | "not_allow_listed" | "external_https" | "unsafe_target"
    }

function sameHost(a: URL, b: URL): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase()
}

/** Append `qr=<slug>` once (attribution for the destination's own capture form). */
function withQrParam(path: string, slug: string): string {
  const [base, hash = ""] = path.split("#")
  const [pathname, query = ""] = base.split("?")
  const params = new URLSearchParams(query)
  if (!params.has("qr")) params.set("qr", slug)
  const qs = params.toString()
  return `${pathname}${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`
}

/**
 * PURE — where a recorded scan is sent. The tenant is NOT an input: the caller resolved
 * the qr_codes row by slug already, and nothing the scanner controls reaches this
 * function except the slug (which only ever appends itself as `qr=`).
 *
 *   targetUrl absent / the minter's pre-slug placeholder → landing (no_target)
 *   /qr/<slug> (the landing itself)                       → landing (landing_is_target)
 *   relative `/x` or same-host absolute, allow-listed     → in_app `/x?qr=<slug>`
 *   relative or same-host but NOT allow-listed            → landing (not_allow_listed)
 *   https://other-host/…                                  → landing + external offer
 *   http:, javascript:, data:, mailto:, `//host`, garbage → landing, external null (unsafe_target)
 */
export function resolveQrScanDestination(input: {
  slug: string
  targetUrl: string | null | undefined
  /** The app's own origin(s): NEXT_PUBLIC_APP_URL and the request origin (a custom domain). */
  appOrigins: ReadonlyArray<string | null | undefined>
}): QrScanDestination {
  const slug = input.slug
  const landing = `/qr/${encodeURIComponent(slug)}`
  const raw = (input.targetUrl ?? "").trim()
  if (!raw) return { kind: "landing", path: landing, external: null, reason: "no_target" }

  const origins: URL[] = []
  for (const o of input.appOrigins) {
    if (!o) continue
    try { origins.push(new URL(o)) } catch { /* an unparsable origin is simply not ours */ }
  }

  let path: string | null = null
  if (raw.startsWith("/")) {
    if (raw.startsWith("//")) return { kind: "landing", path: landing, external: null, reason: "unsafe_target" }
    // NORMALISE before the allow-list test: `/listings/../dashboard` is `/dashboard` to every
    // browser, so it is judged as `/dashboard` (not allow-listed), never as `/listings/…`.
    try {
      const u = new URL(raw, "http://qr.invalid")
      path = `${u.pathname}${u.search}${u.hash}`
    } catch {
      return { kind: "landing", path: landing, external: null, reason: "unsafe_target" }
    }
  } else {
    let url: URL
    try { url = new URL(raw) } catch { return { kind: "landing", path: landing, external: null, reason: "unsafe_target" } }
    const isOurs = (url.protocol === "https:" || url.protocol === "http:") && origins.some((o) => sameHost(o, url))
    if (isOurs) {
      path = `${url.pathname}${url.search}${url.hash}`
    } else if (url.protocol === "https:") {
      return { kind: "landing", path: landing, external: { url: url.toString(), host: url.host }, reason: "external_https" }
    } else {
      return { kind: "landing", path: landing, external: null, reason: "unsafe_target" }
    }
  }

  const pathname = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/"
  if (pathname === "/qr" || pathname === landing) return { kind: "landing", path: landing, external: null, reason: "landing_is_target" }
  if (!isQrInAppPublicPath(path)) return { kind: "landing", path: landing, external: null, reason: "not_allow_listed" }
  return { kind: "in_app", path: withQrParam(path, slug), reason: "allow_listed" }
}

/** PURE — the words the landing page uses for its tap-through link, by destination type. */
export function qrContinueLabel(destinationType: string | null | undefined, external: boolean): string {
  switch (destinationType) {
    case "listing_detail":    return "View the listing"
    case "book_meeting":      return "Book a time"
    case "cma_form":          return "Get your home value"
    case "video_avatar_tour": return "Watch the video tour"
    case "podcast_episode":   return "Listen to the episode"
    case "anniversary_video": return "Watch your video"
    case "landing_page":      return external ? "Continue" : "Open the page"
    default:                  return "Continue"
  }
}

// ─── 3 · the minted token (wave 152, lane 152C) ───────────────────────────────
//
// Owner (verbatim, 2026-11-11): "qr minted bar code has a destination url and each bar code needs is unique and
// needs tracking, creating one and managing." The slug used to be the LABEL lower-cased plus Date.now() in base36 —
// predictable, and it printed the label's entity into the code: `pre_listing_kit:<contactId>` put a Contact id in
// the scanned URL, `estimate_comparison:<street-address>` a home address. The slug is now an UNPREDICTABLE token the
// minter draws from a CSPRNG (lib/marketing/tracked-qr.ts) and the label stays a server-side key. Codes minted
// before wave 152 keep their slugs — the resolver looks a code up by slug, whatever its shape — so every printed
// piece keeps resolving.

/** The token shape: 22 symbols from a 32-symbol alphabet (no 0/1/l/o — readable when typed off a printed piece) =
 *  110 bits from a CSPRNG. Short enough that the full scan URL stays a small QR symbol (version ≤ 5 at EC M). */
export const QR_TOKEN_SHAPE = { length: 22, alphabet: "abcdefghijkmnpqrstuvwxyz23456789" } as const

/** Whether one token stands for a DESIGN (every printed copy shares it — a scan never identifies a person) or for one
 *  physical PIECE (still not a person: a piece can be handed on, so a scan of it is evidence about the piece). */
export const QR_TOKEN_SCOPES = ["per_design", "per_piece"] as const
export type QrTokenScope = (typeof QR_TOKEN_SCOPES)[number]

/** What the destination does with personal data — said at mint so the board and the ROI reader never assume more. */
export const QR_CONSENT_CONTEXTS = ["no_personal_data", "consented_form", "external_site"] as const
export type QrConsentContext = (typeof QR_CONSENT_CONTEXTS)[number]

/**
 * qr_codes.mint_context (m945) — the provenance a code was minted with, for the board and for any ROI reader of
 * qr_codes / qr_scan_events: who/what minted it, for which channel/source/placement/asset, under
 * which office or team, what the destination may do with personal data, the token scope, the print size and whether
 * per-scan tracking is on. `placement` uses the existing marketing_asset_qr_links.placement_type vocabulary and
 * `mail_layout` the mail layout library's keys (lib/direct-mail/mail-piece-rules.ts) — no third spelling.
 */
export interface QrMintContext {
  minted_via: "governed" | "automated"
  /** The label's key kind (`listing`, `direct_mail_campaign`, `lead_magnet`, …) or `manual` for a person-typed label. */
  label_kind: string
  token_scope: QrTokenScope
  tracking: "enabled" | "disabled"
  channel?: string | null
  source?: string | null
  placement?: string | null
  mail_layout?: string | null
  asset_id?: string | null
  team_id?: string | null
  location_id?: string | null
  purpose_context?: string | null
  consent_context?: QrConsentContext | null
  print_size_in?: number | null
  idempotency_key?: string | null
  duplicated_from?: string | null
}

/** marketing_asset_qr_links.placement_type (live CHECK) — the ONE placement vocabulary a code's mint context names
 *  (scripts/qr-registry-guard.ts holds it equal to the generated cache). Mail pieces also name their layout key. */
export const QR_PLACEMENT_TYPES = ["flyer", "listing_asset", "mailer", "podcast_landing", "social_landing", "video_endcard"] as const

/** PURE — a refusal that names a column the live table does not have yet (a WRITTEN-NOT-APPLIED migration): PostgREST
 *  PGRST204 on a write, Postgres 42703 on a read. The QR doors read it to degrade to the pre-m945/m946 shape instead of
 *  failing a printed code's scan; a governed write reads it to REFUSE instead of dropping provenance. */
export function isAbsentColumnRefusal(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  return err.code === "PGRST204" || err.code === "42703" || /column .* does not exist|could not find the '.*' column/i.test(err.message ?? "")
}

/** PURE — the key kind of a label: `listing:<id>` → `listing`; a person-typed label → `manual`. */
export function qrLabelKind(label: string): string {
  const m = /^(?:platform:)?([a-z][a-z_]*):/.exec(label)
  return m ? m[1] : "manual"
}

// ─── 4 · destination safety (wave 152, lane 152C) ─────────────────────────────
//
// resolveQrScanDestination (§2) decides where a RECORDED scan goes, and never auto-follows a foreign host. This
// section decides what a person may SAVE as a code's destination in the first place — at mint and at every edit —
// so an unsafe destination is refused while it is typed, with words that say what to do, instead of being quietly
// demoted to the landing page months later on a printed piece.

/**
 * External hosts a code may point at without being the tenant's own site, each tied to the destination type that
 * needs it. Derived from the board's own destination types (video_avatar_tour / anniversary_video / podcast_episode /
 * book_meeting are hosted elsewhere by nature), not from reputation. A host that is not here and is not the tenant's
 * own verified domain or declared website is refused, and the tenant is told how to add it. Widening this list is a
 * reviewed one-line change; it is never widened per request.
 */
const QR_EXTERNAL_DESTINATION_HOSTS: ReadonlyArray<{ host: string; why: string }> = [
  { host: "youtube.com",        why: "video tours and anniversary videos (video_avatar_tour, anniversary_video)" },
  { host: "youtu.be",           why: "YouTube's own short links for the same videos" },
  { host: "vimeo.com",          why: "video tours (video_avatar_tour)" },
  { host: "podcasts.apple.com", why: "podcast episodes (podcast_episode)" },
  { host: "open.spotify.com",   why: "podcast episodes (podcast_episode)" },
  { host: "calendly.com",       why: "an appointment page (book_meeting)" },
]

type QrDestinationRefusalCode =
  | "empty" | "too_long" | "unparsable" | "unsafe_scheme" | "not_https" | "credentials_in_url"
  | "ip_or_local_host" | "redirect_loop" | "not_public_page" | "personal_data_in_url" | "host_not_allowed"

type QrDestinationVerdict =
  | { ok: true; url: string; kind: "in_app" | "tenant_site" | "allowed_external" }
  | { ok: false; code: QrDestinationRefusalCode; message: string }

const QR_DESTINATION_MAX = 2048
/** Query keys that name a person or a credential. A code is printed and shared; its destination never carries them. */
const PERSONAL_QUERY_KEY_RE = /^(e-?mail|phone|tel|mobile|cell|contact(_?id)?|lead(_?id)?|recipient(_?id)?|first_?name|last_?name|full_?name|name|address|street|ssn|dob|token|access_?token|api_?key|key|secret|password|pass|session|auth|sig|signature)$/i
const EMAIL_VALUE_RE = /[^@\s/]+@[^@\s/]+\.[a-z]{2,}/i
/** A value that IS a North-American phone number (not merely long digits — an MLS number or a timestamp is not one). */
const PHONE_VALUE_RE = /^\+?1?[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{4}$/

function hostMatches(host: string, rule: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "")
  const r = rule.toLowerCase().replace(/^www\./, "")
  return h === r || h.endsWith(`.${r}`)
}

/** The refusal words, one place — the board shows exactly this sentence beside the field. */
function refuse(code: QrDestinationRefusalCode, message: string): QrDestinationVerdict { return { ok: false, code, message } }

/** Personal data or a credential in the query string or fragment — the URL is printed on a piece. */
function personalDataIn(u: URL): boolean {
  for (const [k, v] of u.searchParams) {
    if (PERSONAL_QUERY_KEY_RE.test(k)) return true
    if (EMAIL_VALUE_RE.test(v) || PHONE_VALUE_RE.test(v.trim())) return true
  }
  const rest = decodeURIComponent(`${u.pathname}${u.hash}`)
  return EMAIL_VALUE_RE.test(rest)
}

/**
 * PURE — may this URL be saved as a QR code's destination? The tenant comes from the SESSION in the caller, which
 * also supplies `tenantHosts` (the tenant's ACTIVE verified custom domains + its declared website host, read under the
 * session's brokerage). `ownSlug` lets an edit point a code back at its own landing (the minter's default).
 *
 *   relative `/x` or an app-origin URL → must be an allow-listed public page (§2), never /api, never another code
 *   https on a tenant host              → the tenant's own site (loop-checked: never its /api/qr door)
 *   https on QR_EXTERNAL_DESTINATION_HOSTS → allowed external (the landing offers it as a tap-through, §2)
 *   anything else                       → refused, with the one action that fixes it
 * Every accepted URL is free of personal data and credentials, under 2,048 characters, https, on a named host.
 */
export function validateQrDestination(input: {
  url: string | null | undefined
  appOrigins: ReadonlyArray<string | null | undefined>
  tenantHosts?: ReadonlyArray<string | null | undefined>
  ownSlug?: string | null
}): QrDestinationVerdict {
  const raw = (input.url ?? "").trim()
  if (!raw) return refuse("empty", "Add the web address people should reach when they scan this code.")
  if (raw.length > QR_DESTINATION_MAX) return refuse("too_long", "That web address is too long to put behind a printed code. Use a shorter link to the same page.")

  const origins: URL[] = []
  for (const o of input.appOrigins) { if (!o) continue; try { origins.push(new URL(o)) } catch { /* not ours */ } }

  /** An in-app page (a relative path, or an absolute URL on one of the app's own origins — kept as typed). */
  const inAppVerdict = (path: string, keep: string): QrDestinationVerdict => {
    let u: URL
    try { u = new URL(path, "https://qr.invalid") } catch { return refuse("unparsable", "That web address could not be read. Paste the full address, starting with https://.") }
    const pathname = u.pathname.replace(/\/+$/, "") || "/"
    if (/^\/api(\/|$)/.test(pathname)) return refuse("redirect_loop", "A code cannot point at the app's own tracking links. Choose the page people should see instead.")
    const ownLanding = input.ownSlug ? `/qr/${input.ownSlug}` : null
    if ((pathname === "/qr" || /^\/qr\/[^/]+/.test(pathname)) && pathname !== ownLanding) return refuse("redirect_loop", "A code cannot point at another QR code — that sends people around in a loop. Point it at the page itself.")
    if (personalDataIn(u)) return refuse("personal_data_in_url", "That web address carries personal details or a key (an email, phone number, name or token). Remove them — printed codes are seen by anyone.")
    if (pathname !== ownLanding && !isQrInAppPublicPath(`${pathname}${u.search}`)) return refuse("not_public_page", "That page needs a sign-in, so people scanning a printed code could not open it. Choose a public page: a listing, your profile, a landing page, a form or an open house.")
    return { ok: true, url: keep, kind: "in_app" }
  }

  if (raw.startsWith("/")) {
    if (raw.startsWith("//")) return refuse("unsafe_scheme", "Paste the full web address, starting with https://.")
    let normalized: string
    try { const u = new URL(raw, "https://qr.invalid"); normalized = `${u.pathname}${u.search}${u.hash}` } catch { return refuse("unparsable", "That web address could not be read. Paste the full address, starting with https://.") }
    return inAppVerdict(normalized, normalized)
  }

  let url: URL
  try { url = new URL(raw) } catch { return refuse("unparsable", "That web address could not be read. Paste the full address, starting with https://.") }
  if (url.protocol !== "https:" && url.protocol !== "http:") return refuse("unsafe_scheme", "Only web pages can be behind a QR code. Paste an address that starts with https://.")
  if (url.username || url.password) return refuse("credentials_in_url", "That web address includes a sign-in name or password. Remove them before saving.")
  const host = url.hostname.toLowerCase()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) {
    return refuse("ip_or_local_host", "That address points at a private or numeric location people outside your office cannot reach. Use your public website's address.")
  }
  if (url.protocol === "http:") return refuse("not_https", "That page isn't secure (it starts with http://). Use the https:// version so phones open it without a warning.")

  if (origins.some((o) => o.host.toLowerCase() === url.host.toLowerCase())) return inAppVerdict(`${url.pathname}${url.search}${url.hash}`, url.toString())
  if (personalDataIn(url)) return refuse("personal_data_in_url", "That web address carries personal details or a key (an email, phone number, name or token). Remove them — printed codes are seen by anyone.")

  const tenantHosts = (input.tenantHosts ?? []).filter((h): h is string => !!h)
  if (tenantHosts.some((h) => hostMatches(host, h))) {
    if (/^\/api\/qr(\/|$)/.test(url.pathname)) return refuse("redirect_loop", "A code cannot point at a tracking link. Choose the page people should see instead.")
    return { ok: true, url: url.toString(), kind: "tenant_site" }
  }
  if (QR_EXTERNAL_DESTINATION_HOSTS.some((r) => hostMatches(host, r.host))) return { ok: true, url: url.toString(), kind: "allowed_external" }
  return refuse("host_not_allowed", `Codes can open your own pages, your verified website, or a video, podcast or booking page on a supported service. ${host} isn't one of those yet — add it as your website in Settings → Brand, or connect it under Settings → Custom domains, then save again.`)
}

// ─── 5 · lifecycle (wave 152, lane 152C) ──────────────────────────────────────

/** qr_codes.retired_reason — the ONE code source of the m945 CHECK. A retired code is terminal: it never routes again,
 *  and its row (proof of a mailed campaign) is never deleted. `revoked_unsafe` = turned off because its destination
 *  became unsafe. Pause is `is_active = false` with no retirement. */
export const QR_RETIRED_REASONS = ["retired", "revoked_unsafe"] as const

export type QrLifecycleState = "active" | "paused" | "expired" | "retired" | "revoked"

/** PURE — the ONE classifier of a code's state. Terminal states win over paused, paused over expired. */
export function qrLifecycleState(
  row: { is_active?: boolean | null; expires_at?: string | null; retired_at?: string | null; retired_reason?: string | null },
  nowMs: number = Date.now(),
): QrLifecycleState {
  if (row.retired_at) return row.retired_reason === "revoked_unsafe" ? "revoked" : "retired"
  if (row.is_active === false) return "paused"
  if (row.expires_at && new Date(row.expires_at).getTime() <= nowMs) return "expired"
  return "active"
}

/**
 * PURE — what a person holding a printed code is told when the code will not open its page, in the tenant-facing
 * message shape (what happened · what it affects · whether anything was saved — only if TRUE · who can act · ONE
 * action). No stack trace, no provider string, no tenant data. The scan route and the landing page record nothing
 * about the person for any of these, which is why "nothing about you was saved" may be said.
 */
export function qrUnavailableNotice(state: Exclude<QrLifecycleState, "active"> | "missing" | "error"): { heading: string; detail: string; action: string } {
  switch (state) {
    case "paused":  return { heading: "This QR code is paused", detail: "The business that printed it has paused it, so it isn't opening its page right now. Nothing about you was saved.", action: "Contact the agent or office named on the printed piece for the current link." }
    case "expired": return { heading: "This QR code has expired", detail: "It was set to stop working after a date that has now passed. Nothing about you was saved.", action: "Contact the agent or office named on the printed piece for a current link." }
    case "retired": return { heading: "This QR code has been retired", detail: "The campaign it was printed for has ended, so it no longer opens a page. Nothing about you was saved.", action: "Contact the agent or office named on the printed piece if you still need help." }
    case "revoked": return { heading: "This QR code was turned off for your safety", detail: "The business that printed it turned it off because the page it pointed to is no longer one it can vouch for. Nothing about you was saved.", action: "Contact the agent or office named on the printed piece directly rather than following other links." }
    case "missing": return { heading: "We don't recognize this QR code", detail: "It may have been printed incorrectly or belong to a different service. Nothing about you was saved.", action: "Contact the business that gave you the code for the right link." }
    case "error":   return { heading: "We couldn't open this QR code right now", detail: "Something went wrong on our side. Nothing about you was saved.", action: "Scan the code again in a minute." }
  }
}

// ─── 6 · tracking (wave 152, lane 152C) ───────────────────────────────────────
//
// A scan records only what the tenant may know: the time, the code, its campaign/placement (on the code), a COARSE
// device class, the referring HOST, and a visitor key that is a one-way hash of a coarse network prefix + browser,
// scoped to one code and one UTC day (lib/marketing/tracked-qr.ts qrScanEvidence) — never the raw IP address,
// never the full browser string, never a person. Four counts stay apart: raw scans · human-likely visits (bots and
// quick repeats filtered) · unique visitor-days (only where a key exists) · consented submissions (a Contact created
// through the landing form's consent). A scan never creates a Contact and is never read as a known consumer.

/** qr_scan_events.traffic_class — the ONE code source of the m946 CHECK. */
export const QR_TRAFFIC_CLASSES = ["human_likely", "bot", "repeat"] as const
export type QrTrafficClass = (typeof QR_TRAFFIC_CLASSES)[number]
/** qr_scan_events.device_class — the ONE code source of the m946 CHECK. */
export const QR_DEVICE_CLASSES = ["mobile", "tablet", "desktop", "unknown"] as const
export type QrDeviceClass = (typeof QR_DEVICE_CLASSES)[number]

/** A second scan by the same visitor key within this window is a REPEAT, not another visit. */
export const QR_REPEAT_WINDOW_MS = 30 * 60_000

/** Link previewers, crawlers, uptime checkers and scripted clients — a QR is scanned by a phone camera, not by these. */
const AUTOMATED_UA_RE = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebookcatalog|whatsapp|telegrambot|slackbot|discordbot|linkedinbot|twitterbot|embedly|preview|headless|phantomjs|puppeteer|playwright|lighthouse|pingdom|uptime|monitor|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|okhttp|java\/|libwww|httpclient|node-fetch|axios\//i

/** PURE — a coarse device class from the browser string (never stored itself). */
export function qrDeviceClass(userAgent: string | null | undefined): QrDeviceClass {
  const ua = (userAgent ?? "").toLowerCase()
  if (!ua) return "unknown"
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/.test(ua)) return "tablet"
  if (/iphone|ipod|android.*mobile|mobile|windows phone|blackberry|opera mini/.test(ua)) return "mobile"
  if (/windows nt|macintosh|x11|linux|cros/.test(ua)) return "desktop"
  return "unknown"
}

/** PURE — bot first (an empty browser string is not a phone camera), then a quick repeat by the same key, else a visit. */
export function classifyQrScan(input: { userAgent: string | null | undefined; lastSameVisitorScanAt?: string | null; nowMs?: number }): QrTrafficClass {
  const ua = (input.userAgent ?? "").trim()
  if (!ua || AUTOMATED_UA_RE.test(ua)) return "bot"
  const now = input.nowMs ?? Date.now()
  if (input.lastSameVisitorScanAt && now - new Date(input.lastSameVisitorScanAt).getTime() < QR_REPEAT_WINDOW_MS) return "repeat"
  return "human_likely"
}

export interface QrScanSummary {
  rawScans: number
  humanLikelyVisits: number
  botScans: number
  repeatScans: number
  /** Distinct (visitor key) among non-bot scans; the key is per code per UTC day, so this counts visitor-DAYS.
   *  null when no row carries a key (scans recorded before wave 152, or a code with tracking off). */
  uniqueVisitorDays: number | null
  /** Scans the landing form tied to a Contact who gave consent there (qr_scan_events.contact_id). */
  consentedSubmissions: number
  /** Scans recorded before classification existed — counted raw, never guessed into a class. */
  unclassified: number
}

/** PURE — the board's aggregate. Never invents a class for an unclassified row and never calls a scan a person. */
export function summarizeQrScans(rows: ReadonlyArray<{ traffic_class?: string | null; visitor_key?: string | null; contact_id?: string | null }>): QrScanSummary {
  let humanLikelyVisits = 0, botScans = 0, repeatScans = 0, consentedSubmissions = 0, unclassified = 0
  const keys = new Set<string>()
  let anyKey = false
  for (const r of rows) {
    if (r.traffic_class === "human_likely") humanLikelyVisits++
    else if (r.traffic_class === "bot") botScans++
    else if (r.traffic_class === "repeat") repeatScans++
    else unclassified++
    if (r.visitor_key) { anyKey = true; if (r.traffic_class !== "bot") keys.add(r.visitor_key) }
    if (r.contact_id) consentedSubmissions++
  }
  return { rawScans: rows.length, humanLikelyVisits, botScans, repeatScans, uniqueVisitorDays: anyKey ? keys.size : null, consentedSubmissions, unclassified }
}

/** PURE — the referring HOST only: a full referring URL can carry another site's query string (and its personal data).
 *  A bare host (a row recorded that way) is kept; anything unparsable is dropped. */
export function qrReferrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null
  try { return new URL(referrer).hostname.toLowerCase() || null } catch { return /^[a-z0-9.-]+$/i.test(referrer) ? referrer.toLowerCase() : null }
}

/** PURE — the coarse network a visitor key is built from: an IPv4 /24 or an IPv6 /48. The full address is never kept. */
export function coarseNetworkPrefix(ip: string | null | undefined): string {
  const v = (ip ?? "").trim()
  if (!v) return "none"
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split(".").slice(0, 3).join(".")
  if (v.includes(":")) return v.toLowerCase().split(":").slice(0, 3).join(":")
  return "none"
}

// ─── 7 · destination history (wave 152, lane 152C) ────────────────────────────

/** One entry of qr_codes.destination_history (m945). Entries are APPEND-ONLY (m945's trigger refuses a shrink or a
 *  rewrite); a printed code keeps its token across every version. */
export interface QrDestinationVersion {
  version: number
  target_url: string
  destination_type: string | null
  kind: "minted" | "legacy_initial" | "edited"
  changed_at: string
  changed_by_user_id: string | null
  reason: string | null
}

/** PURE — the next history after a destination change. A row minted before wave 152 has an empty history; its first
 *  edit records the URL it had as `legacy_initial` first, so the original destination is never lost. */
export function appendQrDestinationVersion(
  history: ReadonlyArray<QrDestinationVersion> | null | undefined,
  previous: { target_url: string; destination_type: string | null },
  next: { target_url: string; destination_type: string | null; changed_at: string; changed_by_user_id: string | null; reason: string | null },
): QrDestinationVersion[] {
  const out: QrDestinationVersion[] = Array.isArray(history) ? history.map((h) => ({ ...h })) : []
  if (out.length === 0) {
    out.push({ version: 1, target_url: previous.target_url, destination_type: previous.destination_type, kind: "legacy_initial", changed_at: next.changed_at, changed_by_user_id: null, reason: "destination before version history" })
  }
  const version = out.reduce((m, h) => Math.max(m, Number(h.version) || 0), 0) + 1
  out.push({ version, target_url: next.target_url, destination_type: next.destination_type, kind: "edited", changed_at: next.changed_at, changed_by_user_id: next.changed_by_user_id, reason: next.reason })
  return out
}
