#!/usr/bin/env python3
"""Generates the n8n workflows of the QA control tower (n8n/workflows/*.json). No secrets here:
nodes reference credentials by id; n8n/setup.sh creates those from environment variables.

  A. qa-results             CI / regression results -> LLM summary for business -> email
  B. qa-launch-regression   release event (webhook) or migration lead (form) -> regression run
  C. qa-case-intake         key user describes a case in plain words -> template YAML -> PR -> agent writes the test
  D. qa-mcp                 MCP server: any agent (Claude, Copilot...) can launch regressions and read results
"""
import json
import os
import pathlib
import re
import subprocess
import uuid

# Who gets the business notifications (Resend; the sender's domain must be verified there).
NOTIFY_FROM = os.environ.get("N8N_NOTIFY_FROM", "QA Lab <qa@example.com>")
NOTIFY_TO = [a.strip() for a in os.environ.get("N8N_NOTIFY_TO", "qa-team@example.com").split(",")]
# The GitHub repo the flows open PRs in: QA_REPO=owner/name, else this checkout's origin.
REPO = os.environ.get("QA_REPO") or re.sub(r"^.*github\.com[:/]|\.git$", "", subprocess.run(
    ["git", "remote", "get-url", "origin"], capture_output=True, text=True, cwd=pathlib.Path(__file__).parent).stdout.strip())
GH = f"https://api.github.com/repos/{REPO}"
CRED = {
    "anthropic": {"anthropicApi": {"id": "qaAnthropic00001", "name": "Anthropic"}},
    "github": {"githubApi": {"id": "qaGithub00000001", "name": "GitHub"}},
    "resend": {"httpHeaderAuth": {"id": "qaResend00000001", "name": "Resend"}},
    "mcp": {"httpBearerAuth": {"id": "qaMcpBearer00001", "name": "MCP token"}},
}
# n8n/setup.sh builds into a temp dir with the deployment's repo and addresses; the committed
# workflows/ stay neutral (python3 n8n/build.py with QA_REPO unset outside a git checkout).
OUT = pathlib.Path(os.environ.get("N8N_WORKFLOWS_OUT") or pathlib.Path(__file__).parent / "workflows")


def node(name, type_, version, params, pos, creds=None, **extra):
    n = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, name + type_)), "name": name, "type": type_,
         "typeVersion": version, "position": pos, "parameters": params}
    if creds:
        n["credentials"] = CRED[creds]
    n.update(extra)
    return n


def gh(name, method, url, pos, body=None, accept="application/vnd.github+json"):
    p = {"method": method, "url": url, "authentication": "predefinedCredentialType", "nodeCredentialType": "githubApi",
         "sendHeaders": True, "headerParameters": {"parameters": [{"name": "Accept", "value": accept}]}, "options": {}}
    if body:
        p.update(sendBody=True, specifyBody="json", jsonBody=body)
    return node(name, "n8n-nodes-base.httpRequest", 4.2, p, pos, "github")


def claude(name, model, pos):
    return node(name, "@n8n/n8n-nodes-langchain.lmChatAnthropic", 1.6,
                {"model": {"__rl": True, "mode": "id", "value": model}, "options": {"maxTokensToSample": 2000, "temperature": 0.2}},
                pos, "anthropic")


def chain(name, prompt, pos):
    return node(name, "@n8n/n8n-nodes-langchain.chainLlm", 1.9, {"promptType": "define", "text": prompt}, pos)


def control_room(name, body, pos):
    """Fire-and-forget event to the control room (apps/control-room); never stops the flow."""
    return node(name, "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST", "url": os.environ.get("N8N_QA_EVENTS_URL", "http://control:17000") + "/api/events",
        "sendBody": True, "specifyBody": "json", "jsonBody": body, "options": {"timeout": 3000}},
        pos, onError="continueRegularOutput")


