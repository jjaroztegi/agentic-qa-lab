// Business case catalog: YAML cases (plus drafts waiting in a PR) and which ones already have a test.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

export interface CatalogCase {
  id: string;
  title: string;
  process?: string;
  subprocess?: string;
  systems: string[]; // as written in the case
  chips: string[]; // normalised: ERP, MES, L2
  priority?: string;
  owner?: string;
  frequency?: string;
  steps: string[];
  expected_results: string[];
  draft: boolean;
  tests: string[];
}

export function systemChip(s: string): string {
  if (/^l2|desktop|level 2/i.test(s)) return "L2";
  if (/erp|sap|odoo/i.test(s)) return "ERP";
  if (/mes/i.test(s)) return "MES";
  return s.split(/\s|\(/)[0];
}

function readCases(dir: string | undefined, draft: boolean): CatalogCase[] {
  if (!dir || !existsSync(dir)) return [];
  const out: CatalogCase[] = [];
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    try {
      const y = parse(readFileSync(join(dir, f), "utf8")) ?? {};
      const systems: string[] = Array.isArray(y.systems) ? y.systems.map(String) : [];
      out.push({
        id: String(y.id ?? f.replace(/\.ya?ml$/, "")),
        title: String(y.title ?? ""),
        process: y.process, subprocess: y.subprocess, priority: y.priority != null ? String(y.priority) : undefined,
        owner: y.owner, frequency: y.frequency,
        systems, chips: [...new Set(systems.map(systemChip))],
        steps: Array.isArray(y.steps) ? y.steps.map(String) : [],
        expected_results: Array.isArray(y.expected_results) ? y.expected_results.map(String) : [],
        draft, tests: [],
      });
    } catch (e) {
      console.warn(`catalog: cannot read ${f}: ${(e as Error).message}`);
    }
  }
  return out;
}

function walk(dir: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc, depth + 1);
    else if (/\.(ts|mts|js|mjs|cjs)$/.test(name) && st.size < 2_000_000) acc.push(p);
  }
  return acc;
}

export function loadCatalog(opts: { catalogDir?: string; draftsDir?: string; testsDir?: string }): CatalogCase[] {
  const cases = readCases(opts.catalogDir, false);
  const ids = new Set(cases.map((c) => c.id));
  for (const d of readCases(opts.draftsDir, true)) if (!ids.has(d.id)) cases.push(d);
  if (opts.testsDir) {
    const files = walk(opts.testsDir).map((p) => ({ p, rel: relative(opts.testsDir!, p), text: readFileSync(p, "utf8") }));
    for (const c of cases) {
      const lower = c.id.toLowerCase();
      c.tests = files.filter((f) => f.text.includes(c.id) || f.rel.toLowerCase().includes(lower)).map((f) => f.rel).filter((r) => !/(^|\/)support\//.test(r));
    }
  }
  return cases;
}
