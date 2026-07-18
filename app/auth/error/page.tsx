import { redirect } from "next/navigation"

// Superseded by the auth callback's error rail (/login?message=…, see
// app/auth/callback/route.ts). Kept as a redirect stub instead of deleted:
// this path may still be configured as an OAuth error-redirect target in the
// hosted Supabase auth config, which is not verifiable in-repo — a deletion
// would 404 those redirects. Exempted in scripts/orphan-route-sweep.ts.
export default async function LegacyAuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  redirect(`/login?message=${encodeURIComponent(error || "error")}`)
}
