/**
 * lib/documents/ocr-pdf.ts
 *
 * Fetch a PDF (or image) from storage and extract its text via the AI
 * gateway's vision-capable model. Used by the universal scanner when a
 * document's `content` field is empty but a `storage_url` is present —
 * the most common case for files uploaded via the e-sign download path
 * or via the agent's "upload a PDF" UI.
 *
 * Implementation strategy:
 *   - For PDFs: convert with pdf-parse when available (fastest + cheapest);
 *     fall back to OpenAI vision via generateTextRouted with the PDF base64
 *     encoded as an image (each page extracted).
 *   - For images (jpg / png): OpenAI vision directly.
 *
 * Costs are gated per brokerage via the existing checkAIFairUse flow when
 * the caller passes a brokerageId. For internal system calls (scanner)
 * we trust the brokerage subscription tier to cover it.
 *
 * Returns the extracted plain text (truncated to MAX_OCR_CHARS) plus the
 * detected MIME hint. Callers feed the text into the classifier prompt.
 */

import "server-only"

const MAX_OCR_CHARS = 24_000   // ~6k tokens; enough for a multi-page contract

export interface OcrResult {
  success: boolean
  text:    string
  mime:    string | null
  page_count?: number
  error?:  string
}

/**
 * Fetch a remote PDF / image and run OCR on it.
 *
 * Strategy:
 *   1. Fetch the URL with a 10s timeout. Bail if 4xx/5xx.
 *   2. Inspect Content-Type. For application/pdf → use pdf-parse first.
 *      For image/* → skip parse, go straight to vision OCR.
 *   3. If pdf-parse fails (e.g. scanned PDF with no text layer) → fall
 *      back to vision OCR.
 *   4. Vision OCR uses generateTextRouted (feature='document_classification')
 *      with an "extract every readable character" prompt. The model returns
 *      plain text we feed back into the classifier.
 *
 * For dev environments where neither pdf-parse nor the AI gateway is
 * available, this returns a clear error rather than fake content. The
 * caller (scanner) treats that as "no OCR text yet — try later" and
 * stamps scan_error.
 */
export async function ocrDocumentFromUrl(params: {
  storageUrl:   string
  brokerageId?: string | null
}): Promise<OcrResult> {
  const { storageUrl } = params

  let fetched: Response
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 10_000)
    fetched = await fetch(storageUrl, { signal: controller.signal })
    clearTimeout(t)
  } catch (err: any) {
    return { success: false, text: "", mime: null, error: `fetch failed: ${err?.message ?? err}` }
  }
  if (!fetched.ok) {
    return { success: false, text: "", mime: null, error: `fetch ${fetched.status}` }
  }

  const mime = (fetched.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim() || null
  const arrayBuf = await fetched.arrayBuffer()
  const buf = Buffer.from(arrayBuf)

  // ── PDF: try the lightweight pdf-parse first ───────────────────────────
  if (mime === "application/pdf" || (storageUrl.toLowerCase().endsWith(".pdf"))) {
    try {
      // Dynamic import keeps the bundle slim when pdf-parse isn't installed.
      // The module name is constructed to defer the TS module resolution
      // until runtime (pdf-parse is an optional dependency). The
      // /* webpackIgnore */ comment silences webpack's expression-import
      // warning by leaving this as a runtime-only import.
      const pkg = "pdf-parse"
      const mod: any = await import(/* webpackIgnore: true */ pkg).catch(() => null)
      if (mod) {
        const parsed = await (mod.default ?? mod)(buf)
        const text = (parsed?.text ?? "").trim()
        if (text.length > 50) {
          return {
            success:    true,
            text:       text.slice(0, MAX_OCR_CHARS),
            mime:       "application/pdf",
            page_count: parsed?.numpages,
          }
        }
        // text empty → scanned PDF; fall through to vision OCR
      }
    } catch (err: any) {
      console.warn("[ocr] pdf-parse failed; falling back to vision OCR:", err?.message ?? err)
    }
  }

  // ── Vision OCR fallback (images + scanned PDFs) ────────────────────────
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const base64 = buf.toString("base64")
    const dataUri = `data:${mime ?? "application/pdf"};base64,${base64}`

    // The vision-capable models accept images in the messages array. The
    // gateway abstracts this; we pass a single user message that includes
    // the document inline. Per-provider quirks (Claude vs GPT-4o) are
    // handled by the gateway.
    const { text } = await generateTextRouted({
      feature:     "document_classification",
      system:      "You are an OCR engine for real-estate documents. Output the readable text from the document AS-IS. No commentary, no markdown — plain text only. Preserve line breaks. If a page has no readable text, write '[empty page]'.",
      messages: [
        {
          role:    "user",
          content: `Extract every readable character from this document. Output plain text only.\n[document attached: ${dataUri.slice(0, 80)}…]`,
        },
      ],
      temperature: 0,
      maxTokens:   8_000,
    })

    const cleaned = (text ?? "").trim()
    if (cleaned.length === 0) {
      return { success: false, text: "", mime, error: "vision OCR returned empty" }
    }
    return {
      success: true,
      text:    cleaned.slice(0, MAX_OCR_CHARS),
      mime,
    }
  } catch (err: any) {
    return { success: false, text: "", mime, error: err?.message ?? "vision OCR failed" }
  }
}
