export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit) { return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json" } }) as any }
  static redirect(url: string | URL, status = 307) { return new Response(null, { status, headers: { location: String(url) } }) as any }
  static next() { return new Response(null) as any }
}
export class NextRequest extends Request { get nextUrl() { return new URL(this.url) } }
export function after(fn: () => unknown) { void Promise.resolve().then(fn) }
export const userAgent = () => ({})
