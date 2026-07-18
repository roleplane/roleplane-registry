import { readFileSync } from "node:fs";
import { join } from "node:path";

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
