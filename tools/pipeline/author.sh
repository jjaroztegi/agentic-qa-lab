#!/usr/bin/env bash
# Business case -> automated test, in an isolated environment, filmed.
#   tools/pipeline/author.sh CP-005
# Picks the agent by the systems the case touches: web (ERP/MES) -> qa-author, only the Java
# L2 client -> qa-author-desktop, web + L2 -> qa-author writing one cross-system test.
# The agent sees only what policy/agent-access.yaml allows: it works in a sealed copy of the repo with
# no source code of black-box (commercial) systems, and may not read this checkout.
# Leaves the new test in the working tree and the evidence in evidence/; exit 0 = test proven.
set -euo pipefail
source "$(dirname "$0")/lib.sh"; cd "$ROOT"
CASE=${1:?case id}; export RUN_ID=${RUN_ID:-author_$(date +%Y%m%d%H%M%S)}
f=catalog/cases/$CASE.yaml; [[ -f $f ]] || { echo "Not found: $f" >&2; exit 2; }
# Systems, title and access policy of the case (one JSON per line: no word splitting surprises).
policy=$(node -e '
  const fs=require("fs"), Y=require("yaml");
  const c=Y.parse(fs.readFileSync(process.argv[1],"utf8")), a=Y.parse(fs.readFileSync("policy/agent-access.yaml","utf8")).systems;
  const sys=[...new Set((c.systems||[]).map(s=>s.split(" ")[0]))];
  const code=c.black_box?[]:sys.map(s=>a[s]?.source).filter(Boolean);
  const access=Object.fromEntries(sys.map(s=>[s, !c.black_box && a[s]?.source ? "source access" : "black box"]));
  console.log(JSON.stringify({systems:sys, title:c.title, code, access}));' "$f")
systems=$(jq -r '.systems|join(",")' <<< "$policy")
title=$(jq -c .title <<< "$policy")
web=0; l2=0
[[ ,$systems, == *,ERP,* ]] && web=1
[[ ,$systems, == *,L2,* ]] && l2=1
if ((l2 && !web)); then skill=qa-author-desktop; else skill=qa-author; fi
export QA_AGENT_TOOLS="${QA_AGENT_TOOLS:+$QA_AGENT_TOOLS,}Bash(tools/l2:*),Bash(tools/api:*),Bash(node --test:*)"

# Sealed workspace: the test platform (cases, tests, support layer, tools, agent skills, access
# policy) plus the source of the systems the case may see. Everything else, including this checkout, is out of reach.
WS=$(mktemp -d "${TMPDIR:-/tmp}/qa-agent-XXXX")/repo
mkdir -p "$WS"
keep=$(git ls-tree --name-only HEAD -- .agents .claude .mcp.json policy catalog tests specs tools package.json package-lock.json playwright.config.ts)
git archive HEAD -- $keep $(jq -r '.code[]' <<< "$policy") | tar -x -C "$WS"
# From scratch (QA_FROM_SCRATCH=1, PR label "from-scratch"): no existing business tests or plans to learn
# from; only the support layers and the planner's seed remain, as on the first day on a new system.
if [[ -n ${QA_FROM_SCRATCH:-} ]]; then
  find "$WS/tests" -type f \( -name '*.spec.ts' -o -name '*.test.mjs' \) ! -name seed.spec.ts ! -path '*/support/*' -delete
  rm -rf "$WS/tests/contracts" "$WS/specs"/*
fi
ln -s "$ROOT/node_modules" "$WS/node_modules"
# Off limits: the home directory (this checkout, other runners' workspaces, any clone) and full
# scenario worktrees. The sealed copy lives in TMPDIR.
export QA_AGENT_SETTINGS=$(jq -nc --arg h "$HOME" --arg t "${TMPDIR:-/tmp}" \
  '[$h + "/**", $t + "/qa-scenario-*/**"] | {permissions:{deny:(map("Read(/" + . + ")", "Edit(/" + . + ")", "Write(/" + . + ")"))}}')

mkdir -p evidence
stage env start "Isolated environment"
env_up
emit run "$RUN_ID" "$(jq -nc --arg c "$CASE" --argjson t "$title" --arg s "$skill" --arg pr "${PR_NUMBER:-}" \
  --arg erp "${ERP_URL:-http://127.0.0.1:18069}" --arg mes "$MES_URL" --arg vnc "$QA_VNC_WS" --arg novnc "$QA_NOVNC" --arg repo "${GITHUB_REPOSITORY:-}" \
  --argjson access "$(jq -c .access <<< "$policy")" --arg scratch "${QA_FROM_SCRATCH:-}" \
  '{workflow:"author", case:$c, title:$t, skill:$s, pr:($pr|tonumber? // null), vnc:$vnc, novnc:$novnc, systems:{ERP:$erp, MES:$mes}, access:$access, from_scratch:($scratch != ""), repo:$repo}')"
stage env ok "ERP copy ${ERP_DB} · MES ${MES_URL} · desktop ${QA_DISPLAY}"
[[ $(uname -s) == Linux ]] && export QA_SHOW=1   # the run desktop is an X display on this host
((l2)) && tools/l2 launch
rec_start

stage agent start "Agent $skill · $(jq -r '.access|to_entries|map(.key+" "+.value)|join(" · ")' <<< "$policy")${QA_FROM_SCRATCH:+ · no prior tests}"
rc=0; "$WS/tools/agent.sh" "$skill" "$CASE" | tee evidence/author-summary.txt || rc=$?
# Only the test platform comes back from the sealed copy: new tests, plans, evidence.
for d in tests specs evidence; do [[ -d $WS/$d ]] && cp -R "$WS/$d/." "$ROOT/$d/"; done
if ((rc == 0)); then stage agent ok; else stage agent fail; exit 1; fi

stage prove start "Proof outside the agent"
id=$(tr "[:upper:]" "[:lower:]" <<< "$CASE")
specs=$(ls tests/e2e/"$id"-*.spec.ts 2>/dev/null || true)
desk=$(ls tests/desktop/"$id"-*.test.mjs 2>/dev/null || true)
[[ -n $specs || -n $desk ]] || { stage prove fail "The agent left no test"; exit 1; }
ok=1
[[ -n $specs ]] && { npx playwright test $specs || ok=0; }
[[ -n $desk ]] && { node --test --test-concurrency=1 --test-timeout=300000 $desk || ok=0; }
if ((ok)); then stage prove ok "Test passed outside the agent"; RESULT_TITLE="Test for $CASE written and proven"
else stage prove fail; RESULT_TITLE="The test for $CASE fails outside the agent"; exit 1; fi
