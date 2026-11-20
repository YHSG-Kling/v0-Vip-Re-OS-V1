/**
 * scripts/document-links-sign-on-read-guard.ts — wave 154, lane 154M (open-loop rows 146A-SO-02 / 146Z-NC-02).
 *
 * THE RULE: no row stores a bearer link to a private document. A row stores a `docref://<bucket>/<path>` reference
 * (lib/storage/signed-doc-url.ts toDocumentRef); a person views it only through the session-gated open door
 * (app/api/documents/open → openDocumentReference), which mints a link whose lifetime is at most the signer's ceiling
 * (DOC_LINK_TTL_CEILING_SECONDS); a server consumer resolves it at use time. SIMULATED throughout: fake Supabase clients that
 * COUNT every storage call; no provider, no network, no live database.
 *
 * CENSUS (stripped source via scripts/strip-comments.ts — a tombstone is not a call site; strings blanked where a specimen could
 * match), each finder with a POSITIVE CONTROL:
 *   C1  every TTL handed to createSignedUrl / signedDocUrl / signDocumentLink / resolveDocumentLink / issueBucketObjectUrl
 *       (ttlSeconds) / uploadBufferToBucket (signedTtlSeconds) in app/ + lib/ evaluates to ≤ the ceiling — constants are
 *       DERIVED from the tree's own `const NAME = <arithmetic>` declarations; a parameter TTL is admitted only inside the
 *       modules that clamp it (named below with the reason), never by count.
 *   C2  no writer persists signer output: every `.insert/.update/.upsert` object property whose value traces (in the same
 *       file) to a signer call or a `.signedUrl` is reported. The writer list is DERIVED (every write naming a column the door
 *       serves); its size is published, never pinned.
 *   C3  the retired constant DOC_URL_TTL_SECONDS appears nowhere as code in app/ lib/ scripts/.
 * EXECUTED (fakes): the real putAndSign → the stored value is a reference with no token and no link minted; the real door
 *   logic with the REAL loadDealWorkAccess as the deal rule: (a) the deal's owning agent → 302 ≤ ceiling; (b) another seat in
 *   the tenant without deal access → refused; (c) tenant B → refused, identical to an unknown reference; (d) the deal
 *   reassigned after upload → the owner is refused on the next click; (e) a legacy signed-URL value → served by path, its
 *   stored token never emitted; (f) a server consumer gets bytes through the resolver the gateway calls, with a ≤ DOC_FETCH_TTL_SECONDS link; (g) a refused signer is a
 *   503 with its reason — never a public fallback. Plus: the signer clamps a 10-year request; the issuer returns a reference
 *   for a persisting writer and a short link only when a lifetime is asked for.
 * BLIND SPOTS (published): C2 traces identifiers within ONE file (a signed URL passed through a helper in another file and
 *   written there is not traced); a computed TTL inside a parameter-TTL module is trusted to that module's clamp (which the
 *   executed section proves); readers are not censused (a page rendering a stored reference without documentOpenHref shows a
 *   dead `docref://` link — fail closed, never a leak); objects with neither a door row kind nor a path kind answer 404.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments, blankStrings, stringLiterals } from "./strip-comments"
const stringLiteralsOf = (src: string): string[] => stringLiterals(src).map((l) => l.text)
import {
  DOC_LINK_TTL_CEILING_SECONDS, DOC_VIEW_TTL_SECONDS, DOC_FETCH_TTL_SECONDS, DOCUMENT_DOOR_KINDS,
  toDocumentRef, parseDocumentRef, documentOpenHref, signDocumentLink, resolveDocumentLink,
  openDocumentReference, type DocumentDoorActor, type DocumentDoorRules,
  SHARE_GRANT_PURPOSES, mintDocumentShareGrant, documentShareUrl, grantDoorLinksInText, resolveDocumentRefsInProps,
} from "../lib/storage/signed-doc-url"
import { encryptSecret, decryptSecret, isEncrypted } from "../lib/security/secret-crypto"
import { isClientVisibleDealDocument } from "../lib/kernel/deal-document-visibility"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { putAndSign } from "../lib/storage/put-and-sign"
import { issueBucketObjectUrl } from "../lib/storage/document-buckets"
import { loadDealWorkAccess } from "../lib/auth/deal-work-ownership"
import { TENANT_ADMIN_USER_TYPES, BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "../lib/auth/resolve-user-role"
import { signedUrlTtlFor } from "../lib/kernel/document-custody"
import { classifyPublicVideo, PUBLIC_MARKETING_VIDEO_TYPES } from "../lib/video/public-video"
import { renderHostBucketFor } from "../lib/remotion/media-host"
import { isDocumentClassBucket } from "../lib/storage/document-buckets"

const root = process.cwd()
let failures = 0
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`); if (!ok) failures++ }
const control = (name: string, ok: boolean) => check(`POSITIVE CONTROL: ${name}`, ok)

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
  return out
}
const files = [...walk(join(root, "app")), ...walk(join(root, "lib"))].map((p) => relative(root, p))
const code = new Map<string, string>()
for (const f of files) code.set(f, blankStrings(stripComments(readFileSync(join(root, f), "utf8"))))

// ── C1 · TTL census ───────────────────────────────────────────────────────────────────────────────────────────────────
console.log("\n[C1 · every signed-link lifetime in app/ + lib/ is at most the ceiling]")
const CONSTS: Record<string, number> = {}
const constRe = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*number\s*)?=\s*([\d\s*+()_]+)(?=[\n;])/g
for (const src of code.values()) for (const m of src.matchAll(constRe)) {
  const expr = m[2].replace(/_/g, "").trim()
  if (/^[\d\s*+()]+$/.test(expr) && /\d/.test(expr)) { try { CONSTS[m[1]] = Function(`return (${expr})`)() as number } catch { /* not arithmetic */ } }
}
// An imported alias (`import { FORM_PACKET_PREVIEW_TTL_SECONDS as FORM_URL_TTL_SECONDS }`) takes its source constant's value.
for (const src of code.values()) for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]*)\s+as\s+([A-Z][A-Z0-9_]*)\b/g)) if (m[1] in CONSTS && !(m[2] in CONSTS)) CONSTS[m[2]] = CONSTS[m[1]]
function ttlOf(expr: string): number | null {
  let e = expr.trim().replace(/_/g, "")
  e = e.replace(/\b[A-Z][A-Z0-9]*\b/g, (n) => {
    const k = Object.keys(CONSTS).find((c) => c.replace(/_/g, "") === n)
    return k !== undefined ? String(CONSTS[k]) : n
  })
  if (!/^[\d\s*+()]+$/.test(e) || !/\d/.test(e)) return null
  try { return Function(`return (${e})`)() as number } catch { return null }
}
/** Modules whose TTL is a PARAMETER bounded by construction (each reason is executed below or is a clamp in the signer). */
const PARAMETER_TTL_OK: Record<string, string> = {
  "lib/storage/signed-doc-url.ts": "the signer: every lifetime passes clampDocLinkTtl (executed: a 10-year request is clamped)",
  "lib/storage/document-buckets.ts": "the issuer: clampDocLinkTtl before signedDocUrl",
  "lib/kernel/document-custody.ts": "signedUrlTtlFor(purpose) — every purpose is checked ≤ the ceiling below",
  "lib/storage/buckets.ts": "uploadBufferToBucket forwards its caller's signedTtlSeconds to the issuer, which clamps",
  "app/api/documents/open/route.ts": "the door: sign(bucket, path, ttlSeconds) receives DOC_VIEW_TTL_SECONDS from openDocumentReference",
  "lib/agentic-os/connector-gateway.ts": "resolves with DOC_FETCH_TTL_SECONDS",
}
type Site = { file: string; fn: string; expr: string; ttl: number | null }
function ttlSites(file: string, src: string): Site[] {
  const out: Site[] = []
  for (const m of src.matchAll(/\.createSignedUrl\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*([^)]+?)\s*\)/g)) out.push({ file, fn: "createSignedUrl", expr: m[1], ttl: ttlOf(m[1]) })
  for (const m of src.matchAll(/\b(signedDocUrl|signDocumentLink)\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^)]+?)\s*\)/g)) out.push({ file, fn: m[1], expr: m[2], ttl: ttlOf(m[2]) })
  for (const m of src.matchAll(/\bresolveDocumentLink\(\s*[^,]+,\s*[^,]+,\s*([^)]+?)\s*\)/g)) out.push({ file, fn: "resolveDocumentLink", expr: m[1], ttl: ttlOf(m[1]) })
  for (const m of src.matchAll(/\b(?:issueBucketObjectUrl|uploadBufferToBucket)\([\s\S]{0,300}?\b(?:ttlSeconds|signedTtlSeconds)\s*:\s*([^,}\n]+)/g)) out.push({ file, fn: "issueBucketObjectUrl/uploadBufferToBucket", expr: m[1], ttl: ttlOf(m[1]) })
  return out
}
const sites = [...code.entries()].flatMap(([f, s]) => ttlSites(f, s))
const over = sites.filter((s) => s.ttl !== null && s.ttl > DOC_LINK_TTL_CEILING_SECONDS)
const unresolved = sites.filter((s) => s.ttl === null && !(s.file in PARAMETER_TTL_OK))
console.log(`    (published) ${sites.length} lifetime site(s) across ${new Set(sites.map((s) => s.file)).size} file(s); ${sites.filter((s) => s.ttl !== null).length} evaluated from the tree's own constants, ${sites.filter((s) => s.ttl === null && s.file in PARAMETER_TTL_OK).length} parameter TTLs inside ${Object.keys(PARAMETER_TTL_OK).length} clamping modules; ceiling ${DOC_LINK_TTL_CEILING_SECONDS}s`)
check("C1 no call site asks for a signed link above the ceiling", over.length === 0, over.map((s) => `${s.file}:${s.fn}=${s.expr}`).join(", "))
check("C1 every lifetime outside the clamping modules resolves to a number (nothing unmeasured)", unresolved.length === 0, unresolved.map((s) => `${s.file}:${s.fn}=${s.expr}`).join(", "))
check("C1 the census sees real sites (the form-packet door, the share-link view, the e-sign hand-off)", sites.some((s) => s.file === "lib/forms/tenant-form-packets.ts") && sites.some((s) => s.file === "app/actions/dotloop-integration.ts") && sites.some((s) => s.file === "lib/workflow/adapters/send-for-esign.ts"))
check("C1 every custody purpose sits at or under the ceiling", ["view", "download", "share", "compliance_export", "analysis"].every((p) => signedUrlTtlFor(p) <= DOC_LINK_TTL_CEILING_SECONDS))
control("the TTL finder reads a 10-year request as over the ceiling", ttlSites("specimen.ts", `await svc.storage.from(b).createSignedUrl(p, 60 * 60 * 24 * 365 * 10)`).some((s) => (s.ttl ?? 0) > DOC_LINK_TTL_CEILING_SECONDS)
  && ttlSites("specimen.ts", `await signedDocUrl(svc, b, p, 7 * 86_400)`).some((s) => (s.ttl ?? 0) > DOC_LINK_TTL_CEILING_SECONDS)
  && ttlSites("specimen.ts", `await issueBucketObjectUrl(svc, { bucket: b, objectPath: p, ttlSeconds: 60 * 60 * 24 * 365 })`).some((s) => (s.ttl ?? 0) > DOC_LINK_TTL_CEILING_SECONDS))

