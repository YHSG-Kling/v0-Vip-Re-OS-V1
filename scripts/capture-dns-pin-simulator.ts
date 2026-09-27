#!/usr/bin/env tsx
/**
 * scripts/capture-dns-pin-simulator.ts   (npm run test:capture-dns-pin)
 * ─────────────────────────────────────────────────────────────────────────────
 * DNS REBINDING IS CLOSED IN THE TENANT CAPTURE SSRF GUARD — lane 86C.
 *
 * THE GAP (85A published it): lib/assets/screenshot-capture.ts checked a general page's host
 * answers (layer 2), then let Chromium resolve the name AGAIN on its own. A hostile resolver
 * answers the check with a public address and the browser, a moment later, with
 * 169.254.169.254 (cloud metadata) — the request interception only judged host NAMES and IP
 * literals, never what a name resolved to. The robots.txt fetch had the same hole and followed
 * redirects unchecked.
 *
 * THE FIX: createHostPinner resolves each host ONCE per capture and pins the verified address;
 * fetchPinned re-checks every request (URL rule, then the pin) and connects to the PINNED
 * address; the puppeteer adapter fulfils every request itself over that connection and launches
 * Chromium with `--host-resolver-rules=MAP * ~NOTFOUND`, so the browser resolves nothing.
 *
 * LAYERS
 *   · the pin and the pinned fetch against an INJECTED REBINDING RESOLVER (public first, then
 *     metadata) and an injected transport that records the address it was told to dial;
 *   · the real seam (captureScreenshot) end to end with the same injections;
 *   · a REAL Chromium run (no network — every byte is served by the injected transport) when a
 *     chromium binary is resolvable; if none is, that layer is reported SKIPPED, never green.
 *
 * POSITIVE CONTROLS: the resolver really does rebind (a second lookup answers metadata); the
 *   pre-86C shape (check, then resolve again to connect) dials 169.254.169.254 in the same
 *   fixture; a host with any inward answer is refused with ZERO transport calls.
 *
 * Run: npx tsx --conditions=react-server scripts/capture-dns-pin-simulator.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  createHostPinner, fetchPinned, fetchRobotsPinned, captureScreenshot, puppeteerScreenshotProvider, PINNED_BROWSER_ARGS,
  type PinnedTransport, type ScreenshotProvider, type ProviderCaptureInput,
} from "../lib/assets/screenshot-capture"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const PUBLIC_IP = "93.184.216.34"
const METADATA = "169.254.169.254"
/** A rebinding resolver: the first answer for a name is public, every later one is metadata. */
function rebindingResolver(extra: Record<string, string[]> = {}) {
  const calls: string[] = []
  const seen = new Set<string>()
  const lookup = async (host: string) => {
    calls.push(host)
    if (extra[host]) return extra[host]
    if (host.includes("nxdomain")) throw new Error("ENOTFOUND")
    if (seen.has(host)) return [METADATA]
    seen.add(host)
    return [PUBLIC_IP]
  }
  return { lookup, calls }
}
function recordingTransport(serve: (url: URL) => { status: number; headers?: Record<string, string>; body?: string }) {
  const dialed: Array<{ url: string; address: string }> = []
  const transport: PinnedTransport = async ({ url, address }) => {
    dialed.push({ url: url.toString(), address })
    const r = serve(url)
    return { status: r.status, headers: r.headers ?? { "content-type": "text/plain" }, body: Buffer.from(r.body ?? "") }
  }
  return { transport, dialed }
}

