/**
 * scripts/canaries/_connector-gateway-stub.ts — WAVE 141 (lane 141J): the connector gateway with its ONE
 * egress door (callConnector) replaced by a RECORDER. Everything else is the real module (`export *`), so a
 * named import of any other gateway export still links. Installed by the CRM sync-out canary through
 * _harness.ts stubModule() BEFORE lib/crm/sync.ts is first imported; the canary asserts the recorder was
 * HIT — a stub that missed its graph is not a pass. Nothing here ever reaches the network.
 */
export * from "../../lib/agentic-os/connector-gateway"

export interface RecordedConnectorCall { connector: string; baseUrl: string; path: string; method?: string; auth?: unknown; body?: unknown }
interface Recorder {
  calls: RecordedConnectorCall[]
  respond: (req: RecordedConnectorCall) => { ok: boolean; status: number | null; data: unknown; error?: string | null }
}
const G = globalThis as unknown as { __W141_CONNECTOR?: Recorder }
G.__W141_CONNECTOR ??= { calls: [], respond: () => ({ ok: true, status: 201, data: { id: "canary-remote-1" } }) }

/** The recorder — the canary reads `calls` and may replace `respond`. */
export function connectorRecorder(): Recorder { return G.__W141_CONNECTOR! }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the gateway's generic signature
export async function callConnector<T = any>(req: any): Promise<any> {
  const rec = G.__W141_CONNECTOR!
  const call: RecordedConnectorCall = { connector: req.connector, baseUrl: req.baseUrl, path: req.path, method: req.method, auth: req.auth, body: req.body }
  rec.calls.push(call)
  const r = rec.respond(call)
  return { ok: r.ok, status: r.status, data: r.data as T, headers: {}, drift: null, error: r.error ?? null }
}
