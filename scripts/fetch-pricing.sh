#!/bin/sh
# Fetch model pricing from models.dev and generate TypeScript module
set -e

PROVIDERS="anthropic|openai|google-ai-studio|google-vertex|groq|mistral|cohere|perplexity|aws-bedrock|deepseek"
OUT="src/pricing-data.ts"

DATA=$(curl -sf https://models.dev/api.json | jq -c "
[to_entries[]
| select(.key | test(\"^($PROVIDERS)$\"))
| .key as \$p
| (.value.models // {} | to_entries[])
| select(.value.cost)
| {(\"\(\$p)/\(.value.id // .key)\"): (.value.cost | {input, output, cacheRead: .cache_read, cacheWrite: .cache_write} | with_entries(select(.value | type == \"number\")))}
] | add") || {
  if [ -f "$OUT" ]; then
    echo "Fetch failed, keeping existing $OUT" >&2
    exit 0
  fi
  echo "Fetch failed and no existing $OUT" >&2
  exit 1
}

printf '// Auto-generated — run `pnpm pricing` to update\n// Source: https://models.dev/api.json\n\nconst data: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = %s;\n\nexport default data;\n' "$DATA" > "$OUT"

echo "Wrote $(echo "$DATA" | jq 'keys | length') models to $OUT"
