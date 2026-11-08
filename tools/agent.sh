#!/usr/bin/env bash
# Runs a repo skill headless with Claude Code. CI-agnostic: GitHub Actions, Azure DevOps or a
# laptop call the same script. Usage: tools/agent.sh <skill> <args...>
# Writes the full stream to evidence/agents/<skill>-<ts>.jsonl (and streams it to the control room when
# QA_EVENTS_URL is set) and prints the final JSON result.
set -euo pipefail
skill=$1; shift
cd "$(dirname "$0")/.."
mkdir -p evidence/agents
log="evidence/agents/${skill}-$(date +%Y%m%dT%H%M%S).jsonl"
# A clean Claude Code configuration: the agent gets this repo's instructions and skills only, never
# the personal skills, plugins, settings or memory of whoever runs it. Model access comes from the
# environment (ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN for a gateway).
CLAUDE_CONFIG_DIR=$(mktemp -d); export CLAUDE_CONFIG_DIR
trap 'rm -rf "$CLAUDE_CONFIG_DIR"' EXIT
jq -n --arg p "$PWD" '{projects: {($p): {hasTrustDialogAccepted: true}}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
claude -p "/${skill} $*" \
  --strict-mcp-config --mcp-config .mcp.json \
  --model "${QA_AGENT_MODEL:-claude-opus-5-5}" \
  --permission-mode acceptEdits \
  --allowedTools "Read,Write,Edit,Glob,Grep,Agent,Bash(npx playwright test:*),Bash(curl -s http://127.0.0.1:*),Bash(git diff:*),Bash(git status:*),mcp__playwright-test${QA_AGENT_TOOLS:+,$QA_AGENT_TOOLS}" \
  --max-turns "${QA_AGENT_MAX_TURNS:-120}" \
  ${QA_AGENT_SETTINGS:+--settings "$QA_AGENT_SETTINGS"} \
  --output-format stream-json --verbose ${QA_AGENT_EXTRA_ARGS:-} \
  | tee "$log" >(if [[ -n ${QA_EVENTS_URL:-} && -f tools/emit.mjs ]]; then node tools/emit.mjs agent "${RUN_ID:-local}"; else cat >/dev/null; fi) \
  | jq --unbuffered -rRc 'fromjson? | select(.type=="assistant") | .message.content[]? | select(.type=="text" or .type=="tool_use") | if .type=="text" then "· " + (.text|.[0:300]) else "→ " + .name + " " + ((.input|tostring)|.[0:160]) end'
jq -Rc 'fromjson? | select(.type=="result") | {subtype, is_error, num_turns, duration_ms, total_cost_usd, result: (.result|.[0:2000])}' "$log" | tail -1