// ── C2 · no writer persists signer output ─────────────────────────────────────────────────────────────────────────────
console.log("\n[C2 · no writer persists a signed link into a row]")
const DOOR_COLUMNS = [...new Set(DOCUMENT_DOOR_KINDS.map((k) => k.column))]
const SIGNER = /\b(signedDocUrl|signDocumentLink|resolveDocumentLink)\(|\.createSignedUrl\(|\.signedUrl\b|\bttlSeconds\s*:/
function balancedArg(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) { const c = src[i]; if (c === "(" || c === "{" || c === "[") depth++; else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) return src.slice(open, i + 1) } }
  return src.slice(open)
}
type Write = { file: string; column: string; value: string; signed: boolean }
function writesIn(file: string, src: string): Write[] {
  const out: Write[] = []
  const bindings = new Map<string, string[]>()
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^\n;]+)/g)) bindings.set(m[1], [...(bindings.get(m[1]) ?? []), m[2]])
  for (const m of src.matchAll(/(?<![=!<>])\b([A-Za-z_$][\w$]*)\s*=\s*(?!=)([^\n;]+)/g)) bindings.set(m[1], [...(bindings.get(m[1]) ?? []), m[2]])
  // `issued.url` from an issuer call that asked for a lifetime is a signed link; without one it is a reference.
  const signedIssuers = new Set<string>()
  for (const m of src.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+issueBucketObjectUrl\(([^)]*)\)/g)) if (/ttlSeconds\s*:/.test(m[2])) signedIssuers.add(m[1])
  const tracesToSigner = (expr: string, depth = 0): boolean => {
    if (SIGNER.test(expr)) return true
    for (const id of signedIssuers) if (new RegExp(`\\b${id}\\.url\\b`).test(expr)) return true
    if (depth > 3) return false
    const ids = expr.match(/^[\s(]*([A-Za-z_$][\w$]*)/)
    const id = ids?.[1]
    if (!id || ["null", "undefined", "true", "false"].includes(id)) return false
    return (bindings.get(id) ?? []).some((rhs) => tracesToSigner(rhs, depth + 1))
  }
  for (const m of src.matchAll(/\.(insert|update|upsert)\(/g)) {
    const arg = balancedArg(src, m.index! + m[0].length - 1)
    for (const col of DOOR_COLUMNS) {
      for (const p of arg.matchAll(new RegExp(`\\b${col}\\s*:\\s*([^,}\\n]+)`, "g"))) out.push({ file, column: col, value: p[1].trim(), signed: tracesToSigner(p[1]) })
    }
  }
  return out
}
const writes = [...code.entries()].flatMap(([f, s]) => writesIn(f, s))
const persisted = writes.filter((w) => w.signed)
console.log(`    (published) ${writes.length} write(s) of a door column (${DOOR_COLUMNS.join(", ")}) across ${new Set(writes.map((w) => w.file)).size} file(s) — derived, not pinned`)
check("C2 no write stores a value that traces to the signer", persisted.length === 0, persisted.map((w) => `${w.file}:${w.column}=${w.value}`).join(", "))
check("C2 the writer census sees the upload doors it exists for (putAndSign callers write stored.ref)", writes.some((w) => w.value === "stored.ref") || writes.some((w) => /^(storageUrl|documentUrl|publicUrl)$/.test(w.value)))
const putCallers = [...code.entries()].filter(([f, s]) => f !== "lib/storage/put-and-sign.ts" && /\bputAndSign\(/.test(s)).map(([f]) => f)
const readsSigned = putCallers.filter((f) => /\bstored\.signedUrl\b/.test(code.get(f)!))
check(`C2 no putAndSign caller reads a signed URL off it (${putCallers.length} callers, derived)`, putCallers.length > 0 && readsSigned.length === 0, readsSigned.join(","))
control("the writer finder sees a signed URL written into a row (direct, through a binding, and through a lifetime-bearing issuer)",
  writesIn("s.ts", `const url = await signedDocUrl(svc, b, p, 60)\nawait svc.from("offers").insert({ offer_document_url: url })`).some((w) => w.signed)
  && writesIn("s.ts", `await svc.from("transaction_documents").insert({ storage_url: stored.signedUrl })`).some((w) => w.signed)
  && writesIn("s.ts", `const issued = await issueBucketObjectUrl(svc, { bucket: "documents", objectPath: p, ttlSeconds: 600 })\nawait svc.from("documents").update({ storage_url: issued.url })`).some((w) => w.signed)
  && !writesIn("s.ts", `const issued = await issueBucketObjectUrl(svc, { bucket: "documents", objectPath: p })\nawait svc.from("documents").update({ storage_url: issued.url })`).some((w) => w.signed)
  && !writesIn("s.ts", `await svc.from("transaction_documents").insert({ storage_url: stored.ref })`).some((w) => w.signed))

// ── C3 · the retired constant ─────────────────────────────────────────────────────────────────────────────────────────
console.log("\n[C3 · the ten-year constant is gone]")
const scriptFiles = walk(join(root, "scripts")).map((p) => relative(root, p)).filter((f) => f !== "scripts/document-links-sign-on-read-guard.ts")
const OLD = /\bDOC_URL_TTL_SECONDS\b/
const stillCode = [...files, ...scriptFiles].filter((f) => OLD.test(code.get(f) ?? blankStrings(stripComments(readFileSync(join(root, f), "utf8")))))
check("C3 DOC_URL_TTL_SECONDS appears nowhere as code (app/, lib/, scripts/)", stillCode.length === 0, stillCode.join(","))
control("the finder sees the constant in a specimen import, and not in a tombstone comment", OLD.test(blankStrings(stripComments(`import { DOC_URL_TTL_SECONDS } from "@/lib/storage/signed-doc-url"`))) && !OLD.test(blankStrings(stripComments(`// TOMBSTONE: DOC_URL_TTL_SECONDS deleted`))))

// ── C4 · THE READER CENSUS — every place a door column reaches a link or a fetch ─────────────────────────────────────
console.log("\n[C4 · every stored reference that reaches a link or a fetch passes the ONE helper (or a named exception)]")
const camel = (c: string) => c.replace(/_([a-z])/g, (_m, x: string) => x.toUpperCase())
const DOOR_TABLE_OF = new Map<string, string[]>()
for (const k of DOCUMENT_DOOR_KINDS) DOOR_TABLE_OF.set(k.column, [...(DOOR_TABLE_OF.get(k.column) ?? []), k.table])
// DERIVED: a door column whose NAME also exists on a table outside the door (scripts/schema-snapshot.ts — the live schema) also
// holds public media there, so it is enforced only in files that name its door table. Every other door column is enforced everywhere.
const doorTables = new Set<string>(DOCUMENT_DOOR_KINDS.map((k) => k.table))
const SHARED_COLUMNS = [...DOOR_TABLE_OF.keys()].filter((c) => Object.entries(SCHEMA_SNAPSHOT).some(([t, cols]) => !doorTables.has(t) && cols.includes(c)))
const UNIQUE_COLUMNS = [...DOOR_TABLE_OF.keys()].filter((c) => !SHARED_COLUMNS.includes(c))
const HELPER = /\b(documentOpenHref|documentOpenUrl|documentShareUrl|resolveDocumentLink|grantDoorLinksInText|resolveDocumentRefsInProps)\b/
const SITE_RES: Array<[string, RegExp]> = [
  ["href/src", /\b(?:href|src|poster)=\{([^}]*)\}/g],
  ["window.open", /window\.open\(([^)]*)\)/g],
  ["fetch", /\bfetch\(([^)]*)\)/g],
  ["url-prop", /\b(?:url|fileUrl|formUrl|pdfUrl|documentUrl|sourceUrl|file_url|mediaUrl)\s*:\s*([^,}\n]+)/g],
  // Wave 155 (lane 155K2): a media PLAYER takes its source as a JSX `url={…}` prop (CardVideoPlayer) — the census was blind to it.
  ["jsx-url", /\burl=\{([^}]*)\}/g],
]
type ReaderSite = { file: string; kind: string; expr: string; wrapped: boolean }
function readerSites(file: string, code: string, rawSrc: string): ReaderSite[] {
  const sharedHere = SHARED_COLUMNS.filter((c) => (DOOR_TABLE_OF.get(c) ?? []).some((t) => rawSrc.includes(t)))
  const toks = [...UNIQUE_COLUMNS, ...UNIQUE_COLUMNS.map(camel), ...sharedHere, ...sharedHere.map(camel)]
  if (toks.length === 0) return []
  const tok = new RegExp(`\\b(${toks.join("|")})\\b`)
  const out: ReaderSite[] = []
  for (const [kind, re] of SITE_RES) for (const m of code.matchAll(re)) if (tok.test(m[1])) out.push({ file, kind, expr: m[1].trim(), wrapped: HELPER.test(m[1]) })
  return out
}
/** Each exception: file + a fragment of the expression, and WHY the value there is not a stored private reference. */
const UPSTREAM = (where: string) => `UPSTREAM — the value was already passed through the ONE helper at ${where}`
const PUBLIC_RULE = "PUBLIC — a render not addressed to a contact is public media by rule (lib/remotion/media-host.ts:63-67 renderHostBucketFor; lib/video/public-video.ts:94 refuses a contact-addressed video)"
const GATEWAY = "GATEWAY — handed to callConnector asset-download, which resolves a docref:// at use (lib/agentic-os/connector-gateway.ts)"
const READER_EXCEPTIONS: Array<{ file: string; frag: string; why: string }> = [
  { file: "app/actions/transaction-document-signatures.ts", frag: "storage_url", why: "GATEWAY — lib/esign/dispatch-packet.ts fetches each document through callConnector asset-download, which resolves at use" },
  { file: "app/actions/onboarding/license.ts", frag: "documentUrl", why: "TEXT — the reference is named in the verifier's prompt text; nothing fetches or renders it" },
  { file: "app/api/cron/listing-promo-hybrid-composite/route.ts", frag: "video_url", why: PUBLIC_RULE },
  { file: "app/v/[slug]/page.tsx", frag: "thumbnail_url", why: PUBLIC_RULE },
  { file: "app/vendor/documents/w9-card.tsx", frag: "documentUrl", why: UPSTREAM("lib/vendors/w9.ts (documentUrl: documentOpenHref(row?.document_url))") },
  { file: "app/dashboard/videos/board/page.tsx", frag: "video_url", why: UPSTREAM("the same file (viewableVideo at every load / realtime merge)") },
  { file: "app/dashboard/videos/components/BrollPicker.tsx", frag: "_url", why: "PUBLIC — the brokerage's stock intro / outro / b-roll library (lib/remotion/stock-pick.ts), never addressed to a contact" },
  { file: "app/dashboard/videos/create/video-create-client.tsx", frag: "thumbnail_url", why: "PUBLIC — avatar / stock asset thumbnails, never addressed to a contact" },
  { file: "app/dashboard/marketing/studio/marketing-studio-client.tsx", frag: "_url", why: PUBLIC_RULE },
  { file: "app/dashboard/documents/library/generated-library-client.tsx", frag: "blobUrl", why: UPSTREAM("app/actions/generated-documents.ts (blobUrl: documentOpenHref(d.blob_url))") },
  { file: "lib/orchestrator/internal.ts", frag: "video_url", why: PUBLIC_RULE },
  { file: "lib/kernel/document-autofile.ts", frag: "document_url", why: "PARSE — handed to the storage mover, which reads it with parseBucketObjectPath (delegates to the ONE parser)" },
  { file: "lib/kernel/document-compliance-audit.ts", frag: "document_url", why: "GATEWAY — OCR goes through callConnector asset-download; the vision hand-off resolves with resolveDocumentLink (same file)" },
  { file: "lib/repurpose/actions.ts", frag: "video_url", why: "GATEWAY — the repurpose transcription fetches media through callConnector asset-download (lib/repurpose/transcribe-core.ts)" },
  { file: "lib/esign/addendum-signature-request.ts", frag: "storageUrl", why: "MINTED — the documentUrl dep (same file) mints at use through the ONE parser + issuer" },
  { file: "lib/workflow/adapters/send-for-esign.ts", frag: "storage_url", why: GATEWAY },
  { file: "lib/did/result-url-rehost-sweep.ts", frag: "_url", why: "VENDOR — the sweep re-hosts rows still carrying the provider's own result URL; a docref:// row is already ours" },
  { file: "lib/video/plan-asset-readiness.ts", frag: "video_url", why: "PUBLIC — a stock asset (lib/remotion/stock-pick.ts)" },
  { file: "lib/lead-magnets/promised-deliverables.ts", frag: "blob_url", why: "STORED — the delivery EVIDENCE keeps the grant-free reference; the outgoing body is upgraded by grantDoorLinksInText (same file)" },
  { file: "lib/documents/ocr-pdf.ts", frag: "storageUrl", why: GATEWAY },
  { file: "lib/ads/ctv-campaign.ts", frag: "video_url", why: PUBLIC_RULE },
  { file: "app/components/ai-identity/AIIdentityEditor.tsx", frag: "avatarUrl", why: "PUBLIC — the agent's own avatar (agent-media, a PUBLIC_MEDIA_BUCKETS entry in lib/storage/document-buckets.ts)" },
  { file: "app/dashboard/marketing/podcast/components/create-episode-dialog.tsx", frag: "thumbnailUrl", why: "PUBLIC — a podcast episode's cover (published media)" },
  { file: "app/dashboard/videos/board/page.tsx", frag: "thumbnailUrl", why: "VENDOR — the provider's thumbnail in video_metadata / provider_metadata, not the stored column (the columns pass viewableVideo, same file)" },
  { file: "app/dashboard/videos/create/video-create-client.tsx", frag: "thumbnailUrl", why: "PUBLIC — stock backgrounds, never addressed to a contact" },
  { file: "app/lm/[slug]/page.tsx", frag: "videoUrl", why: "PUBLIC — a landing video is published only after stagedPublicationVerdict(…, 'landing_page') (lib/video/video-staging.ts), which refuses a video addressed to a contact (lib/video/public-video.ts:94)" },
  { file: "app/portal/[contactId]/components/seller-mode/agent-update-video-card.tsx", frag: "thumbnailUrl", why: UPSTREAM("app/portal/[contactId]/listing/page.tsx (thumbnailUrl: documentOpenHref(latestUpdate.thumbnail_url))") },
  { file: "app/portal/[contactId]/components/seller-mode/agent-update-video-card.tsx", frag: "latestUpdate.videoUrl", why: UPSTREAM("app/portal/[contactId]/listing/page.tsx (videoUrl: documentOpenHref(latestUpdate.video_url)) — the player url={…} prop, seen since wave 155") },
  { file: "lib/did/index.ts", frag: "videoUrl", why: "VENDOR — D-ID's own result URL, downloaded and re-hosted (never a stored reference)" },
]
const rawOf = new Map<string, string>()
for (const f of files) rawOf.set(f, readFileSync(join(root, f), "utf8"))
const readers = [...code.entries()].flatMap(([f, s]) => readerSites(f, s, rawOf.get(f) ?? ""))
const excused = (r: ReaderSite) => READER_EXCEPTIONS.find((e) => e.file === r.file && r.expr.includes(e.frag))
const bare = readers.filter((r) => !r.wrapped && !excused(r))
// ── C5 · SHARED MEDIA NAMES (wave 155, lane 155K2 — directive item 7; was "REPORTED, NOT ENFORCED" through d2d6468c) ────────
// A shared column's camelCase spelling (videoUrl, avatarUrl, thumbnailUrl, documentUrl, certificateUrl, pdfUrl) in a file that never
// names its door table is ALSO an ordinary public-media prop, so a blanket ban would be wrong. Instead EVERY such site carries a
// CLASS with the file:line that proves it; an UNCLASSIFIED site is RED (it may be protected media about or for a Contact). On a
// CONTACT-FACING surface (CONTACT_ROOTS) only a door-proven class is accepted, and PUBLIC must cite one of the named public rules.
//   UPSTREAM — the value was minted by the door helper (or a per-read signer) at `at`; PUBLIC — public media by a named rule;
//   AGENT — the agent's OWN likeness / photo (agent media), never a contact's; VENDOR — a provider's own result URL, re-hosted or
//   shown to the authoring staff seat; GATEWAY — fetched server-side through callConnector asset-download (resolves at use);
//   INPUT — a link a staff seat TYPED, stored as given (not a reference of ours); SHORT — a link issued for the requesting seat and
//   never stored; STORED — delivery evidence keeps the grant-free reference; the outgoing body is upgraded at `at`.
type MediaClass = "UPSTREAM" | "PUBLIC" | "AGENT" | "VENDOR" | "GATEWAY" | "INPUT" | "SHORT" | "STORED"
const CONTACT_ROOTS = ["app/portal/", "app/vendor/", "app/client/"]
const CONTACT_OK: ReadonlySet<MediaClass> = new Set<MediaClass>(["UPSTREAM", "SHORT", "PUBLIC"])
/** The public rules a PUBLIC site on a contact-facing surface may cite (each is the code that makes the media public). */
const PUBLIC_RULES = ["lib/video/public-video.ts", "lib/remotion/media-host.ts", "lib/storage/document-buckets.ts", "lib/application/transactions.ts"]
const P_DOC = "lib/documents/client-document-producer.ts:127"
const MEDIA_SITE_CLASSES: Array<{ file: string; frag: string; cls: MediaClass; at: string }> = [
  { file: "app/actions/commission-policy/agreements.ts", frag: "input.documentUrl", cls: "INPUT", at: "app/dashboard/financials/agreements/agreement-governance-panel.tsx:167" },
  { file: "app/actions/kernel-bridges.ts", frag: "produced.pdfUrl", cls: "UPSTREAM", at: P_DOC },
  { file: "app/actions/reporting-kernel.ts", frag: "pdfResult.data.pdfUrl", cls: "SHORT", at: "lib/kernel/reporting.ts:1118" },
  { file: "app/actions/transaction-milestones.ts", frag: "res.pdfUrl", cls: "UPSTREAM", at: "lib/kernel/appraiser-packet.ts:890" },
  { file: "app/actions/vendor-verification.ts", frag: "certificateUrl", cls: "INPUT", at: "app/actions/vendor-verification.ts:176" },
  { file: "app/components/features/education/EducationEditor.tsx", frag: "videoUrl", cls: "VENDOR", at: "app/components/features/education/EducationEditor.tsx:310" },
  { file: "app/components/features/lead-magnets/BookProjectPanel.tsx", frag: "pdfUrl", cls: "UPSTREAM", at: P_DOC },
  { file: "app/components/features/offers/offer-document-panel.tsx", frag: "documentUrl", cls: "UPSTREAM", at: "app/components/features/offers/offer-workspace.tsx:476" },
  { file: "app/components/portal/NetSheetCalculator.tsx", frag: "pdfUrl", cls: "UPSTREAM", at: P_DOC },
  { file: "app/dashboard/admin/billing/subscription-agreement-card.tsx", frag: "view.documentUrl", cls: "SHORT", at: "app/actions/admin/subscription-agreement.ts:194" },
  { file: "app/dashboard/documents/document-center-client.tsx", frag: "doc.documentUrl", cls: "UPSTREAM", at: "app/actions/document-center.ts:174" },
  { file: "app/dashboard/financials/agreements/agreement-governance-panel.tsx", frag: "g.documentUrl", cls: "UPSTREAM", at: "app/actions/commission-policy/agreements.ts:94" },
  { file: "app/dashboard/financials/agreements/agreement-governance-panel.tsx", frag: "amend.documentUrl", cls: "INPUT", at: "app/dashboard/financials/agreements/agreement-governance-panel.tsx:167" },
  { file: "app/dashboard/financials/agreements/page.tsx", frag: "s.documentUrl", cls: "UPSTREAM", at: "app/actions/commission-agreement-history.ts:125" },
  { file: "app/dashboard/forms/FormsLibraryClient.tsx", frag: "record.documentUrl", cls: "UPSTREAM", at: "app/dashboard/forms/FormsLibraryClient.tsx:262" },
  { file: "app/dashboard/intelligence/components/os/leaderboard-panel.tsx", frag: "avatarUrl", cls: "AGENT", at: "app/actions/gamification.ts:58" },
  { file: "app/dashboard/marketing/studio/components/content-command-center.tsx", frag: "selected.thumbnailUrl", cls: "UPSTREAM", at: "lib/marketing/content-catalog.ts:1022" },
  { file: "app/dashboard/offers/outside-offer-threads.tsx", frag: "review.documentUrl", cls: "UPSTREAM", at: "lib/esign/addendum-signature-request.ts:384" },
  { file: "app/dashboard/onboarding/progress/progress-dashboard-client.tsx", frag: "cert.certificateUrl", cls: "UPSTREAM", at: "lib/onboarding/certification-engine.ts:608" },
  { file: "app/dashboard/settings/license-ce/license-ce-client.tsx", frag: "c.certificateUrl", cls: "UPSTREAM", at: "app/actions/admin/license-tracking.ts:434" },
  { file: "app/dashboard/settings/twin-studio/components/twin-card.tsx", frag: "twin.avatarUrl", cls: "AGENT", at: "app/actions/twin-studio.ts:73" },
  { file: "app/dashboard/superadmin/growth/image-library-card.tsx", frag: "thumbnailUrl", cls: "PUBLIC", at: "lib/marketing/image-library.ts:40" },
  { file: "app/dashboard/transactions/[id]/cda/cda-template-fields-card.tsx", frag: "pdfUrl", cls: "UPSTREAM", at: "app/actions/cda-template-field-actions.ts:321" },
  { file: "app/dashboard/vendors/vendor-directory-client.tsx", frag: "result.status.certificateUrl", cls: "INPUT", at: "lib/vendors/insurance-posture.ts:118" },
  { file: "app/portal/[contactId]/components/PortalWelcomeVideo.tsx", frag: "video.videoUrl", cls: "UPSTREAM", at: "lib/portal/welcome-video.ts:244" },
  // Static generic guides (`/education/*.mp4`) chosen by persona and stage — the same file for every client of that persona.
  { file: "app/portal/[contactId]/transaction/[transactionId]/page.tsx", frag: "educationalContent.videoUrl", cls: "PUBLIC", at: "lib/application/transactions.ts:3406" },
  // The page reads remotion_composition_renders ONLY (never the contact-addressed chapter video in ai_video_projects); a composition
  // render that is not a contact-addressed video project is public media by the host rule. See the lane notes' owner decision.
  { file: "app/portal/listing-plan/[id]/listing-plan-segments.tsx", frag: "current.videoUrl", cls: "PUBLIC", at: "lib/remotion/media-host.ts:63" },
  { file: "app/portal/listing-plan/[id]/listing-plan-segments.tsx", frag: "current.thumbnailUrl", cls: "PUBLIC", at: "lib/remotion/media-host.ts:63" },
  { file: "app/site/[slug]/page.tsx", frag: "heroVideo.", cls: "PUBLIC", at: "lib/video/public-video.ts:167" },
  { file: "lib/commission/agreement-terms.ts", frag: "signed.documentUrl", cls: "UPSTREAM", at: "lib/commission/agreement-terms.ts:199" },
  { file: "lib/integrations/providers/brokermint-provider.ts", frag: "request.documentUrl", cls: "GATEWAY", at: "lib/integrations/providers/brokermint-provider.ts:141" },
  { file: "lib/integrations/providers/docusign-provider.ts", frag: "request.documentUrl", cls: "GATEWAY", at: "lib/integrations/providers/docusign-provider.ts:285" },
  { file: "lib/integrations/providers/dotloop-provider.ts", frag: "request.documentUrl", cls: "GATEWAY", at: "lib/integrations/providers/dotloop-provider.ts:242" },
  { file: "lib/integrations/providers/formsimplicity-provider.ts", frag: "request.documentUrl", cls: "GATEWAY", at: "lib/integrations/providers/formsimplicity-provider.ts:167" },
  { file: "lib/integrations/providers/skyslope-provider.ts", frag: "request.documentUrl", cls: "GATEWAY", at: "lib/integrations/providers/skyslope-provider.ts:204" },
  { file: "lib/intelligence/partners-meeting.ts", frag: "res.videoUrl", cls: "VENDOR", at: "lib/intelligence/partners-meeting.ts:127" },
  { file: "lib/kernel/appraiser-packet.ts", frag: "packet.pdfUrl", cls: "UPSTREAM", at: "lib/kernel/appraiser-packet.ts:890" },
  { file: "lib/lead-magnets/book-creator.ts", frag: "r.pdfUrl", cls: "UPSTREAM", at: P_DOC },
  { file: "lib/lead-magnets/promised-deliverables.ts", frag: "input.book.pdfUrl", cls: "STORED", at: "lib/lead-magnets/promised-deliverables.ts:267" },
  { file: "lib/market-reports/producer.ts", frag: "r.pdfUrl", cls: "UPSTREAM", at: P_DOC },
  { file: "lib/offers/offer-extractor.ts", frag: "pdfUrl", cls: "GATEWAY", at: "lib/offers/offer-extractor.ts:65" },
  { file: "lib/providers/vibe.ts", frag: "videoUrl", cls: "VENDOR", at: "lib/providers/vibe.ts:207" },
]
const sharedCamel = new RegExp(`\\b(${SHARED_COLUMNS.map(camel).join("|")})\\b`)
type MediaSite = { file: string; kind: string; expr: string }
function mediaSites(file: string, src: string, readerExprs: ReadonlySet<string>): MediaSite[] {
  return SITE_RES.flatMap(([kind, re]) => [...src.matchAll(re)]
    .filter((m) => sharedCamel.test(m[1]) && !HELPER.test(m[1]) && !readerExprs.has(m[1].trim()))
    .map((m) => ({ file, kind, expr: m[1].trim() })))
}
const mediaClassOf = (s: MediaSite) => MEDIA_SITE_CLASSES.find((e) => e.file === s.file && s.expr.includes(e.frag))
const contactFacing = (f: string) => CONTACT_ROOTS.some((r) => f.startsWith(r))
/** The verdict for one site: null = accepted, else why it is refused. */
function mediaVerdict(s: MediaSite, classOf: (s: MediaSite) => { cls: MediaClass; at: string } | undefined = mediaClassOf): string | null {
  const c = classOf(s)
  if (!c) return "UNCLASSIFIED — it may be protected media about or for a Contact; classify it or route it through the door helper"
  if (contactFacing(s.file) && !CONTACT_OK.has(c.cls)) return `${c.cls} is not accepted on a contact-facing surface (only ${[...CONTACT_OK].join(" / ")})`
  if (contactFacing(s.file) && c.cls === "PUBLIC" && !PUBLIC_RULES.some((r) => c.at.startsWith(`${r}:`))) return `PUBLIC on a contact-facing surface must cite a named public rule (${PUBLIC_RULES.join(", ")}), not ${c.at}`
  return null
}
const mediaAll = [...code.entries()].flatMap(([f, src]) => mediaSites(f, src, new Set(readers.filter((r) => r.file === f).map((r) => r.expr))))
const mediaRefused = mediaAll.map((s) => ({ s, why: mediaVerdict(s) })).filter((x) => x.why)
const usedMediaClasses = new Set(mediaAll.map(mediaClassOf).filter(Boolean))
const staleMediaClasses = MEDIA_SITE_CLASSES.filter((e) => !usedMediaClasses.has(e))
const danglingCitations = MEDIA_SITE_CLASSES.filter((e) => { const [p, ln] = e.at.split(/:(?=\d+$)/); try { return readFileSync(join(root, p), "utf8").split("\n").length < Number(ln) } catch { return true } })
const usedExceptions = new Set(readers.filter((r) => !r.wrapped).map((r) => excused(r)).filter(Boolean))
const staleExceptions = READER_EXCEPTIONS.filter((e) => !usedExceptions.has(e))
console.log(`    (published) door columns ${DOOR_TABLE_OF.size} (derived from DOCUMENT_DOOR_KINDS): enforced everywhere ${UNIQUE_COLUMNS.join(", ")} (+ camelCase); shared names ${SHARED_COLUMNS.join(", ")} enforced only where the file names their door table`)
const byClass = MEDIA_SITE_CLASSES.reduce<Record<string, number>>((a, e) => { a[e.cls] = (a[e.cls] ?? 0) + mediaAll.filter((s) => mediaClassOf(s) === e).length; return a }, {})
console.log(`    (published, ENFORCED since wave 155) ${mediaAll.length} shared-name media site(s) in ${new Set(mediaAll.map((s) => s.file)).size} file(s) (derived); by class ${Object.entries(byClass).map(([k, v]) => `${k} ${v}`).join(" · ")}; ${mediaAll.filter((s) => contactFacing(s.file)).length} on contact-facing surfaces (${CONTACT_ROOTS.join(", ")})`)
check("C5 every shared-name media site is classified, and on a contact-facing surface only through the door (UPSTREAM / SHORT) or a named public rule", mediaRefused.length === 0, mediaRefused.map((x) => `${x.s.file} <${x.s.kind}> ${x.s.expr.slice(0, 60)} — ${x.why}`).join(" | "))
check("C5 every media classification still matches a site (a stale class is a hole)", staleMediaClasses.length === 0, staleMediaClasses.map((e) => `${e.file}#${e.frag}`).join(", "))
check("C5 every classification's proof citation exists (file present, line in range)", danglingCitations.length === 0, danglingCitations.map((e) => e.at).join(", "))
{
  const planted = mediaSites("app/portal/[contactId]/planted.tsx", `<video src={row.videoUrl} />`, new Set())
  const plantedPublic = (s: MediaSite) => mediaVerdict(s, () => ({ cls: "PUBLIC", at: "app/portal/somewhere.tsx:1" }))
  const plantedVendor = (s: MediaSite) => mediaVerdict(s, () => ({ cls: "VENDOR", at: "lib/did/index.ts:625" }))
  const plantedOk = (s: MediaSite) => mediaVerdict(s, () => ({ cls: "PUBLIC", at: "lib/video/public-video.ts:94" }))
  const player = mediaSites("x.tsx", `<CardVideoPlayer url={latest.videoUrl} />`, new Set())
  control("C5 catches a planted UNCLASSIFIED portal video, a PUBLIC portal site citing no public rule, a VENDOR class on a portal page, and sees a player's url={…} prop; a door-wrapped twin and a correctly cited PUBLIC pass",
    planted.length === 1 && /UNCLASSIFIED/.test(mediaVerdict(planted[0]) ?? "") && /named public rule/.test(plantedPublic(planted[0]) ?? "")
    && /not accepted on a contact-facing/.test(plantedVendor(planted[0]) ?? "") && plantedOk(planted[0]) === null
    && player.length === 1 && mediaSites("x.tsx", `<video src={documentOpenHref(row.videoUrl)} />`, new Set()).length === 0)
}
console.log(`    (published) ${readers.length} reader site(s) in ${new Set(readers.map((r) => r.file)).size} file(s): ${readers.filter((r) => r.wrapped).length} through the helper, ${readers.length - readers.filter((r) => r.wrapped).length} on the named exception list (${READER_EXCEPTIONS.length} entries), ${bare.length} bare`)
check("C4 no stored reference reaches a link or a fetch without the ONE helper or a named exception", bare.length === 0, bare.map((r) => `${r.file} <${r.kind}> ${r.expr.slice(0, 80)}`).join(" | "))
check("C4 every named exception still matches a site (a stale exemption is a hole)", staleExceptions.length === 0, staleExceptions.map((e) => `${e.file}#${e.frag}`).join(", "))
// A select string that ALIASES a door column (`file_url:storage_url`) is invisible to a code scan — strings are blanked. Each
// such file must apply the helper itself.
const aliasRe = new RegExp(String.raw`\b\w+:(${[...DOOR_TABLE_OF.keys()].join("|")})\b`)
const aliasFiles = files.filter((f) => stringLiteralsOf(rawOf.get(f) ?? "").some((lit) => aliasRe.test(lit)))
const aliasBare = aliasFiles.filter((f) => !HELPER.test(code.get(f) ?? ""))
check(`C4 every file that aliases a door column inside a select string applies the helper itself (${aliasFiles.length} file(s), derived)`, aliasBare.length === 0, aliasBare.join(", "))
control("the reader finder sees a bare stored reference in an href, a window.open, a fetch and a provider url, and not the helper-wrapped twin",
  readerSites("s.tsx", `<a href={doc.storage_url}>`, "").length === 1 && readerSites("s.tsx", `<a href={doc.storage_url}>`, "")[0].wrapped === false
  && readerSites("s.tsx", `window.open(d.storage_url)`, "").length === 1 && readerSites("s.ts", `await fetch(row.receipt_url)`, "").length === 1
  && readerSites("s.ts", `{ url: offer.offer_document_url }`, "").length === 1
  && readerSites("s.tsx", `<a href={documentOpenHref(doc.storage_url) ?? undefined}>`, "")[0].wrapped === true
  && readerSites("s.tsx", `<video src={v.video_url} />`, "ai_video_projects").length === 1 && readerSites("s.tsx", `<video src={v.video_url} />`, "listing_videos").length === 0)
