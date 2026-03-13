import { createBrowserClient } from '@supabase/ssr'

let clientInstance: ReturnType<typeof createBrowserClient> | null = null

function getClientInstance() {
  if (clientInstance) return clientInstance
  
  // Environment variables must be accessed at runtime, not build time
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  
  if (!url || !key) {
    throw new Error(
      'Missing Supabase environment variables. Ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.'
    )
  }
  
  clientInstance = createBrowserClient(url, key, {
    auth: {
      // Increase lock timeout to prevent timeout errors during concurrent auth operations
      lock: {
        acquireTimeout: 30000, // 30 seconds instead of default 10
      },
      // Prevent multiple tabs from fighting over the same session
      storageKey: 'vip-agents-auth',
      flowType: 'pkce',
    },
  })
  return clientInstance
}

export const supabase = getClientInstance()

export { supabase as default }

// Export createClient as alias for compatibility — always returns the singleton
export const createClient = () => getClientInstance()
