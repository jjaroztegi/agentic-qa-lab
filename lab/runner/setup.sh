#!/usr/bin/env bash
# Self-hosted GitHub Actions runners for the lab (label qa-lab). They sit next to the systems under
# test, as they would inside a company network. Linux with systemd.
#   lab/runner/setup.sh [count]        register runners 1..count for this checkout's GitHub repo
# The runners run as a dedicated user (QA_RUNNER_USER, default qa) in the docker group: workflow code
# never runs as you, so it cannot read your home directory, credentials or tool settings. Each runner
# lives in its own UTS namespace and reports QA_RUNNER_HOST (default qa-lab) as its machine name.
# Needs: sudo, gh logged in with admin rights on the repository. The runner user needs Node 24, the
# Claude Code CLI and Playwright's Chromium on its PATH, and its ~/.config/qa-runner.env (mode 600)
# holds the model access and the other settings in docs/operations/runners.md.
# The repository variable QA_LAB_RUNNERS=true turns on the jobs that need these runners.
set -euo pipefail
count=${1:-1}
user=${QA_RUNNER_USER:-qa} host=${QA_RUNNER_HOST:-qa-lab}
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
ver=$(gh api repos/actions/runner/releases/latest -q .tag_name | sed 's/^v//')
arch=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
tgz="${XDG_CACHE_HOME:-$HOME/.cache}/actions-runner-$ver-linux-$arch.tar.gz"
[[ -f $tgz ]] || curl -fsSL -o "$tgz" "https://github.com/actions/runner/releases/download/v$ver/actions-runner-linux-$arch-$ver.tar.gz"

id "$user" &>/dev/null || sudo useradd --create-home --shell /bin/bash "$user"
sudo usermod -aG docker "$user"
home=$(getent passwd "$user" | cut -d: -f6)
as() { sudo -u "$user" -H "$@"; }
envfile=$home/.config/qa-runner.env
sudo test -f "$envfile" || { as install -d -m 700 "$home/.config"; as install -m 600 /dev/null "$envfile"; echo "Fill in $envfile (docs/operations/runners.md)"; }

for n in $(seq 1 "$count"); do
  dir=$home/actions-runner-$n name=$host-$n unit=qa-runner-$n
  if sudo test -f "$dir/.runner"; then echo "· $name already registered"; continue; fi
  as mkdir -p "$dir" && as tar xzf - -C "$dir" < "$tgz"
  token=$(gh api -X POST "repos/$repo/actions/runners/registration-token" -q .token)
  as bash -c 'cd "$1" && ./config.sh --unattended --url "https://github.com/$2" --token "$3" --name "$4" --labels qa-lab --work _work --replace' \
    _ "$dir" "$repo" "$token" "$name" >/dev/null
  sudo tee "/etc/systemd/system/$unit.service" >/dev/null <<EOF
[Unit]
Description=GitHub Actions runner $name for $repo (QA lab)
After=network-online.target docker.service
Wants=network-online.target

[Service]
# Started as root only to enter a UTS namespace with its own machine name, then runs as $user.
ExecStart=/usr/bin/unshare --uts /bin/sh -c 'hostname $host && exec /usr/sbin/runuser -u $user -- $dir/run.sh'
WorkingDirectory=$dir
Environment=HOME=$home USER=$user
EnvironmentFile=$envfile
Restart=on-failure
KillSignal=SIGINT
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload && sudo systemctl enable --now "$unit" >/dev/null
  echo "✓ $name"
done
