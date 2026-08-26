import { createServerClient } from "@supabase/ssr"

export async function createClient() {
  const { cookies } = await import("next/headers")
  const cookieStore = await cookies()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    throw new Error("Missing Supabase environment variables. Please check your configuration.")
  }

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      // `_cacheHeaders` is the second argument @supabase/ssr passes from 0.10.0 on.
      // It is accepted and NOT applied here, deliberately: this client is built on
      // next/headers `cookies()`, which can write Set-Cookie but exposes no way to
      // set arbitrary response headers — the response object does not exist at this
      // layer. Naming the parameter keeps the gap visible instead of looking like an
      // oversight for the next lane to "fix".
      //
      // That is safe because this client does not own refresh: `autoRefreshToken` is
      // false below, and the auth gate in proxy.ts ("SESSION-LEAK GUARD" block) is
      // what refreshes sessions and applies the cache headers — it holds the
      // NextResponse, so it can.
      //
      // Note the library hardcodes `persistSession: true` AFTER spreading the caller's
      // `auth` options (dist/main/createServerClient.js), so the `persistSession: false`
      // below is overridden by the library — true in 0.8.0 and unchanged in 0.10.2, so
      // the bump did not alter this behaviour.
      setAll(_cookiesToSet, _cacheHeaders) {
        try {
          _cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // The `setAll` method was called from a Server Component.
          // Server Components cannot set cookies; this is the documented pattern
          // and proxy.ts refreshes the session instead.
        }
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: (url, options = {}) => {
        return fetch(url, {
          ...options,
          // Remove any signal that might cause abort errors
          signal: undefined,
        })
      },
    },
  })
}

// Export createClient function for use in API routes
// Also export as createServerClient for backward compatibility
export { createClient as createServerClient }
