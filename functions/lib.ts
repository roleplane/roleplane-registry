import type { PublishEnv } from "../src/publish.ts";

/** The shape Cloudflare Pages hands every Function invocation. */
export interface PagesContext {
  request: Request;
  env: {
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    REGISTRY_REPO?: string;
  };
}

/** Wire the stateless handler env from Pages project settings + global fetch. */
export function publishEnv(ctx: PagesContext): PublishEnv {
  return {
    clientId: ctx.env.GITHUB_CLIENT_ID,
    clientSecret: ctx.env.GITHUB_CLIENT_SECRET,
    registryRepo: ctx.env.REGISTRY_REPO ?? "roleplane/roleplane-registry",
    fetch: fetch.bind(globalThis),
  };
}