control("the alias finder sees `file_url:storage_url` in a select string", aliasRe.test(`id, file_url:storage_url, created_at`) && !aliasRe.test(`id, storage_url, created_at`))

// ── C6 · no raw person id in a PUBLIC page's URL or a public tracker body (wave 155, lane 155K2; directive 471) ───────────
// The blog pages honored `?c=<contact_id>` (no writer ever built it) and posted it to public trackers that stored it as the viewer.
// Every file under an unauthenticated public root, and every public tracker component, is scanned (stripped source) for a person
// id read from the query string or sent in a tracker body. A sealed grant (lib/marketing/tracked-qr.ts) is the only way to carry one.
console.log("\n[C6 · no raw Contact / Lead id in a public page's query string or a public tracker body]")
const PUBLIC_PAGE_ROOTS = ["app/blog/", "app/embed/", "app/site/", "app/lm/", "app/v/", "app/p/", "app/qr/", "app/home-value/", "app/open-house/", "app/newsletters/", "app/reviews/", "app/buyer-intake/", "app/showings/", "app/widget/", "app/trust/", "app/components/blog-landing/", "app/api/blog/"]
const PERSON_KEY = String.raw`(?:c|cid|contact|contact_?id|contactId|lead|lead_?id|leadId|person_?id|personId)`
const RAW_ID_RES: Array<[string, RegExp]> = [
  ["query destructure", new RegExp(String.raw`const\s*\{[^}]*\b${PERSON_KEY}\b\s*(?::[^,}]*)?[,}][^=]*=\s*await\s+searchParams`)],
  ["query get", new RegExp(String.raw`searchParams\.get\(\s*["'\`]${PERSON_KEY}["'\`]`)],
  ["body claim", new RegExp(String.raw`\bbody\.(?:contact_?id|contactId|lead_?id|leadId|person_?id)\b`)],
]
/** A CLIENT post (a JSON.stringify'd body) that carries a person id. A server route writing an id it RESOLVED (a token's row) is not this. */
const TRACKER_BODY = /JSON\.stringify\(\s*\{[^}]*\b(?:contact_id|lead_id|contactId|leadId)\s*:\s*(?!null\b)[A-Za-z_]/
function rawIdHits(file: string, src: string): string[] {
  const stripped = stripComments(src)
  const hits = RAW_ID_RES.filter(([, re]) => re.test(stripped)).map(([k]) => `${file} <${k}>`)
  return TRACKER_BODY.test(stripped) ? [...hits, `${file} <tracker body>`] : hits
}
const publicFiles = files.filter((f) => PUBLIC_PAGE_ROOTS.some((r) => f.startsWith(r)))
const rawIdFound = publicFiles.flatMap((f) => rawIdHits(f, rawOf.get(f) ?? readFileSync(join(root, f), "utf8")))
console.log(`    (published) ${publicFiles.length} file(s) under ${PUBLIC_PAGE_ROOTS.length} named public roots scanned (blind spot: a public page outside these roots is not scanned)`)
check("C6 no public page reads a person id from its query string and no public tracker posts one", rawIdFound.length === 0, rawIdFound.join(" | "))
control("C6 catches the retired blog shape (`const { p, c: contactId } = await searchParams`), a `searchParams.get(\"lead_id\")`, and a tracker body carrying `contact_id: contactId`, and a route storing `body.contact_id`; `viewer_contact_id: null` and a server-resolved `r.contact_id` pass",
  rawIdHits("p.tsx", `const { p: persona, c: contactId, utm_source } = await searchParams`).length === 1
  && rawIdHits("p.ts", `const id = req.nextUrl.searchParams.get("lead_id")`).length === 1
  && rawIdHits("t.tsx", `body: JSON.stringify({ blog_post_id: id, contact_id: contactId })`).length === 1
  && rawIdHits("r.ts", `insert({ viewer_contact_id: null })`).length === 0
  && rawIdHits("r.ts", `if (typeof body.contact_id === "string") stored = body.contact_id`).length === 1
  && rawIdHits("r.ts", `insert({ event_id: ev.id, contact_id: r.contact_id })`).length === 0
  && rawIdHits("p.tsx", `const { p: persona, utm_source } = await searchParams`).length === 0)

// ── EXECUTED ──────────────────────────────────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>
function fakeDb(tables: Record<string, Row[]>) {
  const storage = { uploads: [] as string[], signs: [] as Array<{ bucket: string; path: string; ttl: number }>, publicUrls: 0, refuse: false, n: 0 }
  const likeRe = (p: string) => new RegExp("^" + p.replace(/\\([\\%_])|([.*+?^${}()|[\]])|%|_/g, (m, esc, special) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : special ? "\\" + special : m === "%" ? ".*" : ".") + "$")
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let projection = "*"
    let lim = Infinity
    const project = (r: Row) => {
      if (projection.trim() === "*") return { ...r }
      const o: Row = {}
      for (const part of projection.split(",").map((s) => s.trim()).filter(Boolean)) { const [a, b] = part.includes(":") ? part.split(":").map((s) => s.trim()) : [part, part]; o[a] = r[b] }
      return o
    }
    const run = () => ({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim).map(project), error: null })
    const b: any = {
      select: (s = "*") => { projection = s; return b },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b },
      like: (c: string, p: string) => { const re = likeRe(p); filters.push((r) => typeof r[c] === "string" && re.test(r[c])); return b },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b },
      not: () => b, order: () => b,
      limit: (n: number) => { lim = n; return b },
      maybeSingle: async () => { const r = run(); return { data: r.data[0] ?? null, error: null } },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  const client: any = {
    from,
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => { storage.uploads.push(`${bucket}/${path}`); return { data: { path }, error: null } },
        createSignedUrl: async (path: string, ttl: number) => {
          storage.signs.push({ bucket, path, ttl })
          if (storage.refuse) return { data: null, error: { message: "new row violates row-level security policy (simulated refusal)" } }
          return { data: { signedUrl: `https://proj.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=FRESH-${++storage.n}` }, error: null }
        },
        getPublicUrl: (path: string) => { storage.publicUrls++; return { data: { publicUrl: `https://proj.supabase.co/storage/v1/object/public/${bucket}/${path}` } } },
        remove: async () => ({ data: [], error: null }),
      }),
    },
  }
  return { client, storage, tables }
}

