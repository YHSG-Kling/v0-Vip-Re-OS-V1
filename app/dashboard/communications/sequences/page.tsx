import { redirect } from "next/navigation"

export default async function SequencesRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    const v = Array.isArray(value) ? value[0] : value
    if (v !== undefined) qs.set(key, v)
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : ""
  redirect(`/dashboard/campaigns/sequences${suffix}`)
}
