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
  
  clientInstance = createBrowserClient(url, key)
  return clientInstance
}

// Lazy proxy — resolves the real client only when a property is accessed.
// Keeps `next build` static page collection working without env vars set.
export const supabase = new Proxy({} as ReturnType<typeof createBrowserClient>, {
  get(_target, prop) {
    const inst = getClientInstance() as any
    const v = inst[prop]
    return typeof v === 'function' ? v.bind(inst) : v
  },
})

export { supabase as default }

// Export createClient as alias for compatibility — always returns the singleton
export const createClient = () => getClientInstance()
