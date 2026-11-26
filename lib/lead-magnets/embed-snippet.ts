/**
 * lib/lead-magnets/embed-snippet.ts — the MISSING HALF of POST
 * /api/lead-magnets/submissions (lane 85E, census 6d, CLAUDE.md §1.2).
 *
 * That route's own header says it exists "for embeds OUTSIDE this app": a
 * brokerage's own website posting a lead-magnet form straight into the ONE
 * kernel command (lib/kernel/lead-magnets.ts captureFormSubmission — consent,
 * provenance, the lead pipeline). The opposite-missing census had carried it as
 * an UNRESOLVED door for waves because NOTHING anywhere handed a tenant that
 * embed: the lead-magnet library showed only the hosted /lm/[slug] page, and
 * the route answered no CORS preflight, so a form on another origin could not
 * have read its own result even if someone had hand-written one. This module
 * builds the snippet the library's "Embed on your site" control copies, and the
 * route now answers the preflight the snippet's JSON POST triggers.
 *
 * Checked before building (grep + the embeds settings page): the only other
 * embed surface, app/dashboard/settings/embeds, hands out the AI-twin CHAT
 * widget script (/api/embed/script) — a different capability, not a form.
 *
 * PURE — no I/O. Every interpolated value is escaped for the attribute/JS
 * context it lands in; the tenant pair it carries (form id + brokerage id) is
 * already public on the hosted page and is VERIFIED server-side — the kernel
 * re-reads the form under that brokerage and refuses a mismatch.
 */

/** The ONE path the snippet posts to — the route this module is the other half of. */
export const LEAD_MAGNET_EMBED_ENDPOINT = "/api/lead-magnets/submissions"

export interface LeadMagnetEmbedInput {
  /** The app's public origin, e.g. https://app.example.com (no trailing slash needed). */
  origin: string
  /** lead_capture_forms.id — the form the kernel verifies. */
  formId: string
  /** The form's brokerage — cross-checked by the kernel, never trusted. */
  brokerageId: string
  /** Shown as the form's heading. */
  magnetName: string
  /** A valuation form carries the address field AND requires TCPA consent
   *  (the kernel refuses a consent-less property_address submission). */
  magnetType: string
  /** The disclosure the checkbox shows; the kernel's default when absent. */
  consentText?: string
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const jsStr = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c")

/** The endpoint URL on a given origin. */
export function leadMagnetEmbedEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${LEAD_MAGNET_EMBED_ENDPOINT}`
}

/**
 * The copy-paste HTML: a plain form (name, email, phone; address on a valuation
 * magnet), a consent checkbox, and a small script that POSTs the kernel's input
 * contract (CaptureFormSubmissionInput) as JSON and shows the ROUTE'S answer —
 * success only on a 201, the refusal's own error text otherwise (a consent-less
 * valuation is refused 422 by the kernel, never shown as "thanks").
 */
export function buildLeadMagnetEmbedSnippet(input: LeadMagnetEmbedInput): string {
  const endpoint = leadMagnetEmbedEndpoint(input.origin)
  const valuation = input.magnetType === "home_valuation"
  const consent = input.consentText ?? "By submitting this form, you consent to receive communications from us. You may opt out at any time."
  const id = `vip-lm-${input.formId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`
  return [
    `<form id="${esc(id)}" style="max-width:420px;font-family:system-ui,sans-serif">`,
    `  <h3>${esc(input.magnetName)}</h3>`,
    `  <input name="first_name" placeholder="First name" required style="display:block;width:100%;margin:6px 0">`,
    `  <input name="last_name" placeholder="Last name" required style="display:block;width:100%;margin:6px 0">`,
    `  <input name="email" type="email" placeholder="Email" required style="display:block;width:100%;margin:6px 0">`,
    `  <input name="phone" type="tel" placeholder="Phone (optional)" style="display:block;width:100%;margin:6px 0">`,
    ...(valuation ? [`  <input name="property_address" placeholder="Property address" required style="display:block;width:100%;margin:6px 0">`] : []),
    `  <label style="display:block;font-size:12px;margin:8px 0"><input type="checkbox" name="tcpa"${valuation ? " required" : ""}> ${esc(consent)}</label>`,
    `  <button type="submit">Send</button>`,
    `  <p data-status style="font-size:13px"></p>`,
    `</form>`,
    `<script>`,
    `(function(){var f=document.getElementById(${jsStr(id)});if(!f)return;f.addEventListener("submit",function(e){e.preventDefault();`,
    `var d={};new FormData(f).forEach(function(v,k){if(k!=="tcpa"&&v!=="")d[k]=v});var s=f.querySelector("[data-status]");s.textContent="Sending…";`,
    `fetch(${jsStr(endpoint)},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({formId:${jsStr(input.formId)},brokerageId:${jsStr(input.brokerageId)},submissionData:d,tcpaConsentGiven:!!f.tcpa.checked,source:"embed"})})`,
    `.then(function(r){return r.json().then(function(j){if(r.status===201&&j.success){s.textContent="Thank you — we will be in touch.";f.reset()}else{s.textContent=(j&&j.error)||"Something went wrong. Please try again."}})})`,
    `.catch(function(){s.textContent="Something went wrong. Please try again."})})})();`,
    `</script>`,
  ].join("\n")
}

/**
 * The CORS headers the route answers with. The door is PUBLIC BY DESIGN (the
 * submitter is the lead; there is no session to protect and the tenant pair is
 * verified by the kernel), so any origin may POST — but only POST/OPTIONS and
 * only a JSON body, and no credentials are ever admitted.
 */
export const LEAD_MAGNET_EMBED_CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
}
