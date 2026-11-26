/**
 * scripts/open-loop-ledger-dispositions-154m.ts — wave 154, lane 154M (sign-on-read for private documents).
 *
 * The two rows that carried "10-year persisted signed URLs" (146A-SO-02, and its convergence twin 146Z-NC-02) are CLOSED by
 * code evidence the generator re-derives on every run (`path#anchor` in STRIPPED source, `key:`): a row stores a docref://
 * reference (putAndSign / issueBucketObjectUrl), the ten-year default is gone, the signer clamps every lifetime to the
 * one-hour ceiling, and the ONE open door decides access on every click. test:document-links-sign-on-read proves it —
 * census with positive controls plus the executed revocation case (a reassigned agent is refused on the next click) —
 * SIMULATED (fake Supabase; live rows carrying such links measured 0 by the integrator on 2026-11-18).
 * Spread LAST into MANUAL_DISPOSITIONS (scripts/open-loop-ledger-dispositions.ts), after 154K.
 */
import type { Disposition } from "./open-loop-ledger"

const M = "wave 154 lane 154M at 0c18c7ca"
const cl = (e: string[], note: string): Disposition => ({ s: "closed", e, by: `${M} — ${note}`, lc: true })

const SIGN_ON_READ_EVIDENCE = [
  "key:test:document-links-sign-on-read",
  "lib/storage/signed-doc-url.ts#export const DOC_LINK_TTL_CEILING_SECONDS = 60 * 60",
  "lib/storage/signed-doc-url.ts#return Math.min(Math.max(n, 1), DOC_LINK_TTL_CEILING_SECONDS)",
  "lib/storage/put-and-sign.ts#if (ref) return { ok: true, path: up.path, ref }",
  "lib/storage/document-buckets.ts#return { ok: true, url: toDocumentRef(bucket, objectPath), kind: \"reference\", ttlSeconds: null }",
  "app/api/documents/open/route.ts#const answer = await openDocumentReference(",
  "app/dashboard/onboarding/license/license-intake-client.tsx#documentUrl: toDocumentRef(\"agent-documents\", fileName)",
]
const FIXED = "FIXED — no row stores a bearer link: putAndSign and the issuer return a docref:// reference (transaction_documents.storage_url, client_documents.document_url, offers.offer_document_url, agent_licenses.document_url and the other door columns); DOC_URL_TTL_SECONDS is deleted and the signer clamps to one hour; every view goes through /api/documents/open (session tenant → row by reference → the row kind's access rule → a 5-minute link); server consumers resolve at use time. RLS-revocation now holds on the next click (proved: a reassigned deal's former agent is refused)"

export const WAVE154M_DISPOSITIONS: Record<string, Disposition> = {
  "146A-SO-02": cl(SIGN_ON_READ_EVIDENCE, FIXED),
  "146Z-NC-02": cl(SIGN_ON_READ_EVIDENCE, `${FIXED}; the ~100 readers were not rewritten — the reference resolves through one pure helper (documentOpenHref) at the mappers / render sites that show a link`),
}
