#!/usr/bin/env tsx
/**
 * scripts/avatar-rehost-simulator.ts   (npm run test:avatar-rehost)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AVATAR IS SELF-HOSTED, AND THE PROFILE STORES THE URL — NOT THE ID.
 * Owner contract: "once D-ID creates the avatar, our system polls it until the
 * avatar creates, then we download it and save it to our supabase bucket. the
 * avatar url in the supabase bucket is saved to the profile, not avatarid."
 * The poll cron already polled; this proves it now ALSO (1) downloads the
 * finished avatar and re-hosts it in the twin-avatars bucket, (2) saves the
 * bucket URL to the profile (agent_voice_profiles.avatar_url), keeping
 * did_avatar_id only for clip generation, (3) is best-effort (falls back to the
 * D-ID url so the avatar is never blank), and (4) the onboarding twin check +
 * schema snapshot recognize the new avatar_url column.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// m324 moved the completion body out of the cron and into ONE shared module
// that the cron and the D-ID webhook both call, so the two ways this OS learns
// an avatar finished can never disagree about what "done" means. The re-host
// contract is unchanged — it just lives where both callers can reach it, and
// these assertions follow it rather than pinning it to the cron forever.
const COMPLETION = "lib/did/avatar-completion.ts"

console.log("\n── the completion path downloads + re-hosts the finished avatar ──")
{
  const done = src(COMPLETION)
  check("re-hosts into the twin-avatars bucket", done.includes('AVATAR_BUCKET = "twin-avatars"'))
  check("a rehostAvatarImage helper downloads then uploads to storage",
    /function rehostAvatarImage/.test(done) &&
    /fetch\(sourceUrl\)/.test(done) &&
    /\.storage\.from\(AVATAR_BUCKET\)[\s\S]*?\.upload\(/.test(done) &&
    done.includes("getPublicUrl"))
  check("it is best-effort (returns null on failure, caller falls back to D-ID url)",
    /return null/.test(done) && done.includes("rehosted ?? didAssetUrl"))
}

console.log("\n── the PROFILE stores the bucket URL (not just the id) ──")
{
  const done = src(COMPLETION)
  check("the ready asset saves avatar_url (the self-hosted URL)",
    /agent_avatar_assets[\s\S]*?avatar_url: avatarUrl/.test(done))
  check("the default twin's profile stores avatar_url",
    /agent_voice_profiles[\s\S]*?avatar_url: avatarUrl/.test(done))
  check("did_avatar_id is still mirrored (needed for clip generation)",
    /did_avatar_id: asset\.did_avatar_id/.test(done))
}

console.log("\n── and BOTH ways of learning it finished go through that one module ──")
{
  const cron = src("app/api/cron/poll-did-avatars/route.ts")
  const hook = src("app/api/webhooks/did/route.ts")
  check("the poll cron delegates to the shared applier",
    cron.includes('from "@/lib/did/avatar-completion"') && cron.includes("applyAvatarOutcome("))
  check("the D-ID webhook delegates to the SAME applier",
    hook.includes('from "@/lib/did/avatar-completion"') && hook.includes("applyAvatarOutcome("))
}

console.log("\n── onboarding + schema recognize the new column ──")
{
  const cs = src("lib/onboarding/critical-setup.ts")
  check("the twin facts loader selects avatar_url", cs.includes("did_avatar_id, avatar_url"))
  check("twinConfigured counts a re-hosted avatar_url as set up",
    /hasAvatar\s*=\s*vps\.some\(\(v\)\s*=>\s*!!v\.did_avatar_id\s*\|\|\s*!!v\.avatar_url\)/.test(cs))

  const snap = src("scripts/schema-snapshot.ts")
  check("schema snapshot lists avatar_url on both tables",
    /agent_avatar_assets:\s*\[[^\]]*"avatar_url"/.test(snap) &&
    /agent_voice_profiles:\s*\[[^\]]*"avatar_url"/.test(snap))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ AVATAR_REHOST_FAIL"); process.exit(1) }
console.log(" ✅ AVATAR_REHOST_PASS — avatar downloaded + re-hosted; profile stores the bucket URL, not just the id")
