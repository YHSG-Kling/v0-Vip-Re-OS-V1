// ESM resolve hooks for the MCP replay bridge: the app's Supabase factories and
// the Next.js request-scope modules resolve to bridge stubs; everything else is
// the real module. Registered AFTER tsx so this hook runs first.
const here = new URL("./stubs/", import.meta.url)
const MAP = {
  "server-only": "empty.mjs",
  "client-only": "empty.mjs",
  "next/headers": "next-headers.ts",
  "next/cache": "next-cache.ts",
  "next/server": "next-server.ts",
}
export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: new URL(MAP[specifier], here).href, shortCircuit: true }
  const r = await next(specifier, context)
  if (r.url.endsWith("/lib/supabase/service.ts")) return { ...r, url: new URL("service.ts", here).href }
  if (r.url.endsWith("/lib/supabase/server.ts")) return { ...r, url: new URL("server.ts", here).href }
  return r
}
