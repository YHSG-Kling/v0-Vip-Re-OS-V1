import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireSuperadminAuth } from "@/lib/kernel/api-auth"

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
  const url = `https://api.zenrows.com/v1/?apikey=${encodeURIComponent(key)}&url=https://httpbin.org/get`
  const res = await fetch(url, { method: "GET" })
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testBatchdata(): Promise<TestResponse> {
  const key = process.env.BATCHDATA_API_KEY
  if (!key) return { ok: false, message: "BATCHDATA_API_KEY not set" }
  // BatchData uses bearer auth — hit the property search endpoint with an empty body.
  const res = await fetch("https://api.batchdata.com/api/v1/property/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ requests: [] }),
  })
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Auth rejected" }
  // 400 is expected (empty body) — that means the key was accepted.
  if (res.ok || res.status === 400) return { ok: true, message: "Auth accepted" }
  return { ok: false, message: `HTTP ${res.status}` }
}

async function testApify(): Promise<TestResponse> {
  const key = process.env.APIFY_API_KEY
  if (!key) return { ok: false, message: "APIFY_API_KEY not set" }
  const res = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(key)}`, {
    method: "GET",
  })
  if (res.status === 401) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testDid(): Promise<TestResponse> {
  const key = process.env.DID_API_KEY
  if (!key) return { ok: false, message: "DID_API_KEY not set" }
  // List talks endpoint with limit=1 just to verify auth.
  const res = await fetch("https://api.d-id.com/talks?limit=1", {
    method: "GET",
    headers: {
      Authorization: `Basic ${key}`,
      Accept: "application/json",
    },
  })
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testElevenlabs(): Promise<TestResponse> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return { ok: false, message: "ELEVENLABS_API_KEY not set" }
  const res = await fetch("https://api.elevenlabs.io/v1/user", {
    method: "GET",
    headers: { "xi-api-key": key },
  })
  if (res.status === 401) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testHeygen(): Promise<TestResponse> {
  const key = process.env.HEYGEN_API_KEY
  if (!key) return { ok: false, message: "HEYGEN_API_KEY not set" }
  const res = await fetch("https://api.heygen.com/v1/user/remaining_quota", {
    method: "GET",
    headers: { "X-Api-Key": key, Accept: "application/json" },
  })
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Auth rejected" }
  if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
  return { ok: true, message: "OK" }
}

async function testHousecanary(): Promise<TestResponse> {
  const key = process.env.HOUSECANARY_API_KEY
  const secret = process.env.HOUSECANARY_API_SECRET
  if (!key || !secret) return { ok: false, message: "HOUSECANARY_API_KEY / SECRET not set" }
  const auth = Buffer.from(`${key}:${secret}`).toString("base64")
  const res = await fetch("https://api.housecanary.com/v2/property/value?address=1600+Amphitheatre+Pkwy&zipcode=94043", {
    method: "GET",
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
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
  heygen: testHeygen,
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
