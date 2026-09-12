// lib/did/gateway.ts
// ─────────────────────────────────────────────────────────────────────────────
// EVERY D-ID CALL LEAVES THROUGH CONNECTION OS.
//
// The connector gateway's own header states the architecture rule: "every
// outbound api / oauth / mcp call leaves the app through this one function, and
// every response comes back IN through connector-shape.adaptResponse (so a
// vendor field rename self-heals + is reported as drift) … never a bespoke
// fetch scattered across feature code."
//
// Six D-ID surfaces were doing exactly the bespoke fetch that rule forbids —
// thirteen raw calls in total. What that costs, concretely:
//
//   · NO SELF-HEALING. A D-ID field rename is invisible; adaptResponse exists to
//     catch it and report the drift, and a raw fetch skips it entirely.
//   · NO CREDENTIAL PATH. The gateway is where auth is resolved and rotated. A
//     raw fetch pins process.env.DID_API_KEY at the call site, so a rotated or
//     tenant-scoped credential never reaches it.
//   · NO METERING OR ATTRIBUTION. Vendor spend and connector health are counted
//     at the gateway. Thirteen calls were invisible to both.
//
// lib/did/index.ts already had didPost/didGet on the gateway, but they are
// private to that module and they THROW. The route handlers need the opposite:
// a total call that returns {ok, status, data} so they can run it through
// classifyDidError and give the agent a real instruction. That is what this is.
//
// It carries the two headers the D-ID contract requires on every call, so no
// caller can forget them:
//   · Basic auth from DID_API_KEY (D-ID uses the key as the username, blank pw).
//   · x-api-key-external with OUR ElevenLabs key, because the reference is
//     explicit that it is "your own ElevenLabs API key for TTS (IVC voices
//     only)" — every agent voice here is an IVC clone in our account, so without
//     it D-ID resolves voice_id against ITS account, the avatar speaks in a
//     stranger's voice, and nothing reports a problem.

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { externalKeyHeader } from "./contract"

const DID_BASE = "https://api.d-id.com"

export interface DidGatewayResult<T = any> {
  ok: boolean
  /** HTTP status, or null when the request never completed. */
  status: number | null
  data: T | null
  /** Gateway-level error string, when the call never produced a response. */
  error: string | null
}

export interface DidRequestInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  body?: unknown
  /** Extra headers. The auth + external-key headers are always merged in. */
  headers?: Record<string, string>
  /**
   * Send the ElevenLabs external key. TRUE by default because the voice-bearing
   * endpoints are the common case; a plain status GET does not need it and
   * passing it there is noise, not harm.
   */
  withExternalKey?: boolean
}

/** True when the platform D-ID credential is configured at all. */
export function didConfigured(): boolean {
  return !!(process.env.DID_API_KEY ?? "").trim()
}

/**
 * Call D-ID through the single egress path.
 *
 * TOTAL — never throws. A missing credential, a transport failure and a 4xx all
 * come back as `{ok:false}` with whatever status there was, so the caller can
 * hand the body to classifyDidError and turn it into something a human can act
 * on rather than a shrug.
 */
export async function didRequest<T = any>(
  path: string, init: DidRequestInit = {},
): Promise<DidGatewayResult<T>> {
  const key = (process.env.DID_API_KEY ?? "").trim()
  if (!key) {
    return { ok: false, status: null, data: null, error: "DID_API_KEY is not configured" }
  }

  try {
    const res = await callConnector<T>({
      connector: "did",
      baseUrl: DID_BASE,
      path,
      method: init.method ?? "GET",
      auth: { style: "basic", username: key, password: "" },
      headers: {
        ...(init.withExternalKey === false ? {} : externalKeyHeader()),
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    })
    return {
      ok: res.ok,
      status: res.status ?? null,
      data: (res.data ?? null) as T | null,
      error: res.error ?? null,
    }
  } catch (e) {
    return {
      ok: false, status: null, data: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
