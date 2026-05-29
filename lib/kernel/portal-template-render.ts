/**
 * lib/kernel/portal-template-render.ts
 *
 * Pure render helper for client portal transparency templates. Kept out of the server-only
 * event-fanout module so it can be unit-tested directly. Transparency notices are proactive and
 * SPECIFIC, not generic: template strings may contain {key} tokens filled from the event metadata
 * (e.g. real contract dates — earnest money due, inspection deadline, closing). A missing/blank key
 * renders as "TBD" so a partially-known milestone still posts something useful rather than a raw
 * token.
 */
export function renderTemplateText(
  text:     string | undefined,
  metadata: Record<string, any> | undefined,
): string | undefined {
  if (!text || !text.includes("{")) return text
  return text.replace(/\{([a-z0-9_]+)\}/gi, (_m, key: string) => {
    const v = metadata?.[key]
    return v === undefined || v === null || v === "" ? "TBD" : String(v)
  })
}
