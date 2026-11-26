/**
 * lib/documents/ocr-pdf.ts
 *
 * THE DOCUMENT READER — fetch a PDF / image / digital receipt and return its text, page by page. Used by the
 * universal scanner (lib/documents/scan-uploaded-document.ts) when a document's `content` is empty, by the
 * document compliance audit's text pass, and by the receipt reader (lib/documents/receipt-intake.ts).
 *
 * Order of readers — the cheapest honest one first, OCR only where justified:
 *   1. NATIVE TEXT. A text-layer PDF through pdf-parse (when installed); a digital receipt / email body (text/plain,
 *      text/html) decoded as-is. No model call.
 *   2. VISION. Images (photos, scans) and PDFs with no text layer go to the routed vision lane
 *      (AI_TASK_ROUTING.document_image_scan) through the ONE raw gateway egress, lib/ai/gateway-chat.ts, with the
 *      document attached as an image part.
 *
 * WAVE 152 (lane 152D) — THE VISION PATH NEVER SAW THE DOCUMENT. It called generateTextRouted, whose `messages`
 * take text only, and attached `[document attached: data:image/jpeg;base64,/9j/4AAQ…]` — the first 80 characters of
 * the data URL — as TEXT. The model was asked to "extract every readable character" from a document it could not
 * see, so every photo, scanned PDF and image-only contract that reached it was classified from INVENTED text. It
 * also passed no brokerageId, so that spend was never booked to the tenant (CLAUDE.md §5: a wrong number on
 * ai_tool_usage is a wrong invoice). Now:
 *   · the image goes as an `image_url` content part (the shape app/actions/business-card/business-card-actions.ts
 *     proved in wave 141F);
 *   · the model is the routing table's, resolved at call time — never a literal here;
 *   · the tenant's AI entitlement and budget are asked FIRST (mayUseAndAfford), fail closed;
 *   · the cost is BOOKED (logAIUsage) — the gateway's own token count when it reports one, an estimate that says so
 *     otherwise;
 *   · the reader keeps page boundaries ("=== PAGE n ===") and returns quality flags (rotated, blurry, cut off …), so a
 *     downstream extractor can cite the page a value came from and a degraded photo lowers confidence;
 *   · `[illegible]` is written where a mark cannot be read — the prompt forbids a guess.
 * For a scanned PDF the routed provider may refuse a PDF data URL; that is returned as an honest failure, never
 * replaced with content.
 *
 * `allowVision: false` keeps a caller on the text layer only (the compliance audit's stated "NO vision" contract).
 */

import "server-only"
import { createHash } from "node:crypto"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const MAX_OCR_CHARS = 24_000   // ~6k tokens; enough for a multi-page contract
const VISION_MAX_OUTPUT_TOKENS = 6_000
/** Image tokens per attached page image (w × h / 750 for a resized phone photo) — used ONLY when the gateway reports no usage. */
const IMAGE_TOKEN_ESTIMATE = 1_600

export interface OcrResult {
  success: boolean
  text:    string
  mime:    string | null
  page_count?: number
  error?:  string
  /** Which reader produced the text. */
  reader?: "native_text" | "vision"
  /** The text split on page boundaries (a single unmarked reading is page 1). */
  pages?: Array<{ page: number; text: string }>
  /** What the vision reader reported about the image itself (rotated, blurry, cut_off, glare, low_light, partial_page, handwritten). */
  quality_flags?: string[]
  /** sha256 of the exact bytes read — the document version a downstream extraction cites. */
  sha256?: string
}

const VISION_PROMPT = `Transcribe this document exactly as it is printed or written.
Rules:
- Output plain text only. Begin every page with a line "=== PAGE n ===" (n = 1, 2, 3 …) in page order.
- Copy every name, number, date and amount exactly as shown. Do not correct, complete, total, convert or reformat anything.
- Where a word or number cannot be read, write [illegible] in its place. Never guess a value.
- Keep each table row on one line with columns separated by " | ".
- After the last page write exactly one line: QUALITY_FLAGS: followed by a comma-separated list from rotated, blurry, cut_off, glare, low_light, partial_page, handwritten — or QUALITY_FLAGS: none`

/** The proof seams. Production passes none: the routed model, mayUseAndAfford, gatewayChat and logAIUsage run. */
export interface ReaderSeams {
  model?: () => Promise<{ alias: string; slug: string }>
  afford?: (brokerageId: string, estTokens: number) => Promise<{ allowed: boolean; message?: string }>
  chat?: (args: { model: string; messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }>; maxTokens: number; temperature: number }) => Promise<{ ok: boolean; content: string | null; error: string | null; usage: { inputTokens: number; outputTokens: number } | null }>
  book?: (row: { userId: string | null; brokerageId: string | null; model: string; inputTokens: number; outputTokens: number; feature: string; manager: string; executionTimeMs: number; success: boolean; contextExtra: Record<string, unknown> }) => Promise<void>
}

