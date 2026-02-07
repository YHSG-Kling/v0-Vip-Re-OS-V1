import { createBrowserClient } from '@supabase/ssr'

let clientInstance: ReturnType<typeof createBrowserClient> | null = null

function getClientInstance() {
  if (clientInstance) return clientInstance
  clientInstance = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  )
  return clientInstance
}

export const supabase = getClientInstance()

export { supabase as default }

// Export createClient as alias for compatibility — always returns the singleton
export const createClient = () => getClientInstance()