// The grant sealer is the repo's existing envelope helper; a TEST-ONLY key, in this process only (never printed).
process.env.SECRETS_ENCRYPTION_KEY = process.env.SECRETS_ENCRYPTION_KEY || "document-links-guard-test-key"
const SEALER = { seal: encryptSecret, open: decryptSecret, isSealed: isEncrypted }

async function main() {
  console.log("\n[EXECUTED · SIMULATED — the real put function, the real door logic, the real deal rule]")
  const B1 = "b1000000-0000-4000-8000-000000000001", B2 = "b2000000-0000-4000-8000-000000000002"
  const U_OWNER = "e0000000-0000-4000-8000-0000000000a1", U_OTHER = "e0000000-0000-4000-8000-0000000000a2", U_B2 = "e0000000-0000-4000-8000-0000000000b1", U_CONTACT = "e0000000-0000-4000-8000-0000000000c1"
  const A_OWNER = "a0000000-0000-4000-8000-0000000000a1", A_OTHER = "a0000000-0000-4000-8000-0000000000a2"
  const T1 = "d1000000-0000-4000-8000-000000000001", C1 = "c1000000-0000-4000-8000-000000000001"
  const db = fakeDb({
    transactions: [{ id: T1, brokerage_id: B1, agent_id: A_OWNER, coordinator_id: null, status: "active", stage: "under_contract" }],
    agents: [{ id: A_OWNER, user_id: U_OWNER, brokerage_id: B1, team_id: null }, { id: A_OTHER, user_id: U_OTHER, brokerage_id: B1, team_id: null }],
    transaction_coordinators: [], user_role_assignments: [], transaction_assignments: [], teams: [],
    transaction_documents: [], client_documents: [], offers: [], agent_licenses: [], documents: [], generated_documents: [], ai_video_projects: [],
    contacts: [{ id: C1, brokerage_id: B1, contact_user_id: U_CONTACT, agent_id: A_OWNER, avatar_url: null }],
    agent_certifications: [], closing_disclosure_agreement: [], brokerage_forms: [], brokerage_cda_templates: [], business_expenses: [],
    // Every session actor's SEAT (the door re-reads its standing on every click — lane 155A; status NULL reads active).
    users: [U_OWNER, U_OTHER, U_CONTACT, "e0000000-0000-4000-8000-0000000000b9", "e0000000-0000-4000-8000-0000000000d1"].map((id) => ({ id, brokerage_id: B1, status: "active", deleted_at: null }))
      .concat([{ id: U_B2, brokerage_id: B2, status: "active", deleted_at: null }]),
  })

  // UPLOAD through the real put function.
  const stored = await putAndSign(db.client, { bucket: "transaction-documents", path: `${B1}/${T1}/inspection report.pdf`, body: new Uint8Array([37, 80, 68, 70]), brokerageId: B1 })
  const ref = stored.ok ? stored.ref : ""
  check("UPLOAD the stored value is a docref:// reference with no token, and no link was minted to store it",
    stored.ok && ref.startsWith("docref://transaction-documents/") && !/token=|^https?:/i.test(ref) && db.storage.signs.length === 0 && db.storage.uploads.length === 1, JSON.stringify(stored))
  db.tables.transaction_documents.push({ id: "d1", brokerage_id: B1, transaction_id: T1, contact_id: null, uploaded_by: U_OWNER, client_visible: false, storage_url: ref })
  const href = documentOpenHref(ref) ?? ""
  const doorRef = new URL(href, "https://app.example").searchParams.get("ref")
  check("UPLOAD the reader helper turns it into the same-origin door, and the door's ref round-trips to the same object", href.startsWith("/api/documents/open?ref=") && JSON.stringify(parseDocumentRef(doorRef)) === JSON.stringify(parseDocumentRef(ref)))

  const deps = (actor: DocumentDoorActor | null) => {
    const rules: DocumentDoorRules = {
      tenantAdminUserTypes: TENANT_ADMIN_USER_TYPES,
      financeReaderUserTypes: new Set([...BROKERAGE_FINANCE_ADMIN_USER_TYPES, "compliance_officer"]),
      dealRead: async (transactionId) => {
        const r = await loadDealWorkAccess(db.client, { userId: actor!.userId, brokerageId: actor!.brokerageId, userType: actor!.userType, transactionId })
        return r.ok ? { ok: true, read: r.access.capabilities.read } : { ok: false, error: r.error }
      },
      partnerLane: async () => ({ ok: true, granted: partnerLaneOpen }),
      clientVisibleDealDocument: isClientVisibleDealDocument,
    }
    return { db: db.client, rules, actor: async () => actor ? { ok: true as const, actor } : { ok: false as const, reason: "unauthenticated" as const }, sign: (b: string, p: string, t: number) => signDocumentLink(db.client, b, p, t), sealer: SEALER }
  }
  let partnerLaneOpen = false
  const mkRef0 = (b: string, path: string) => toDocumentRef(b, path)
  const owner: DocumentDoorActor = { userId: U_OWNER, brokerageId: B1, userType: "agent" }
  const a = await openDocumentReference(deps(owner), doorRef)
  const aSign = db.storage.signs.at(-1)
  check("(a) the deal's owning agent in tenant A → 302 to a fresh link whose requested lifetime ≤ the ceiling",
    a.status === 302 && /token=FRESH-/.test(a.location) && !!aSign && aSign.ttl === DOC_VIEW_TTL_SECONDS && aSign.ttl <= DOC_LINK_TTL_CEILING_SECONDS, JSON.stringify(a))
  const b = await openDocumentReference(deps({ userId: U_OTHER, brokerageId: B1, userType: "agent" }), doorRef)
  check("(b) a different seat in tenant A without deal access → refused (404)", b.status === 404, JSON.stringify(b))
  const c = await openDocumentReference(deps({ userId: U_B2, brokerageId: B2, userType: "broker_owner" }), doorRef)
  const unknown = await openDocumentReference(deps(owner), "docref://transaction-documents/never/uploaded.pdf")
  const junk = await openDocumentReference(deps(owner), "javascript:alert(1)")
  check("(c) tenant B → refused, IDENTICAL to an unknown reference and to junk (no oracle)", c.status === 404 && JSON.stringify(c) === JSON.stringify(unknown) && JSON.stringify(c) === JSON.stringify(junk))
  const anon = await openDocumentReference(deps(null), doorRef)
  check("…and no session → 401 (the route sends the sign-in page), before the reference is even parsed", anon.status === 401)
  const signsBefore = db.storage.signs.length
  db.tables.transactions[0].agent_id = A_OTHER
  const d = await openDocumentReference(deps(owner), doorRef)
  check("(d) access revoked after upload (the deal reassigned) → the former owner is refused on the next click, no link minted",
    d.status === 404 && db.storage.signs.length === signsBefore, JSON.stringify(d))
  const dNew = await openDocumentReference(deps({ userId: U_OTHER, brokerageId: B1, userType: "agent" }), doorRef)
  check("…and the newly assigned agent now opens it (the rule, not a cached grant)", dNew.status === 302)

  const LEGACY = `https://proj.supabase.co/storage/v1/object/sign/client-documents/${B1}/${C1}/w9.pdf?token=STOLEN-TOKEN`
  db.tables.client_documents.push({ id: "cd1", brokerage_id: B1, transaction_id: null, contact_id: C1, uploaded_by: U_CONTACT, client_visible: true, document_url: LEGACY })
  const legacyHref = documentOpenHref(LEGACY) ?? ""
  const e = await openDocumentReference(deps({ userId: U_CONTACT, brokerageId: B1, userType: "contact" }), new URL(legacyHref, "https://app.example").searchParams.get("ref"))
  const eSign = db.storage.signs.at(-1)
  check("(e) a legacy signed-URL value → resolved by bucket + path; the stored token is never emitted, forwarded or used",
    e.status === 302 && !/STOLEN/.test(legacyHref) && !/STOLEN/.test((e as any).location ?? "") && eSign?.bucket === "client-documents" && eSign.path === `${B1}/${C1}/w9.pdf`, JSON.stringify(e))
  const legacyAsRaw = await openDocumentReference(deps({ userId: U_CONTACT, brokerageId: B1, userType: "contact" }), LEGACY)
  check("…the door also accepts the legacy value itself and still mints its own link", legacyAsRaw.status === 302 && !/STOLEN/.test((legacyAsRaw as any).location))

  // (f) THE BYTE PATH IN PRODUCTION is the connector gateway's asset-download (the offer extractor, OCR, the e-sign adapters):
  // it calls resolveDocumentLink(svc, url, DOC_FETCH_TTL_SECONDS) and then fetches once. Executed here with the same call and
  // constant; the gateway's own branch is asserted on stripped source (the gateway needs a live service client to run).
  const gw = code.get("lib/agentic-os/connector-gateway.ts") ?? ""
  const gwResolve = gw.search(/resolveDocumentLink\(\s*createServiceClient\(\)\s*as never,\s*original\.url,\s*DOC_FETCH_TTL_SECONDS\s*\)/)
  check("(f) the gateway resolves a docref:// url at use time with DOC_FETCH_TTL_SECONDS, BEFORE the request is built, and refuses when the signer refuses",
    gwResolve > 0 && gwResolve < gw.indexOf("withAppliedAlternate(original)") && /if \(!link\.ok\) return \{ ok: false/.test(gw))
  const link = await resolveDocumentLink(db.client, ref, DOC_FETCH_TTL_SECONDS)
  let fetched = ""
  const res = link.ok ? await (async (u: string) => { fetched = u; return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }) })(link.url) : null
  const bytes = res ? await res.arrayBuffer() : new ArrayBuffer(0)
  const fSign = db.storage.signs.at(-1)
  check("(f) a server-side consumer gets the bytes through the resolver with a link of ≤ DOC_FETCH_TTL_SECONDS",
    link.ok && bytes.byteLength === 3 && /token=FRESH-/.test(fetched) && !!fSign && fSign.ttl <= DOC_FETCH_TTL_SECONDS, JSON.stringify(fSign))
  const fRaw = await resolveDocumentLink(db.client, "docref://documents/x.pdf", 60 * 60 * 24 * 365 * 10)
  check("…and a consumer asking for ten years is CLAMPED to the ceiling", fRaw.ok && db.storage.signs.at(-1)!.ttl === DOC_LINK_TTL_CEILING_SECONDS)

  db.storage.refuse = true
  db.tables.transactions[0].agent_id = A_OWNER
  const g = await openDocumentReference(deps(owner), doorRef)
  const gResolve = await resolveDocumentLink(db.client, ref, DOC_VIEW_TTL_SECONDS)
  const gIssue = await issueBucketObjectUrl(db.client, { bucket: "documents", objectPath: "x.pdf", ttlSeconds: 300 })
  check("(g) a refused signer is a refusal WITH ITS REASON — 503, no location, never a public fallback",
    g.status === 503 && /refused/.test((g as any).reason) && !("location" in g) && !gResolve.ok && /refused/.test(gResolve.reason) && !gIssue.ok && db.storage.publicUrls === 0, JSON.stringify(g))
  db.storage.refuse = false

  const issuedRef = await issueBucketObjectUrl(db.client, { bucket: "documents", objectPath: `board-packets/${B1}/2026-10.pdf` })
  const issuedPub = await issueBucketObjectUrl(db.client, { bucket: "listing-media", objectPath: "a.jpg" })
  check("ISSUER a persisting writer (no lifetime) gets a reference; a public-media bucket still gets its public URL",
    issuedRef.ok && issuedRef.kind === "reference" && issuedRef.url.startsWith("docref://documents/") && issuedPub.ok && issuedPub.kind === "public")
  const bp = await openDocumentReference(deps({ userId: U_OTHER, brokerageId: B1, userType: "broker_owner" }), issuedRef.ok ? issuedRef.url : "")
  const bpAgent = await openDocumentReference(deps(owner), issuedRef.ok ? issuedRef.url : "")
  const bpOther = await openDocumentReference(deps({ userId: U_B2, brokerageId: B2, userType: "broker_owner" }), issuedRef.ok ? issuedRef.url : "")
  check("PATH KIND the board packet (no row) opens for the tenant's admin roster only — not an agent, not another tenant", bp.status === 302 && bpAgent.status === 404 && bpOther.status === 404)
  // ── BINDING: a row may not point the door at ANOTHER tenant's object ───────────────────────────────────────────────────
  db.tables.agent_licenses.push({ id: "lic-own", brokerage_id: B1, agent_id: A_OWNER, document_url: mkRef0("agent-documents", `${U_OWNER}/license/1-own.pdf`) })
  db.tables.agent_licenses.push({ id: "lic-forged", brokerage_id: B1, agent_id: A_OWNER, document_url: mkRef0("agent-documents", `${U_B2}/license/1-theirs.pdf`) })
  const ownLic = await openDocumentReference(deps(owner), mkRef0("agent-documents", `${U_OWNER}/license/1-own.pdf`))
  const signsBeforeForged = db.storage.signs.length
  const forgedLic = await openDocumentReference(deps(owner), mkRef0("agent-documents", `${U_B2}/license/1-theirs.pdf`))
  const noIdLic = await openDocumentReference(deps(owner), mkRef0("agent-documents", `license/no-owner.pdf`))
  check("BINDING a row of MY tenant that stores a reference to ANOTHER tenant's object (browser-supplied) is refused with no link minted; my own object opens; a path naming no tenant-owned id is refused",
    ownLic.status === 302 && forgedLic.status === 404 && db.storage.signs.length === signsBeforeForged && noIdLic.status === 404 && JSON.stringify(forgedLic) === JSON.stringify(unknown))

  // ── SHARE GRANTS (round 2): outside recipients with NO session ──────────────────────────────────────────────────────
  console.log("\n[EXECUTED · SIMULATED — share grants for outside recipients]")
  const C_LEAD = "c1000000-0000-4000-8000-0000000000f1"
  const mkRef = mkRef0
  const R = {
    outside_offer_packet: { ref: mkRef("documents", `${B1}/offers/o1/packet.pdf`), table: "documents", row: { id: "doc-o1", brokerage_id: B1, transaction_id: T1, contact_id: null }, col: "storage_url" },
    appraiser_packet: { ref: mkRef("documents", `client-docs/${B1}/appraiser_packet-1.pdf`), table: "generated_documents", row: { id: "gd-ap", brokerage_id: B1, transaction_id: T1, contact_id: null, agent_id: A_OWNER, document_type: "appraiser_packet", metadata: {} }, col: "blob_url" },
    lead_magnet: { ref: mkRef("documents", `client-docs/${B1}/checklist-1.pdf`), table: "generated_documents", row: { id: "gd-lm", brokerage_id: B1, transaction_id: null, contact_id: null, agent_id: A_OWNER, document_type: "checklist", metadata: { source: "lead_magnet_funnel" } }, col: "blob_url" },
    market_report: { ref: mkRef("documents", `client-docs/${B1}/market_report-1.pdf`), table: "generated_documents", row: { id: "gd-mr", brokerage_id: B1, transaction_id: null, contact_id: C_LEAD, agent_id: A_OWNER, document_type: "market_report", metadata: {} }, col: "blob_url" },
    book: { ref: mkRef("documents", `client-docs/${B1}/book-1.pdf`), table: "generated_documents", row: { id: "gd-bk", brokerage_id: B1, transaction_id: null, contact_id: null, agent_id: A_OWNER, document_type: "book", metadata: {} }, col: "blob_url" },
    personal_video: { ref: mkRef("personal-videos", `compositions/${B1}/welcome/r1.mp4`), table: "ai_video_projects", row: { id: "vp-1", brokerage_id: B1, contact_id: C_LEAD, agent_id: A_OWNER }, col: "video_url" },
  } as const
  for (const v of Object.values(R)) db.tables[v.table].push({ ...v.row, [v.col]: v.ref })
  const anonDeps = deps(null)
  const unknownWithGrant = await openDocumentReference(anonDeps, "docref://documents/never/uploaded.pdf", "enc:v1:AAAA:BBBB:CCCC")
  const same = (a: unknown) => JSON.stringify(a) === JSON.stringify(unknownWithGrant)
  check("a grant on an unknown reference with no session is the plain 404 (the baseline every refusal below must equal)", unknownWithGrant.status === 404)
  const grants: Record<string, string> = {}
  for (const [purpose, v] of Object.entries(R)) {
    const minted = mintDocumentShareGrant(SEALER, { ref: v.ref, purpose: purpose as keyof typeof SHARE_GRANT_PURPOSES, brokerageId: B1, rowId: v.row.id, contactId: purpose === "personal_video" ? C_LEAD : null })
    if (!minted.ok) { check(`${purpose}: the grant mints`, false, minted.reason); continue }
    grants[purpose] = minted.grant
    const url = documentShareUrl(v.ref, minted.grant, "https://app.example") ?? ""
    const u = new URL(url)
    const signsBefore = db.storage.signs.length
    const opened = await openDocumentReference(anonDeps, u.searchParams.get("ref"), u.searchParams.get("g"))
    const sign = db.storage.signs[db.storage.signs.length - 1]
    const days = Math.round((Date.parse(minted.expiresAt) - Date.now()) / 86_400_000)
    check(`SHARE ${purpose}: opens with NO session → 302 to a ≤ 5-minute link (grant lives ${days} days; the click mints, the grant does not)`,
      opened.status === 302 && db.storage.signs.length === signsBefore + 1 && sign.ttl === DOC_VIEW_TTL_SECONDS && days === SHARE_GRANT_PURPOSES[purpose as keyof typeof SHARE_GRANT_PURPOSES].ttlSeconds / 86_400, JSON.stringify(opened))
  }
  const replay = await openDocumentReference(anonDeps, doorRef, grants.lead_magnet)
  check("a lead-magnet grant replayed against a DEAL document reference → refused, identical to unknown", replay.status === 404 && same(replay))
  const dealRow = db.tables.transaction_documents[0]
  const dealGrant = mintDocumentShareGrant(SEALER, { ref, purpose: "outside_offer_packet", brokerageId: B1, rowId: dealRow.id })
  const dealOpen = await openDocumentReference(anonDeps, doorRef, dealGrant.ok ? dealGrant.grant : "")
  check("a grant MINTED for a deal document (custody kind transaction_document) is ignored — refused, identical to unknown", dealGrant.ok && dealOpen.status === 404 && same(dealOpen))
  const expired = mintDocumentShareGrant(SEALER, { ref: R.lead_magnet.ref, purpose: "lead_magnet", brokerageId: B1, rowId: R.lead_magnet.row.id, now: new Date(Date.now() - 31 * 86_400_000) })
  const expOpen = await openDocumentReference(anonDeps, R.lead_magnet.ref, expired.ok ? expired.grant : "")
  const g0 = grants.lead_magnet
  const tampered = g0.slice(0, -6) + (g0.slice(-6, -5) === "A" ? "B" : "A") + g0.slice(-5)
  const tamOpen = await openDocumentReference(anonDeps, R.lead_magnet.ref, tampered)
  const forged = await openDocumentReference(anonDeps, R.lead_magnet.ref, JSON.stringify({ k: "doc-share-v1", r: R.lead_magnet.ref, p: "lead_magnet", b: B1, i: "gd-lm", c: null, e: 9_999_999_999 }))
  const B2REF = mkRef("documents", `client-docs/${B2}/checklist-9.pdf`)
  db.tables.generated_documents.push({ id: "gd-b2", brokerage_id: B2, document_type: "checklist", metadata: { source: "lead_magnet_funnel" }, blob_url: B2REF })
  const crossRef = await openDocumentReference(anonDeps, B2REF, g0)
  const crossTenant = mintDocumentShareGrant(SEALER, { ref: R.lead_magnet.ref, purpose: "lead_magnet", brokerageId: B2, rowId: R.lead_magnet.row.id })
  const crossTenantOpen = await openDocumentReference(anonDeps, R.lead_magnet.ref, crossTenant.ok ? crossTenant.grant : "")
  const wrongPurpose = mintDocumentShareGrant(SEALER, { ref: R.lead_magnet.ref, purpose: "personal_video", brokerageId: B1, rowId: R.lead_magnet.row.id, contactId: C_LEAD })
  const wrongPurposeOpen = await openDocumentReference(anonDeps, R.lead_magnet.ref, wrongPurpose.ok ? wrongPurpose.grant : "")
  const otherContact = mintDocumentShareGrant(SEALER, { ref: R.personal_video.ref, purpose: "personal_video", brokerageId: B1, rowId: "vp-1", contactId: C1 })
  const otherContactOpen = await openDocumentReference(anonDeps, R.personal_video.ref, otherContact.ok ? otherContact.grant : "")
  db.tables.generated_documents = db.tables.generated_documents.filter((r: Row) => r.id !== "gd-lm")
  const deletedOpen = await openDocumentReference(anonDeps, R.lead_magnet.ref, g0)
  check("expired · tampered · an UNSEALED (plaintext) grant · tenant A's grant with tenant B's reference · a grant claiming tenant B for A's row · a wrong purpose · another contact's video · a deleted row → all refused, each IDENTICAL to unknown",
    [expOpen, tamOpen, forged, crossRef, crossTenantOpen, wrongPurposeOpen, otherContactOpen, deletedOpen].every((a) => a.status === 404 && same(a)),
    JSON.stringify([expOpen, tamOpen, forged, crossRef, crossTenantOpen, wrongPurposeOpen, otherContactOpen, deletedOpen].map((a) => a.status)))
  const withSession = await openDocumentReference(deps(owner), doorRef, tampered)
  check("…and a signed-in seat presenting a bad grant falls back to its own session rule (the owner still opens the deal document)", withSession.status === 302)

  // The SENDER's upgrade: the outgoing body only; no grant in any stored row.
  const body = `Your guide: https://app.example/api/documents/open?ref=${encodeURIComponent(R.book.ref)}\nVideo: ${R.personal_video.ref}\nDeal file: ${ref}`
  const up = await grantDoorLinksInText(db.client, body, { brokerageId: B1, recipientContactId: C_LEAD, sealer: SEALER, origin: "https://app.example" })
  const upText = up.ok ? up.text : ""
  check("SENDER grantDoorLinksInText: the book and the contact's own video get grant URLs, the deal file only the sign-in door, no raw docref:// leaves",
    up.ok && up.granted === 2 && (upText.match(/&g=enc%3Av1%3A/g) ?? []).length === 2 && !upText.includes("docref://") && upText.endsWith(`https://app.example/api/documents/open?ref=${encodeURIComponent(ref)}`), upText)
  const upOther = await grantDoorLinksInText(db.client, `Video: ${R.personal_video.ref}`, { brokerageId: B1, recipientContactId: C1, sealer: SEALER, origin: "https://app.example" })
  check("…a personal video addressed to ANOTHER contact gets no grant (sign-in door only)", upOther.ok && upOther.granted === 0 && !/&g=/.test(upOther.ok ? upOther.text : ""))
  const storedGrant = Object.entries(db.tables).flatMap(([t, rows]) => (rows as Row[]).filter((r) => JSON.stringify(r).includes("enc:v1:") || /[?&]g=/.test(JSON.stringify(r))).map((r) => `${t}:${r.id}`))
  check("no grant appears in any stored row (every table of the simulated database scanned after every mint and send)", storedGrant.length === 0, storedGrant.join(", "))
  const savedKey = process.env.SECRETS_ENCRYPTION_KEY
  delete process.env.SECRETS_ENCRYPTION_KEY
  const noKey = mintDocumentShareGrant(SEALER, { ref: R.book.ref, purpose: "book", brokerageId: B1, rowId: "gd-bk" })
  const noKeyBody = await grantDoorLinksInText(db.client, body, { brokerageId: B1, recipientContactId: C_LEAD, sealer: SEALER, origin: "https://app.example" })
  process.env.SECRETS_ENCRYPTION_KEY = savedKey
  check("SECRET MISSING: the mint fails CLOSED with its reason and the sender's body upgrade refuses the send — never a public or long-lived link",
    !noKey.ok && /SECRETS_ENCRYPTION_KEY/.test(noKey.reason) && !noKeyBody.ok && /SECRETS_ENCRYPTION_KEY/.test(noKeyBody.reason))

  // RENDER INPUTS: a personal avatar track in the props is resolved for the renderer only.
  const props = { avatarVideoUrl: R.personal_video.ref, scenes: [{ clip: R.personal_video.ref }], title: "Welcome", logo: "https://cdn.example/logo.png" }
  const signsBeforeProps = db.storage.signs.length
  const rp = await resolveDocumentRefsInProps(db.client, props)
  check("RENDER resolveDocumentRefsInProps: every docref:// in the props (nested too) becomes a link of the signer's ceiling; plain strings and public URLs untouched; the persisted props keep the reference",
    rp.ok && /token=FRESH-/.test((rp.props as typeof props).avatarVideoUrl) && /token=FRESH-/.test((rp.props as typeof props).scenes[0].clip) && (rp.props as typeof props).logo === props.logo
    && db.storage.signs.length === signsBeforeProps + 2 && db.storage.signs.slice(-2).every((x) => x.ttl === DOC_LINK_TTL_CEILING_SECONDS) && props.avatarVideoUrl === R.personal_video.ref)

  // The session rules that mirror the live row rules (round 2).
  const C_SELLER = "c1000000-0000-4000-8000-0000000000b9", U_SELLER = "e0000000-0000-4000-8000-0000000000b9"
  db.tables.contacts.push({ id: C_SELLER, brokerage_id: B1, contact_user_id: U_SELLER, agent_id: A_OWNER })
  db.tables.transactions[0].seller_contact_id = C_SELLER
  db.tables.transaction_documents.push({ id: "d-vis", brokerage_id: B1, transaction_id: T1, contact_id: null, uploaded_by: U_OWNER, client_visible: true, doc_type: "inspection_report", storage_url: mkRef("transaction-documents", `${B1}/${T1}/visible.pdf`) })
  db.tables.transaction_documents.push({ id: "d-hid", brokerage_id: B1, transaction_id: T1, contact_id: null, uploaded_by: U_OWNER, client_visible: false, doc_type: "inspection_report", storage_url: mkRef("transaction-documents", `${B1}/${T1}/hidden.pdf`) })
  const seller = { userId: U_SELLER, brokerageId: B1, userType: "contact" }
  const sVis = await openDocumentReference(deps(seller), mkRef("transaction-documents", `${B1}/${T1}/visible.pdf`))
  const sHid = await openDocumentReference(deps(seller), mkRef("transaction-documents", `${B1}/${T1}/hidden.pdf`))
  const lead = await openDocumentReference(deps({ userId: U_CONTACT, brokerageId: B1, userType: "contact" }), mkRef("transaction-documents", `${B1}/${T1}/visible.pdf`))
  check("CONTACT a party to the deal opens a client-visible deal document; a hidden one and a non-party contact are refused (isClientVisibleDealDocument + the deal's contact columns)", sVis.status === 302 && sHid.status === 404 && lead.status === 404)
  // Lane 155A: this row used to assert a party opens a deal document it did NOT upload. The live m888 rule (read 2026-11-19)
  // is narrower — the party's OWN upload, or the CDA delivered to that title user — and the door now mirrors it.
  const U_TITLE = "e0000000-0000-4000-8000-0000000000d1"
  const title = { userId: U_TITLE, brokerageId: B1, userType: "vendor" }
  db.tables.transaction_documents.push({ id: "d-title-own", brokerage_id: B1, transaction_id: T1, contact_id: null, uploaded_by: U_TITLE, client_visible: false, doc_type: "title_commitment", metadata: {}, storage_url: mkRef("transaction-documents", `${B1}/${T1}/title/commitment.pdf`) })
  db.tables.transaction_documents.push({ id: "d-cda", brokerage_id: B1, transaction_id: T1, contact_id: null, uploaded_by: U_OWNER, client_visible: false, doc_type: "cda", metadata: { delivered_to_title_user_id: U_TITLE }, storage_url: mkRef("transaction-documents", `${B1}/${T1}/cda.pdf`) })
  partnerLaneOpen = true
  const pOwn = await openDocumentReference(deps(title), mkRef("transaction-documents", `${B1}/${T1}/title/commitment.pdf`))
  const pCda = await openDocumentReference(deps(title), mkRef("transaction-documents", `${B1}/${T1}/cda.pdf`))
  const pOther = await openDocumentReference(deps(title), mkRef("transaction-documents", `${B1}/${T1}/visible.pdf`))
  partnerLaneOpen = false
  const pShut = await openDocumentReference(deps(title), mkRef("transaction-documents", `${B1}/${T1}/title/commitment.pdf`))
  check("PARTY a title / lender / vendor party opens its OWN upload and the CDA delivered to it while its lane stands, is refused a deal document it did not upload, and is refused its own once the lane is gone (m888 transaction_documents_party_select, live)",
    pOwn.status === 302 && pCda.status === 302 && pOther.status === 404 && pShut.status === 404, JSON.stringify([pOwn.status, pCda.status, pOther.status, pShut.status]))

  // ── PRIV-006 (wave 155, lane 155K2): a protected video opens only for its authorized viewer and fails on the NEXT click after
  // revocation; a public marketing video plays with no login (no door, no grant, nothing minted).
  console.log("\n[EXECUTED · SIMULATED — PRIV-006: protected vs public video]")
  const pvRow = db.tables.ai_video_projects.find((r: Row) => r.id === "vp-1")!
  const pvGrant = mintDocumentShareGrant(SEALER, { ref: R.personal_video.ref, purpose: "personal_video", brokerageId: B1, rowId: "vp-1", contactId: C_LEAD })
  const pvG = pvGrant.ok ? pvGrant.grant : ""
  const pvFirst = await openDocumentReference(anonDeps, R.personal_video.ref, pvG)
  const pvStranger = await openDocumentReference(deps({ userId: U_B2, brokerageId: B2, userType: "agent" }), R.personal_video.ref)
  pvRow.contact_id = C1 // the video is re-addressed: the lead's authorization is gone
  const pvSigns = db.storage.signs.length
  const pvAfter = await openDocumentReference(anonDeps, R.personal_video.ref, pvG)
  pvRow.contact_id = C_LEAD
  check("PRIV-006 the personal video opens for ITS contact's grant (302), is refused to another tenant's seat, and the SAME grant is refused on the next click once the video is re-addressed — no link minted",
    pvFirst.status === 302 && pvStranger.status === 404 && pvAfter.status === 404 && same(pvAfter) && db.storage.signs.length === pvSigns,
    JSON.stringify([pvFirst.status, pvStranger.status, pvAfter.status]))
  const marketing = { video_type: PUBLIC_MARKETING_VIDEO_TYPES[0], contact_id: null, approval_status: "approved", status: "completed", compliance_status: "passed", video_url: "https://proj.supabase.co/storage/v1/object/public/video-assets/reel.mp4" }
  const hostPublic = renderHostBucketFor({ contact_id: null })
  const hostPersonal = renderHostBucketFor({ contact_id: C_LEAD })
  const signsBeforePublic = db.storage.signs.length
  check("PRIV-006 a public marketing video: classified public, hosted in a PUBLIC media bucket (its URL plays with no login, no door, nothing minted); the same video addressed to a contact is refused publication and hosted in a document-class bucket",
    classifyPublicVideo(marketing).public === true && !isDocumentClassBucket(hostPublic) && db.storage.signs.length === signsBeforePublic
    && classifyPublicVideo({ ...marketing, contact_id: C_LEAD }).public === false && isDocumentClassBucket(hostPersonal),
    JSON.stringify({ hostPublic, hostPersonal }))

  control("the parser refuses traversal and non-references", parseDocumentRef("docref://documents/a/../b.pdf") === null && parseDocumentRef("https://example.com/a.pdf") === null && parseDocumentRef("docref://BAD BUCKET/x") === null && toDocumentRef("documents", "a b/c.pdf") === "docref://documents/a%20b/c.pdf")

  console.log(`\n${failures === 0 ? "GREEN" : "RED"} — document-links-sign-on-read: ${failures} failure(s) (SIMULATED)`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
