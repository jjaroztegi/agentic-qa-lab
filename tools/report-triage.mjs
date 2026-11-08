#!/usr/bin/env node
// Turns evidence/triage.json into: a PR comment, a GitHub issue per regression, and an event
// for n8n (business notification). Usage: node tools/report-triage.mjs <pr-number>
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pr = process.argv[2];
const t = JSON.parse(readFileSync("evidence/triage.json", "utf8"));
const run = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8" }).trim();

const label = {
  test_drift: "Test drift (repaired)",
  app_regression: "Application regression",
  environment: "Environment",
  flaky: "Flaky",
};
const verdict = {
  pass_after_heal: "Passed: the change meets the business cases; the agent repaired the locators and the rerun passes.",
  blocked_regression: "Blocked: the change breaks a business case.",
  blocked_environment: "Blocked by the test environment, not by the change.",
  flaky: "Intermittent failure: review the test's waits.",
}[t.verdict] ?? t.verdict;

const issues = [];
for (const f of t.failures.filter((f) => f.category === "app_regression")) {
  const body = [
    `**Case:** \`catalog/cases/${f.case}.yaml\`  ·  **PR:** #${pr}  ·  **Run:** ${run}`,
    "", "### Business impact", f.business_explanation,
    "", "### Evidence", ...f.evidence.map((e) => `- \`${e}\``),
    "", `Evidence pack (video, trace, screenshots, data): run artifact \`evidence-${process.env.RUN_ID}\`.`,
    "", "_Detected and classified by qa-triage. The test was not modified._",
  ].join("\n");
  const url = gh("issue", "create", "--title", `[${f.case}] Regression: ${f.test}`, "--body", body, "--label", "regression");
  issues.push(url);
  f.issue = url;
}

const comment = [
  "## Agent triage", "", verdict, "",
  "| Case | Classification | Confidence | Explanation | Action |", "|---|---|---|---|---|",
  ...t.failures.map((f) => `| ${f.case} | ${label[f.category] ?? f.category} | ${Math.round(f.confidence * 100)} % | ${f.business_explanation} | ${f.issue ?? f.action} |`),
  "", process.env.REPLAY_URL ? `[Replay: the run's screen and the agent's steps](${process.env.REPLAY_URL})  ·  ` : "", `Evidence: ${run}`,
].join("\n");
writeFileSync("evidence/triage-comment.md", comment);
if (pr) gh("pr", "comment", pr, "--body-file", "evidence/triage-comment.md");

// n8n: business notification + audit trail. Best effort; CI does not depend on it.
const hook = process.env.N8N_QA_WEBHOOK ?? "http://127.0.0.1:15678/webhook/qa-results";
await fetch(hook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: "ci", pr, run, ...t }),
  signal: AbortSignal.timeout(5000),
}).catch((e) => console.warn("n8n not reachable:", e.message));
console.log(comment);
