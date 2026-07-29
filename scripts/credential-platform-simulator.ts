#!/usr/bin/env tsx
/**
 * scripts/credential-platform-simulator.ts   (npm run test:credential-platform) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * FIVE FINISHED INTEGRATIONS THAT COULD NOT STORE A CREDENTIAL.
 *
 * platform_credentials.platform admitted 53 values. Five complete, working
 * consumer paths named a value that was not among them, so each ran end to end
 * and failed on the very last write — the credential row itself.
 *
 *   'google'    GOOGLE ADS. The OAuth route carries a full google_ads provider:
 *               real authorize + token URLs, the adwords scope, the developer
 *               token folded into config. Its own comment says the credential is
 *               "Stored under platform='google'" because that is "what the ad
 *               connector loads". The round-trip completed, the token was
 *               exchanged — and the insert was rejected.
 *   'xero'      ACCOUNTING. Same route, full xero provider (login.xero.com
 *               authorize, identity.xero.com token), stored platform falls
 *               through to 'xero'. accounting-sync.ts reads it for the connected
 *               state. Same shape.
 *   'wordpress' BLOG PUBLISHING. publishToWordPress is finished — it reads
 *               api_url + api_key/access_token, builds the auth header, POSTs to
 *               /wp-json/wp/v2/posts. blog_posts.publish_target already admits
 *               'wordpress' and the editor renders a WordPress publish button.
 *               The credential it needs is exactly what the generic "Add
 *               Platform Credential" form collects, so the ONLY thing that ever
 *               stopped it was this CHECK: the publisher returned "WordPress
 *               credentials not configured" forever and no broker could ever
 *               configure them.
 *
 *   'platform_quickbooks' / 'platform_zoom'
 *               THE m273 IDIOM, WHICH IS A SECURITY DESIGN. The platform's OWN
 *               QuickBooks and OWN Zoom are stored under DISTINCT keys on
 *               purpose: the tenant credential cascade falls back to
 *               owner_type='platform', so reusing the plain 'quickbooks' /
 *               'zoom' keys would let a brokerage with no connection of its own
 *               resolve — and bill against, or host meetings on — the COMPANY's
 *               account. Two modules and a superadmin surface enforce this and
 *               the codebase calls it "a leak impossible by construction".
 *               Neither key was admitted, so the platform could never connect
 *               its own books or its own Zoom. The failure was at least SAFE,
 *               but the feature was dead — and the obvious "fix" for someone who
 *               had not read those headers is to drop the distinct key and
 *               reintroduce exactly the leak it exists to prevent. That is why
 *               this simulator pins the keys apart.
 *
 * m297 adds all five. It does NOT add 'tiktok' — see below.
 *
 * ── WHY THIS CLASS OF BUG LIVED HERE ────────────────────────────────────────
 * The "Add Platform Credential" form takes the platform as FREE TEXT
 * ("e.g. dotloop, twilio, sendgrid") and wrote it straight into a
 * CHECK-constrained column. There was no shared list anywhere of what the column
 * accepts, so a near-miss came back as a raw Postgres constraint string that
 * does not say which platforms are valid. lib/integrations/credential-platforms.ts
 * is now that list: the action validates against it and the form offers it.
 *
 * ── THE ONE DELIBERATELY NOT ADDED ──────────────────────────────────────────
 * 'tiktok'. ad_campaigns.platform is a DIFFERENT column with a DIFFERENT
 * vocabulary (facebook|instagram|google|linkedin|tiktok|vibe_ctv), and the ads
 * workspace read platform_credentials using THAT list — which is how it came to
 * ask for a tiktok credential. There is no TikTok OAuth provider and no TikTok
 * connect form, so nothing in this codebase could ever write that row. Adding
 * the value would create a vocabulary entry nothing can produce, the same dead
 * literal this sweep has removed everywhere else.
 *
 * So the ads code changed instead. "Not connected" and "cannot be connected
 * here" are different facts, and a workspace showing the first when it means the
 * second is lying. The gap is now NAMED (unconnectableAdPlatforms) rather than
 * rendered as a disconnected account.
 *
 * ── AND THE CREDENTIAL GATE WAS DEAD CODE ───────────────────────────────────
 * createAdCampaign fetched the platform credential and DISCARDED the result —
 * the file header's rule 9 ("Provider account connection required before
 * campaign launch") was enforced nowhere. That is a large part of why nobody
 * noticed the query could not match for two of the five platforms it asked
 * about. A draft legitimately does not require a live connection, so it does not
 * block; it now reports accountConnected + accountConnectable.
 *
 * VERIFIED LIVE: all five new platforms store and each reader's EXACT predicate
 * then finds the row (the WordPress publisher's platform+is_active+api_url
 * filter, xero's connected-state read, the ads list); 'tiktok' and a near-miss
 * typo both still raise check_violation, so the widening is exact. Probes
 * deleted, count back to 0.
 */
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  CREDENTIAL_PLATFORMS, isCredentialPlatform,
  AD_CAMPAIGN_PLATFORMS, CONNECTABLE_AD_PLATFORMS,
  AD_PLATFORMS_WITHOUT_CREDENTIALS, isConnectableAdPlatform,
} from "../lib/integrations/credential-platforms"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")

