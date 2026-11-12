/**
 * scripts/canaries/_esign-dispatch-stub.ts — WAVE 141 (lane 141K): the ONE e-sign dispatch core
 * (lib/esign/dispatch-packet.ts) with its egress door (dispatchEsignPacket) replaced by a RECORDER.
 * Everything else is the real module (`export *`), so any other named import still links. Installed by
 * the CDA canary through _harness.ts stubModule() BEFORE lib/transactions/cda-esign.ts is first imported;
 * the canary asserts the recorder was HIT (a stub that missed its graph is not a pass). No envelope ever
 * reaches DocuSign, Dotloop, SkySlope, Authentisign or Google Drive from here.
 */
export * from "../../lib/esign/dispatch-packet"

export interface RecordedEsignDispatch {
  brokerageId: string
  userId: string | null
  signers: Array<{ email: string; name?: string; role?: string }>
  documents: Array<{ name: string; url?: string }>
  recordId: string | null
  propertyAddress: string | null
}
interface EsignRecorder {
  calls: RecordedEsignDispatch[]
  respond: (req: RecordedEsignDispatch) => Record<string, unknown>
}
const G = globalThis as unknown as { __W141_ESIGN?: EsignRecorder }
G.__W141_ESIGN ??= { calls: [], respond: () => ({ ok: true, kind: "api", providerName: "docusign", envelopeId: "env_canary_1", status: "sent" }) }

/** The recorder — the canary reads `calls` and may replace `respond`. */
export function esignDispatchRecorder(): EsignRecorder { return G.__W141_ESIGN! }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the dispatch core's signature
export async function dispatchEsignPacket(_svc: any, input: any): Promise<any> {
  const rec = G.__W141_ESIGN!
  const call: RecordedEsignDispatch = {
    brokerageId: input.brokerageId, userId: input.userId ?? null, signers: input.signers ?? [], documents: input.documents ?? [],
    recordId: input.recordId ?? null, propertyAddress: input.propertyAddress ?? null,
  }
  rec.calls.push(call)
  return rec.respond(call)
}
