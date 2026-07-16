import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Rule {
  id: string;
  pattern: string;
  flags: string;
  message: string;
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

/**
 * Warn-level injection scan. A screening aid for the maintainer's editorial
 * review, never a hard block and never a security boundary.
 */
export function lintText(text: string): LintWarning[] {
  const warnings: LintWarning[] = [];
  for (const rule of spec.rules) {
    const re = new RegExp(rule.pattern, rule.flags);
    for (const match of text.matchAll(re)) {
      warnings.push({ rule: rule.id, message: rule.message, match: match[0] });
    }
  }
  return warnings;
}