def wf(name, nodes, links, ai=()):
    conns = {}
    for a, b in links:
        conns.setdefault(a, {"main": [[]]})["main"][0].append({"node": b, "type": "main", "index": 0})
    for a, b, kind in ai:
        conns.setdefault(a, {}).setdefault(kind, [[]])[0].append({"node": b, "type": kind, "index": 0})
    wid = str(uuid.uuid5(uuid.NAMESPACE_URL, name)).replace("-", "")[:16]
    return {"id": wid, "name": name, "nodes": nodes, "connections": conns, "active": False,
            "settings": {"executionOrder": "v1", "timezone": "Europe/Berlin"}, "pinData": {}, "tags": []}


# ---------------- A. results -> business ----------------
CONTEXT_JS = r"""
const e = $json.body ?? $json;
const f = e.failures ?? [];
const out = [];
if (e.source === 'ci') {
  out.push(`Origin: code change to the in-house MES (PR #${e.pr}). Agent triage verdict: ${e.verdict}.`);
  for (const x of f) out.push(`- Case ${x.case} (${x.category}, confidence ${Math.round((x.confidence ?? 0) * 100)} %): ${x.business_explanation} Action: ${x.issue ?? x.action}.`);
} else {
  out.push(`Origin: regression of commercial systems. System under test: ${e.target}. Mode: ${e.mode}. Reason: ${e.reason}.`);
  out.push(`End-to-end business cases result: ${e.e2e}. Statistics: ${JSON.stringify(e.stats ?? {})}.`);
  if (e.diff) out.push(`Before/after data comparison:\n${e.diff}`);
}
const bad = String(e.verdict ?? '').startsWith('blocked') || e.e2e === 'failure' || e.compare === 'failure';
return [{ json: { context: out.join('\n'), run: e.run, bad, origin: e.source, pr: e.pr ?? null } }];
"""
PROMPT_A = """={{ `You are the quality lead of a steel plant. Write a short notice in English for the business key users (not technical) about this automated test result.
Rules: at most 120 words; calm and factual, no exclamation marks, no emojis. Start with one verdict line that says whether the change can go ahead ("Passed" or "Blocked"); then which business process is affected and what the impact would be on the plant or in the ERP; end with who has to act. No technical jargon (no locators, CI, JSON). Do not invent anything that is not below. Quantities in metric tonnes with a decimal point (47.75 t).

Result:
${$json.context}` }}"""
EMAIL_JS = r"""
const c = $('Context').first().json;
const text = $json.text.trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const html = `<div style="font-family:system-ui,sans-serif;max-width:620px;color:#222">
<p style="font-size:12px;color:#666;margin:0 0 12px">QA lab · automated notice</p>
${text.split('\n').filter(Boolean).map((l) => `<p style="margin:0 0 10px;line-height:1.5">${esc(l)}</p>`).join('')}
<p style="margin-top:18px"><a href="${c.run}" style="color:#1d5fa8">View the run's evidence</a></p></div>`;
const subject = `QA · ${c.bad ? 'Blocked' : 'Passed'} · ${c.origin === 'ci' ? `MES change (PR #${c.pr})` : 'Commercial systems regression'}`;
return [{ json: { subject, html, text: text.replace(/\*\*/g, '') } }];
"""
a_nodes = [
    node("Test result", "n8n-nodes-base.webhook", 2.1, {"httpMethod": "POST", "path": "qa-results", "options": {}}, [0, 0],
         webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "qa-results"))),
    node("Context", "n8n-nodes-base.code", 2, {"jsCode": CONTEXT_JS}, [220, 0]),
    chain("Summary for business", PROMPT_A, [440, 0]),
    claude("Claude Haiku 5.5", "claude-haiku-5-5", [440, 220]),
    node("Compose notice", "n8n-nodes-base.code", 2, {"jsCode": EMAIL_JS}, [700, 0]),
    node("Send email (Teams in production)", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST", "url": "https://api.resend.com/emails", "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth", "sendBody": True, "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ from: " + json.dumps(NOTIFY_FROM) + ", to: " + json.dumps(NOTIFY_TO) + ", subject: $json.subject, html: $json.html, text: $json.text }) }}",
        "options": {}}, [920, 0], "resend"),
]
A = wf("QA · Results to business", a_nodes,
       [("Test result", "Context"), ("Context", "Summary for business"), ("Summary for business", "Compose notice"),
        ("Compose notice", "Send email (Teams in production)")],
       [("Claude Haiku 5.5", "Summary for business", "ai_languageModel")])