console.log("══════════════════════════════════════════════════")
console.log(" Credential platforms (a finished integration can store its credential)")
console.log("══════════════════════════════════════════════════")

const live = CHECK_VOCABULARIES.platform_credentials?.platform ?? []

console.log("\n── the declared vocabulary IS the live one ──")
{
  check(`${CREDENTIAL_PLATFORMS.length} declared, ${live.length} live — same size`,
    CREDENTIAL_PLATFORMS.length === live.length)
  check("every declared platform is admitted",
    live.length > 0 && CREDENTIAL_PLATFORMS.every((p) => live.includes(p)))
  check("every live platform is declared — the module is not missing any",
    live.every((p) => (CREDENTIAL_PLATFORMS as readonly string[]).includes(p)))
  check("no duplicates in the declared list",
    new Set(CREDENTIAL_PLATFORMS).size === CREDENTIAL_PLATFORMS.length)
}

console.log("\n── the five finished integrations can now be stored ──")
{
  for (const p of ["google", "xero", "wordpress", "platform_quickbooks", "platform_zoom"]) {
    check(`'${p}' is admitted (m297)`, live.includes(p))
  }
  check("the platform-owned keys stay DISTINCT from the tenant ones — the leak guard",
    live.includes("quickbooks") && live.includes("platform_quickbooks") &&
    live.includes("zoom") && live.includes("platform_zoom"))
  check("…and the 53 that already worked still do — m297 is additive",
    ["dotloop", "twilio", "sendgrid", "stripe", "quickbooks", "zoom", "idxbroker",
     "platform_social_tiktok", "hubspot", "lob"].every((p) => live.includes(p)))
}

