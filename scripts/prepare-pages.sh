#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/prepare-pages.sh <category>
# category: "daily" or "analysis"

CATEGORY="${1:?Usage: prepare-pages.sh <daily|analysis>}"
SITE_DIR="_site"

mkdir -p "$SITE_DIR/daily" "$SITE_DIR/analysis"

# Copy new reports into the right category
cp results/reports/*.html "$SITE_DIR/$CATEGORY/" 2>/dev/null || true

# Fetch existing gh-pages content and merge in
git fetch origin gh-pages:gh-pages 2>/dev/null || true
for dir in daily analysis; do
  if git show "gh-pages:$dir/" 2>/dev/null; then
    for f in $(git ls-tree --name-only "gh-pages:$dir/"); do
      if [ ! -f "$SITE_DIR/$dir/$f" ]; then
        git show "gh-pages:$dir/$f" > "$SITE_DIR/$dir/$f" 2>/dev/null || true
      fi
    done
  fi
done

# Build index.html
cat > "$SITE_DIR/index.html" << 'HTMLEOF'
<!DOCTYPE html>
<html>
<head>
<title>TACo Performance Reports</title>
<style>
  body { font-family: 'SF Mono', Monaco, 'Inconsolata', monospace; background: #1a1a2e; color: #e0e0e0; padding: 2em; max-width: 800px; margin: 0 auto; }
  h1 { color: #fff; margin-bottom: 0.2em; }
  h2 { color: #96FF5E; margin-top: 1.5em; }
  .subtitle { color: #888; margin-bottom: 2em; }
  ul { list-style: none; padding: 0; }
  li { padding: 0.3em 0; }
  a { color: #96FF5E; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #666; font-style: italic; }
</style>
</head>
<body>
<h1>TACo Performance</h1>
<p class="subtitle">Threshold signing network health &amp; analysis reports</p>
HTMLEOF

# Daily section
echo '<h2>Daily Health Checks</h2>' >> "$SITE_DIR/index.html"
DAILY_FILES=$(ls -t "$SITE_DIR/daily/"*.html 2>/dev/null | xargs -I{} basename {} || true)
if [ -n "$DAILY_FILES" ]; then
  echo '<ul>' >> "$SITE_DIR/index.html"
  for f in $DAILY_FILES; do
    echo "<li><a href=\"daily/$f\">$f</a></li>" >> "$SITE_DIR/index.html"
  done
  echo '</ul>' >> "$SITE_DIR/index.html"
else
  echo '<p class="empty">No daily reports yet.</p>' >> "$SITE_DIR/index.html"
fi

# Analysis section
echo '<h2>Ad-hoc Analysis</h2>' >> "$SITE_DIR/index.html"
ANALYSIS_FILES=$(ls -t "$SITE_DIR/analysis/"*.html 2>/dev/null | xargs -I{} basename {} || true)
if [ -n "$ANALYSIS_FILES" ]; then
  echo '<ul>' >> "$SITE_DIR/index.html"
  for f in $ANALYSIS_FILES; do
    echo "<li><a href=\"analysis/$f\">$f</a></li>" >> "$SITE_DIR/index.html"
  done
  echo '</ul>' >> "$SITE_DIR/index.html"
else
  echo '<p class="empty">No analysis reports yet.</p>' >> "$SITE_DIR/index.html"
fi

echo '</body></html>' >> "$SITE_DIR/index.html"
touch "$SITE_DIR/.nojekyll"

echo "[prepare-pages] Done. Category: $CATEGORY"