# ---------------- B. launch regression ----------------
NORMALIZE_JS = r"""
const b = $json.body ?? $json;
const target = /migrat|new/i.test(b.target ?? b['System under test'] ?? '') ? 'erp-new' : 'erp';
const mode = /migrat|compar/i.test(b.mode ?? b['Test type'] ?? '') ? 'migration' : 'regression';
const reason = b.reason ?? b['Reason'] ?? [b.system, b.version].filter(Boolean).join(' ') ?? 'n8n';
return [{ json: { target, mode, reason: String(reason).slice(0, 120) } }];
"""
b_nodes = [
    node("Release event", "n8n-nodes-base.webhook", 2.1, {"httpMethod": "POST", "path": "release-event", "options": {}}, [0, -120],
         webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "release-event"))),
    node("Rehearsal form", "n8n-nodes-base.formTrigger", 2.6, {
        "formTitle": "Launch regression",
        "formDescription": "For the migration or release lead: runs the regression of critical processes against the chosen system.",
        "formFields": {"values": [
            {"fieldLabel": "System under test", "fieldType": "dropdown", "requiredField": True,
             "fieldOptions": {"values": [{"option": "Current ERP"}, {"option": "Migrated ERP (lift & shift rehearsal)"}]}},
            {"fieldLabel": "Test type", "fieldType": "dropdown", "requiredField": True,
             "fieldOptions": {"values": [{"option": "Process regression"}, {"option": "Migration: regression + data comparison"}]}},
            {"fieldLabel": "Reason", "fieldType": "text", "requiredField": True, "placeholder": "Rehearsal 2 of wave 1"}]},
        "options": {"path": "launch-regression", "respondWithOptions": {"values": {"formSubmittedText": "Regression started. The result will be sent by email."}}}},
        [0, 80], webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "launch-regression"))),
    node("Normalize", "n8n-nodes-base.code", 2, {"jsCode": NORMALIZE_JS}, [240, 0]),
    gh("Launch regression (GitHub Actions)", "POST", f"{GH}/actions/workflows/regression.yml/dispatches", [480, 0],
       body='={{ JSON.stringify({ ref: "main", inputs: { target: $json.target, mode: $json.mode, reason: $json.reason } }) }}'),
]
B = wf("QA · Launch regression", b_nodes,
       [("Release event", "Normalize"), ("Rehearsal form", "Normalize"), ("Normalize", "Launch regression (GitHub Actions)")])

