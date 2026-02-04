import { createBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"

// Use a global variable to ensure singleton across hot reloads in development
const globalForSupabase = globalThis as unknown as {
  supabaseClient: SupabaseClient | undefined
}

export function createClient() {
  // Return existing client if already initialized
  if (globalForSupabase.supabaseClient) {
    return globalForSupabase.supabaseClient
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables. Please add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    )
  }

  // Create the client with a consistent storage key
  const client = createBrowserClient(url, key, {
    auth: {
      storageKey: 'sb-auth-token',
      storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    },
  })

  // Store in global for reuse
  globalForSupabase.supabaseClient = client

  return client
}
