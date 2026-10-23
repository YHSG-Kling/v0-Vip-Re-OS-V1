const jar = new Map<string, string>()
export async function cookies() {
  return {
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (n: string, v: string) => { jar.set(n, v) },
    delete: (n: string) => { jar.delete(n) },
    has: (n: string) => jar.has(n),
    // The real store serialises as a Cookie request header (`a=1; b=2`, values URI-encoded).
    // Callers forward it verbatim — `headers: { Cookie: cookieStore.toString() }` in
    // app/actions/reputation-kernel.ts — and without this they sent "[object Object]".
    toString: () => [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "),
  }
}
export async function headers() {
  return new Headers({ host: "demo.wave91.test", "x-forwarded-proto": "https", "user-agent": "mcp-bridge-walkthrough" })
}
export async function draftMode() { return { isEnabled: false, enable() {}, disable() {} } }