# ---------------- C. key user files a case ----------------
EXAMPLE = (pathlib.Path(__file__).parent.parent / "catalog/cases/CP-001.yaml").read_text()
NEXT_JS = r"""
// cases on main plus cases still open as PRs (branch case/cp-NNN), so two intakes never collide
const nums = [
  ...$('Catalog cases').all().map((i) => /^CP-(\d+)\.yaml$/.exec(i.json.name ?? '')?.[1]),
  ...$input.all().map((i) => /refs\/heads\/case\/cp-(\d+)$/.exec(i.json.ref ?? '')?.[1]),
].filter(Boolean).map(Number);
const n = Math.max(0, ...nums) + 1;
const f = $('Case intake').first().json;
return [{ json: { id: `CP-${String(n).padStart(3, '0')}`, form: f } }];
"""
PROMPT_C = """={{ `Turn a key user's description into a test case in the single catalog template (YAML). Return ONLY the YAML, with no explanation and no code fences.

Rules:
- id: ${$json.id}. Use exactly the keys of the example, in this order: id, title, process, subprocess, systems, priority, owner, frequency, preconditions, data, steps, expected_results, data_validation, dependencies. Write everything in English; keys inside data are snake_case English.
- Expected results must be measurable (a value, a status, an exact message) and checkable without a person interpreting them.
- If something is missing to make it measurable, do NOT invent it: write the field as "PENDING: <what is missing>" for the reviewer to complete.
- The available systems are ERP (Odoo, standing in for SAP), MES (in-house application) and L2 (Java desktop client).
- data_validation says how the result is checked in data (ERP mrp.production / sale.order, or the MES API /api/orders, /api/coils).

Example case from the catalog:
${$node["Example"].json.data ?? ''}

Key user's form:
Title: ${$json.form['Title']}
Process: ${$json.form['Process']}
Priority: ${$json.form['Priority']}
Owner: ${$json.form['Business owner']}
Frequency: ${$json.form['Frequency']}
Description: ${$json.form['Describe the case']}
How it is checked: ${$json.form['How do you know it worked?'] ?? ''}` }}"""
PREP_JS = r"""
const id = $('Next ID').first().json.id;
let yaml = $json.text.trim().replace(/^```(?:ya?ml)?\s*/i, '').replace(/```\s*$/, '').trim() + '\n';
if (!yaml.startsWith(`id: ${id}`) && !yaml.includes(`\nid: ${id}`)) throw new Error('The generated YAML does not have the expected id ' + id);
const title = (yaml.match(/^title:\s*(.+)$/m) ?? [, id])[1].replace(/^["']|["']$/g, '');
const pending = (yaml.match(/PENDING/g) ?? []).length;
return [{ json: { id, title, yaml, branch: `case/${id.toLowerCase()}`, content: Buffer.from(yaml).toString('base64'), pending } }];
"""
PR_BODY = """={{ JSON.stringify({ title: `New case ${$('Prepare').first().json.id}: ${$('Prepare').first().json.title}`, head: $('Prepare').first().json.branch, base: "main",
  body: `Case filed by **${$('Case intake').first().json['Business owner']}** through the n8n intake form and drafted in the catalog template by the intake workflow.\\n\\n` +
        ($('Prepare').first().json.pending ? `${$('Prepare').first().json.pending} PENDING field(s): the functional reviewer must complete them before approving.\\n\\n` : '') +
        `After functional review, add the \\`automate\\` label: the qa-author agent then explores the ERP and the MES, writes the test and pushes it to this PR.` }) }}"""
EV_DRAFT = """={{ JSON.stringify([
  { run: `intake_${$execution.id}`, source: "n8n", kind: "run", case: $('Prepare').first().json.id,
    data: { workflow: "intake", case: $('Prepare').first().json.id, title: $('Prepare').first().json.title, owner: $('Case intake').first().json['Business owner'] } },
  { run: `intake_${$execution.id}`, source: "n8n", kind: "stage", stage: "intake", status: "ok", case: $('Prepare').first().json.id,
    title: `Intake from ${$('Case intake').first().json['Business owner']}`, detail: $('Case intake').first().json['Describe the case'] },
  { run: `intake_${$execution.id}`, source: "n8n", kind: "stage", stage: "draft", status: $('Prepare').first().json.pending ? "warn" : "ok",
    case: $('Prepare').first().json.id, title: "Case drafted in the catalog template",
    detail: $('Prepare').first().json.pending ? `${$('Prepare').first().json.pending} PENDING field(s) for the reviewer` : "", data: { yaml: $('Prepare').first().json.yaml } } ]) }}"""
EV_PR = """={{ JSON.stringify({ run: `intake_${$execution.id}`, source: "n8n", kind: "stage", stage: "pr", status: "ok",
  case: $('Prepare').first().json.id, pr: $('Open PR').first().json.number, url: $('Open PR').first().json.html_url,
  title: `Proposal #${$('Open PR').first().json.number} opened` }) }}"""
