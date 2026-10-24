#!/bin/bash
# docs/playbooks/build.sh — print each playbook's HTML to an A4 PDF with headless Chrome.
# Run from anywhere:  bash docs/playbooks/build.sh
# The PDFs are the free downloads for sign-up forms (Audience ▸ Sign-up forms ▸ Free download).
# docs/ is blocked from the public site (netlify.toml), so nothing here is downloadable without signing up.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for f in *.html; do
  out="${f%.html}.pdf"
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=10000 \
    --print-to-pdf="$PWD/$out" "file://$PWD/$f" 2>/dev/null
  echo "built $out"
done
