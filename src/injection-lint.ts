import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

interface Rule {
  id: string;
  pattern: string;
  flags: string;
  message: string;
  /** Which content the rule screens: absent = all, "toolless" = content
   * declaring no tools, "tool-declaring" = content that declares tools. */
  appliesTo?: "toolless" | "tool-declaring";
}

interface RulesSpec {
  version: number;
  rules: Rule[];
}

const spec = JSON.parse(
  readFileSync(join(import.meta.dirname, "injection-rules.json"), "utf8"),
) as RulesSpec;

export const rulesVersion = spec.version;

export interface LintWarning {
  rule: string;
  message: string;
  match: string;
}

export interface LintContext {
  /** Whether the content's frontmatter declares tools — the standalone-run
   * surface gets its own rule set, and pure-knowledge rules stand down. */
  declaresTools?: boolean;
}

/** Whether a markdown unit's frontmatter declares any tools — decides which
 * injection-lint rule set screens it. Non-frontmatter content declares none. */
export function declaresTools(content: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return false;
  try {
    const fm = parseYaml(match[1]) as Record<string, unknown> | null;
    return Array.isArray(fm?.tools) && fm.tools.length > 0;
  } catch {
    return false;
  }
}

/**
 * Warn-level injection scan. A screening aid for the maintainer's editorial
 * review, never a hard block and never a security boundary.
 */
export function lintText(text: string, context: LintContext = {}): LintWarning[] {
  const declaresTools = context.declaresTools ?? false;
  const warnings: LintWarning[] = [];
  for (const rule of spec.rules) {
    if (rule.appliesTo === "toolless" && declaresTools) continue;
    if (rule.appliesTo === "tool-declaring" && !declaresTools) continue;
    const re = new RegExp(rule.pattern, rule.flags);
    for (const match of text.matchAll(re)) {
      warnings.push({ rule: rule.id, message: rule.message, match: match[0] });
    }
  }
  return warnings;
}