console.log("\n── each blocked consumer names a value it can now write ──")
{
  const oauth = src("app/api/integrations/oauth/[provider]/route.ts")
  // Scope the scan to the storedPlatform ternary chain. A whole-file sweep also
  // catches `?? "brokerage"` defaults, which are not platform keys.
  const chain = oauth.slice(
    oauth.indexOf("const storedPlatform ="),
    oauth.indexOf(": provider", oauth.indexOf("const storedPlatform =")),
  )
  const stored = [...chain.matchAll(/\?\s*"(\w+)"/g)].map((m) => m[1])
  check("the OAuth route's google_ads branch stores 'google'",
    /oauthProvider === "google_ads" \? "google"/.test(oauth) && live.includes("google"))
  check("the OAuth route declares a real xero provider",
    /xero:\s*\{/.test(oauth) && /login\.xero\.com/.test(oauth) && live.includes("xero"))
  check(`every platform the OAuth route stores is admitted (${stored.join(", ")})`,
    stored.length >= 5 && stored.every((s) => live.includes(s)))
  check("…including the two m273-idiom platform-owned keys",
    stored.includes("platform_quickbooks") && stored.includes("platform_zoom"))

  const blog = src("app/actions/blog.ts")
  check("the WordPress publisher reads platform='wordpress'",
    /\.eq\("platform", "wordpress"\)/.test(blog) && live.includes("wordpress"))
  check("…and needs exactly what the generic credential form collects",
    /api_url, api_key, access_token/.test(blog))

  const acct = src("app/actions/accounting-sync.ts")
  check("accounting-sync reads a xero credential",
    /"quickbooks", "xero"/.test(acct) && live.includes("xero"))
}

console.log("\n── the free-text form can no longer produce a raw constraint error ──")
{
  const act = src("app/actions/settings/integrations.ts")
  check("upsertPlatformCredential validates the platform", /isCredentialPlatform\(params\.platform\)/.test(act))
  check("…and the refusal NAMES the vocabulary instead of echoing Postgres",
    /is not a supported platform/.test(act) && /CREDENTIAL_PLATFORMS\.join/.test(act))

  const ui = src("app/dashboard/settings/integrations/integrations-client.tsx")
  check("the form offers the real list", /list="credential-platform-options"/.test(ui) &&
    /CREDENTIAL_PLATFORMS\.map/.test(ui))

  check("the guard accepts every real platform", CREDENTIAL_PLATFORMS.every(isCredentialPlatform))
  check("the guard rejects a near-miss typo", !isCredentialPlatform("wordpres"))
  check("the guard rejects 'tiktok'", !isCredentialPlatform("tiktok"))
  check("the guard rejects non-strings", !isCredentialPlatform(undefined) && !isCredentialPlatform(7))
}

console.log("\n── ads: the two vocabularies are separated, and the gap is named ──")
{
  check("'tiktok' is a CAMPAIGN platform", (AD_CAMPAIGN_PLATFORMS as readonly string[]).includes("tiktok"))
  check("…but NOT a credential platform — nothing could ever write it", !live.includes("tiktok"))
  check("every connectable ad platform IS a credential platform",
    CONNECTABLE_AD_PLATFORMS.every((p) => live.includes(p)))
  check("every connectable ad platform is also a campaign platform",
    CONNECTABLE_AD_PLATFORMS.every((p) => (AD_CAMPAIGN_PLATFORMS as readonly string[]).includes(p)))
  check("the two ad lists partition the campaign platforms with nothing left over",
    CONNECTABLE_AD_PLATFORMS.length + AD_PLATFORMS_WITHOUT_CREDENTIALS.length === AD_CAMPAIGN_PLATFORMS.length &&
    AD_CAMPAIGN_PLATFORMS.every((p) =>
      (CONNECTABLE_AD_PLATFORMS as readonly string[]).includes(p) !==
      (AD_PLATFORMS_WITHOUT_CREDENTIALS as readonly string[]).includes(p)))
  check("no unconnectable ad platform is a credential platform",
    AD_PLATFORMS_WITHOUT_CREDENTIALS.every((p) => !live.includes(p)))
  check("isConnectableAdPlatform agrees with the lists",
    isConnectableAdPlatform("google") && !isConnectableAdPlatform("tiktok") && !isConnectableAdPlatform(null))

  const ads = src("lib/kernel/ads.ts")
  check("the workspace no longer queries a tiktok credential",
    !/\.in\("platform", \["facebook", "instagram", "google", "linkedin", "tiktok"\]\)/.test(ads))
  check("…it queries the connectable set", /CONNECTABLE_AD_PLATFORMS/.test(ads))
  check("…and reports what cannot be connected at all",
    /unconnectableAdPlatforms: AD_PLATFORMS_WITHOUT_CREDENTIALS/.test(ads))
  check("the credential gate's result is no longer discarded",
    /accountConnected: !!platformCred\?\.is_active/.test(ads))
  check("…and it distinguishes unconnected from unconnectable",
    /accountConnectable: connectable/.test(ads))
  check("the gate does not fire a doomed query for an unconnectable platform",
    /const connectable = isConnectableAdPlatform\(platform\)/.test(ads))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ CREDENTIAL_PLATFORM_FAIL"); process.exit(1) }
console.log(" ✅ CREDENTIAL_PLATFORM_PASS — every finished integration can store its credential")
