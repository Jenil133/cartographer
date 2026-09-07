#!/usr/bin/env bash
#
# One-time history cleanup for the Cartographer repo.
#
#   1. Removes docs/phase-{1,2,3}.md from every commit (private build specs that
#      were pushed in the first scaffold commit before being gitignored).
#   2. Strips every "Co-Authored-By: Claude ..." trailer from commit messages, so
#      the history is authored solely as Jenil133.
#
# This REWRITES history and FORCE-PUSHES. Safe here: solo repo, no collaborators.
# Anyone who has already cloned would need to re-clone.
#
# Run from the repo root:   bash scripts/clean-history.sh
#
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "==> Backing up to ../cartographer-backup-$(date +%Y%m%d-%H%M%S).bundle"
git bundle create "../cartographer-backup-$(date +%Y%m%d-%H%M%S).bundle" --all

echo "==> Commits currently carrying the trailer:"
git log --format='  %h %s' --grep='Co-Authored-By' || true

echo "==> Rewriting history..."
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter '
      git rm -r --cached --ignore-unmatch \
        docs/phase-1.md docs/phase-2.md docs/phase-3.md
  ' \
  --msg-filter '
      # Drop the trailer line, then trim any trailing blank lines it left behind.
      sed "/^Co-Authored-By: Claude/d" | awk "
        { lines[NR] = \$0 }
        END {
          last = NR
          while (last > 0 && lines[last] ~ /^[[:space:]]*$/) last--
          for (i = 1; i <= last; i++) print lines[i]
        }
      "
  ' \
  --prune-empty HEAD

echo "==> Verifying..."
if git log --all --format='%H' --grep='Co-Authored-By: Claude' | grep -q .; then
  echo "!! trailer still present - NOT pushing"; exit 1
fi
if git rev-list --all --objects | grep -qE 'docs/phase-[123]\.md'; then
  echo "!! spec files still reachable - NOT pushing"; exit 1
fi
echo "   clean: no trailers, no spec files in any commit"

echo "==> Force-pushing to origin/main"
git push --force origin main

echo "==> Expiring local reflog copies of the old history"
rm -rf .git/refs/original
git reflog expire --expire=now --all
git gc --prune=now --aggressive --quiet

echo "==> Done. Final history:"
git log --oneline
