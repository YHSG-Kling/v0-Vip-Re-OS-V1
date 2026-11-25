/**
 * lib/lead-intelligence/visitor-site-binding.ts — is this page a site the tenant registered? (wave 156, lane 156F)
 *
 * The public tracking pixel (app/api/track/pixel/route.ts) cannot use a session: a stranger on the tenant's website
 * fires it. What binds a hit to a tenant is the tenant's OWN SITE — the hosts it registered:
 *   · ACTIVE verified custom domains (tenant_custom_domains, status 'active'), and
 *   · the website it declared (brokerage_brand_settings.website_url, brokerages.website),
 * read through THE one tenant-host reader, lib/marketing/qr-governance.ts loadQrTenantHosts (LAW 2 — no second list).
 *
 * A page host matches a registered host exactly, as its `www.` twin, or as a subdomain of it. No page host, an
 * unparseable one or no registered host at all → false (fail closed: a tenant that registered no site records nothing).
 */

type Db = { from: (table: string) => any }

function hostOf(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** PURE — does `pageHost` belong to one of `registered`? */
function hostMatchesRegistered(pageHost: string | null, registered: readonly string[]): boolean {
  if (!pageHost) return false
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "")
  const p = bare(pageHost)
  return registered.some((r) => {
    const h = bare(r)
    return !!h && (p === h || p.endsWith(`.${h}`))
  })
}

export async function pageHostRegisteredForTenant(db: Db, brokerageId: string, pageUrl: string | null | undefined): Promise<boolean> {
  const pageHost = hostOf(pageUrl)
  if (!pageHost || !brokerageId) return false
  const { loadQrTenantHosts } = await import("@/lib/marketing/qr-governance")
  const { customDomains, websiteHosts } = await loadQrTenantHosts(db, brokerageId)
  return hostMatchesRegistered(pageHost, [...customDomains, ...websiteHosts])
}
