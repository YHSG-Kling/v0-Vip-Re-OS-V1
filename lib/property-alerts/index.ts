export { runAlert, runAllActiveAlerts }      from "./alert-engine"
export { scorePropertyForAlert }             from "./alert-matcher"
// `searchIDXForAlert` is no longer IDX-only — it routes the tenant's own IDX
// board OR the platform's RentCast. The name is retained on purpose; see the
// header of ./idx-alert-search.ts for why a rename is an integrator-side change.
export { searchIDXForAlert, RENTCAST_ALERT_KEY_PREFIX } from "./idx-alert-search"
export { deliverAlertResults }               from "./alert-notifier"
export { isSnoozed }                         from "./alert-cadence"
export type { RunAlertResult }               from "./alert-engine"
export type { AlertListingSearchResult, AlertSearchContext, AlertSearchRefusal } from "./idx-alert-search"
export type { MatchResult, AlertProperty, AlertCriteria } from "./alert-matcher"
