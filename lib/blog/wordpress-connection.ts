// lib/blog/wordpress-connection.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE WORDPRESS PUBLISH PATH ASKED A QUESTION THE DATABASE CANNOT ANSWER.
//
// publishToWordPress is complete: it renders the post, injects the view-tracker
// and share block, sets the rel="canonical" back to the hosted URL for the
// 'both' target, and POSTs to the WordPress REST API. blog_posts.publish_target
// admits 'wordpress' and 'both'; the blog editor renders a "Publish to
// WordPress" button. Everything downstream of the credential is real.
//
// The credential itself never was. The action read:
//
//     .from("platform_credentials").eq("platform", "wordpress")
//
// and platform_credentials.platform is CHECK-constrained. 'wordpress' is not one
// of its admitted values, so that filter matched nothing — on every call, for
// every brokerage, since the feature shipped. The caller then reported
// "WordPress credentials not configured", which reads as an instruction to go
// configure it. There is nowhere to configure it:
//
//   · lib/connections/scope.ts (the Connection OS — the single source of truth
//     for what each scope may connect) has no cms/blog domain, so no connect
//     flow offers WordPress and none can write that row;
//   · even if one did, the CHECK would reject the write.
//
// So a broker following the error message would have looked for a setting that
// does not exist, and the button would have kept failing with the same words.
//
// ── WHY THIS IS NOT SIMPLY FIXED HERE ────────────────────────────────────────
// The obvious "fix" is to widen the CHECK. That is precisely the drift the
// consolidation rule exists to stop: providers are decided ONCE in the
// Connection OS, and owned (platform-provided vs tenant-supplied) ONCE in
// lib/providers/tenancy-matrix.ts. Adding a vendor to a CHECK so a call site
// stops failing creates a second, invisible allow-list — which is how the
// settings pages ended up with providers mapped across many pages before they
// were consolidated onto the Connection OS.
//
// There IS prior intent on record for WordPress specifically, unlike the other
// vendors that got swept into the same CHECK:
//   · m140/m141 designed the publish_target ladder deliberately, noting that
//     many brokerages don't run WordPress and hosted/embed exist for them;
//   · lib/kernel/manager-registry.ts records "WordPress-target stays manual
//     (per-tenant creds)" — i.e. WordPress was understood to be a TENANT
//     credential, not a platform one.
//
// That makes it a real candidate, not an invention. But turning it on is a
// four-part decision — a `cms` domain in CONNECTOR_PROVIDERS, its DOMAIN_AUTH
// field spec (site URL + application password), an api_url-carrying credential
// write shape, and a tenancy-matrix row — and that belongs to the owner.
//
// ── WHAT THIS MODULE DOES ────────────────────────────────────────────────────
// It answers honestly instead of asking an impossible question: no connectable
// WordPress provider means no credential, stated as such, with no query issued.
// The moment `cms` lands in the Connection OS, WORDPRESS_DOMAIN below resolves
// and the lookup runs — the publish path itself needs no further change.

import { CONNECTOR_PROVIDERS } from "@/lib/connections/scope"

/** The connector domain WordPress would live under, once it is decided. */
const WORDPRESS_DOMAIN = "cms"
const WORDPRESS_PROVIDER = "wordpress"

export interface WordPressCredential {
  api_url: string | null
  api_key: string | null
  access_token: string | null
}

/**
 * PURE — is WordPress a provider this platform actually offers a connection for?
 * Derived from the Connection OS so it can never disagree with the settings UI:
 * if the Connection Center does not offer it, nothing here pretends it exists.
 */
export function isWordPressConnectable(): boolean {
  const providers = (CONNECTOR_PROVIDERS as Record<string, readonly string[]>)[WORDPRESS_DOMAIN]
  return Array.isArray(providers) && providers.includes(WORDPRESS_PROVIDER)
}

/**
 * PURE — the reason a WordPress publish cannot proceed, in words that match
 * reality. Not "credentials not configured" (which implies a settings screen
 * that does not exist) but what is actually true and what the alternatives are.
 */
export function wordPressUnavailableReason(): string {
  if (!isWordPressConnectable()) {
    return (
      "WordPress publishing is not available: WordPress is not a connectable " +
      "provider in Settings → Connections, so there is no site credential to " +
      "publish with. Use the Hosted or Embed publish target — both go live " +
      "immediately with no external account."
    )
  }
  return "WordPress credentials not configured. Connect your site in Settings → Connections."
}

/**
 * Resolve the brokerage's WordPress credential, or null.
 *
 * Returns null WITHOUT querying while WordPress is not connectable — the point
 * of this module is that the old code ran a filter the column could never match
 * and read the empty result as "not set up yet". A question that cannot be
 * answered should not be asked.
 */
export async function resolveWordPressCredential(
  supabase: { from: (t: string) => any },
  brokerageId: string,
): Promise<WordPressCredential | null> {
  if (!isWordPressConnectable()) return null

  const { data } = await supabase
    .from("platform_credentials")
    .select("api_url, api_key, access_token")
    .eq("brokerage_id", brokerageId)
    .eq("platform", WORDPRESS_PROVIDER)
    .eq("is_active", true)
    .maybeSingle()

  return (data as WordPressCredential | null) ?? null
}
