// Minimal `next/server` stand-in for the MCP replay bridge.
//
// Faithful where handlers can observe it:
//   · json() keeps caller headers (Retry-After, Cache-Control …); content-type is only
//     defaulted, as Response.json does, so a caller's own type (problem+json) survives.
//   · redirect() takes `number | ResponseInit` and refuses a non-redirect status, as the
//     real one does, instead of emitting a Response with a nonsense status.
//   · every response carries `.cookies` (get/getAll/has/set/delete) backed by Set-Cookie
//     headers, so `NextResponse.redirect(u).cookies.set(...)` works.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface ResponseCookie {
  name: string
  value: string
  path?: string
  domain?: string
  expires?: Date | number
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: boolean | "lax" | "strict" | "none"
}

const decode = (v: string) => { try { return decodeURIComponent(v) } catch { return v } }

function serializeCookie(c: ResponseCookie): string {
  const parts = [`${c.name}=${encodeURIComponent(c.value ?? "")}`]
  parts.push(`Path=${c.path ?? "/"}`)
  if (c.domain) parts.push(`Domain=${c.domain}`)
  if (c.expires !== undefined) parts.push(`Expires=${new Date(c.expires).toUTCString()}`)
  if (typeof c.maxAge === "number") parts.push(`Max-Age=${c.maxAge}`)
  if (c.httpOnly) parts.push("HttpOnly")
  if (c.secure) parts.push("Secure")
  if (c.sameSite) parts.push(`SameSite=${c.sameSite === true ? "Strict" : c.sameSite[0].toUpperCase() + c.sameSite.slice(1)}`)
  return parts.join("; ")
}

/** Name/value out of a Set-Cookie line — attributes are not needed by any bridge caller. */
function readCookie(line: string): { name: string; value: string } {
  const pair = line.split(";", 1)[0]
  const eq = pair.indexOf("=")
  return eq < 0 ? { name: pair.trim(), value: "" } : { name: pair.slice(0, eq).trim(), value: decode(pair.slice(eq + 1).trim()) }
}

/** The response-side cookie jar. Headers are the single source of truth: every
 *  mutation rewrites the Set-Cookie lines, so nothing can drift from what is sent. */
class ResponseCookies {
  constructor(private readonly headers: Headers) {}
  private lines(): string[] { return this.headers.getSetCookie() }
  private write(lines: string[]) {
    this.headers.delete("set-cookie")
    for (const l of lines) this.headers.append("set-cookie", l)
  }
  getAll() { return this.lines().map(readCookie) }
  get(name: string) { return this.getAll().find((c) => c.name === name) }
  has(name: string) { return this.get(name) !== undefined }
  set(nameOrCookie: string | ResponseCookie, value?: string, opts: Partial<ResponseCookie> = {}) {
    const c: ResponseCookie = typeof nameOrCookie === "string" ? { ...opts, name: nameOrCookie, value: value ?? "" } : nameOrCookie
    // One line per name: a later set() replaces the earlier one.
    this.write([...this.lines().filter((l) => readCookie(l).name !== c.name), serializeCookie(c)])
    return this
  }
  /** Expire the cookie on the client (empty value, epoch expiry), like the real API. */
  delete(nameOrCookie: string | string[] | Pick<ResponseCookie, "name" | "path" | "domain">) {
    const list = Array.isArray(nameOrCookie) ? nameOrCookie : [nameOrCookie]
    for (const n of list) {
      const c = typeof n === "string" ? { name: n } : n
      this.set({ ...c, value: "", expires: new Date(0) })
    }
    return this
  }
}

export class NextResponse extends Response {
  #cookies?: ResponseCookies
  get cookies() { return (this.#cookies ??= new ResponseCookies(this.headers)) }

  static json(body: unknown, init?: ResponseInit) {
    const headers = new Headers(init?.headers)
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    return new NextResponse(JSON.stringify(body), { ...init, headers }) as any
  }
  static redirect(url: string | URL, init?: number | ResponseInit) {
    const initObj: ResponseInit = typeof init === "object" && init !== null ? init : {}
    const status = typeof init === "number" ? init : (initObj.status ?? 307)
    if (!REDIRECT_STATUSES.has(status)) throw new RangeError('Failed to execute "redirect" on "response": Invalid status code')
    const headers = new Headers(initObj.headers)
    headers.set("location", String(url))
    return new NextResponse(null, { ...initObj, headers, status }) as any
  }
  static next(init?: ResponseInit) { return new NextResponse(null, init) as any }
}
export class NextRequest extends Request { get nextUrl() { return new URL(this.url) } }
export function after(fn: () => unknown) { void Promise.resolve().then(fn) }
export const userAgent = () => ({})
