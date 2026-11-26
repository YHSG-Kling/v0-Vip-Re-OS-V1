// instrumentation.ts — Next.js server instrumentation (wave 152, lane 152K — convergence row 93; finding F-6 / R-5 in
// docs/architecture/PRODUCTION-ARCHITECTURE.md, spec 143H-OL-08).
//
// A server error that escapes a route / render / server action WITHOUT passing through collectError left no
// automation_errors row — the flight recorder never heard of it. Next calls onRequestError for exactly those errors.
// This hook hands each one to THE error writer (lib/errors/collect-error.ts collectError — the one intake, service
// client, never throws) and nothing else:
//   · Node runtime only (the edge runtime cannot load the service client) — gated on NEXT_RUNTIME, the precedent in
//     lib/enrichment/inline-drain.ts;
//   · the request PATH without its query string (a query can carry an email, a token or an id), the method and Next's
//     route context — never a header, never a cookie, never a body;
//   · tenant unresolved → platform scope (no brokerage id is guessed from a URL);
//   · it never throws: a failed report must not turn one error into two.

// The parameter shapes Next passes (next/dist/server/instrumentation/types.d.ts InstrumentationOnRequestError), narrowed
// to the fields read here — headers are deliberately not in the type, so they cannot be logged by accident.
type RequestErrorRequest = Readonly<{ path: string; method: string }>
type RequestErrorContext = Readonly<{ routerKind: string; routePath: string; routeType: string; renderSource?: string }>

export async function onRequestError(error: unknown, request: RequestErrorRequest, context: RequestErrorContext): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  try {
    const { collectError } = await import("./lib/errors/collect-error")
    const e = error instanceof Error ? error : new Error(String(error))
    const digest = typeof (error as { digest?: unknown })?.digest === "string" ? (error as { digest: string }).digest : null
    await collectError({
      workflowName: `next:${context.routeType}:${context.routePath}`.slice(0, 200),
      errorMessage: e.message.slice(0, 2000),
      stack: e.stack,
      severity: "high",
      errorType: "unhandled_request_error",
      context: {
        method: request.method,
        path: String(request.path ?? "").split("?")[0].slice(0, 500),
        routerKind: context.routerKind,
        routeType: context.routeType,
        renderSource: context.renderSource ?? null,
        digest,
      },
    })
  } catch {
    // The hook must never throw (collectError already swallows its own failures; this guards the dynamic import).
  }
}
