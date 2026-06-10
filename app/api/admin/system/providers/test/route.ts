import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface TestResponse {
  ok: boolean
  message: string
  latencyMs?: number
}

async function timed<T extends TestResponse>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now()
  const result = await fn()
  return { ...result, latencyMs: Date.now() - start } as T
}

async function testZenrows(): Promise<TestResponse> {
  const key = process.env.ZENROWS_API_KEY
  if (!key) return { ok: false, message: "ZENROWS_API_KEY not set" }
  // Hit the API with a trivial httpbin URL to verify auth.
  const res = await callConnector({
    connector: "zenrows", baseUrl: "https://api.zenrows.com", path: "/v1/", method: "GET",
    query: { apikey: key, url: "https://httpbin.org/get" }, auth: { style: "none" },
  })
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testBatchdata(): Promise<TestResponse> {
  const key = process.env.BATCHDATA_API_KEY
  if (!key) return { ok: false, message: "BATCHDATA_API_KEY not set" }
  // BatchData uses bearer auth — hit the property search endpoint with an empty body.
  const res = await callConnector({
    connector: "batchdata", baseUrl: "https://api.batchdata.com", path: "/api/v1/property/search", method: "POST",
    auth: { style: "bearer", token: key }, body: { requests: [] },
  })
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Auth rejected" }
  // 400 is expected (empty body) — that means the key was accepted.
  if (res.ok || res.status === 400) return { ok: true, message: "Auth accepted" }
  return { ok: false, message: `HTTP ${res.status}` }
}

async function testApify(): Promise<TestResponse> {
  const key = process.env.APIFY_API_KEY
  if (!key) return { ok: false, message: "APIFY_API_KEY not set" }
  const res = await callConnector({
    connector: "apify", baseUrl: "https://api.apify.com", path: "/v2/users/me", method: "GET",
    query: { token: key }, auth: { style: "none" },
  })
  if (res.status === 401) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testDid(): Promise<TestResponse> {
  const key = process.env.DID_API_KEY
  if (!key) return { ok: false, message: "DID_API_KEY not set" }
  // List talks endpoint with limit=1 just to verify auth.
  const res = await callConnector({
    connector: "did", baseUrl: "https://api.d-id.com", path: "/talks", method: "GET",
    query: { limit: "1" }, auth: { style: "header", name: "Authorization", value: `Basic ${key}` },
  })
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testElevenlabs(): Promise<TestResponse> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return { ok: false, message: "ELEVENLABS_API_KEY not set" }
  const res = await callConnector({
    connector: "elevenlabs", baseUrl: "https://api.elevenlabs.io", path: "/v1/user", method: "GET",
    auth: { style: "header", name: "xi-api-key", value: key },
  })
  if (res.status === 401) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testHousecanary(): Promise<TestResponse> {
  const key = process.env.HOUSECANARY_API_KEY
  const secret = process.env.HOUSECANARY_API_SECRET
  if (!key || !secret) return { ok: false, message: "HOUSECANARY_API_KEY / SECRET not set" }
  const res = await callConnector({
    connector: "housecanary", baseUrl: "https://api.housecanary.com", path: "/v2/property/value", method: "GET",
    query: { address: "1600 Amphitheatre Pkwy", zipcode: "94043" },
    auth: { style: "basic", username: key, password: secret },
  })
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

const TESTERS: Record<string, () => Promise<TestResponse>> = {
  zenrows: testZenrows,
  batchdata: testBatchdata,
  apify: testApify,
  did: testDid,
  elevenlabs: testElevenlabs,
  housecanary: testHousecanary,
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const auth = await requireSuperadminAuth(supabase)
  if (!auth.ok) return auth.response

  const body = await req.json().catch(() => ({}))
  const provider = String(body?.provider ?? "").toLowerCase()
  const tester = TESTERS[provider]
  if (!tester) {
    return NextResponse.json({ ok: false, message: "Unknown provider" }, { status: 400 })
  }

  try {
    const result = await timed(tester)
    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ ok: false, message: err?.message ?? "Test failed" }, { status: 500 })
  }
}