function pagesOf(text: string): Array<{ page: number; text: string }> {
  const parts = text.split(/^=== PAGE (\d+) ===\s*$/m)
  if (parts.length < 3) return [{ page: 1, text: text.trim() }]
  const out: Array<{ page: number; text: string }> = []
  for (let i = 1; i < parts.length; i += 2) out.push({ page: Number(parts[i]), text: (parts[i + 1] ?? "").trim() })
  return out
}

function stripHtml(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#36;/g, "$")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim()
}

async function defaultModel(): Promise<{ alias: string; slug: string }> {
  const { selectModelForTask } = await import("@/lib/ai/models")
  const { resolveModel } = await import("@/lib/ai/resolve-model")
  const { model } = selectModelForTask("document_image_scan")
  return { alias: model, slug: String(resolveModel(model as Parameters<typeof resolveModel>[0])) }
}

/**
 * Read a document already in memory (the receipt upload hands its bytes straight here — nothing is re-fetched).
 * `brokerageId` must be the SESSION's tenant or the tenant of a row read under a tenant predicate (CLAUDE.md §4).
 */
export async function ocrDocumentFromBuffer(
  params: { buffer: Buffer; mime: string | null; fileName?: string | null; brokerageId: string | null; userId?: string | null; allowVision?: boolean; manager?: string },
  seams: ReaderSeams = {},
): Promise<OcrResult> {
  const buf = params.buffer
  const mime = (params.mime ?? "").toLowerCase().split(";")[0].trim() || null
  const sha256 = createHash("sha256").update(buf).digest("hex")
  const name = (params.fileName ?? "").toLowerCase()

  // ── 1. NATIVE TEXT ─────────────────────────────────────────────────────
  if (mime === "text/plain" || mime === "text/html" || name.endsWith(".txt") || name.endsWith(".html") || name.endsWith(".eml")) {
    const raw = buf.toString("utf8")
    const text = (mime === "text/html" || name.endsWith(".html") ? stripHtml(raw) : raw).trim()
    if (text.length === 0) return { success: false, text: "", mime, error: "the file has no readable text", sha256 }
    const clipped = text.slice(0, MAX_OCR_CHARS)
    return { success: true, text: clipped, mime, reader: "native_text", pages: [{ page: 1, text: clipped }], page_count: 1, quality_flags: [], sha256 }
  }
  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    try {
      // Dynamic import keeps the bundle slim when pdf-parse isn't installed. The module name is constructed to
      // defer the TS module resolution until runtime (pdf-parse is an optional dependency); /* webpackIgnore */
      // leaves it a runtime-only import.
      const pkg = "pdf-parse"
      const mod: any = await import(/* webpackIgnore: true */ pkg).catch(() => null)
      if (mod) {
        const parsed = await (mod.default ?? mod)(buf)
        const text = (parsed?.text ?? "").trim()
        if (text.length > 50) {
          // pdf-parse separates pages with form feeds; keep the boundary so a value can cite its page.
          const pageTexts = text.split("\f").map((t: string) => t.trim()).filter((t: string) => t.length > 0)
          const pages = pageTexts.length > 1 ? pageTexts.map((t: string, i: number) => ({ page: i + 1, text: t })) : [{ page: 1, text }]
          return {
            success:    true,
            text:       text.slice(0, MAX_OCR_CHARS),
            mime:       "application/pdf",
            page_count: parsed?.numpages,
            reader:     "native_text",
            pages,
            quality_flags: [],
            sha256,
          }
        }
        // text empty → scanned PDF; fall through to vision
      }
    } catch (err: any) {
      console.warn("[ocr] pdf-parse failed; falling back to vision:", err?.message ?? err)
    }
  }

  if (params.allowVision === false) {
    return { success: false, text: "", mime, error: "no text layer, and this caller reads text layers only", sha256 }
  }

  // ── 2. VISION (images, scanned PDFs) — the routed lane, metered ───────────
  const estTokens = IMAGE_TOKEN_ESTIMATE + Math.ceil(VISION_PROMPT.length / 4) + VISION_MAX_OUTPUT_TOKENS
  if (params.brokerageId) {
    const afford = seams.afford ?? (async (brokerageId: string, est: number) => {
      const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
      const v = await mayUseAndAfford({ brokerageId, capability: "ai.generate", estTokens: est })
      return { allowed: v.allowed, message: v.message ?? (v.allowed ? undefined : `AI reading is not available on this account right now (${v.reason}).`) }
    })
    const gate = await afford(params.brokerageId, estTokens)
    if (!gate.allowed) return { success: false, text: "", mime, error: gate.message ?? "AI reading is not available on this account right now.", sha256 }
  }

  let model: { alias: string; slug: string }
  try {
    model = await (seams.model ?? defaultModel)()
  } catch (err: any) {
    return { success: false, text: "", mime, error: `vision lane unavailable: ${err?.message ?? err}`, sha256 }
  }
  const chat = seams.chat ?? (async (args: Parameters<NonNullable<ReaderSeams["chat"]>>[0]) => {
    const { gatewayChat } = await import("@/lib/ai/gateway-chat")
    return gatewayChat(args)
  })
  const dataUrl = `data:${mime ?? "application/octet-stream"};base64,${buf.toString("base64")}`
  const startedAt = Date.now()
  let response: Awaited<ReturnType<NonNullable<ReaderSeams["chat"]>>>
  try {
    response = await chat({
      model: model.slug,
      maxTokens: VISION_MAX_OUTPUT_TOKENS,
      temperature: 0,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: VISION_PROMPT }] }],
    })
  } catch (err: any) {
    response = { ok: false, content: null, error: err?.message ?? "vision call threw", usage: null }
  }

  // BOOK THE COST — the gateway's count when it gave one, an estimate (and the row says so) otherwise.
  try {
    const book = seams.book ?? (async (row: Parameters<NonNullable<ReaderSeams["book"]>>[0]) => {
      const { logAIUsage } = await import("@/lib/ai/cost-tracking")
      await logAIUsage({ ...row, model: row.model as Parameters<typeof logAIUsage>[0]["model"] })
    })
    const outputText = response.content ?? ""
    await book({
      userId: params.userId ?? null,
      brokerageId: params.brokerageId,
      model: model.alias,
      inputTokens: response.usage?.inputTokens ?? (IMAGE_TOKEN_ESTIMATE + Math.ceil(VISION_PROMPT.length / 4)),
      outputTokens: response.usage?.outputTokens ?? Math.ceil(outputText.length / 4),
      feature: "document_image_scan",
      manager: params.manager ?? "deal_coordinator",
      executionTimeMs: Date.now() - startedAt,
      success: response.ok,
      contextExtra: { token_basis: response.usage ? "gateway_usage" : "estimated", mime, bytes: buf.length, sha256 },
    })
  } catch (err: any) {
    console.error("[ocr] ai_tool_usage not booked:", err?.message ?? err)
  }

  if (!response.ok) return { success: false, text: "", mime, error: response.error ?? "vision reader failed", sha256 }
  const raw = (response.content ?? "").trim()
  const flagLine = /^QUALITY_FLAGS:\s*(.*)$/im.exec(raw)
  const quality_flags = flagLine && !/^none$/i.test(flagLine[1].trim())
    ? flagLine[1].split(",").map((f) => f.trim().toLowerCase().replace(/\s+/g, "_")).filter((f) => /^[a-z_]{3,20}$/.test(f))
    : []
  const body = raw.replace(/^QUALITY_FLAGS:.*$/im, "").trim()
  if (body.replace(/=== PAGE \d+ ===/g, "").replace(/\[illegible\]/gi, "").trim().length === 0) {
    return { success: false, text: "", mime, error: "the reader found no readable text on the document", quality_flags, sha256 }
  }
  const clipped = body.slice(0, MAX_OCR_CHARS)
  const pages = pagesOf(clipped)
  return { success: true, text: clipped, mime, reader: "vision", pages, page_count: pages.length, quality_flags, sha256 }
}

