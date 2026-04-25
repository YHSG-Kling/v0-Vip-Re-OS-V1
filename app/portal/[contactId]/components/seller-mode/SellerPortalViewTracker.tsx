"use client"

/**
 * SellerPortalViewTracker
 *
 * Fires the seller_portal_viewed analytics event exactly once after the
 * component mounts on the client.  Rendered by the SellerHome server component
 * so the event is never triggered during SSR or prefetch passes.
 */

import { useEffect } from "react"
import { emitSellerPortalViewed } from "@/app/actions/portal-seller"

interface Props {
  contactId: string
  page: string
}

export function SellerPortalViewTracker({ contactId, page }: Props) {
  useEffect(() => {
    emitSellerPortalViewed(contactId, page).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
