// THE ONE service-client factory (lane 140O, CLAUDE.md §4 "gate first, then use the
// service client"). TOMBSTONE: this module built its own `createClient(url, serviceKey)`
// from the raw env — a second spelling of lib/supabase/service.ts that the proofs which
// swap that one leaf (scripts/seat-user-convergence-guard.ts's Module._load shim) could
// never see, and a second place the env check lived. The factory throws the same way when
// the service env is absent.
import { createServiceClient } from "@/lib/supabase/service"

/**
 * Provisions the AI-ISA system actor for a brokerage.
 *
 * Idempotent: returns the existing ai_isa_system_user_id if one is
 * already cached on the brokerage. Otherwise creates a new auth.users
 * entry (no password, email-confirmed, system-tagged metadata), lets
 * the handle_new_auth_user trigger mirror it into public.users, then
 * promotes the public.users row to platform_role='ai_isa_system' and
 * caches the user_id on brokerages.
 *
 * The handle_new_auth_user trigger reads first_name/last_name/
 * user_type/brokerage_id from raw_user_meta_data; we supply all four.
 *
 * GATE FIRST (§4): every caller is a gated internal — createTenantCore / the operating
 * baseline (lib/kernel/tenant-operating-baseline.ts) with the id the caller minted or
 * resolved, never a request body. Returns the ISA actor's user_id.
 */
export async function provisionIsaActorForBrokerage(args: {
  brokerageId: string
  brokerageName?: string
  brokerageSlug?: string | null
}): Promise<{ userId: string; created: boolean }> {
  const admin = createServiceClient()

  // Fast path — brokerage already has an actor.
  const { data: existing } = await admin
    .from("brokerages")
    .select("ai_isa_system_user_id, name, slug")
    .eq("id", args.brokerageId)
    .maybeSingle()

  if (existing?.ai_isa_system_user_id) {
    return { userId: existing.ai_isa_system_user_id, created: false }
  }

  const slug = (args.brokerageSlug ?? existing?.slug ?? args.brokerageId.replace(/-/g, "")).toLowerCase()
  const name = args.brokerageName ?? existing?.name ?? args.brokerageId
  const email = `ai-isa+${slug}@vipreos.internal`

  // 1. Create the auth.users entry. The handle_new_auth_user trigger
  //    will INSERT the public.users mirror automatically using the
  //    metadata we pass.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      user_type: "system",
      platform_role: "ai_isa_system",
      brokerage_id: args.brokerageId,
      first_name: "AI ISA",
      last_name: "System",
      display_name: `AI ISA System (${name})`,
    },
    app_metadata: { provider: "system", providers: ["system"] },
  })
  if (createErr || !created.user) {
    throw new Error(`auth.admin.createUser failed: ${createErr?.message ?? "unknown"}`)
  }

  const userId = created.user.id

  // 2. Promote the public.users row to the ISA shape. The trigger
  //    cannot set platform_role (it's NOT in its INSERT payload), so
  //    we patch it here.
  const { error: promoteErr } = await admin
    .from("users")
    .update({
      platform_role: "ai_isa_system",
      user_type: "system",
      brokerage_id: args.brokerageId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId)
  if (promoteErr) {
    throw new Error(`failed to promote public.users to ai_isa_system: ${promoteErr.message}`)
  }

  // 3. Cache on the brokerage row so the runtime helper is a single hop.
  const { error: cacheErr } = await admin
    .from("brokerages")
    .update({ ai_isa_system_user_id: userId })
    .eq("id", args.brokerageId)
  if (cacheErr) {
    throw new Error(`failed to cache ai_isa_system_user_id on brokerage: ${cacheErr.message}`)
  }

  return { userId, created: true }
}
