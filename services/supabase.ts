import { createClient } from "@supabase/supabase-js"

let supabaseInstance: ReturnType<typeof createClient> | null = null

export function getSupabase() {
  if (supabaseInstance) {
    return supabaseInstance
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn("[v0] Supabase configuration missing - using fallback mode")
    console.warn("[v0] NEXT_PUBLIC_SUPABASE_URL:", supabaseUrl ? "set" : "MISSING")
    console.warn("[v0] NEXT_PUBLIC_SUPABASE_ANON_KEY:", supabaseAnonKey ? "set" : "MISSING")
    // Return null instead of throwing to allow app to work without Supabase
    return null
  }

  supabaseInstance = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  })

  return supabaseInstance
}

export function createBrowserClient() {
  return getSupabase()
}

export const isSupabaseConfigured = () => {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    (typeof window !== "undefined" && (window as any).ENV?.NEXT_PUBLIC_SUPABASE_URL)

  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    (typeof window !== "undefined" && (window as any).ENV?.NEXT_PUBLIC_SUPABASE_ANON_KEY)

  return !!(supabaseUrl && supabaseAnonKey)
}

export const supabase = new Proxy({} as ReturnType<typeof createClient>, {
  get(target, prop) {
    if (typeof window === "undefined") {
      return undefined
    }
    const client = getSupabase()
    if (!client) {
      // Return safe fallbacks if Supabase is not configured
      if (prop === 'auth') {
        return {
          getSession: () => Promise.resolve({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
          signOut: () => Promise.resolve({ error: null }),
        }
      }
      return undefined
    }
    return (client as any)[prop]
  },
})
