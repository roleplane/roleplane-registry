import { handleCallback } from "../../src/publish.ts";
import { publishEnv, type PagesContext } from "../lib.ts";

export function onRequestGet(ctx: PagesContext): Promise<Response> {
  return handleCallback(ctx.request, publishEnv(ctx));
}
