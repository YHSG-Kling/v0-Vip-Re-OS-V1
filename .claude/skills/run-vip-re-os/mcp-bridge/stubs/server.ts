import { currentUserClient } from "../bridge"
export async function createClient() { return currentUserClient() }
export { createClient as createServerClient }
