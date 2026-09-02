---
name: codex-usage-history-poster
description: Analyze local Codex JSONL usage logs and generate a polished vertical historical-usage infographic with Beijing-time daily trends, a calendar heatmap, per-model token and cost breakdowns, reasoning-effort mix, and privacy-safe workflow signals. Use when the user asks for a Codex token history poster, local usage atlas, model consumption report, or visual API-cost estimate. Do not use for official billing reconciliation or raw conversation export.
---

# Codex Usage History Poster

Create a reproducible editorial-style poster from the user's own local Codex logs. The output should resemble a designed data poster, not a dashboard card wall.

## Run the bundled pipeline

Use `scripts/generate.py`. It performs aggregation, rendering, and validation in one pass.

```powershell
python scripts/generate.py --output <output-directory> --days 100
```

- Default Codex data root: `~/.codex`.
- Override with `--codex-home <path>` when needed.
- Use `--days 0` only when the user explicitly wants full history. If the range exceeds 112 natural days, choose a shorter range for poster legibility.
- Use `--from-date YYYY-MM-DD` and `--to-date YYYY-MM-DD` for an explicit Beijing-time window.
- The script requires Python 3.10+ and Pillow. Prefer an existing Codex bundled Python runtime when it already provides Pillow; do not install packages without authorization.

The pipeline writes:

- `codex_historical_usage_atlas.png`
- `summary.json`
- `daily_usage.csv`
- `daily_model_usage.csv`
- `model_usage.csv`
- `effort_usage.csv`
- `mode_usage.csv`
- `tool_category_usage.csv`
- `skill_signals.csv`
- `validation.json`

## Data and pricing rules

- Convert timestamps to `Asia/Shanghai` before date, hour, or weekday grouping.
- Count `payload.info.last_token_usage` from `event_msg`; do not sum cumulative totals.
- Attribute each usage event to the latest preceding `turn_context` model, reasoning effort, and collaboration mode in the same JSONL file.
- Treat model names without a matching rate as unpriced; include their tokens in totals and exclude them from cost.
- Use `assets/pricing_rates.json` for the bundled price snapshot. When current pricing matters, verify the listed official OpenAI model pages and update the snapshot date/rates before rendering.
- Label cost as an API base-text-rate estimate, never as an actual Codex bill. Exclude long-context multipliers, cache-write premiums, regional uplifts, and tool-call fees unless request-level evidence supports them.

Read [references/data-contract.md](references/data-contract.md) only when changing the parser, pricing logic, or exported schema.

## Privacy invariants

- Never export message bodies, tool arguments, file contents, raw session IDs, authentication data, account identifiers, or local source paths.
- Skill/plugin handles may be counted only from explicit `$skill` or `@plugin` markers; export handles and counts only.
- Keep generated data in the user-selected output directory, not inside the skill folder.
- Run the bundled validation and stop if reconciliation or sensitive-pattern checks fail.

## Poster design contract

- Preserve the visual mother idea: warm archival paper, distressed navy display type, cobalt/red/gold/teal accents, token ticket, model-colored cables, and editorial rules.
- Reading order: title → hero total → daily model stack → date heatmap → model ledger → cost/effort composition → compact usage summary.
- Use one stable color per model across the trend, legend, cables, and model ledger.
- Show input/output tokens directly below the hero total.
- Keep the heatmap deterministic and render missing days as muted blanks.
- Display per-model total tokens, input/output detail, share, and price estimate.
- Use a declarative title. Keep explanatory copy compact and in Chinese unless the user requests another language.
- Inspect the final PNG after rendering. Fix collisions, clipped labels, mojibake, or unreadable heatmap cells before delivery.

## Delivery

Report the image path, dimensions, file size, SHA-256, data window, headline totals, pricing caveats, and validation result. Keep local modification, commit, push, and deployment states separate.
