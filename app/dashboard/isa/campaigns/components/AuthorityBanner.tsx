// NON-DISMISSIBLE — do not add close/hide logic
export function AuthorityBanner() {
  return (
    <div className="w-full rounded-lg border border-yellow-400 bg-yellow-50 px-4 py-3">
      <p className="text-sm font-semibold text-yellow-900">
        🔒 ISA Authority Rules: Automated outreach is BLOCKED for contacts in{" "}
        <span className="font-bold">REPRESENTATION</span> or{" "}
        <span className="font-bold">ACTIVE_TRANSACTION</span> states. Permitted contact states:{" "}
        <span className="font-bold">LEAD, PROSPECT, NEW_CONTACT</span> only.
      </p>
    </div>
  )
}
