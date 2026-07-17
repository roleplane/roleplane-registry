import { handlePublish } from "../src/publish.ts";
import { publishEnv, type PagesContext } from "./lib.ts";

export function onRequestPost(ctx: PagesContext): Promise<Response> {
  return handlePublish(ctx.request, publishEnv(ctx));
}
