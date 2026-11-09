import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Narrator, describePath, explainError, locatorLabel, narrateBash, systemOf, testOutcome, type Item } from "../src/shared/narrate.ts";
import { shellWords, splitShell } from "../src/shared/shell.ts";

const fixture = (name: string) => {
  const lines = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const n = new Narrator();
  let ts = 0;
  for (const l of lines) n.push(l, (ts = Date.parse(l.timestamp ?? "") || ts || Date.parse("2026-11-07T23:19:00Z")));
  return n;
};
// Quoted UI labels, paths and subagent summaries below come from the recorded fixtures
// (CP-005 maintenance request in the ERP; CP-005 automatic hold on the Level 2 client);
// update them when the fixtures are re-recorded.
const web = fixture("qa-author-maintenance.jsonl");
const desk = fixture("qa-author-desktop-auto-hold.jsonl");
const find = (n: Narrator, s: string | RegExp) => n.items.find((i) => (typeof s === "string" ? i.text === s : s.test(i.text)));
const phasesOf = (n: Narrator) => n.items.map((i) => i.phase).filter((p, i, a) => p !== a[i - 1]);

// Hand-made tool calls for behaviours the recordings do not exercise.
type Call = [name: string, input: unknown, result?: string, isError?: boolean];
function synth(...calls: Call[]) {
  const n = new Narrator();
  calls.forEach(([name, input, result, isError], k) => {
    const id = `toolu_${k}`;
    n.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }, k * 1000);
    if (result !== undefined) n.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: !!isError }] } }, k * 1000 + 500);
  });
  return n;
}

