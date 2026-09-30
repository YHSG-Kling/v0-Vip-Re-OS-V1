const jar = new Map<string, string>()
export async function cookies() {
  return {
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (n: string, v: string) => { jar.set(n, v) },
    delete: (n: string) => { jar.delete(n) },
    has: (n: string) => jar.has(n),
  }
}
export async function headers() {
  return new Headers({ host: "demo.wave91.test", "x-forwarded-proto": "https", "user-agent": "mcp-bridge-walkthrough" })
}
export async function draftMode() { return { isEnabled: false, enable() {}, disable() {} } }
