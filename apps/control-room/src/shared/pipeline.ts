// The stage line shown on top of a run: one per kind of journey.
import type { Stage, Status } from "./contract.ts";
import type { Run, StageState } from "./summary.ts";

export interface Node { key: Stage; label: string; state?: StageState }

const AUTHOR: [Stage, string][] = [
  ["intake", "Intake"], ["draft", "Case drafted"], ["pr", "Proposal (PR)"], ["env", "Isolated environment"],
  ["agent", "Agent"], ["prove", "Proof ×3"], ["review", "Review"], ["merge", "Merged"],
];
const CI: [Stage, string][] = [["env", "Isolated environment"], ["prove", "Business cases"], ["triage", "Agent triage"], ["guard", "Guard"]];
const REGRESSION: [Stage, string][] = [["env", "Environment"], ["prove", "Regression"], ["compare", "Data comparison"]];
export const STAGE_LABEL: Record<Stage, string> = {
  intake: "Intake", draft: "Case drafted", pr: "Proposal (PR)", env: "Isolated environment", agent: "Agent", prove: "Proof",
  push: "Pushed to PR", review: "Review", merge: "Merged", triage: "Triage", guard: "Guard", report: "Report", compare: "Data comparison",
};
export const WORKFLOW_LABEL: Record<string, string> = { author: "Authoring", intake: "Case intake", ci: "Continuous integration", regression: "Regression" };

/** Merges the stage states of every run in a journey: the latest event per stage wins. */
export function mergedStages(runs: Run[]): Partial<Record<Stage, StageState>> {
  const out: Partial<Record<Stage, StageState>> = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.summary.stages) as [Stage, StageState][]) {
    if (v && (!out[k] || v.ts >= out[k]!.ts)) out[k] = v;
  }
  return out;
}

export function pipelineFor(runs: Run[]): Node[] {
  const wf = runs.map((r) => r.info.workflow).find((w) => w === "ci" || w === "regression");
  const def = wf === "ci" ? CI : wf === "regression" ? REGRESSION : AUTHOR;
  const st = mergedStages(runs);
  const nodes: Node[] = def.map(([key, label]) => ({ key, label, state: st[key] }));
  // The test pushed to the PR opens the review.
  const review = nodes.find((n) => n.key === "review");
  if (review && !review.state && st.push) review.state = { ...st.push, status: st.push.status === "ok" ? "start" : st.push.status };
  for (const [k, v] of Object.entries(st) as [Stage, StageState][]) {
    if (!nodes.some((n) => n.key === k) && !(k === "push" && review)) nodes.push({ key: k, label: STAGE_LABEL[k], state: v });
  }
  return nodes;
}

export const statusWord: Record<Status, string> = { start: "running", ok: "done", fail: "failed", warn: "warning", info: "info" };
