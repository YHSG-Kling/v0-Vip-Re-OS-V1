"use server"

import { lookupPropertyByAddress, type AddressLookupResult } from "@/lib/property/address-lookup"
// THE SPEND ACTOR. This is a "use server" export, so the tenant the paid
// Perplexity lookup below is billed to can only come from the SESSION (§4).
import { getAgentContext } from "@/lib/identity/get-agent-context"

export type { AddressLookupResult }

export async function lookupAddressAction(params: {
  address: string
  city: string
  state: string
  zip?: string
}): Promise<AddressLookupResult> {
  const spendActor = await getAgentContext()
  return lookupPropertyByAddress({
    ...params,
    brokerageId: spendActor.brokerageId,
    userId: spendActor.userId || null,
  })
}
