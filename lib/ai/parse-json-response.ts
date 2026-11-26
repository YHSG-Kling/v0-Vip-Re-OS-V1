// lib/ai/parse-json-response.ts
// Strip a ```json / ``` markdown code fence off an LLM text response, if
// present, and JSON.parse the remainder. Survivor for FOUR byte-identical
// private `parseAIJsonResponse` copies (SAME BODY census round 3,
// 2026-09-09): app/actions/ai-content-generation.tsx:42,
// app/actions/content-studio.ts:21, app/actions/open-house-automation.ts:16,
// app/actions/social-media-automation.ts:103 — §1/§6.
//
// Throws (does not swallow) a malformed-JSON SyntaxError, exactly as every
// former copy did — callers already wrap this in their own try/catch.
// Generic so a caller keeps the loosely-typed shape every former copy returned (they were `any`);
// the default stays `any` rather than `unknown` deliberately — narrowing it broke 27 call sites at once.
export function parseAIJsonResponse<T = any>(text: string): T {
  let cleanText = text.trim()
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/^```json\s*/, "").replace(/```\s*$/, "")
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```\s*/, "").replace(/```\s*$/, "")
  }
  return JSON.parse(cleanText.trim())
}
