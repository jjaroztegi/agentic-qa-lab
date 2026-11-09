#!/usr/bin/env bash
# Reproduce one of the stories end to end.
#   scenarios/run.sh                      list them
#   scenarios/run.sh <scenario>           for real: a pull request (or the n8n form, or a release
#                                         event) and GitHub Actions + the agents react
#   scenarios/run.sh <scenario> --local   the same pipeline scripts on this machine, no GitHub
# Each scenarios/<name>/scenario.sh sets TITLE and KIND:
#   intake      a key user fills the n8n form (local: the case goes straight to the catalog)
#   case        new catalog case(s) from case*.yaml -> the authoring agent writes the tests
#   change      a code change made by apply() -> CI, and the triage agent if a case breaks
#   regression  an event (vendor release, migration rehearsal) -> black-box regression
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
if [[ -z ${1:-} ]]; then
  for d in scenarios/*/scenario.sh; do (source "$d"; printf '  %-24s %s\n' "$(basename "$(dirname "$d")")" "$TITLE"); done
  exit 0
fi
name=${1%/}; name=${name#scenarios/}; mode=${2:-pr}
SCEN=$ROOT/scenarios/$name
[[ -f $SCEN/scenario.sh ]] || { echo "Not found: $SCEN/scenario.sh (scenarios/run.sh lists them)" >&2; exit 2; }
source "$SCEN/scenario.sh"
local=0; [[ $mode == --local ]] && local=1
((local)) || git fetch -q origin main

# Next free case id: catalog on main + cases still open as PRs (branches case/cp-NNN), as n8n does.
next_id() {
  local n
  n=$( { git ls-tree --name-only origin/main catalog/cases/ 2>/dev/null || ls catalog/cases; } | sed -n 's/.*CP-\([0-9]*\)\.yaml/\1/p'
       git ls-remote --heads origin 'case/cp-*' 2>/dev/null | sed -n 's/.*case\/cp-\([0-9]*\)$/\1/p'
       echo "${LAST_ID:-0}" )
  printf 'CP-%03d' $(( 10#$(sort -n <<< "$n" | tail -1) + 1 ))
}

worktree() {  # fresh checkout of main on a new branch
  local wt; wt=$(mktemp -d "${TMPDIR:-/tmp}/qa-scenario-XXXX")
  git worktree add -q -b "$1" "$wt" "$( ((local)) && echo HEAD || echo origin/main)" && echo "$wt"
}

case $KIND in
intake)
  if ((local)); then KIND=case; else
    echo "· Intake through the n8n form (as a business user)"
    node scenarios/01-business-intake/submit-form.mjs "$SCEN/form.json"; exit; fi ;;
regression)
  ((local)) && { apply; exec tools/pipeline/regression.sh "$TARGET" "$RMODE"; }
  apply; gh workflow run regression.yml -f target="$TARGET" -f mode="$RMODE" -f reason="$TITLE"
  echo "Regression started: gh run list --workflow regression.yml"; exit ;;
esac

if [[ $KIND == case ]]; then
  for f in "$SCEN"/case*.yaml; do
    id=$(next_id); LAST_ID=${id#CP-}
    branch="case/$(tr '[:upper:]' '[:lower:]' <<< "$id")"
    wt=$(worktree "$branch")
    sed "s/^id: CP-XXX/id: $id/" "$f" > "$wt/catalog/cases/$id.yaml"
    title=$(sed -n 's/^title: //p' "$wt/catalog/cases/$id.yaml")
    (cd "$wt" && git add catalog && git -c user.name="${GIT_AUTHOR_NAME:-scenario}" -c user.email="${GIT_AUTHOR_EMAIL:-scenario@local}" commit -qm "feat(catalog): $id $title")
    if ((local)); then
      (cd "$wt" && npm ci --silent && QA_FROM_SCRATCH=${FROM_SCRATCH:-} tools/pipeline/author.sh "$id") || true
      echo "Test and evidence in $wt (git worktree remove $wt when done)"
    else
      (cd "$wt" && git push -q -u origin "$branch")
      url=$(gh pr create --base main --head "$branch" --label new-case --title "New case $id: $title" \
        --body "Business case \`$id\` added to the catalog (scenario \`$name\`). With the \`automate\` label, the agent explores the systems, writes the test and pushes it to this PR.")
      [[ -n ${FROM_SCRATCH:-} ]] && gh pr edit "$url" --add-label from-scratch >/dev/null   # no existing tests for the agent
      gh pr edit "$url" --add-label automate >/dev/null   # starts the authoring agent
      echo "$id  $url"
      git worktree remove --force "$wt"
      sleep 2   # one GitHub request at a time: no secondary rate limit
    fi
  done
  ((local)) || echo "Follow the run in the control room: http://127.0.0.1:17000"
  exit
fi

# KIND=change: a code change on a branch, as a developer would push it.
branch="scenario/$name-$(date +%m%d-%H%M%S)"
wt=$(worktree "$branch")
trap 'git worktree remove --force "$wt" >/dev/null 2>&1 || true' EXIT
(cd "$wt" && apply && git add -A && git -c user.name="${GIT_AUTHOR_NAME:-scenario}" -c user.email="${GIT_AUTHOR_EMAIL:-scenario@local}" commit -qm "$COMMIT")
if ((local)); then
  (cd "$wt" && npm ci --silent && tools/pipeline/ci.sh "$(git -C "$ROOT" rev-parse HEAD)")
  exit
fi
(cd "$wt" && git push -q -u origin "$branch")
gh pr create --base main --head "$branch" --title "$COMMIT" --body "$BODY"
echo "Follow the run in the control room: http://127.0.0.1:17000"