/**
 * Fetch a remote PDF / image and read it. Strategy unchanged for existing callers: fetch with a 10 s timeout, then
 * the same readers as ocrDocumentFromBuffer. For dev environments where neither pdf-parse nor the AI gateway is
 * available, this returns a clear error rather than fake content; the scanner treats that as "no OCR text yet".
 */
export async function ocrDocumentFromUrl(params: {
  storageUrl:   string
  brokerageId?: string | null
  userId?:      string | null
  allowVision?: boolean
}): Promise<OcrResult> {
  const { storageUrl } = params

  const fetched = await callConnector<Buffer>({
    connector: "asset-download", baseUrl: "", path: "", url: storageUrl,
    method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 10_000,
  })
  if (!fetched.ok || !fetched.data) {
    return { success: false, text: "", mime: null, error: `fetch ${fetched.status ?? "failed"}` }
  }

  const headerMime = (fetched.headers["content-type"] ?? "").toLowerCase().split(";")[0].trim() || null
  const path = storageUrl.toLowerCase().split("?")[0]
  return ocrDocumentFromBuffer({
    buffer: fetched.data,
    mime: headerMime ?? (path.endsWith(".pdf") ? "application/pdf" : null),
    fileName: path.split("/").pop() ?? null,
    brokerageId: params.brokerageId ?? null,
    userId: params.userId ?? null,
    allowVision: params.allowVision,
  })
}