async function main() {
  console.log("\n[1 · the pin — resolve ONCE, reuse the verified address]")
  {
    const probe = rebindingResolver()
    const first = await probe.lookup("www.pin-proof.com"), second = await probe.lookup("www.pin-proof.com")
    check("POSITIVE CONTROL — the injected resolver really rebinds (public, then metadata)", first[0] === PUBLIC_IP && second[0] === METADATA)

    const r = rebindingResolver()
    const pin = createHostPinner(r.lookup)
    const a = await pin("www.pin-proof.com"), b = await pin("WWW.Pin-Proof.com."), c = await pin("www.pin-proof.com")
    check("the pin answers the SAME verified public address every time", a.ok && b.ok && c.ok && a.address === PUBLIC_IP && b.address === PUBLIC_IP && c.address === PUBLIC_IP)
    check("…because the resolver was asked ONCE (case and trailing dot fold onto one pin)", r.calls.filter((h) => h === "www.pin-proof.com").length === 1, r.calls.join(","))

    const mixed = createHostPinner(async () => [PUBLIC_IP, "10.0.0.7"])
    const m = await mixed("mixed.pin-proof.com")
    check("a host with ANY inward answer is refused (all answers are judged, not the first)", !m.ok && /10\.0\.0\.7/.test(m.reason))
    const nx = await createHostPinner(rebindingResolver().lookup)("nxdomain.pin-proof.com")
    check("an unresolvable host is refused (fail closed)", !nx.ok && /did not resolve/.test(nx.reason))
    const lit = createHostPinner(async () => { throw new Error("literal must not be looked up") })
    check("an IP literal is judged as itself (public ok, metadata refused) without a lookup", (await lit(PUBLIC_IP)).ok && !(await lit(METADATA)).ok)
  }

  console.log("\n[2 · every request is re-checked and made over the pin]")
  {
    const r = rebindingResolver({ "cdn.rebind-proof.com": [METADATA] })
    const pin = createHostPinner(r.lookup)
    const t = recordingTransport(() => ({ status: 200, body: "ok" }))
    const one = await fetchPinned("https://www.pin-proof.com/", { pin, transport: t.transport })
    const two = await fetchPinned("https://www.pin-proof.com/listing.css", { pin, transport: t.transport })
    check("two requests to one host both dial the address the check verified (no second lookup to rebind)",
      one.ok && two.ok && t.dialed.length === 2 && t.dialed.every((d) => d.address === PUBLIC_IP), JSON.stringify(t.dialed))

    // The pre-86C shape: check the answers, then let the connecting side resolve AGAIN.
    const naive = rebindingResolver()
    const naiveConnect = async (host: string) => {
      const checked = await naive.lookup(host)
      if (checked.some((a) => a === METADATA)) return "refused"
      return (await naive.lookup(host))[0]
    }
    check("POSITIVE CONTROL — check-then-resolve (the 85A shape) DIALS METADATA in this same fixture", (await naiveConnect("www.pin-proof.com")) === METADATA)

    const before = t.dialed.length
    const sub = await fetchPinned("https://cdn.rebind-proof.com/x.png", { pin, transport: t.transport })
    check("a subresource host that resolves inward is refused with ZERO dials", !sub.ok && t.dialed.length === before)
    const meta = await fetchPinned(`http://${METADATA}/latest/meta-data/`, { pin, transport: t.transport })
    const internal = await fetchPinned("https://svc.internal/secrets", { pin, transport: t.transport })
    const file = await fetchPinned("file:///etc/passwd", { pin, transport: t.transport })
    check("the URL rule still runs FIRST: a metadata literal, an internal name and file: are refused before any lookup or dial",
      !meta.ok && !internal.ok && !file.ok && t.dialed.length === before && !r.calls.includes("svc.internal"))
  }

  console.log("\n[3 · robots.txt rides the pin; each redirect hop is re-checked]")
  {
    const r = rebindingResolver()
    const pin = createHostPinner(r.lookup)
    const toMeta = recordingTransport((u) => u.pathname === "/robots.txt" && u.hostname === "www.pin-proof.com" ? { status: 302, headers: { location: `http://${METADATA}/robots.txt` } } : { status: 200, body: "User-agent: *\nDisallow: /" })
    const got = await fetchRobotsPinned("https://www.pin-proof.com", pin, toMeta.transport)
    check("a robots redirect into metadata is NOT followed (null = no robots file), and metadata is never dialed",
      got === null && toMeta.dialed.length === 1 && !toMeta.dialed.some((d) => d.url.includes(METADATA)))
    const r2 = rebindingResolver()
    const hop = recordingTransport((u) => u.hostname === "www.pin-proof.com" ? { status: 301, headers: { location: "https://static.pin-proof.com/robots.txt" } } : { status: 200, body: "User-agent: *\nAllow: /" })
    const followed = await fetchRobotsPinned("https://www.pin-proof.com", createHostPinner(r2.lookup), hop.transport)
    check("POSITIVE CONTROL — a redirect to another PUBLIC host is followed, pinned too", followed === "User-agent: *\nAllow: /" && hop.dialed.every((d) => d.address === PUBLIC_IP) && hop.dialed.length === 2)
    const loop = recordingTransport(() => ({ status: 302, headers: { location: "https://www.pin-proof.com/robots.txt" } }))
    check("a redirect loop is capped (≤4 hops), never spun", (await fetchRobotsPinned("https://www.pin-proof.com", createHostPinner(rebindingResolver().lookup), loop.transport)) === null && loop.dialed.length <= 4)
  }

  console.log("\n[4 · the seam end to end — the checked address IS the one the capture uses]")
  {
    const r = rebindingResolver()
    const t = recordingTransport((u) => u.pathname === "/robots.txt" ? { status: 200, body: "User-agent: *\nAllow: /" } : { status: 200, body: "<html></html>" })
    const seen: ProviderCaptureInput[] = []
    const provider: ScreenshotProvider = {
      name: "puppeteer",
      async capture(input) {
        seen.push(input)
        // What the real adapter does per request: re-check + pin + dial.
        const nav = await fetchPinned(input.url, { pin: input.hostPin!, transport: input.pinnedTransport })
        if (!nav.ok) throw new Error(nav.reason)
        return { png: Buffer.from("png"), satisfied: [] }
      },
    }
    const inserted: Array<Record<string, unknown>> = []
    const chain = () => {
      const q: any = {}
      for (const m of ["select", "eq", "is", "limit", "order", "in", "not"]) q[m] = () => q
      q.insert = (row: Record<string, unknown>) => { inserted.push(row); return q }
      q.maybeSingle = async () => ({ data: null, error: null })
      q.single = async () => ({ data: { id: "still-1" }, error: null })
      return q
    }
    const svc = {
      from: () => chain(),
      storage: { from: (b: string) => ({ upload: async () => ({ error: null }), getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example.test/${b}/${p}` } }) }) },
    }
    const res = await captureScreenshot(
      { kind: "public_page", url: "https://www.pin-proof.com/market/austin-q3", owner: { brokerageId: "b-1", userId: "u-1" } } as any,
      { svc, provider, lookupHost: r.lookup, pinnedTransport: t.transport, now: new Date() },
    )
    check("a general page is captured through the pin", res.ok, JSON.stringify(res))
    check("the provider received the capture's DNS pin and the public-network flag", seen.length === 1 && typeof seen[0].hostPin === "function" && seen[0].publicNetworkOnly === true)
    check("the seam check, the robots fetch and the browser navigation ALL dialed the one verified address",
      t.dialed.length === 2 && t.dialed.every((d) => d.address === PUBLIC_IP) && t.dialed.some((d) => d.url.endsWith("/robots.txt")), JSON.stringify(t.dialed))
    check("…with ONE lookup for the host across all three (the rebound answer was never asked for)", r.calls.filter((h) => h === "www.pin-proof.com").length === 1, r.calls.join(","))

    const bad = await captureScreenshot(
      { kind: "public_page", url: "https://www.inward-proof.com/x", owner: { brokerageId: "b-1", userId: "u-1" } } as any,
      { svc, provider, lookupHost: async () => [METADATA], pinnedTransport: t.transport, now: new Date() },
    )
    check("a host whose FIRST answer is metadata is refused at the seam, before robots or the browser", !bad.ok && /non-public/.test((bad as any).reason))
    let threw = ""
    try { await puppeteerScreenshotProvider.capture({ url: "https://www.pin-proof.com/", viewport: { width: 800, height: 600 }, redactSelectors: [], readyWhen: [], userAgent: "x", timeoutMs: 1000, publicNetworkOnly: true }) } catch (e) { threw = (e as Error).message }
    check("the puppeteer adapter REFUSES a public-network capture with no pin (fail closed, before any launch)", /needs its DNS pin/.test(threw), threw)
  }

  console.log("\n[5 · source rules on the adapter]")
  {
    const seam = stripComments(readFileSync(join(process.cwd(), "lib/assets/screenshot-capture.ts"), "utf8"))
    check("Chromium is launched resolving NOTHING itself for a public-network capture", PINNED_BROWSER_ARGS.includes("--host-resolver-rules=MAP * ~NOTFOUND") && /input\.publicNetworkOnly \? PINNED_BROWSER_ARGS/.test(seam))
    check("every intercepted request is fulfilled over the pin (fetchPinned → req.respond), never req.continue() to the network",
      /fetchPinned\(url,/.test(seam) && /req\.respond\(/.test(seam) && (seam.match(/req\.continue\(/g) ?? []).length === 1 && /scheme === "data:"[^\n]*req\.continue\(/.test(seam))
    const naiveSpecimen = `page.on("request", (req) => { if (requestHostRefusal(req.url())) req.abort(); else req.continue() })`
    check("CONTROL: the finder flags the 85A adapter shape (continue to the network after a NAME check)", !/fetchPinned\(url,/.test(naiveSpecimen) && /req\.continue\(\)/.test(naiveSpecimen))
  }

  console.log("\n[6 · REAL Chromium, no network: every byte served over the pin]")
  {
    const { resolveChromiumExecutable } = await import("../lib/remotion/chromium-executable")
    const exe = await resolveChromiumExecutable({ localDiscovery: true, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers" } as NodeJS.ProcessEnv })
    if (!exe) {
      console.log("  – SKIPPED: no chromium binary resolvable here — the real-browser layer did NOT run (blind spot, not a pass)")
    } else {
      process.env.CHROMIUM_EXECUTABLE_PATH = exe
      const r = rebindingResolver({ "img.rebind-proof.com": [METADATA] })
      const pin = createHostPinner(r.lookup)
      await pin("www.pin-proof.com") // the seam's check
      const t = recordingTransport((u) => u.hostname === "www.pin-proof.com"
        ? { status: 200, headers: { "content-type": "text/html" }, body: `<html><body style="background:#0a0;margin:0"><h1>pinned</h1><img src="https://img.rebind-proof.com/p.png"><img src="http://${METADATA}/latest/meta-data/"><img src="https://www.pin-proof.com/again.png"></body></html>` }
        : { status: 404 })
      let out: { png: Buffer } | null = null
      let err = ""
      try {
        out = await puppeteerScreenshotProvider.capture({
          url: "https://www.pin-proof.com/", viewport: { width: 640, height: 400 }, redactSelectors: [], readyWhen: [], userAgent: "pin-proof",
          timeoutMs: 30_000, publicNetworkOnly: true, hostPin: pin, pinnedTransport: t.transport,
        })
      } catch (e) { err = (e as Error).message }
      check("the real browser rendered the page served over the pin (PNG produced)", !!out && out.png.length > 1000 && out.png.subarray(1, 4).toString() === "PNG", err)
      check("every dial the browser caused went to the ONE verified address", t.dialed.length >= 2 && t.dialed.every((d) => d.address === PUBLIC_IP), JSON.stringify(t.dialed))
      check("the rebinding subresource host and the metadata literal were NEVER dialed", !t.dialed.some((d) => d.url.includes("rebind-proof") || d.url.includes(METADATA)))
      check("the page host was looked up ONCE for the whole browser session (the check's lookup; the browser asked nothing)", r.calls.filter((h) => h === "www.pin-proof.com").length === 1, r.calls.join(","))
    }
  }

  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed) { console.log(" ❌ CAPTURE_DNS_PIN_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ CAPTURE_DNS_PIN_PASS — resolve once, pin, re-check every request; the browser resolves nothing")
}

main().catch((e) => { console.error(e); process.exit(1) })
