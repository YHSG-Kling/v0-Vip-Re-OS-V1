// Re-export the singleton Supabase client to avoid multiple GoTrueClient instances
import { supabase as supabaseClient, createClient as createClientSingleton } from "@/lib/supabase/client"

export function getSupabase() {
  return supabaseClient
}

export function createBrowserClient() {
  return createClientSingleton()
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

// Re-export the singleton client
export const supabase = supabaseClient
