/**
 * scripts/next-headers-shim.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE next/headers + server-only shim for CLI scripts that execute
 * production app code outside a Next request scope.
 *
 * TOMBSTONE (lane 78D, §1.1 merge onto the survivor): this was declared
 * inline in scripts/production-smoke-drill.ts (`SHIM_URL`, `shimLoader`,
 * `registerNextHeadersShim`, lines 76-152 before the move) and is now
 * imported back there. It moved because scripts/seed-showcase-tenant.ts
 * needs the SAME hook — ensureDemoTenant → signupBrokerageAction imports
 * next/headers — and a second copy of a module-customization hook is exactly
 * the drift CLAUDE.md §6 forbids.
 *
 * WHAT IT SHIMS, AND NOTHING ELSE. `cookies()` / `headers()` / `draftMode()`
 * from "next/headers" return an EMPTY store; the "server-only" / "client-only"
 * guard packages (whose only behaviour is to throw outside a React Server
 * environment) become no-ops. Every pipeline function that then executes is
 * production code — only the request plumbing is shimmed.
 */
import { register, createRequire } from "node:module"

const SHIM_URL = "vipre-smoke-shim:next-headers"
const shimLoader = `
export async function resolve(specifier, context, next) {
  if (specifier === "next/headers") return { shortCircuit: true, url: ${JSON.stringify(SHIM_URL)} }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === ${JSON.stringify(SHIM_URL)}) {
    return { shortCircuit: true, format: "module", source: \`
      const store = {
        getAll: () => [], get: () => undefined, has: () => false,
        set: () => {}, delete: () => {}, toString: () => "",
        [Symbol.iterator]: function* () {},
      }
      export async function cookies() { return store }
      const hdrs = new Map()
      export async function headers() { return hdrs }
      export async function draftMode() { return { isEnabled: false, enable() {}, disable() {} } }
    \` }
  }
  return next(url, context)
}
`
export function registerNextHeadersShim(): boolean {
  try {
    // ESM resolution path (dynamic import("next/headers") inside the app code).
    register(`data:text/javascript,${encodeURIComponent(shimLoader)}`)
    // CJS resolution path — tsx translates most app modules through the CJS
    // loader, where module.register hooks are not consulted. Patch Module._load
    // for exactly two request-plumbing specifiers:
    //   - "server-only": a guard package whose ONLY behavior is to throw outside
    //     a React Server environment; the drill IS server-side, so it no-ops.
    //   - "next/headers": same empty cookie store as the ESM shim.
    const nodeModule: any = createRequire(import.meta.url)("node:module")
    // Some production modules still use a bare require() for a lazy sibling
    // load (lib/listing-lifecycle/transition-validator.ts, lib/buyer-lifecycle/
    // transition-validator.ts + gating-helpers.ts + extensions/contact-
    // lifecycle-sync.ts, lib/kernel/ai-search-citation-monitor.ts — measured
    // 2026-09-21); under an ESM execution context that identifier must exist
    // globally. lib/providers/dispatch.ts moved to createRequire in wave 75 and
    // lib/remotion/music-mixer.ts + voiceover-mixer.ts in wave 77 (lane 77D),
    // so the ffmpeg-static loads no longer depend on this shim.
    if (typeof (globalThis as any).require === "undefined") {
      ;(globalThis as any).require = createRequire(import.meta.url)
    }
    const realLoad = nodeModule._load
    const cjsCookieStore = {
      getAll: () => [], get: () => undefined, has: () => false,
      set: () => {}, delete: () => {}, toString: () => "",
    }
    // Requests arrive either as bare specifiers ("server-only") or as resolved
    // absolute filenames (…/node_modules/server-only/index.js) depending on
    // which loader path (require vs ESM-translated CJS) pulled them in.
    const isGuardPkg = (r: string) =>
      r === "server-only" || r === "client-only" ||
      /[\\/]node_modules[\\/](server-only|client-only)[\\/]/.test(r)
    const isNextHeaders = (r: string) =>
      r === "next/headers" || /[\\/]node_modules[\\/]next[\\/]headers(\.js)?$/.test(r)
    nodeModule._load = function (request: string, ...rest: unknown[]) {
      if (isGuardPkg(request)) return {}
      if (isNextHeaders(request)) {
        return {
          cookies: async () => cjsCookieStore,
          headers: async () => new Map(),
          draftMode: async () => ({ isEnabled: false, enable() {}, disable() {} }),
        }
      }
      return realLoad.call(this, request, ...rest)
    }
    return true
  } catch {
    return false
  }
}
