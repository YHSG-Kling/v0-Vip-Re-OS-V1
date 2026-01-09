import { createClient } from "@supabase/supabase-js"

let supabaseInstance: ReturnType<typeof createClient> | null = null

export function getSupabase() {
  if (supabaseInstance) {
    return supabaseInstance
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    (typeof window !== "undefined" && (window as any).ENV?.NEXT_PUBLIC_SUPABASE_URL)

  const supabaseAnonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    (typeof window !== "undefined" && (window as any).ENV?.NEXT_PUBLIC_SUPABASE_ANON_KEY)

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Supabase is not configured. Please add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in the Vars section of the sidebar.",
    )
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
    return (client as any)[prop]
  },
})
