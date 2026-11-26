import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * PRIVATE-DOCUMENT LINKS — SIGN ON READ (wave 154, lane 154M; open-loop rows 146A-SO-02 / 146Z-NC-02).
 *
 * The sensitive document buckets (offer-documents, transaction-documents, client-documents, documents, agent-documents …)
 * are deliberately NOT public (m278), so `getPublicUrl` returns a URL that 403s and a signed URL is the access primitive.
 *
 * WHAT CHANGED. Until wave 154 the signer defaulted to a TEN-YEAR lifetime because the write-time callers PERSISTED the
 * signed URL into a row (transaction_documents.storage_url, client_documents.document_url, offers.offer_document_url,
 * agent_licenses.document_url …). A stored bearer link keeps working for ten years after the person's access is revoked
 * and it bypasses every storage policy. The end-state this header used to promise is now the code:
 *
 *   · A ROW STORES A REFERENCE, never a link: `docref://<bucket>/<object path>` (toDocumentRef). It is not http(s), so a
 *     browser cannot open it and a server `fetch` refuses it — a reader that forgets to resolve it fails CLOSED.
 *   · ONE PARSER (parseDocumentRef) reads that spelling AND an old-style Supabase signed URL (backward compatibility without
 *     trust: bucket + path are extracted, the stored token is discarded and never served or forwarded).
 *   · A PERSON VIEWS through ONE same-origin door, `/api/documents/open?ref=…` (documentOpenHref → app/api/documents/open/
 *     route.ts → openDocumentReference below): tenant from the SESSION, the ROW located by its reference inside that tenant,
 *     the existing access rule for that row's kind applied, then a 302 to a signed URL that lives DOC_VIEW_TTL_SECONDS.
 *   · A SERVER-SIDE consumer that needs bytes or hands a link to a provider resolves at use time (resolveDocumentLink
 *     — the connector gateway's asset-download does that for every byte consumer) with the shortest lifetime that use needs.
 *   · The signer accepts no lifetime above DOC_LINK_TTL_CEILING_SECONDS; a caller asking for more is CLAMPED to it.
 *
 * TOMBSTONE (§1): `DOC_URL_TTL_SECONDS` (60·60·24·365·10, the ten-year write-time default) is DELETED. Survivors:
 * DOC_LINK_TTL_CEILING_SECONDS / DOC_VIEW_TTL_SECONDS below for a lifetime, toDocumentRef below for what a row stores.
 *
 * This module has NO runtime imports on purpose: the pure helpers are used by client components on hot pages, and the door
 * logic takes every query and rule as an injected dependency so the route wires them and a proof can drive them.
 */

// ─── lifetimes ───────────────────────────────────────────────────────────────

/**
 * THE CEILING — no signed link to a private document lives longer than one hour. One hour is the longest single legitimate
 * use in the tree: an e-sign provider or an AI extractor that receives a link and fetches it asynchronously
 * (lib/esign/dispatch-packet.ts already used 60·60). Every in-app view is shorter (DOC_VIEW_TTL_SECONDS), and anything that
 * needs the document later mints again through the door instead of holding a link.
 */
export const DOC_LINK_TTL_CEILING_SECONDS = 60 * 60

/** A person's click through the door: the browser follows the 302 at once; five minutes covers a slow PDF viewer. */
export const DOC_VIEW_TTL_SECONDS = 5 * 60

/** A server-side byte fetch that happens immediately after signing (extractors, comparisons). */
export const DOC_FETCH_TTL_SECONDS = 2 * 60

/** PURE. The lifetime the signer will actually request: positive integer, never above the ceiling (clamped, not trusted). */
export function clampDocLinkTtl(ttlSeconds: number | null | undefined): number {
  const n = typeof ttlSeconds === "number" && Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.floor(ttlSeconds) : DOC_VIEW_TTL_SECONDS
  return Math.min(Math.max(n, 1), DOC_LINK_TTL_CEILING_SECONDS)
}

type DocLinkResult = { ok: true; url: string; ttlSeconds: number | null } | { ok: false; reason: string }

/**
 * THE SIGNER. A short-lived signed URL for one object, or a refusal WITH ITS REASON — never a public fallback.
 * supabase-js RESOLVES a refusal (CLAUDE.md §3), so the error is read rather than reached past.
 */
export async function signDocumentLink(client: SupabaseClient, bucket: string, path: string, ttlSeconds?: number | null): Promise<DocLinkResult> {
  const ttl = clampDocLinkTtl(ttlSeconds)
  try {
    const { data, error } = await client.storage.from(bucket).createSignedUrl(path, ttl)
    if (error) return { ok: false, reason: `createSignedUrl refused for ${bucket}/${path}: ${error.message}` }
    if (!data?.signedUrl) return { ok: false, reason: `createSignedUrl returned no URL for ${bucket}/${path}` }
    return { ok: true, url: data.signedUrl, ttlSeconds: ttl }
  } catch (e) {
    return { ok: false, reason: `createSignedUrl threw for ${bucket}/${path}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** The "" -on-failure shape older callers guard on. Same signer, same ceiling; the default is a VIEW lifetime. */
export async function signedDocUrl(
  client: SupabaseClient,
  bucket: "offer-documents" | "transaction-documents" | "client-documents" | (string & {}),
  path: string,
  ttlSeconds: number = DOC_VIEW_TTL_SECONDS,
): Promise<string> {
  const r = await signDocumentLink(client, bucket, path, ttlSeconds)
  if (!r.ok) {
    console.error(`[storage] ${r.reason}`)
    return ""
  }
  return r.url
}

// ─── the ONE reference format and its ONE parser ─────────────────────────────

const DOC_REF_PREFIX = "docref://"
export const DOCUMENT_OPEN_PATH = "/api/documents/open"
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/
/** An old-style Supabase signed (or authenticated) object URL. The public layout is NOT a private reference. */
const LEGACY_SIGNED_RE = /^https?:\/\/[^/?#\s]+\/storage\/v1\/object\/(?:sign|authenticated)\/([^/?#\s]+)\/([^?#\s]+)/i

type DocumentRef = { bucket: string; path: string; legacy: boolean }
/** The door URL, absolute or relative; group 1 = the url-encoded `ref` parameter. */
const DOOR_URL_RE = /^(?:https?:\/\/[^/?#\s]+)?\/api\/documents\/open\?(?:[^#\s]*&)?ref=([^&#\s]+)/i

function decodePath(encoded: string): string | null {
  const segs = encoded.split("/")
  const out: string[] = []
  for (const s of segs) {
    let d: string
    try { d = decodeURIComponent(s) } catch { return null }
    if (!d || d === "." || d === ".." || /[\u0000-\u001f]/.test(d)) return null
    out.push(d)
  }
  return out.length > 0 ? out.join("/") : null
}

/** PURE. What a row stores for a private-bucket object: a stable, non-secret reference (bucket + object path). */
export function toDocumentRef(bucket: string, path: string): string {
  const clean = String(path ?? "").replace(/^\/+/, "")
  if (!BUCKET_RE.test(bucket) || !clean || decodePath(clean.split("/").map(encodeURIComponent).join("/")) === null) {
    throw new Error(`toDocumentRef: not a storable object reference (${bucket}/${clean})`)
  }
  return DOC_REF_PREFIX + bucket + "/" + clean.split("/").map(encodeURIComponent).join("/")
}

/**
 * PURE. THE ONE PARSER. A `docref://` reference, or an old-style signed URL (legacy: true — its token is discarded), → bucket +
 * path. Anything else (a public media URL, a data: URL, an external link, junk) → null.
 */
export function parseDocumentRef(value: unknown): DocumentRef | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  if (v.startsWith(DOC_REF_PREFIX)) {
    const rest = v.slice(DOC_REF_PREFIX.length)
    const i = rest.indexOf("/")
    if (i <= 0) return null
    const bucket = rest.slice(0, i)
    const enc = rest.slice(i + 1)
    if (!BUCKET_RE.test(bucket) || !enc || /[?#\s]/.test(enc)) return null
    const path = decodePath(enc)
    return path ? { bucket, path, legacy: false } : null
  }
  // The door's own spelling (absolute or relative): only the `ref` parameter is read — a grant beside it is not part of the reference.
  const door = DOOR_URL_RE.exec(v)
  if (door) {
    let inner = ""
    try { inner = decodeURIComponent(door[1]) } catch { return null }
    return inner.startsWith(DOC_REF_PREFIX) ? parseDocumentRef(inner) : null
  }
  const m = LEGACY_SIGNED_RE.exec(v)
  if (m) {
    const bucket = (() => { try { return decodeURIComponent(m[1]) } catch { return "" } })()
    const path = decodePath(m[2])
    return BUCKET_RE.test(bucket) && path ? { bucket, path, legacy: true } : null
  }
  return null
}

/**
 * PURE. THE READER HELPER: a stored value → what a page may put in an href / src.
 *   · a private reference (or a legacy signed URL) → the same-origin open door, `/api/documents/open?ref=docref://…`
 *     (sign-in required; the stored token of a legacy URL is never emitted);
 *   · anything else (a public media URL, a data: URL, an external link) passes through unchanged;
 *   · empty → null.
 */
export function documentOpenHref(value: string | null | undefined): string | null {
  if (!value) return null
  const ref = parseDocumentRef(value)
  if (!ref) return value
  return `${DOCUMENT_OPEN_PATH}?ref=${encodeURIComponent(toDocumentRef(ref.bucket, ref.path))}`
}

/** PURE. The door as an ABSOLUTE link — for an email or a notification a person opens outside the app (sign-in required). */
export function documentOpenUrl(value: string | null | undefined, origin: string): string | null {
  const href = documentOpenHref(value)
  if (!href || !href.startsWith(DOCUMENT_OPEN_PATH)) return href
  return `${origin.replace(/\/+$/, "")}${href}`
}

// ─── OUTSIDE RECIPIENTS: the share grant (round 2 of lane 154M) ─────────────────────────────────────────────────────
//
// A person with no seat (a lead who asked for a guide, an outside listing agent, an appraiser, a contact opening an emailed
// personal video) cannot pass a sign-in door. They get the SAME door with a SHARE GRANT: a server-sealed, expiring statement
// "this reference, this row, this purpose, this tenant[, this contact]" minted at SEND time. Sealed with the repo's existing
// authenticated envelope and secret (lib/security/secret-crypto.ts encryptSecret — AES-256-GCM under SECRETS_ENCRYPTION_KEY,
// rotation-aware through _PREVIOUS); no new secret. Without the key the mint FAILS CLOSED with its reason and the send reports
// it. The door honors a grant only for this CLOSED list of purposes, only for the row kinds each names, re-reads the row on
// every click (deleted / withdrawn / other tenant → the same 404) and still mints only a DOC_VIEW_TTL_SECONDS storage link.
// A grant never rides in a stored row: senders upgrade the OUTGOING body only (grantDoorLinksInText).

const DAY = 24 * 60 * 60
/**
 * The share purposes — a CLOSED allow-list — each with its lifetime (owner-adjustable defaults) and the row kinds it may open.
 * No deal document, W-9, license, commission agreement, CDA, receipt or any other custody kind is reachable by a grant.
 */
export const SHARE_GRANT_PURPOSES = {
  /** The outside listing agent reads an offer packet over days of negotiation — the 7 days the outbound email always had. */
  outside_offer_packet: { ttlSeconds: 7 * DAY, kinds: ["document"] },
  /** A licensed appraiser reviews the packet around one appraisal appointment — a week. */
  appraiser_packet: { ttlSeconds: 7 * DAY, kinds: ["generated_document"] },
  /** A lead magnet is marketing the lead asked for and re-opens at leisure — a month. */
  lead_magnet: { ttlSeconds: 30 * DAY, kinds: ["generated_document"] },
  /** A market report delivered to a lead — the same marketing horizon. */
  market_report: { ttlSeconds: 30 * DAY, kinds: ["generated_document"] },
  /** A book delivered to a lead — the same marketing horizon. */
  book: { ttlSeconds: 30 * DAY, kinds: ["generated_document"] },
  /** A personal video emailed to the ONE contact it is addressed to — a month, and only for that contact's row. */
  personal_video: { ttlSeconds: 30 * DAY, kinds: ["personal_video", "personal_video_thumbnail"] },
} as const
type SharePurpose = keyof typeof SHARE_GRANT_PURPOSES

/** The generated_documents a grant may name: by document_type, else by the producing source in metadata. */
const GENERATED_SHARE_PURPOSE_BY_TYPE: Record<string, SharePurpose> = { book: "book", market_report: "market_report", appraiser_packet: "appraiser_packet" }
const GENERATED_SHARE_PURPOSE_BY_SOURCE: Record<string, SharePurpose> = { lead_magnet_delivery: "lead_magnet", lead_magnet_funnel: "lead_magnet" }
function generatedSharePurpose(row: { document_type?: unknown; metadata?: unknown }): SharePurpose | null {
  const t = typeof row.document_type === "string" ? row.document_type : ""
  if (t in GENERATED_SHARE_PURPOSE_BY_TYPE) return GENERATED_SHARE_PURPOSE_BY_TYPE[t]
  const src = (row.metadata as { source?: unknown } | null)?.source
  return typeof src === "string" && src in GENERATED_SHARE_PURPOSE_BY_SOURCE ? GENERATED_SHARE_PURPOSE_BY_SOURCE[src] : null
}

/** The sealer the caller injects: lib/security/secret-crypto.ts { encryptSecret, decryptSecret, isEncrypted }. */
export type ShareGrantSealer = { seal: (plain: string) => string; open: (sealed: string) => string | null; isSealed: (v: string) => boolean }
type ShareGrant = { k: "doc-share-v1"; r: string; p: SharePurpose; b: string; i: string; c: string | null; e: number }

/** Mint a grant at SEND time. Fails closed with its reason (no secret configured, bad reference) — never a fallback link. */
export function mintDocumentShareGrant(
  sealer: ShareGrantSealer,
  input: { ref: string; purpose: SharePurpose; brokerageId: string; rowId: string; contactId?: string | null; now?: Date },
): { ok: true; grant: string; expiresAt: string } | { ok: false; reason: string } {
  const parsed = parseDocumentRef(input.ref)
  if (!parsed) return { ok: false, reason: "the value is not a private document reference" }
  if (!(input.purpose in SHARE_GRANT_PURPOSES) || !input.brokerageId || !input.rowId) return { ok: false, reason: "a share grant needs a listed purpose, a tenant and a row" }
  const exp = Math.floor((input.now ?? new Date()).getTime() / 1000) + SHARE_GRANT_PURPOSES[input.purpose].ttlSeconds
  const body: ShareGrant = { k: "doc-share-v1", r: toDocumentRef(parsed.bucket, parsed.path), p: input.purpose, b: input.brokerageId, i: input.rowId, c: input.contactId ?? null, e: exp }
  try {
    const grant = sealer.seal(JSON.stringify(body))
    if (!sealer.isSealed(grant)) return { ok: false, reason: "the share grant could not be sealed" }
    return { ok: true, grant, expiresAt: new Date(exp * 1000).toISOString() }
  } catch (e) {
    return { ok: false, reason: `the share grant could not be sealed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** PURE. The absolute door URL carrying a grant — what an email to an outside recipient contains. */
export function documentShareUrl(ref: string, grant: string, origin: string): string | null {
  const href = documentOpenHref(ref)
  if (!href || !href.startsWith(DOCUMENT_OPEN_PATH)) return null
  return `${origin.replace(/\/+$/, "")}${href}&g=${encodeURIComponent(grant)}`
}

/** Open and validate a presented grant against the presented reference. Anything off → null (the caller answers 404). */
function readShareGrant(sealer: ShareGrantSealer, raw: string, ref: DocumentRef, now: Date): ShareGrant | null {
  // An UNSEALED value is refused before opening: the envelope helper passes plaintext through verbatim (legacy secrets), so a
  // forged JSON grant would otherwise read as valid.
  if (!raw || !sealer.isSealed(raw)) return null
  let g: ShareGrant
  try {
    const plain = sealer.open(raw)
    if (!plain) return null
    g = JSON.parse(plain) as ShareGrant
  } catch { return null }
  if (!g || g.k !== "doc-share-v1" || !(g.p in SHARE_GRANT_PURPOSES) || typeof g.b !== "string" || !g.b || typeof g.i !== "string" || !g.i) return null
  if (typeof g.e !== "number" || g.e * 1000 <= now.getTime()) return null
  if (g.r !== toDocumentRef(ref.bucket, ref.path)) return null
  return g
}

/**
 * The SENDER's helper: upgrade every private reference / door link in an OUTGOING body. A row on the closed share list (in the
 * sender's tenant, and for a personal video addressed to `recipientContactId`) gets the grant URL; anything else becomes the
 * plain sign-in door URL — a raw `docref://` never leaves. A mint that fails (no secret) fails the whole body, so the send is
 * refused with the reason rather than going out with a link that cannot open.
 */
export async function grantDoorLinksInText(
  q: SupabaseClient<any, any, any>,
  text: string,
  opts: { brokerageId: string; recipientContactId?: string | null; sealer: ShareGrantSealer; origin: string; now?: Date },
): Promise<{ ok: true; text: string; granted: number } | { ok: false; reason: string }> {
  const TOKEN = /(?:https?:\/\/[^/?#\s"'<>]+)?\/api\/documents\/open\?ref=[^&#\s"'<>]+(?:&(?:amp;)?g=[^&#\s"'<>]*)?|docref:\/\/[^\s"'<>]+/g
  const found = [...new Set(text.match(TOKEN) ?? [])]
  let out = text
  let granted = 0
  for (const token of found) {
    const ref = parseDocumentRef(token.replace(/&(?:amp;)?g=[^&#\s"'<>]*$/, ""))
    if (!ref) continue
    const canonical = toDocumentRef(ref.bucket, ref.path)
    let share: { purpose: SharePurpose; rowId: string; contactId: string | null } | null = null
    const gen = await q.from("generated_documents").select("id, document_type, metadata").eq("brokerage_id", opts.brokerageId).eq("blob_url", canonical).limit(1)
    if (gen.error) return { ok: false, reason: `generated_documents could not be read: ${gen.error.message}` }
    const g0 = ((gen.data ?? []) as Array<{ id: string; document_type?: unknown; metadata?: unknown }>)[0]
    const gp = g0 ? generatedSharePurpose(g0) : null
    if (g0 && gp) share = { purpose: gp, rowId: g0.id, contactId: null }
    if (!share && opts.recipientContactId) {
      for (const column of ["video_url", "thumbnail_url"] as const) {
        const v = await q.from("ai_video_projects").select("id, contact_id").eq("brokerage_id", opts.brokerageId).eq(column, canonical).eq("contact_id", opts.recipientContactId).limit(1)
        if (v.error) return { ok: false, reason: `ai_video_projects could not be read: ${v.error.message}` }
        const v0 = ((v.data ?? []) as Array<{ id: string }>)[0]
        if (v0) { share = { purpose: "personal_video", rowId: v0.id, contactId: opts.recipientContactId }; break }
      }
    }
    let replacement: string | null
    if (share) {
      const minted = mintDocumentShareGrant(opts.sealer, { ref: canonical, purpose: share.purpose, brokerageId: opts.brokerageId, rowId: share.rowId, contactId: share.contactId, now: opts.now })
      if (!minted.ok) return { ok: false, reason: minted.reason }
      replacement = documentShareUrl(canonical, minted.grant, opts.origin)
      granted++
    } else replacement = documentOpenUrl(canonical, opts.origin)
    if (replacement) out = out.split(token).join(replacement)
  }
  return { ok: true, text: out, granted }
}

/**
 * A RENDER INPUT (Remotion props) may carry a stored reference (a personal avatar track). Resolve every `docref://` string in
 * it at render time to a signed link that lives the signer's ceiling — a render fetches its inputs within minutes, and a long
 * composition still finishes inside the hour. The persisted props keep the reference; only the props handed to the renderer
 * carry links. A refused signer refuses the render with its reason.
 */
export async function resolveDocumentRefsInProps<T>(client: SupabaseClient, props: T): Promise<{ ok: true; props: T } | { ok: false; reason: string }> {
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === "string") {
      if (!v.startsWith(DOC_REF_PREFIX)) return v
      const link = await resolveDocumentLink(client, v, DOC_LINK_TTL_CEILING_SECONDS)
      if (!link.ok) throw new Error(link.reason)
      return link.url
    }
    if (Array.isArray(v)) return Promise.all(v.map(walk))
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = await walk(x)
      return o
    }
    return v
  }
  try { return { ok: true, props: (await walk(props)) as T } } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) } }
}

// ─── server-side consumers: resolve at USE time ──────────────────────────────

/**
 * A server-side consumer that hands a link to a provider (an AI extractor, an e-sign service) resolves the stored value now,
 * with the lifetime that use needs (clamped to the ceiling). A non-reference http(s) value (public media, an external link)
 * passes through untouched; anything else is a refusal with its reason.
 */
export async function resolveDocumentLink(client: SupabaseClient, value: string | null | undefined, ttlSeconds: number): Promise<DocLinkResult> {
  const ref = parseDocumentRef(value)
  if (ref) return signDocumentLink(client, ref.bucket, ref.path, ttlSeconds)
  if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return { ok: true, url: value.trim(), ttlSeconds: null }
  return { ok: false, reason: "the row carries no resolvable document" }
}

// ─── THE OPEN DOOR (logic; app/api/documents/open/route.ts wires the session and the rules) ──────────────────────────

/** The session's identity, resolved by the route from auth.getUser() + users — never from the query string. */
/** @proofSeam scripts/document-links-sign-on-read-guard.ts builds actors for the executed door cases */
export type DocumentDoorActor = { userId: string; brokerageId: string; userType: string | null }

/**
 * Every (table, column) a private reference may be stored in, and what the access rule needs from the row. A reference
 * stored anywhere else is not openable through the door (fail closed: it answers "not available").
 */
/** @proofSeam scripts/document-links-sign-on-read-guard.ts derives the writer census's column list from it */
export const DOCUMENT_DOOR_KINDS = [
  { kind: "transaction_document", table: "transaction_documents", column: "storage_url", select: "id, brokerage_id, transaction_id, contact_id, uploaded_by, client_visible, doc_type, metadata" },
  { kind: "client_document", table: "client_documents", column: "document_url", select: "id, brokerage_id, transaction_id, contact_id, uploaded_by, client_visible" },
  { kind: "offer", table: "offers", column: "offer_document_url", select: "id, brokerage_id, transaction_id, contact_id, uploaded_by, agent_id" },
  { kind: "agent_license", table: "agent_licenses", column: "document_url", select: "id, brokerage_id, agent_id" },
  { kind: "agent_eo_certificate", table: "agent_licenses", column: "eo_certificate_url", select: "id, brokerage_id, agent_id" },
  { kind: "document", table: "documents", column: "storage_url", select: "id, brokerage_id, transaction_id, contact_id" },
  { kind: "generated_document", table: "generated_documents", column: "blob_url", select: "id, brokerage_id, transaction_id, contact_id, agent_id, document_type, metadata" },
  { kind: "personal_video", table: "ai_video_projects", column: "video_url", select: "id, brokerage_id, contact_id, agent_id" },
  { kind: "personal_video_thumbnail", table: "ai_video_projects", column: "thumbnail_url", select: "id, brokerage_id, contact_id, agent_id" },
  /** The weekly seller update reel (lib/agents/seller-update-reel-producer.ts) copies its render's output here — personal when addressed to the seller. */
  { kind: "seller_update_video", table: "seller_updates", column: "video_url", select: "id, brokerage_id, contact_id" },
  { kind: "seller_update_thumbnail", table: "seller_updates", column: "thumbnail_url", select: "id, brokerage_id, contact_id" },
  /** The portal contact's own profile photo (app/actions/portal-settings.ts uploadProfilePhoto): the contact, or their agent. */
  { kind: "contact_photo", table: "contacts", column: "avatar_url", select: "id, brokerage_id, contact_id:id, agent_id" },
  { kind: "agent_certificate", table: "agent_certifications", column: "certificate_url", select: "id, brokerage_id, agent_id" },
  { kind: "cda_pdf", table: "closing_disclosure_agreement", column: "generated_pdf_url", select: "id, brokerage_id, transaction_id, agent_id" },
  { kind: "brokerage_form", table: "brokerage_forms", column: "document_url", select: "id, brokerage_id, uploaded_by:created_by" },
  { kind: "cda_template", table: "brokerage_cda_templates", column: "pdf_url", select: "id, brokerage_id, uploaded_by" },
  /** The brokerage's books: the agent's own expense, or the finance readers (rules.financeReaderUserTypes) — never the whole roster. */
  { kind: "expense_receipt", table: "business_expenses", column: "receipt_url", select: "id, brokerage_id, agent_id" },
] as const

/**
 * Objects that have NO row (lib/kernel/board-packet.ts writes the monthly board packet and only notifies about it). The
 * tenant is the path's second segment; the rule is the tenant admin roster (the packet is the brokerage's financials, and
 * its notification goes to the brokerage's admins).
 */
const DOCUMENT_DOOR_PATH_KINDS = [
  { kind: "board_packet", bucket: "documents", prefix: "board-packets/" },
] as const

type DocumentDoorRow = {
  kind: (typeof DOCUMENT_DOOR_KINDS)[number]["kind"] | (typeof DOCUMENT_DOOR_PATH_KINDS)[number]["kind"]
  id: string
  brokerage_id: string | null
  transaction_id?: string | null
  contact_id?: string | null
  uploaded_by?: string | null
  client_visible?: boolean | null
  agent_id?: string | null
  doc_type?: string | null
  metadata?: unknown
}

/** The existing access rules, injected by the route (lib/auth/deal-work-ownership.ts, lib/kernel/portal-auth.ts). */
/** @proofSeam scripts/document-links-sign-on-read-guard.ts injects the real loadDealWorkAccess as dealRead */
export type DocumentDoorRules = {
  /** loadDealWorkAccess(...).access.capabilities.read for the session user on this deal. */
  dealRead: (transactionId: string) => Promise<{ ok: true; read: boolean } | { ok: false; error: string }>
  /** An external party's lane onto this deal (externalPartnerTransactionLane, or the plain vendor's assignment). */
  partnerLane: (transactionId: string) => Promise<{ ok: true; granted: boolean } | { ok: false; error: string }>
  /** TENANT_ADMIN_USER_TYPES (lib/auth/resolve-user-role.ts) — passed in, never retyped. */
  tenantAdminUserTypes: ReadonlySet<string>
  /** Who may READ the brokerage's books: BROKERAGE_FINANCE_ADMIN_USER_TYPES plus compliance_officer (m467 reads, never keeps). */
  financeReaderUserTypes: ReadonlySet<string>
  /** lib/kernel/deal-document-visibility.ts isClientVisibleDealDocument — passed in, never restated. */
  clientVisibleDealDocument: (doc: { client_visible?: boolean | null; uploaded_by?: string | null; doc_type?: string | null }, viewerUserId: string | null) => boolean
}

type Q = SupabaseClient<any, any, any>

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Locate the rows that store THIS object, inside the session's tenant only. Matches the canonical reference, and — for
 * backward compatibility — an old-style signed URL naming the same bucket + path (its token is never read).
 */
async function locateDocumentRows(q: Q, ref: DocumentRef, actor: DocumentDoorActor): Promise<{ ok: true; rows: DocumentDoorRow[] } | { ok: false; error: string }> {
  const canonical = toDocumentRef(ref.bucket, ref.path)
  const legacyPattern = `%/storage/v1/object/%/${escapeLike(ref.bucket)}/${escapeLike(ref.path.split("/").map(encodeURIComponent).join("/"))}?%`
  const rows: DocumentDoorRow[] = []
  for (const p of DOCUMENT_DOOR_PATH_KINDS) {
    const segs = ref.path.split("/")
    if (ref.bucket === p.bucket && ref.path.startsWith(p.prefix) && segs.length >= 3 && segs[1] === actor.brokerageId && !!actor.brokerageId) {
      rows.push({ kind: p.kind, id: ref.path, brokerage_id: segs[1] })
    }
  }
  for (const k of DOCUMENT_DOOR_KINDS) {
    const exact = await q.from(k.table).select(k.select).eq("brokerage_id", actor.brokerageId).eq(k.column, canonical).limit(20)
    if (exact.error) return { ok: false, error: `${k.table} could not be read: ${exact.error.message}` }
    let found = (exact.data ?? []) as unknown as Array<Omit<DocumentDoorRow, "kind">>
    if (found.length === 0) {
      const legacy = await q.from(k.table).select(k.select).eq("brokerage_id", actor.brokerageId).like(k.column, legacyPattern).limit(20)
      if (legacy.error) return { ok: false, error: `${k.table} could not be read: ${legacy.error.message}` }
      found = (legacy.data ?? []) as unknown as Array<Omit<DocumentDoorRow, "kind">>
    }
    for (const r of found) if (r.brokerage_id === actor.brokerageId) rows.push({ ...r, kind: k.kind })
  }
  return { ok: true, rows }
}

/**
 * THE ACCESS RULE for one located row, by the session's seat class. Fail closed: a read that cannot run is an error, never
 * a pass.
 *   · contact  — only their OWN rows (row.contact_id is a contact whose contact_user_id is the session), and only when the
 *                row is client-visible where the table carries that flag;
 *   · vendor   — (lenders and title are vendor categories, CLAUDE.md §4) only rows THEY uploaded, and on a deal only while
 *                their lane onto that deal still stands;
 *   · staff    — a row on a deal: exactly loadDealWorkAccess's `read` (so a reassigned agent loses the document on the next
 *                click); a row with no deal: their own upload, their own agent row (offers / licenses), their own contact's
 *                document, or the tenant admin roster.
 */
async function mayOpenDocumentRow(q: Q, row: DocumentDoorRow, actor: DocumentDoorActor, rules: DocumentDoorRules): Promise<{ ok: true; allowed: boolean } | { ok: false; error: string }> {
  if (!row.brokerage_id || row.brokerage_id !== actor.brokerageId) return { ok: true, allowed: false }
  const ut = String(actor.userType ?? "").toLowerCase()
  if (row.kind === "board_packet") return { ok: true, allowed: rules.tenantAdminUserTypes.has(ut) }

  if (ut === "contact") {
    const { data: mine, error: mineErr } = await q.from("contacts").select("id").eq("contact_user_id", actor.userId).eq("brokerage_id", actor.brokerageId).limit(50)
    if (mineErr) return { ok: false, error: `the contact link could not be read: ${mineErr.message}` }
    const myContacts = ((mine ?? []) as Array<{ id: string }>).map((c) => c.id)
    if (myContacts.length === 0) return { ok: true, allowed: false }
    // A DEAL document: the portal's own rule (lib/kernel/deal-document-visibility.ts isClientVisibleDealDocument — client-visible,
    // or the contact's own upload, never a hidden type) AND the contact is a party to that deal.
    if (row.kind === "transaction_document" && row.transaction_id) {
      if (!rules.clientVisibleDealDocument(row, actor.userId)) return { ok: true, allowed: false }
      const { data: tx, error: txErr } = await q.from("transactions").select("contact_id, buyer_contact_id, seller_contact_id").eq("id", row.transaction_id).eq("brokerage_id", actor.brokerageId).maybeSingle()
      if (txErr) return { ok: false, error: `the deal could not be read: ${txErr.message}` }
      const t = (tx ?? null) as { contact_id?: string | null; buyer_contact_id?: string | null; seller_contact_id?: string | null } | null
      return { ok: true, allowed: !!t && [t.contact_id, t.buyer_contact_id, t.seller_contact_id].some((c) => !!c && myContacts.includes(c)) }
    }
    // Their OWN row: addressed to one of their contacts; where the table carries a visibility switch, shown to the client or
    // their own upload.
    if (!row.contact_id || !myContacts.includes(row.contact_id)) return { ok: true, allowed: false }
    if ("client_visible" in row && row.client_visible !== true && row.uploaded_by !== actor.userId) return { ok: true, allowed: false }
    return { ok: true, allowed: true }
  }

  if (ut === "vendor") {
    // A DEAL document — EXACTLY the live row rule (m888 transaction_documents_party_select, read live 2026-11-19 by lane 155A):
    // document_party_on_deal(transaction_id) AND (uploaded_by = auth.uid() OR (doc_type = 'cda' AND
    // metadata->>'delivered_to_title_user_id' = auth.uid())). A lane onto the deal is NOT a pass to every file on it: the
    // party's own upload, or the CDA delivered to that title user — never the buyer's pre-approval or another party's file.
    if (row.kind === "transaction_document" && row.transaction_id) {
      const deliveredTo = (row.metadata as { delivered_to_title_user_id?: unknown } | null | undefined)?.delivered_to_title_user_id
      const ownOrDelivered = (!!row.uploaded_by && row.uploaded_by === actor.userId) || (row.doc_type === "cda" && deliveredTo === actor.userId)
      if (!ownOrDelivered) return { ok: true, allowed: false }
      const lane = await rules.partnerLane(row.transaction_id)
      if (!lane.ok) return lane
      return { ok: true, allowed: lane.granted }
    }
    if (!row.uploaded_by || row.uploaded_by !== actor.userId) return { ok: true, allowed: false }
    if (!row.transaction_id) return { ok: true, allowed: true }
    const lane = await rules.partnerLane(row.transaction_id)
    if (!lane.ok) return lane
    return { ok: true, allowed: lane.granted }
  }

  if (!ut) return { ok: true, allowed: false }
  if (row.transaction_id) {
    const deal = await rules.dealRead(row.transaction_id)
    if (!deal.ok) return deal
    return { ok: true, allowed: deal.read }
  }
  if (row.uploaded_by && row.uploaded_by === actor.userId) return { ok: true, allowed: true }
  if (row.kind === "expense_receipt" ? rules.financeReaderUserTypes.has(ut) : rules.tenantAdminUserTypes.has(ut)) return { ok: true, allowed: true }
  const { data: me, error: meErr } = await q.from("agents").select("id").eq("user_id", actor.userId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (meErr) return { ok: false, error: `the agent seat could not be read: ${meErr.message}` }
  const myAgentId = (me as { id?: string } | null)?.id ?? null
  if (!myAgentId) return { ok: true, allowed: false }
  if (row.agent_id && row.agent_id === myAgentId) return { ok: true, allowed: true }
  if (row.contact_id) {
    const { data: c, error: cErr } = await q.from("contacts").select("agent_id").eq("id", row.contact_id).eq("brokerage_id", actor.brokerageId).maybeSingle()
    if (cErr) return { ok: false, error: `the contact could not be read: ${cErr.message}` }
    return { ok: true, allowed: (c as { agent_id?: string | null } | null)?.agent_id === myAgentId }
  }
  return { ok: true, allowed: false }
}

type DocumentDoorAnswer =
  | { status: 302; location: string; ttlSeconds: number; kind: DocumentDoorRow["kind"] }
  | { status: 401; reason: "unauthenticated" }
  /** Unknown reference, another tenant's reference and a forbidden one are this SAME answer — no oracle. */
  | { status: 404; reason: "not_available" }
  /** A read or the signer refused: fail closed, no link, the reason for the server log. */
  | { status: 503; reason: string }

type DocumentDoorDeps = {
  actor: () => Promise<{ ok: true; actor: DocumentDoorActor } | { ok: false; reason: "unauthenticated" } | { ok: false; reason: "refused"; detail: string }>
  db: Q
  rules: DocumentDoorRules
  sign: (bucket: string, path: string, ttlSeconds: number) => Promise<DocLinkResult>
  /** Opens a presented share grant (lib/security/secret-crypto.ts). Absent → every grant is ignored. */
  sealer?: ShareGrantSealer
  now?: () => Date
}

const NOT_AVAILABLE: DocumentDoorAnswer = { status: 404, reason: "not_available" }

/**
 * THE OBJECT MUST BELONG TO THE ROW'S TENANT. A row's reference can arrive from a browser (the license page computes its own;
 * the CDA template upload round-trips through the client), so a seat could store `docref://<another tenant's object>` on its
 * OWN row and have the door sign it. Every writer in this tree builds its object path around a tenant-owned id — the brokerage
 * (`<brokerage>/…`, `client-docs/<brokerage>/…`), a deal (`transactions/<deal>/…`), a contact, a vendor, or the uploader's user
 * id (`<user>/license/…`). So the door signs only when the path names THIS tenant's brokerage id, or a UUID that is a
 * transaction, contact, vendor, user, agent, video project or listing OF THIS TENANT. A path with no tenant-owned id is refused
 * (fail closed — never a guess).
 */
const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
async function pathBoundToTenant(q: Q, path: string, brokerageId: string): Promise<{ ok: true; bound: boolean } | { ok: false; error: string }> {
  const ids = [...new Set((path.match(UUID_IN_PATH) ?? []).map((x) => x.toLowerCase()))]
  if (!brokerageId || ids.length === 0) return { ok: true, bound: false }
  if (ids.includes(brokerageId.toLowerCase())) return { ok: true, bound: true }
  for (const [table, column] of [["transactions", "id"], ["contacts", "id"], ["vendors", "id"], ["users", "id"], ["agents", "id"], ["ai_video_projects", "id"], ["listings", "id"]] as const) {
    const { data, error } = await q.from(table).select("id").in(column, ids).eq("brokerage_id", brokerageId).limit(1)
    if (error) return { ok: false, error: `the object's owner could not be read (${table}): ${error.message}` }
    if ((data ?? []).length > 0) return { ok: true, bound: true }
  }
  return { ok: true, bound: false }
}

/** Is the row a grant names STILL what the grant was minted for (re-read on every click)? */
function shareRowStillEligible(row: DocumentDoorRow & { document_type?: unknown; metadata?: unknown }, g: ShareGrant): boolean {
  if (row.id !== g.i || row.brokerage_id !== g.b || !(SHARE_GRANT_PURPOSES[g.p].kinds as readonly string[]).includes(row.kind)) return false
  if (row.kind === "generated_document") return generatedSharePurpose(row) === g.p
  if (row.kind === "personal_video" || row.kind === "personal_video_thumbnail") return !!g.c && row.contact_id === g.c
  return true
}

/**
 * ONE CLICK THROUGH THE DOOR. Nothing in the query string is trusted beyond locating the row: the reference is parsed, the
 * actor comes from the session, the row must exist inside the actor's tenant, the row's access rule must admit the actor,
 * and only then is a DOC_VIEW_TTL_SECONDS link signed. Nothing is persisted.
 * WITH A SHARE GRANT (an outside recipient, no session): the grant must open under the sealer, be unexpired, name THIS
 * reference, a listed purpose and a row that — re-read now, in the grant's tenant — is of a kind that purpose allows and still
 * eligible. A grant that does not open falls back to the session rule; with no session it is the same 404 as an unknown
 * reference (tampered, expired, wrong purpose, other tenant, deleted row — no oracle).
 */
export async function openDocumentReference(deps: DocumentDoorDeps, rawRef: string | null | undefined, rawGrant?: string | null): Promise<DocumentDoorAnswer> {
  const ref = parseDocumentRef(rawRef)
  if (rawGrant) {
    const g = ref && deps.sealer ? readShareGrant(deps.sealer, rawGrant, ref, deps.now?.() ?? new Date()) : null
    if (g && ref) {
      const located = await locateDocumentRows(deps.db, ref, { userId: "", brokerageId: g.b, userType: null })
      if (!located.ok) return { status: 503, reason: located.error }
      const row = located.rows.find((r) => shareRowStillEligible(r, g))
      const bound = row ? await pathBoundToTenant(deps.db, ref.path, g.b) : null
      if (bound && !bound.ok) return { status: 503, reason: bound.error }
      if (row && bound?.ok && bound.bound) {
        const signed = await deps.sign(ref.bucket, ref.path, DOC_VIEW_TTL_SECONDS)
        if (!signed.ok) return { status: 503, reason: signed.reason }
        return { status: 302, location: signed.url, ttlSeconds: signed.ttlSeconds ?? DOC_VIEW_TTL_SECONDS, kind: row.kind }
      }
    }
    const who = await deps.actor()
    if (!who.ok) return who.reason === "unauthenticated" ? NOT_AVAILABLE : { status: 503, reason: who.detail }
    return openForSession(deps, ref, who.actor)
  }
  const who = await deps.actor()
  if (!who.ok) return who.reason === "unauthenticated" ? { status: 401, reason: "unauthenticated" } : { status: 503, reason: who.detail }
  return openForSession(deps, ref, who.actor)
}

/**
 * IS THE SESSION'S SEAT STILL STANDING? A session token outlives a revocation (an access JWT lives up to an hour), so the door
 * re-reads the seat on EVERY click: the users row must exist in the actor's tenant, not be soft-deleted, and be `active`
 * (NULL reads active, as the database's own rule does); an agent seat deactivated in that tenant (every agents row of the user
 * there is_active = false) is refused. Mirrors public.brokerage_forms_seat_active() (m854, read live 2026-11-19) for the seat
 * standing it checks; the seat CLASS is left to each row's own rule. A read that cannot run fails CLOSED.
 */
async function seatStanding(q: Q, actor: DocumentDoorActor): Promise<{ ok: true; standing: boolean } | { ok: false; error: string }> {
  if (!actor.userId || !actor.brokerageId) return { ok: true, standing: false }
  const { data: u, error: uErr } = await q.from("users").select("id, status, deleted_at").eq("id", actor.userId).eq("brokerage_id", actor.brokerageId).maybeSingle()
  if (uErr) return { ok: false, error: `the session seat could not be read: ${uErr.message}` }
  const seat = (u ?? null) as { status?: string | null; deleted_at?: string | null } | null
  if (!seat || (seat.deleted_at ?? null) !== null || (seat.status ?? "active") !== "active") return { ok: true, standing: false }
  const { data: ag, error: aErr } = await q.from("agents").select("is_active").eq("user_id", actor.userId).eq("brokerage_id", actor.brokerageId).limit(20)
  if (aErr) return { ok: false, error: `the agent seat could not be read: ${aErr.message}` }
  const agentRows = (ag ?? []) as Array<{ is_active?: boolean | null }>
  if (agentRows.length > 0 && !agentRows.some((a) => a.is_active !== false)) return { ok: true, standing: false }
  return { ok: true, standing: true }
}

async function openForSession(deps: DocumentDoorDeps, ref: DocumentRef | null, actor: DocumentDoorActor): Promise<DocumentDoorAnswer> {
  if (!ref) return NOT_AVAILABLE
  const seat = await seatStanding(deps.db, actor)
  if (!seat.ok) return { status: 503, reason: seat.error }
  if (!seat.standing) return NOT_AVAILABLE
  const located = await locateDocumentRows(deps.db, ref, actor)
  if (!located.ok) return { status: 503, reason: located.error }
  if (located.rows.length === 0) return NOT_AVAILABLE
  const bound = await pathBoundToTenant(deps.db, ref.path, actor.brokerageId)
  if (!bound.ok) return { status: 503, reason: bound.error }
  if (!bound.bound) return NOT_AVAILABLE
  for (const row of located.rows) {
    const may = await mayOpenDocumentRow(deps.db, row, actor, deps.rules)
    if (!may.ok) return { status: 503, reason: may.error }
    if (!may.allowed) continue
    const signed = await deps.sign(ref.bucket, ref.path, DOC_VIEW_TTL_SECONDS)
    if (!signed.ok) return { status: 503, reason: signed.reason }
    return { status: 302, location: signed.url, ttlSeconds: signed.ttlSeconds ?? DOC_VIEW_TTL_SECONDS, kind: row.kind }
  }
  return NOT_AVAILABLE
}
