import { handleLogin } from "../../src/publish.ts";
import { publishEnv, type PagesContext } from "../lib.ts";

export function onRequestGet(ctx: PagesContext): Response {
  return handleLogin(ctx.request, publishEnv(ctx));
}
