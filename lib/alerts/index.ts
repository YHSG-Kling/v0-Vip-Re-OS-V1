// lib/alerts barrel — Property Alert System

export { scorePropertyAgainstAlert } from "./alert-matcher"
export type { IDXProperty, PropertyAlert } from "./alert-matcher"

export { runAlertEngine } from "./alert-engine"
export type { AlertEngineResult } from "./alert-engine"

export { sendAlertNotification } from "./alert-notifier"
