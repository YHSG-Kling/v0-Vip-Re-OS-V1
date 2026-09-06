"use client"

// Developers settings — client surface. Three sections + a docs block:
//   1. Webhook subscriptions (create with event picker; toggle/delete/test-ping
//      with the endpoint's REAL response shown)
//   2. Delivery log (last 50 — status / attempts / HTTP response / error detail)
//   3. API tokens (brokerage tier mints scoped vos_ tokens; lower tiers see the
//      honest "available on Brokerage tier" state)
// Secrets and tokens are displayed exactly once, at mint.

import { useState, useTransition } from "react"
import {
  createWebhookSubscription,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  sendWebhookTestPing,
  listWebhookDeliveries,
  mintTenantApiToken,
  revokeTenantApiToken,
  type WebhookSubscriptionView,
  type WebhookDeliveryView,
  type DeveloperTokenState,
  type DevelopersDocsData,
} from "@/app/actions/tenant-webhooks"

interface Props {
  initialSubscriptions: WebhookSubscriptionView[]
  initialDeliveries: WebhookDeliveryView[]
  deliveriesError: string | null
  tokenState: DeveloperTokenState | null
  tokenStateError: string | null
  docs: DevelopersDocsData
}

function fmt(ts: string | null): string {
  if (!ts) return "—"
  try { return new Date(ts).toLocaleString() } catch { return ts }
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    delivered: "bg-green-50 text-green-700 border-green-200",
    pending: "bg-blue-50 text-blue-700 border-blue-200",
    failed: "bg-amber-50 text-amber-700 border-amber-200",
    dead: "bg-red-50 text-red-700 border-red-200",
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-xs font-medium ${styles[status] ?? "bg-gray-50 text-gray-600 border-gray-200"}`}>
      {status}
    </span>
  )
}

export function DevelopersClient(props: Props) {
  const [subscriptions, setSubscriptions] = useState(props.initialSubscriptions)
  const [deliveries, setDeliveries] = useState(props.initialDeliveries)
  const [tokens, setTokens] = useState(props.tokenState?.tokens ?? [])
  const [isPending, startTransition] = useTransition()

  // Create-subscription form
  const [showCreate, setShowCreate] = useState(false)
  const [newUrl, setNewUrl] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [newEvents, setNewEvents] = useState<string[]>([])
  const [createError, setCreateError] = useState<string | null>(null)
  const [freshSecret, setFreshSecret] = useState<{ id: string; secret: string } | null>(null)

  // Test-ping results (per subscription, honest response)
  const [pingResults, setPingResults] = useState<Record<string, string>>({})

  // Token mint form
  const [tokenName, setTokenName] = useState("")
  const [tokenScopes, setTokenScopes] = useState<string[]>([])
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [freshToken, setFreshToken] = useState<{ id: string; token: string } | null>(null)

  const toggleInList = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

  const refreshDeliveries = () => {
    startTransition(async () => {
      const res = await listWebhookDeliveries(50)
      if (res.ok) setDeliveries(res.rows)
    })
  }

  const handleCreate = () => {
    setCreateError(null)
    startTransition(async () => {
      const res = await createWebhookSubscription({ url: newUrl, events: newEvents, description: newDescription })
      if (!res.ok) { setCreateError(res.error); return }
      setFreshSecret({ id: res.id, secret: res.secret })
      setSubscriptions((prev) => [
        {
          id: res.id, url: newUrl.trim(), events: [...newEvents],
          description: newDescription.trim() || null, active: true,
          secretMasked: `whsec_…${res.secret.slice(-4)}`,
          createdAt: new Date().toISOString(), lastSuccessAt: null, lastFailureAt: null, failureCount: 0,
        },
        ...prev,
      ])
      setShowCreate(false); setNewUrl(""); setNewDescription(""); setNewEvents([])
    })
  }

  const handleToggleActive = (sub: WebhookSubscriptionView) => {
    startTransition(async () => {
      const res = await updateWebhookSubscription({ id: sub.id, active: !sub.active })
      if (res.ok) setSubscriptions((prev) => prev.map((s) => (s.id === sub.id ? { ...s, active: !sub.active } : s)))
    })
  }

  const handleDelete = (id: string) => {
    startTransition(async () => {
      const res = await deleteWebhookSubscription(id)
      if (res.ok) setSubscriptions((prev) => prev.filter((s) => s.id !== id))
    })
  }

  const handlePing = (id: string) => {
    setPingResults((prev) => ({ ...prev, [id]: "sending…" }))
    startTransition(async () => {
      const res = await sendWebhookTestPing(id)
      const text = !res.ok
        ? `error: ${res.error}`
        : res.delivered
          ? `delivered — HTTP ${res.status} in ${res.durationMs}ms`
          : `failed — ${res.status !== null ? `HTTP ${res.status}` : "no response"} (${res.error ?? "unknown"}) in ${res.durationMs}ms`
      setPingResults((prev) => ({ ...prev, [id]: text }))
    })
  }

  const handleMint = () => {
    setTokenError(null)
    startTransition(async () => {
      const res = await mintTenantApiToken({ name: tokenName, scopes: tokenScopes })
      if (!res.ok) { setTokenError(res.error); return }
      setFreshToken({ id: res.id, token: res.token })
      setTokens((prev) => [
        { id: res.id, name: tokenName.trim(), scopes: [...tokenScopes], isActive: true, createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: null },
        ...prev,
      ])
      setTokenName(""); setTokenScopes([])
    })
  }

  const handleRevoke = (id: string) => {
    startTransition(async () => {
      const res = await revokeTenantApiToken(id)
      if (res.ok) setTokens((prev) => prev.map((t) => (t.id === id ? { ...t, isActive: false } : t)))
    })
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Developers</h1>
        <p className="text-gray-600 mt-2">
          Outbound webhooks and scoped API tokens for your brokerage. Webhooks fire from the OS&apos;s
          canonical event ledger — signed, retried with backoff, and honestly logged below.
        </p>
      </div>

      {/* ── Webhook subscriptions ─────────────────────────────────────────── */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Webhook endpoints</h2>
            <p className="text-sm text-gray-500">POST notifications to your systems when events happen in the OS</p>
          </div>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
          >
            {showCreate ? "Cancel" : "Add endpoint"}
          </button>
        </div>

        {freshSecret && (
          <div className="mx-6 mt-4 p-4 rounded-lg border border-amber-300 bg-amber-50">
            <p className="text-sm font-medium text-amber-900">Signing secret — shown once, store it now</p>
            <code className="block mt-2 text-sm bg-white border border-amber-200 rounded px-3 py-2 break-all">{freshSecret.secret}</code>
            <p className="text-xs text-amber-800 mt-2">
              Use it to verify the <code>X-Webhook-Signature</code> header (scheme in the docs block below).
            </p>
            <button onClick={() => setFreshSecret(null)} className="mt-2 text-xs text-amber-900 underline">I&apos;ve stored it</button>
          </div>
        )}

        {showCreate && (
          <div className="px-6 py-4 border-b border-gray-100 space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700">Endpoint URL</label>
              <input
                value={newUrl} onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://example.com/webhooks/vip-re-os"
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Description (optional)</label>
              <input
                value={newDescription} onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What consumes this endpoint?"
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Events</label>
              <div className="grid sm:grid-cols-2 gap-2">
                {props.docs.catalog.map((ev) => (
                  <label key={ev.event} className="flex items-start gap-2 text-sm border border-gray-200 rounded-lg px-3 py-2 cursor-pointer hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={newEvents.includes(ev.event)}
                      onChange={() => setNewEvents((prev) => toggleInList(prev, ev.event))}
                      className="mt-0.5"
                    />
                    <span>
                      <code className="font-medium text-gray-900">{ev.event}</code>
                      <span className="block text-xs text-gray-500">{ev.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            {createError && <p className="text-sm text-red-600">{createError}</p>}
            <button
              onClick={handleCreate}
              disabled={isPending}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Create endpoint
            </button>
          </div>
        )}

        <div className="divide-y divide-gray-100">
          {subscriptions.length === 0 && !showCreate && (
            <p className="px-6 py-8 text-sm text-gray-500 text-center">
              No webhook endpoints yet. Add one to start receiving signed event notifications.
            </p>
          )}
          {subscriptions.map((sub) => (
            <div key={sub.id} className="px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 break-all">{sub.url}</p>
                  {sub.description && <p className="text-xs text-gray-500 mt-0.5">{sub.description}</p>}
                  <p className="text-xs text-gray-500 mt-1">
                    <span className="font-mono">{sub.secretMasked}</span>
                    {" · "}events: {sub.events.join(", ")}
                    {" · "}last success {fmt(sub.lastSuccessAt)}
                    {sub.failureCount > 0 && <span className="text-red-600"> · {sub.failureCount} dead delivery{sub.failureCount === 1 ? "" : "ies"}</span>}
                  </p>
                  {pingResults[sub.id] && (
                    <p className="text-xs mt-1 font-mono text-gray-700">test ping → {pingResults[sub.id]}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={sub.active ? "delivered" : "dead"} />
                  <button onClick={() => handlePing(sub.id)} disabled={isPending} className="text-xs text-blue-700 hover:underline disabled:opacity-50">Test</button>
                  <button onClick={() => handleToggleActive(sub)} disabled={isPending} className="text-xs text-gray-700 hover:underline disabled:opacity-50">
                    {sub.active ? "Pause" : "Resume"}
                  </button>
                  <button onClick={() => handleDelete(sub.id)} disabled={isPending} className="text-xs text-red-600 hover:underline disabled:opacity-50">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Delivery log ──────────────────────────────────────────────────── */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Delivery log</h2>
            <p className="text-sm text-gray-500">The last 50 deliveries — status, attempts, and the endpoint&apos;s real response</p>
          </div>
          <button onClick={refreshDeliveries} disabled={isPending} className="text-sm text-blue-700 hover:underline disabled:opacity-50">Refresh</button>
        </div>
        {props.deliveriesError && <p className="px-6 py-3 text-sm text-red-600">{props.deliveriesError}</p>}
        {deliveries.length === 0 ? (
          <p className="px-6 py-8 text-sm text-gray-500 text-center">
            No deliveries yet. Deliveries appear here after a subscribed event fires and the worker runs (every few minutes).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="px-6 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Attempts</th>
                  <th className="px-3 py-2 font-medium">HTTP</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Delivered / next try</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {deliveries.map((d) => (
                  <tr key={d.id} className="align-top">
                    <td className="px-6 py-2 font-mono text-xs text-gray-900">{d.eventType}</td>
                    <td className="px-3 py-2"><StatusBadge status={d.status} /></td>
                    <td className="px-3 py-2 text-gray-700">{d.attempts}</td>
                    <td className="px-3 py-2 text-gray-700">{d.responseStatus ?? "—"}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{fmt(d.createdAt)}</td>
                    <td className="px-3 py-2 text-gray-500 text-xs">
                      {d.status === "delivered" ? fmt(d.deliveredAt) : d.status === "dead" ? "—" : fmt(d.nextAttemptAt)}
                      {d.errorDetail && <span className="block text-red-600 max-w-xs truncate" title={d.errorDetail}>{d.errorDetail}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── API tokens ────────────────────────────────────────────────────── */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">API tokens</h2>
          <p className="text-sm text-gray-500">
            Scoped Bearer credentials (<code>vos_…</code>) for the Agentic-OS API (<code>/api/agentic-os/*</code>)
          </p>
        </div>

        {props.tokenStateError && <p className="px-6 py-4 text-sm text-red-600">{props.tokenStateError}</p>}

        {props.tokenState && !props.tokenState.tokensAvailable && (
          <div className="px-6 py-8 text-center">
            <p className="text-sm font-medium text-gray-700">
              API tokens are available on the {props.tokenState.requiredTierLabel} tier
            </p>
            <p className="text-xs text-gray-500 mt-1">
              You&apos;re on the {props.tokenState.tierLabel} tier. Upgrade to mint scoped API tokens for external agents and integrations.
            </p>
          </div>
        )}

        {props.tokenState?.tokensAvailable && (
          <>
            {freshToken && (
              <div className="mx-6 mt-4 p-4 rounded-lg border border-amber-300 bg-amber-50">
                <p className="text-sm font-medium text-amber-900">API token — shown once, store it now</p>
                <code className="block mt-2 text-sm bg-white border border-amber-200 rounded px-3 py-2 break-all">{freshToken.token}</code>
                <p className="text-xs text-amber-800 mt-2">Send it as <code>Authorization: Bearer &lt;token&gt;</code>. Only its hash is stored.</p>
                <button onClick={() => setFreshToken(null)} className="mt-2 text-xs text-amber-900 underline">I&apos;ve stored it</button>
              </div>
            )}

            <div className="px-6 py-4 border-b border-gray-100 space-y-3">
              <div className="flex gap-3">
                <input
                  value={tokenName} onChange={(e) => setTokenName(e.target.value)}
                  placeholder="Token name (e.g. Zapier bridge)"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
                <button
                  onClick={handleMint} disabled={isPending}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Mint token
                </button>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                {props.tokenState.mintableScopes.map((s) => (
                  <label key={s.scope} className="flex items-center gap-2 text-sm border border-gray-200 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={tokenScopes.includes(s.scope)}
                      onChange={() => setTokenScopes((prev) => toggleInList(prev, s.scope))}
                    />
                    <code className="text-gray-900">{s.scope}</code>
                    <span className="text-xs text-gray-500">{s.description}</span>
                  </label>
                ))}
              </div>
              {tokenError && <p className="text-sm text-red-600">{tokenError}</p>}
            </div>

            <div className="divide-y divide-gray-100">
              {tokens.length === 0 && (
                <p className="px-6 py-8 text-sm text-gray-500 text-center">No API tokens yet. Mint one to let an external agent or integration call the Agentic-OS API.</p>
              )}
              {tokens.map((t) => (
                <div key={t.id} className="px-6 py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{t.name}</p>
                    <p className="text-xs text-gray-500">
                      {t.scopes.join(", ")} · created {fmt(t.createdAt)} · last used {fmt(t.lastUsedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs font-medium ${t.isActive ? "text-green-700" : "text-gray-400"}`}>
                      {t.isActive ? "active" : "revoked"}
                    </span>
                    {t.isActive && (
                      <button onClick={() => handleRevoke(t.id)} disabled={isPending} className="text-xs text-red-600 hover:underline disabled:opacity-50">Revoke</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ── Docs ──────────────────────────────────────────────────────────── */}
      <section className="bg-white border border-gray-200 rounded-lg">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Webhook reference</h2>
          <p className="text-sm text-gray-500">Signature scheme, retry policy, and the exact payload shape</p>
        </div>
        <div className="px-6 py-4 space-y-4 text-sm text-gray-700">
          <div>
            <h3 className="font-medium text-gray-900">Signature</h3>
            <p className="mt-1">
              Every POST carries <code>X-Webhook-Signature</code>, <code>X-Webhook-Event</code>, and{" "}
              <code>X-Webhook-Delivery</code> headers. The signature is Stripe-style:
            </p>
            <pre className="mt-2 bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs overflow-x-auto">{props.docs.signatureHeaderExample}</pre>
            <p className="mt-2 text-xs text-gray-500">Verify (Node.js):</p>
            <pre className="mt-1 bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs overflow-x-auto">{`const [tPart, vPart] = header.split(",")
const t = tPart.slice(2)                      // "t=<unix-seconds>"
const sig = vPart.slice(3)                    // "v1=<hex>"
const expected = crypto.createHmac("sha256", secret)
  .update(\`\${t}.\${rawBody}\`).digest("hex")
const valid = crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300`}</pre>

            {/* A real, known-good triple to test that code against, generated by
                the same signer that signs live deliveries and checked with our
                own verifier before it is shown. */}
            {props.docs.signatureTestVector && (
              <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                <p className="text-xs font-medium text-gray-900">Test vector</p>
                {props.docs.signatureTestVector.error ? (
                  <p className="mt-1 text-xs text-red-600">{props.docs.signatureTestVector.error}</p>
                ) : (
                  <>
                    <p className="mt-1 text-xs text-gray-500">
                      Run your verifier against this before you go live. The body must be signed{" "}
                      <strong>byte for byte</strong> as sent — re-serializing the JSON changes the HMAC.
                      This vector&apos;s timestamp is fixed so it is reproducible, so check the HMAC only;
                      keep the ±300s tolerance on real traffic.
                    </p>
                    <pre className="mt-2 bg-white border border-gray-200 rounded p-3 text-xs overflow-x-auto">{`secret:   ${props.docs.signatureTestVector.secret}
rawBody:  ${props.docs.signatureTestVector.rawBody}
header:   ${props.docs.signatureTestVector.header}
→ expected result: valid`}</pre>
                    <p className="mt-2 text-xs text-gray-500">
                      That secret is for this example only — it signs no real delivery. Yours is the one
                      shown once when you add or rotate an endpoint.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
          <div>
            <h3 className="font-medium text-gray-900">Retries</h3>
            <p className="mt-1">
              Any non-2xx response (or a 5-second timeout) is retried with backoff — 1m, 5m, 30m, then 2h.
              The 5th consecutive failure marks the delivery <StatusBadge status="dead" /> and counts against the endpoint.
              Payload <code>id</code> is stable across retries — use it as your idempotency key.
            </p>
          </div>
          <div>
            <h3 className="font-medium text-gray-900">Payload</h3>
            <pre className="mt-2 bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs overflow-x-auto">{props.docs.samplePayloadJson}</pre>
          </div>
          <div>
            <h3 className="font-medium text-gray-900">Events</h3>
            <ul className="mt-2 space-y-1">
              {props.docs.catalog.map((ev) => (
                <li key={ev.event}>
                  <code className="text-gray-900">{ev.event}</code>
                  <span className="text-gray-500"> — {ev.description}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  )
}
