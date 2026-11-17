#!/usr/bin/env bash
# scripts/ci-mirror-push-job.sh — report a job's result from staging's push run.
#
# Used by .github/workflows/ci.yml on a promote PR (staging → main) that reuses the push run for the
# same commit instead of running everything again (see the `dedupe` job). Waits for the job named
# $NAME in run $RUN to finish, then passes or fails with it.
#
# Env: GH_TOKEN, REPO (owner/name), RUN (push run id), NAME (job name, exact).
set -euo pipefail

url="https://github.com/$REPO/actions/runs/$RUN"
echo "This commit's checks run on staging's push: $url"
for _ in $(seq 1 120); do   # up to 30 minutes
    line=$(gh api "repos/$REPO/actions/runs/$RUN/jobs?per_page=100" \
        --jq '.jobs[] | select(.name == env.NAME) | "\(.status) \(.conclusion // "")"' | head -1)
    if [ "${line%% *}" = completed ]; then
        conclusion="${line#* }"
        echo "\"$NAME\" on the push run: $conclusion"
        [ "$conclusion" = success ] && exit 0
        echo "::error::\"$NAME\" did not pass on staging's push run ($conclusion): $url. Fix it on staging, or re-run that job and then this one."
        exit 1
    fi
    sleep 15
done
echo "::error::Timed out after 30 minutes waiting for \"$NAME\" on $url"
exit 1
