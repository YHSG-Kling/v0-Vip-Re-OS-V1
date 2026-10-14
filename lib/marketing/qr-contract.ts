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
