# Data contract

Read this reference only when modifying the log parser, pricing model, or exported files.

## Source records

Scan `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl` below the selected Codex home.

State changes come from `turn_context`:

- `payload.model`
- `payload.effort`
- `payload.collaboration_mode`

Token deltas come from `event_msg` records where `payload.info.last_token_usage` is present:

- `last_token_usage.input_tokens`
- `last_token_usage.cached_input_tokens`
- `last_token_usage.output_tokens`
- `last_token_usage.reasoning_output_tokens`
- `last_token_usage.total_tokens`

`last_token_usage` is the per-event increment used for aggregation. Do not add `total_token_usage`, which is cumulative within a task and causes double-counting.

## Time window

Parse ISO timestamps, treat naive timestamps as UTC, then convert to `Asia/Shanghai`. Apply `--from-date` and `--to-date` after conversion. When only `--days N` is supplied, anchor the inclusive N-day window on the most recent token event.

## Price estimate

For each priced model:

```text
non_cached_input = max(0, input_tokens - cached_input_tokens)
cost = non_cached_input × input_rate
     + cached_input_tokens × cached_input_rate
     + output_tokens × output_rate
```

Rates are USD per 1,000,000 tokens. Reasoning output is already part of output tokens and must not be charged a second time.

The bundled rate file records its verification date and official source URL per model. Prefix matching may support dated model snapshots, but must not silently map unrelated model families.

## Exported schema

Every token table uses integer fields:

- `events`
- `input_tokens`
- `cached_input_tokens`
- `output_tokens`
- `reasoning_output_tokens`
- `total_tokens`

Model tables additionally include:

- `model`
- `api_cost_est`
- `api_priced`

Daily-model rows use `(date_bj, model)` as their grain. All model, daily, and daily-model totals must reconcile exactly to `summary.json`.

## Privacy

The exporter may retain only aggregate counts and explicit handle names. It must not persist:

- raw JSONL lines;
- message text;
- tool arguments or outputs;
- session/thread/task IDs;
- user, account, organization, or authentication fields;
- absolute source paths.
