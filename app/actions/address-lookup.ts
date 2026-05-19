"use server"

import { lookupPropertyByAddress, type AddressLookupResult } from "@/lib/property/address-lookup"

export type { AddressLookupResult }

export async function lookupAddressAction(params: {
  address: string
  city: string
  state: string
  zip?: string
}): Promise<AddressLookupResult> {
  return lookupPropertyByAddress(params)
}
