import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { RequiredDocsSettingsClient } from "./required-docs-settings-client"
import { RequiredDocRowActions } from "./required-doc-row-actions"
import { getSupportedPresetStates } from "@/lib/compliance/required-doc-presets"
import { documentClassificationLabel } from "@/lib/compliance/document-classifications"
import { describeRowScope } from "@/lib/compliance/checklist-dimensions"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import { createServiceClient } from "@/lib/supabase/service"
import {
  EMPTY_TENANT_VOCABULARY, VOCABULARY_DIMENSIONS, checklistVocabularyFor, loadTenantVocabulary, resolveVocabularyValue, vocabularyOptions,
  type VocabularyDimension,
} from "@/lib/compliance/adaptive-vocabulary"
import { VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES, listVocabularyProposals } from "@/lib/compliance/vocabulary-healing"
import { isTenantAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { VocabularyPanel, type VocabularyPanelDimension } from "./vocabulary-panel"
import { ALL_US_STATES } from "@/lib/state-forms/registry"
import { loadComingSoonPolicy } from "@/lib/compliance/coming-soon-policy"

export const dynamic = "force-dynamic"

// SCOPE LADDER (kept inline — admits compliance/team_lead/agent tiers):
// 'superadmin' removed — dead as users.user_type (0 live rows); broker_owner
// added — storable seat that owns the brokerage.
//
// 'tc' ADDED. Owner's ruling, verbatim: "the required document list is in the
// settings for the transaction coordinator or admin." The TC is the role the
// ruling names FIRST and it was the one seat this page did not admit — a
// transaction coordinator opening Settings → Required documents was told they
// had no permission to see the list they own. `tc` is a live users.user_type
// (the auto-create chain resolves TCs by exactly that value), not an invention.
// The write side agrees: app/actions/compliance/manage-required-docs.ts.
const ADMIN_ROLES = ["tc","broker","broker_owner","broker_admin","admin","compliance_manager","compliance_officer","team_lead","agent"]

export default async function RequiredDocsSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, team_id, user_type, first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")
  if (!ADMIN_ROLES.includes(profile.user_type as string)) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card><CardHeader><CardTitle>Required documents</CardTitle></CardHeader>
        <CardContent>You don't have permission. Only the transaction coordinator (tc) / broker / broker_owner / broker_admin / admin / compliance_manager / compliance_officer / team_lead / agent can edit.</CardContent></Card>
      </div>
    )
  }

  // List all rules visible to this brokerage + the active form library for the
  // template picker (keep-one: Transaction Forms is the ONE upload pipeline).
  const [{ data: rules }, { data: libraryForms }] = await Promise.all([
    supabase
      .from("brokerage_required_documents")
      // star select: the m806 dimension columns (required_stage, financing_kind, contract_subtype,
      // representation, policy_version) are absent until the migration is applied, and a select that
      // names an absent column is refused whole — which would render as "No rules yet".
      .select("*")
      .eq("brokerage_id", profile.brokerage_id)
      .order("scope_type", { ascending: false })
      .order("classification", { ascending: true }),
    supabase
      .from("brokerage_form_library")
      .select("id, name, state, packet_type, pdf_url")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("is_active", true)
      .order("name")
      .limit(200),
  ])

  // THE ADAPTIVE VOCABULARY (wave 144A). Read through the service client AFTER the gate above, for the
  // SESSION's brokerage only (brokerage_settings is admin-only under RLS; the vocabulary is not). A refused
  // read is SHOWN, and the pickers fall back to the platform lists — never to an empty list.
  const svc = createServiceClient()
  const [vocabRead, proposalRead, comingSoonRead] = await Promise.all([
    loadTenantVocabulary(svc, profile.brokerage_id as string),
    listVocabularyProposals(svc, profile.brokerage_id as string),
    loadComingSoonPolicy(svc, profile.brokerage_id as string),
  ])
  const comingSoonRules = comingSoonRead.ok
    ? Object.values(comingSoonRead.policy.entries).map((e) => ({
        mlsName: e.mls_name, states: e.state_codes, attested: !!e.attestation, sourceUrl: e.source.url, ruleRef: e.source.rule_ref,
        summary: `${e.permitted ? "permitted" : "not permitted"}${e.max_days !== null ? `, max ${e.max_days} days` : ""}, showings ${e.showings_permitted ? "permitted" : "not permitted"}${e.mls_submission_within_business_days !== null ? `, MLS within ${e.mls_submission_within_business_days} business day(s) of public marketing` : ""}`,
      }))
    : []
  const vocabulary = vocabRead.ok ? vocabRead.vocabulary : EMPTY_TENANT_VOCABULARY
  const checklistVocabulary = checklistVocabularyFor(vocabulary)
  const dimensionOptions = vocabRead.ok
    ? { contract_subtype: vocabularyOptions("contract_subtype", vocabulary), representation: vocabularyOptions("representation", vocabulary) }
    : null
  const panelDimensions: VocabularyPanelDimension[] = (Object.keys(VOCABULARY_DIMENSIONS) as VocabularyDimension[])
    .filter((k) => VOCABULARY_DIMENSIONS[k].mode !== "platform_only")
    .map((k) => ({
      key: k, label: VOCABULARY_DIMENSIONS[k].label, mode: VOCABULARY_DIMENSIONS[k].mode as "extensible" | "label_alias_only",
      jurisdictional: VOCABULARY_DIMENSIONS[k].jurisdictional,
      terms: vocabularyOptions(k, vocabulary).map((o) => ({ value: o.value, label: o.label, origin: o.origin })),
    }))
  const pendingAttestation = Object.values(vocabulary.terms)
    .filter((t) => resolveVocabularyValue(t.dimension, t.key, vocabulary)?.pendingAttestation)
    .map((t) => ({ dimension: t.dimension, key: t.key, label: t.label, states: t.state_codes ?? [], sourceUrl: t.source?.url ?? null }))

  const formOptions = (libraryForms ?? []).map((f: any) => ({
    id: f.id as string,
    name: f.name as string,
    state: f.state as string,
    packetType: f.packet_type as string,
  }))
  const formById = new Map((libraryForms ?? []).map((f: any) => [f.id as string, f]))

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Required documents</h1>
        <p className="text-sm text-muted-foreground">
          The documents your deals must have on file before submitting to compliance. Rules cascade
          agent → team → brokerage (most specific wins per classification). Attach a blank template
          to any rule so agents grab the exact form you require — upload new form files in{" "}
          <a href="/dashboard/admin/transaction-forms" className="text-primary underline underline-offset-2">Legal Forms</a>.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Active rules ({(rules ?? []).length})</CardTitle></CardHeader>
        <CardContent>
          {(!rules || rules.length === 0) ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No rules yet. Pick your state below and click "Seed defaults" to load the US baseline plus your state's standard requirements.
            </p>
          ) : (
            <ul className="divide-y">
              {rules.map((r: any) => (
                <li key={r.id} className="py-3 flex items-start gap-3">
                  <Badge variant="outline" className="shrink-0 mt-0.5">
                    {r.scope_type}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium">{documentClassificationLabel(r.classification as string | null)}</p>
                      <Badge variant="secondary" className="text-xs">{r.deal_type}</Badge>
                      {r.state_code && <Badge variant="secondary" className="text-xs">{r.state_code}</Badge>}
                      {(r.required_stage || r.financing_kind || r.contract_subtype || r.representation) && (
                        <Badge variant="outline" className="text-xs">{describeRowScope({ ...r, deal_type: null, state_code: null }, checklistVocabulary)}</Badge>
                      )}
                      {r.legal_basis === "state_requirement" && (
                        r.source_url
                          ? <a href={r.source_url as string} target="_blank" rel="noreferrer"><Badge className="bg-blue-100 text-blue-900 text-xs">state requirement · cited</Badge></a>
                          : <Badge className="bg-blue-100 text-blue-900 text-xs">state requirement</Badge>
                      )}
                      {r.block_on_missing
                        ? <Badge className="bg-red-100 text-red-900 text-xs">blocking</Badge>
                        : <Badge className="bg-amber-100 text-amber-900 text-xs">warning</Badge>}
                    </div>
                    {r.description && <p className="text-xs text-muted-foreground mt-1">{r.description}</p>}
                    {r.template_form_id && (() => {
                      const form = formById.get(r.template_form_id as string)
                      return form ? (
                        <p className="text-xs mt-1">
                          <span className="text-muted-foreground">Template: </span>
                          {form.pdf_url ? (
                            <a href={form.pdf_url as string} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
                              {form.name as string}
                            </a>
                          ) : (
                            <span>{form.name as string}</span>
                          )}
                        </p>
                      ) : null
                    })()}
                  </div>
                  <RequiredDocRowActions
                    id={r.id as string}
                    blockOnMissing={!!r.block_on_missing}
                    templateFormId={(r.template_form_id as string | null) ?? null}
                    formOptions={formOptions}
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <RequiredDocsSettingsClient
        brokerageId={profile.brokerage_id as string}
        teamId={(profile.team_id as string | null) ?? null}
        userId={user.id}
        userType={profile.user_type as string}
        supportedStates={getSupportedPresetStates()}
        dimensionOptions={dimensionOptions}
        canCiteStateRequirement={VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has(profile.user_type as string)}
      />

      <VocabularyPanel
        dimensions={panelDimensions}
        proposals={proposalRead.ok ? proposalRead.rows.map((p) => ({ id: p.id, status: p.status, summary: p.summary, requiresCompliance: p.requiresCompliance, warnings: p.warnings, createdAt: p.createdAt })) : []}
        pendingAttestation={pendingAttestation}
        canApprove={isTenantAdminGrantRole(profile.user_type as string)}
        canAttest={VOCABULARY_COMPLIANCE_APPROVER_USER_TYPES.has(profile.user_type as string)}
        supportedStates={[...ALL_US_STATES].map(String).sort()}
        readError={vocabRead.ok ? (proposalRead.ok ? (comingSoonRead.ok ? null : comingSoonRead.error) : proposalRead.error) : vocabRead.error}
        comingSoonRules={comingSoonRules}
      />
    </div>
  )
}
