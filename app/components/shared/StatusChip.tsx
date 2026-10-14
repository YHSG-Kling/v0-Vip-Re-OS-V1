"use client"

// Same-body census, round 4 (2026-09-09, lane FC). Survivor for the
// byte-identical private `StatusChip` component in
// app/components/settings/YourWebsiteCard.tsx:30 and
// app/settings/users/sso-connection-card.tsx:34 — only the component was
// duplicated; each caller keeps its OWN status → { label, cls } map (the data
// genuinely differs: DNS states on one, SSO connection states on the other),
// passed in as `map`.

export interface StatusChipEntry {
  label: string
  cls: string
}

export function StatusChip({
  status,
  map,
}: {
  status: string
  map: Record<string, StatusChipEntry>
}) {
  const chip = map[status] ?? { label: status, cls: "bg-gray-50 text-gray-600 border-gray-200" }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>
      {chip.label}
    </span>
  )
}
