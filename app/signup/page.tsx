import { permanentRedirect } from "next/navigation"
import { cleanCarriedZip } from "@/lib/platform/territory-marketplace"

export const dynamic = "force-dynamic"
export const metadata = { title: "Start your free trial — VIP RE OS" }

// ─────────────────────────────────────────────────────────────────────────────
// TWO PUBLIC SIGNUP FUNNELS → ONE. /signup now redirects to /get-started.
//
// Both pages sold the same 14-day trial, loaded the same subscription_tiers rows
// through the same loadPublicTiers, and ended in the same signupBrokerageAction.
// They were not two products — they were two front doors to one, and only one of
// them was wired for how the platform actually acquires customers.
//
// /get-started is the keeper because it is strictly the superset:
//   · UTM attribution (?utm_source / ?utm_campaign, stamped as the tenant's
//     source) — without it paid and organic acquisition are indistinguishable;
//   · affiliate / referral capture (?ref → refCaptureRedirect), which /api/ref
//     already redirects into, so a prospect arriving on a referral link could
//     never have landed here in the first place;
//   · coupon validation + redemption;
//   · the tier's LIVE funnel snapshot, so a new tenant's website comes up
//     branded on day one;
//   · the prospect-capture form for visitors not ready to sign up.
//
// A signup through /signup got NONE of that: same money in, no attribution, no
// referral credit, no coupon, no branded provisioning. The acquisition record
// simply did not exist for anyone who came through this door.
//
// PORTED BEFORE RETIRING — the one thing /signup had that /get-started lacked:
// the territory-marketplace carry. /pricing's territory CTA hands off with
// ?zip=, which now rides through /get-started into signupBrokerageAction's
// territoryZip (a field it already accepted) and is shown in the form. Both
// ?tier= and ?zip= are preserved across this redirect, so /pricing's existing
// hand-offs keep working unchanged.
//
// KEPT AS A ROUTE rather than deleted: /signup is a PUBLIC url. It is named in
// robots.ts, revalidated by the plan-catalog actions, and may sit in bookmarks,
// ad copy or inbound links this repo cannot see. A permanent redirect preserves
// every one of those; deleting the route would 404 them.
export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ tier?: string; zip?: string }>
}) {
  const params = await searchParams
  const keep = new URLSearchParams()
  if (params.tier) keep.set("tier", params.tier)
  const zip = cleanCarriedZip(params.zip)
  if (zip) keep.set("zip", zip)
  const qs = keep.toString()

  // 308 — the move is permanent, so clients and crawlers should update.
  permanentRedirect(`/get-started${qs ? `?${qs}` : ""}`)
}
