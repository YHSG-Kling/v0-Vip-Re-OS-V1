/**
 * Minimal type declarations for facebook-nodejs-business-sdk (wave 71A).
 * The package ships NO TypeScript types of its own (no "types" field in its
 * package.json, no .d.ts anywhere in the published tree, no @types package on
 * the registry — verified 2026-09-17). Only the ONE surface
 * lib/providers/meta/client.ts actually calls is declared: the generic
 * FacebookAdsApi transport every typed SDK class (Page, Campaign, AdAccount, …)
 * is itself built on. See that file's header for why the generic transport is
 * used instead of the entity-typed classes.
 */
declare module "facebook-nodejs-business-sdk" {
  export class FacebookAdsApi {
    static GRAPH: string
    static VERSION: string
    static init(accessToken: string, locale?: string, crashLog?: boolean): FacebookAdsApi
    constructor(accessToken: string, locale?: string, crashLog?: boolean)
    accessToken: string
    call(
      method: "GET" | "POST" | "DELETE" | "PUT",
      path: Array<string | number> | string,
      params?: Record<string, unknown>,
      files?: Record<string, unknown>,
      useMultipartFormData?: boolean,
      urlOverride?: string,
    ): Promise<any>
  }

  const bizSdk: { FacebookAdsApi: typeof FacebookAdsApi }
  export default bizSdk
}
