"use client"

/**
 * app/components/forms/refusal-notice.tsx — ONE way the forms screens say "no" (wave 156, lane 156C round 2): the refusal's plain
 * sentence and, when it has one, the place to fix it. Provider refusals carry a code (no_provider_selected / credentials_need_attention
 * / provider_unavailable / license_missing / form_not_in_provider_library — lib/forms/provider-form-directory.ts) whose recovery link
 * is shown; library and bundle refusals are already sentences.
 */
export function RefusalNotice({ message, href }: { message: string | null | undefined; href?: string | null }) {
  if (!message) return null
  const label = href === "/settings/integrations" ? "Open Settings → Integrations" : href ? "Fix it here" : null
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
      {href && label && (<>{" "}<a href={href} className="underline">{label}</a></>)}
    </p>
  )
}

/** PURE: the sentence and link of any forms-API error body. */
export function refusalOf(json: unknown): { message: string | null; href: string | null } {
  const j = (json ?? {}) as { error?: string; refused?: string; refusal?: { message?: string; recoverHref?: string } }
  return { message: j.refusal?.message ?? j.error ?? j.refused ?? null, href: j.refusal?.recoverHref ?? null }
}