c_nodes = [
    node("Case intake", "n8n-nodes-base.formTrigger", 2.6, {
        "formTitle": "New test case",
        "formDescription": "Describe it as you would to a new colleague: what is done, with which data, and what must happen. It is drafted in the catalog template and opened as a proposal (PR). After a functional review, an agent writes the automated test.",
        "responseMode": "lastNode",
        "formFields": {"values": [
            {"fieldLabel": "Title", "fieldType": "text", "requiredField": True},
            {"fieldLabel": "Process", "fieldType": "dropdown", "requiredField": True,
             "fieldOptions": {"values": [{"option": o} for o in ["Order-to-coil", "Quality", "Logistics", "Finance", "Other"]]}},
            {"fieldLabel": "Priority", "fieldType": "dropdown", "requiredField": True,
             "fieldOptions": {"values": [{"option": "A — critical"}, {"option": "B — important"}, {"option": "C — support"}]}},
            {"fieldLabel": "Business owner", "fieldType": "text", "requiredField": True},
            {"fieldLabel": "Frequency", "fieldType": "dropdown", "requiredField": True,
             "fieldOptions": {"values": [{"option": o} for o in ["daily", "weekly", "monthly", "per release"]]}},
            {"fieldLabel": "Describe the case", "fieldType": "textarea", "requiredField": True},
            {"fieldLabel": "How do you know it worked?", "fieldType": "textarea"}]},
        "options": {"path": "case-intake"}}, [0, 0], webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "case-intake"))),
    gh("Catalog cases", "GET", f"{GH}/contents/catalog/cases", [220, 0]),
    {**gh("Cases in review", "GET", f"{GH}/git/matching-refs/heads/case/", [330, 0]), "alwaysOutputData": True},
    node("Next ID", "n8n-nodes-base.code", 2, {"jsCode": NEXT_JS}, [440, 0]),
    gh("Example", "GET", f"{GH}/contents/catalog/cases/CP-001.yaml", [660, -160], accept="application/vnd.github.raw"),
    chain("Draft case in the template", PROMPT_C, [880, 0]),
    claude("Claude Sonnet 5.5", "claude-sonnet-5-5", [880, 220]),
    node("Prepare", "n8n-nodes-base.code", 2, {"jsCode": PREP_JS}, [1100, 0]),
    gh("SHA of main", "GET", f"{GH}/git/ref/heads/main", [1320, 0]),
    gh("Create branch", "POST", f"{GH}/git/refs", [1540, 0],
       body="={{ JSON.stringify({ ref: `refs/heads/${$('Prepare').first().json.branch}`, sha: $json.object.sha }) }}"),
    gh("Upload case", "PUT", "={{ `" + GH + "/contents/catalog/cases/${$('Prepare').first().json.id}.yaml` }}", [1760, 0],
       body="={{ JSON.stringify({ message: `feat(catalog): ${$('Prepare').first().json.id} from the business intake form`, content: $('Prepare').first().json.content, branch: $('Prepare').first().json.branch }) }}"),
    gh("Open PR", "POST", f"{GH}/pulls", [1980, 0], body=PR_BODY),
    gh("Label: new-case", "POST", "={{ `" + GH + "/issues/${$json.number}/labels` }}", [2200, 0],
       body='={{ JSON.stringify({ labels: ["new-case"] }) }}'),
    control_room("Control room: case drafted", EV_DRAFT, [1100, -220]),
    control_room("Control room: proposal opened", EV_PR, [1980, -220]),
    node("Confirmation", "n8n-nodes-base.form", 2.5, {
        "operation": "completion", "respondWith": "text",
        "completionTitle": "={{ `Case ${$('Prepare').first().json.id} filed` }}",
        "completionMessage": "={{ `Proposal opened: ${$('Open PR').first().json.html_url}\\n\\nA functional reviewer checks the case first. Then the agent writes the automated test, and the result appears in that same proposal.` }}"},
        [2420, 0], webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "case-intake-done"))),
]
# "Example" feeds the prompt by name; it runs before the chain.
C = wf("QA · Case intake (key users)", c_nodes,
       [("Case intake", "Catalog cases"), ("Catalog cases", "Cases in review"), ("Cases in review", "Next ID"), ("Next ID", "Example"),
        ("Example", "Draft input"), ("Draft input", "Draft case in the template"),
        ("Draft case in the template", "Prepare"), ("Prepare", "SHA of main"), ("Prepare", "Control room: case drafted"), ("SHA of main", "Create branch"),
        ("Create branch", "Upload case"), ("Upload case", "Open PR"), ("Open PR", "Label: new-case"), ("Open PR", "Control room: proposal opened"),
        ("Label: new-case", "Confirmation")],
       [("Claude Sonnet 5.5", "Draft case in the template", "ai_languageModel")])