// Every human line must read as plain English: no JSON, tool ids, shell plumbing or raw URLs.
const LEAKS = [/[{}]/, /":/, /mcp__/, /toolu_/, /\$\(/, /\$\{?[A-Z]/, /2>\//, /&&/, / \| /, /https?:\/\//, /\bundefined\b/, /\bnull\b/, /“”/, /\/work\/agentic-qa-lab/, /\/tmp\/qa-agent-/, /@s\w+:e\d+/];
function assertReadable(items: Item[]) {
  for (const it of items) {
    if (it.kind === "report") continue; // the agent's own words
    assert.match(it.text, /^[A-Z]/, `starts like a sentence: ${it.text}`);
    for (const re of LEAKS) assert.doesNotMatch(it.text, re, `no leak ${re} in: ${it.text}`);
    if (it.detail) for (const re of LEAKS.slice(1)) assert.doesNotMatch(it.detail, re, `no leak ${re} in detail: ${it.detail}`);
  }
}

test("web fixture: every line reads naturally", () => assertReadable(web.items));
test("desktop fixture: every line reads naturally", () => assertReadable(desk.items));

test("web fixture: Playwright calls become plain actions with the real UI labels", () => {
  assert.ok(find(web, "Opens the browser at the test's starting point"));
  assert.ok(find(web, "Clicks “Log out”"));
  assert.ok(find(web, "Types “shift-qa” in “Password” and submits"));
  assert.ok(find(web, "Clicks “Maintenance Requests”"));
  assert.ok(find(web, "Clicks “New”"));
  assert.ok(find(web, "Types “Abnormal vibration on stand F3 · TEST1” in “Request”"));
  assert.ok(find(web, "Types “Stand F3” in “Equipment”"));
  assert.ok(find(web, "Clicks “Corrective”"));
  assert.ok(find(web, "Clicks “High”"));
  assert.ok(find(web, "Reads the screen")?.tone === "quiet");
  assert.ok(find(web, "Writes tests/e2e/cp-005-breakdown-request.spec.ts (+56 lines)"));
  assert.ok(find(web, "Rewrites tests/e2e/cp-005-breakdown-request.spec.ts (+87 lines)"));
});

test("web fixture: tools/api calls to the ERP name the models they query", () => {
  assert.ok(find(web, "Reads tools/api, queries the ERP: maintenance.equipment, maintenance.team and 2 more, and lists tests/ and .claude/agents"));
  assert.ok(find(web, "Queries the ERP: maintenance.equipment, res.users and maintenance.request"));
  assert.ok(find(web, /queries the ERP: maintenance\.request and maintenance\.team, and reads the fields of maintenance\.request in the ERP$/));
});

test("web fixture: subagent work is attributed and its result summarised", () => {
  const agent = find(web, /^Delegates to the generator subagent/)!;
  assert.equal(agent.kind, "subagent");
  assert.equal(agent.detail, "I wrote the test to tests/e2e/cp-005-breakdown-request.spec.ts.");
  assert.ok(web.items.filter((i) => i.sub === "Generator subagent").length > 20);
});

test("web fixture: errors carry a warning and a plain explanation", () => {
  const missed = web.items.find((i) => i.text === "Clicks “Home Menu”" && i.tone === "warn")!;
  assert.equal(missed.detail, "Cannot find “Home Menu” on screen");
  const denied = find(web, "Runs the CP-005 test ×3")!;
  assert.equal(denied.status, "warn");
  assert.equal(denied.detail, "No permission: the command did not run");
});

test("web fixture: test runs report green with counts; phases go Explore → Write → Test → Report", () => {
  const runs = web.items.filter((i) => i.text === "Runs the CP-005 test");
  assert.deepEqual(runs.map((r) => [r.tone, r.detail]), [["ok", "passed (1/1)"], ["ok", "passed (1/1)"], ["ok", "passed (1/1)"]]);
  assert.deepEqual(phasesOf(web), ["explore", "write", "test", "report"]);
  assert.equal(web.items.filter((i) => i.kind === "report").length, 1);
  assert.match(web.items.find((i) => i.kind === "report")!.text, /^\*\*What was done\*\*: The test for CP-005 is in/);
  assert.equal(web.items.at(-1)!.text, "Finishes in 3 min 10 s: 12 turns, US$0.70");
  assert.equal(web.totals.turns, 12);
  assert.ok(Math.abs(web.totals.costUsd! - 0.7035) < 0.001);
});

test("web fixture: the narrator tracks what is on screen", () => {
  const requests = find(web, "Clicks “Maintenance Requests”")!;
  assert.equal(requests.page?.system, "ERP");
  assert.equal(requests.page?.title, "Maintenance Requests");
  assert.equal(find(web, "Clicks “High”")!.page?.title, "Abnormal vibration on stand F3 · TEST1");
});

test("desktop fixture: tools/l2 calls read as Level 2 client actions, with element refs resolved to names", () => {
  assert.ok(find(desk, "Starts the Level 2 client and checks the open windows"));
  assert.ok(find(desk, "Closes the Level 2 client, checks the open windows, starts the Level 2 client and reads the Level 2 screen"));
  assert.ok(find(desk, "Closes the Level 2 windows and checks the open windows"));
  const wait = find(desk, "Starts the Level 2 client, waits for the window “Level 2 · Hot strip mill” and looks for “Measurements”")!;
  assert.deepEqual([wait.page?.system, wait.page?.title], ["L2", "Level 2 · Hot strip mill"]);
  // `tools/l2 click @s…:e1`: the name comes from the earlier find result.
  assert.ok(find(desk, "Clicks “Measurements” in the Level 2 client and queries the MES: coils"));
  assert.ok(find(desk, "Looks for “Coil to measure” in the Level 2 client"));
  assert.ok(find(desk, "Types “QA-EXPL1-C1” in “Coil to measure” and looks for “Load coil” in the Level 2 client"));
  assert.ok(find(desk, "Clicks “Load coil”, reads the Level 2 screen and checks the open windows"));
  assert.ok(find(desk, /^Types “3\.25” in “Measured thickness \(mm\)”, types “1252” in “Measured width \(mm\)”, types “8” in “Measured flatness \(I\)”, clicks “Register measurement” and checks the open windows in the Level 2 client$/));
  assert.ok(find(desk, "Presses Enter, checks the open windows and reads the Level 2 screen, and queries the MES: coil 1 and order 4"));
});

test("desktop fixture: MES calls through tools/api and curl read as business requests", () => {
  assert.ok(find(desk, "Queries the MES: grade S275JR and orders"));
  assert.ok(find(desk, "Creates a test order in the MES"));
  const coil = find(desk, "Registers a test coil in the MES")!; // curl "${MES_URL:-http://…}/orders/4/coils"
  assert.equal(coil.detail, "No permission: the command did not run");
  assert.ok(find(desk, "Checks the environment variables"));
  // node --test on a scratch helper or a repo tool is not a run of the case's test.
  assert.ok(find(desk, "Runs guard-heal.test.mjs"));
  assert.ok(find(desk, "Runs mkcoil.test.mjs and queries the MES: coils"));
});

test("desktop fixture: write, fix and prove the test; totals from the result line", () => {
  const file = "tests/desktop/cp-005-thickness-out-of-tolerance-auto-hold.test.mjs";
  assert.ok(find(desk, `Writes ${file} (+105 lines)`));
  assert.ok(find(desk, `Fixes ${file} (+9 −1)`));
  assert.ok(find(desk, `Fixes ${file} (+1 −3)`));
  const green = desk.items.filter((i) => i.text === "Runs the CP-005 test" && i.tone === "ok");
  assert.equal(green.length, 4);
  assert.ok(green.every((g) => g.detail === "passed (4/4)"));
  // `F=tests/desktop/…; node --test $F` three times: the variable names the case.
  assert.equal(desk.items.filter((i) => i.text === "Runs the CP-005 test ×3" && i.status === "warn").length, 2);
  assert.ok(find(desk, "Looks at the screenshot 03-out-of-tolerance-warning.png"));
  assert.match(desk.items.find((i) => i.kind === "report")!.text, /^I wrote the CP-005 desktop test and it passed 3 runs in a row/);
  assert.equal(desk.items.at(-1)!.text, "Finishes in 4 min 49 s: 47 turns, US$1.62");
  assert.equal(desk.totals.turns, 47);
  assert.equal(desk.totals.durationMs, 288855);
  assert.deepEqual(phasesOf(desk), ["explore", "write", "test", "report"]);
});

test("synthetic calls: navigation, lists, waits, red test runs, missing programs, description fallback", () => {
  const n = synth(
    ["mcp__playwright-test__browser_navigate", { url: "http://127.0.0.1:18069/odoo" }],
    ["mcp__playwright-test__browser_select_option", { element: "Priority", ref: "e5", values: ["High"] }],
    ["mcp__playwright-test__browser_wait_for", { text: "Saved" }],
    ["Bash", { command: "npx playwright test tests/e2e/cp-005-breakdown-request.spec.ts" }, "  1 failed\n  1 passed (9.1s)"],
    ["Bash", { command: "tools/l2 keys key Down" }, "Exit code 127\nbash: xdotool: command not found", true],
    ["Bash", { command: "uptime", description: "Check how long the desktop has been up" }, " 21:00 up 2 days"],
  );
  assert.deepEqual(n.items.map((i) => i.text), [
    "Opens the ERP · /odoo",
    "Selects “High” in “Priority”",
    "Waits for “Saved” to appear",
    "Runs the CP-005 test",
    "Presses Down arrow in the Level 2 client",
    "Checks how long the desktop has been up",
  ]);
  assert.deepEqual([n.items[3].tone, n.items[3].detail], ["fail", "1 of 2 failed"]);
  assert.equal(n.items[4].detail, "A program is missing from the environment (exit code 127)");
  assert.equal(n.items[4].page?.system, "L2");
});

test("narrateBash: common shapes", () => {
  assert.equal(narrateBash("curl -s http://127.0.0.1:13000/api/coils?quality=HOLD | jq length").text, "Queries the MES: held coils");
  assert.equal(narrateBash("curl -s $MES_URL/api/coils").text, "Queries the MES: coils");
  assert.equal(narrateBash("npx playwright test --grep CP-003 --repeat-each=3").text, "Runs the CP-003 test ×3");
  assert.equal(narrateBash("for i in 1 2 3; do npx playwright test tests/e2e/cp-001-x.spec.ts; done").text, "Runs the CP-001 test ×3");
  assert.equal(narrateBash("git diff --stat && git status").text, "Reviews the changes in git");
  assert.equal(narrateBash("node tools/guard-heal.mjs").text, "Runs the heal guard (guard-heal)");
  assert.equal(narrateBash("cat catalog/cases/CP-003.yaml apps/mes/src/domain.ts").text, "Reads case CP-003 and the MES source (domain.ts)");
  assert.equal(narrateBash("cat > /tmp/x.sh <<'EOF'\ncurl -s http://127.0.0.1:13000/api/orders\nEOF\nbash /tmp/x.sh").text, "Writes x.sh and runs the script x.sh");
  assert.equal(narrateBash("echo hi").text, "Runs a command");
  assert.equal(narrateBash(`curl -s -X POST "\${MES_URL:-http://127.0.0.1:13000}/api/orders" -d '{}'`).text, "Creates a test order in the MES");
  assert.equal(narrateBash("node --test tests/desktop/cp-002-x.test.mjs").text, "Runs the CP-002 test");
  assert.equal(narrateBash("node --test /tmp/scratch/setup.test.mjs").text, "Runs setup.test.mjs");
});

test("narrateBash: the Level 2 client, directly, inside docker exec or through tools/l2", () => {
  assert.equal(narrateBash("tools/l2 launch").text, "Starts the Level 2 client");
  assert.equal(narrateBash("tools/l2 snapshot --app java -i").text, "Reads the Level 2 screen");
  assert.equal(narrateBash(`tools/l2 click "$(tools/l2 find --app java --role button --name 'Load coil' | jq -r .ref)"`).text, "Clicks “Load coil” in the Level 2 client");
  assert.equal(narrateBash("tools/l2 click @s1:e4", "", { "@s1:e4": "Hold" }).text, "Clicks “Hold” in the Level 2 client");
  assert.equal(narrateBash("tools/l2 type @s1:e7 3.25", "", { "@s1:e7": "Measured thickness (mm)" }).text, "Types “3.25” in “Measured thickness (mm)” in the Level 2 client");
  assert.equal(narrateBash("tools/l2 keys type 'Flatness defect'").text, "Types “Flatness defect” in the Level 2 client");
  assert.equal(narrateBash(`docker exec qa-desktop bash -lc 'agent-desktop click --name "Hold" && xdotool key Return'`).text, "Clicks “Hold” and presses Enter in the Level 2 client");
  const d = narrateBash(`tools/l2 wait --window "Level 2 · Hot strip mill" --app java`);
  assert.deepEqual([d.text, d.desktop, d.window], ["Waits for the window “Level 2 · Hot strip mill”", true, "Level 2 · Hot strip mill"]);
});

test("narrateBash: tools/api reads as calls to the MES and the ERP", () => {
  assert.equal(narrateBash("tools/api mes GET /api/coils?quality=HOLD").text, "Queries the MES: held coils");
  assert.equal(narrateBash("tools/api mes GET /api/coils/7 && tools/api mes GET /api/orders/3").text, "Queries the MES: coil 7 and order 3");
  assert.equal(narrateBash(`tools/api mes POST /api/orders '{"erp_ref":"X"}'`).text, "Creates a test order in the MES");
  assert.equal(narrateBash(`tools/api erp maintenance.request search_read '[[]]' '{"fields":["name"]}'`).text, "Queries the ERP: maintenance.request");
  assert.equal(narrateBash(`tools/api erp maintenance.request create '[{"name":"x"}]'`).text, "Creates a maintenance.request record in the ERP");
  assert.equal(narrateBash("tools/api").text, "Reads how to use the API tool");
});

test("locatorLabel / systemOf / describePath / explainError / testOutcome", () => {
  assert.equal(locatorLabel("await page.getByRole('button', { name: 'New' }).click();"), "“New”");
  assert.equal(locatorLabel("await page.getByTitle('Home menu').click();"), "“Home menu”");
  assert.equal(locatorLabel(`await page.locator('role=row[name=/S00002/]').locator('role=link').click();`), "the row “S00002”");
  assert.equal(locatorLabel("await page.getByRole('cell', { name: '1,000' }).getByRole('textbox').fill('48.5');"), "the cell “1,000”");
  assert.equal(locatorLabel("f1e5"), undefined);
  assert.equal(systemOf("http://127.0.0.1:18069/odoo/sales"), "ERP");
  assert.equal(systemOf("http://127.0.0.1:18070/odoo"), "New ERP");
  assert.equal(systemOf("http://127.0.0.1:41234/", { "127.0.0.1:41234": "MES" }), "MES");
  assert.equal(describePath("/w/p/catalog/cases/CP-002.yaml", "/w/p"), "case CP-002");
  assert.equal(explainError("### Error\nError: TimeoutError: waiting"), "Timed out waiting");
  assert.deepEqual(testOutcome("  2 passed (12.3s)\n  1 failed"), { passed: 2, failed: 1 });
  assert.deepEqual(testOutcome("ℹ pass 6\nℹ fail 0"), { passed: 6, failed: 0 });
});

test("shell lexer: segments, pipes, heredocs, substitutions", () => {
  assert.deepEqual(splitShell("a; b && c | d").map((s) => [s.text, s.piped]), [["a", false], ["b", false], ["c", false], ["d", true]]);
  assert.deepEqual(splitShell("cat > f <<'EOF'\nx; y\nEOF\nnext").map((s) => s.text), ["cat > f <<'EOF'", "next"]);
  assert.deepEqual(splitShell("f(){ a | b; }; f x").map((s) => s.text), ["f(){ a | b; }", "f x"]);
  assert.deepEqual(shellWords(`agent-desktop type $(f textfield "Coil filter") 'A B'`), ["agent-desktop", "type", `$(f textfield "Coil filter")`, "A B"]);
});
