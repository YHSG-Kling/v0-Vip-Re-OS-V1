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
//
// READ GATE TIGHTENED (wave 4 slice 2). This page used to call the raw library
// read `getDealRoomDemoStatus()` directly, which applies NO capability check —
// so the layout's "platform staff" gate was the whole boundary on the read,
// while both mutations on the same page require `requirePlatformCapability
// ("tenants")`. A staff member without the tenants capability could therefore
// see the demo tenant's id, brokerage name, lead id and contact id, and be shown
// Seed / Tear down controls that would refuse. It now reads through
// getDealRoomDemoStatusAction, which carries the SAME 'tenants' capability gate
// the mutations do — read and write finally agree. (The action was NOT deleted
// as a "thin duplicate" of the library function: this gate is exactly the thing
// it adds.)

import { buildDealRoomRunbook } from "@/lib/platform/deal-room-demo"
import { getDealRoomDemoStatusAction } from "@/app/actions/superadmin/deal-room-demo"
import { DemoRoomClient } from "./demo-room-client"

export const dynamic = "force-dynamic"

export default async function DemoRoomPage() {
  const res = await getDealRoomDemoStatusAction()
  if (!res.ok || !res.status) {
    // Say WHY, and render nothing else. A capability refusal must not fall
    // through to an empty runbook that reads as "the demo is not seeded".
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Deal Room demo unavailable</p>
        <p className="mt-1">
          {res.error ?? "The demo status could not be read."} The Deal Room needs the
          platform <code>tenants</code> capability.
        </p>
      </div>
    )
  }
  const status = res.status
  const runbook = buildDealRoomRunbook({
    leadId: status.leadId,
    contactId: status.contactId,
  })
  return <DemoRoomClient status={status} runbook={runbook} />
}