# The raw example comes back as {data: "..."}; restore id + form for the prompt.
C["nodes"].append(node("Draft input", "n8n-nodes-base.code", 2, {"jsCode":
    "return [{ json: { ...$('Next ID').first().json, example: $json.data ?? '' } }];"}, [770, -160]))
next(n for n in C["nodes"] if n["name"] == "Draft case in the template")["parameters"]["text"] = PROMPT_C.replace('${$node["Example"].json.data ?? \'\'}', "${$json.example}")

# ---------------- D. MCP server ----------------
def tool(name, desc, method, url, pos, body=None, placeholders=(), fields=None, data_field=None):
    p = {"toolDescription": desc, "method": method, "url": url, "authentication": "predefinedCredentialType",
         "nodeCredentialType": "githubApi", "sendHeaders": True, "specifyHeaders": "keypair",
         "parametersHeaders": {"values": [{"name": "Accept", "valueProvider": "fieldValue", "value": "application/vnd.github+json"}]}}
    if body:
        p.update(sendBody=True, specifyBody="json", jsonBody=body)
    if placeholders:
        p["placeholderDefinitions"] = {"values": [{"name": n, "description": d, "type": "string"} for n, d in placeholders]}
    if fields:
        p.update(optimizeResponse=True, responseType="json", dataField=data_field or "", fieldsToInclude="selected", fields=fields)
    return node(name, "@n8n/n8n-nodes-langchain.toolHttpRequest", 1.1, p, pos, "github")

d_nodes = [
    node("QA MCP server", "@n8n/n8n-nodes-langchain.mcpTrigger", 2.1, {
        "authentication": "bearerAuth", "path": "qa",
        "instructions": "QA lab tools: launch regressions of critical processes (current or migrated ERP) and read results and open regressions."},
        [0, 0], "mcp", webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL, "mcp-qa"))),
    tool("launch_regression", "Launches the regression of critical processes. target: 'erp' (current) or 'erp-new' (migrated). mode: 'regression' or 'migration' (adds a before/after data comparison). reason: short text.",
         "POST", f"{GH}/actions/workflows/regression.yml/dispatches", [-200, 240],
         body='{"ref":"main","inputs":{"target":"{target}","mode":"{mode}","reason":"{reason}"}}',
         placeholders=[("target", "erp or erp-new"), ("mode", "regression or migration"), ("reason", "why it is launched")]),
    tool("latest_runs", "Latest test runs (CI of changes, regressions, test authoring) with their status and a link to the evidence.",
         "GET", f"{GH}/actions/runs?per_page=8", [0, 240], fields="name,display_title,status,conclusion,html_url,created_at,head_branch", data_field="workflow_runs"),
    tool("open_regressions", "Open regressions found by the suite (issues with their business case, impact and evidence).",
         "GET", f"{GH}/issues?labels=regression&state=open", [200, 240], fields="number,title,html_url,created_at,body"),
]
D = wf("QA · MCP server", d_nodes, [],
       [("launch_regression", "QA MCP server", "ai_tool"), ("latest_runs", "QA MCP server", "ai_tool"),
        ("open_regressions", "QA MCP server", "ai_tool")])

OUT.mkdir(parents=True, exist_ok=True)
for slug, w in [("qa-results", A), ("qa-launch-regression", B), ("qa-case-intake", C), ("qa-mcp", D)]:
    (OUT / f"{slug}.json").write_text(json.dumps(w, ensure_ascii=False, indent=2) + "\n")
    print(f"{slug}: {w['id']} ({len(w['nodes'])} nodes)")
