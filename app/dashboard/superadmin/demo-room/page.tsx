// app/dashboard/superadmin/demo-room/page.tsx
// ─────────────────────────────────────────────────────────────────────────────
// THE DEAL ROOM — the presenter's runbook for the flagship sales demo. A
// prospect watches the AI team run one deal end to end on the SANCTIONED demo
// tenant: scraped lead → territory match → AI-ISA qualification → conversion +
// policy assignment → a manager deliberation resolving live → a Zoom-
// appointment beat → the client recap.
//
// NO NEW RENDER SURFACES: the demo IS the real product — every runbook step
// deep-links into the live surface where that beat actually lives (/leads, the
// AI-ISA console, the contact record, manager-trust, the meeting room, the
// client portal). This page only stages the story (seed/teardown, superadmin
// actions) and hands the presenter the ordered walkthrough.
//
// Access: the superadmin layout gates the subtree to platform staff; the
// mutating actions additionally require the 'tenants' capability with write.

import { getDealRoomDemoStatus, buildDealRoomRunbook } from "@/lib/platform/deal-room-demo"
import { DemoRoomClient } from "./demo-room-client"

export const dynamic = "force-dynamic"

export default async function DemoRoomPage() {
  const status = await getDealRoomDemoStatus()
  const runbook = buildDealRoomRunbook({
    leadId: status.leadId,
    contactId: status.contactId,
  })
  return <DemoRoomClient status={status} runbook={runbook} />
}
