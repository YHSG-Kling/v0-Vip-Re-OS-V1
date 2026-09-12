import { redirect } from "next/navigation"
import { toMagicLinkMessage } from "@/app/types/auth"

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
  // Narrowed onto the one magic-link vocabulary (app/types/auth.ts) rather than
  // forwarded raw: whatever the hosted auth config puts in `?error=` is a
  // provider string, and /login now REFUSES anything outside the roster. Passing
  // it through unnarrowed would land on the login page as silence.
  redirect(`/login?message=${toMagicLinkMessage(error) ?? "error"}`)
}
