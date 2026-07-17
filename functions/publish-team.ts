import { handlePublishTeam } from "../src/publish.ts";
import { publishEnv, type PagesContext } from "./lib.ts";

export function onRequestPost(ctx: PagesContext): Promise<Response> {
  return handlePublishTeam(ctx.request, publishEnv(ctx));
}
