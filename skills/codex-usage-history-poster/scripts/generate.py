from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
except ImportError as exc:
    raise SystemExit("Pillow is required. Install scripts/requirements.txt in an authorized Python environment.") from exc


TZ = timezone(timedelta(hours=8), name="Asia/Shanghai")
HERE = Path(__file__).resolve().parent
SKILL_ROOT = HERE.parent
DEFAULT_PRICING = SKILL_ROOT / "assets" / "pricing_rates.json"
SKILL_RE = re.compile(r"(?<![A-Za-z0-9_])(?:\$|@)([A-Za-z0-9_.:-]{2,80})")
SKILL_DENY = {"$erroractionpreference", "$psscriptroot", "$projectroot", "$false", "$true", "$_-1"}


@dataclass
class Stats:
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_output_tokens: int = 0
    total_tokens: int = 0
    events: int = 0
    api_cost_est: float = 0.0

    def add(self, usage: dict[str, int], api_cost: float = 0.0) -> None:
        self.input_tokens += usage["input_tokens"]
        self.cached_input_tokens += usage["cached_input_tokens"]
        self.output_tokens += usage["output_tokens"]
        self.reasoning_output_tokens += usage["reasoning_output_tokens"]
        self.total_tokens += usage["total_tokens"]
        self.events += 1
        self.api_cost_est += api_cost

    def row(self) -> dict[str, Any]:
        return {
            "events": self.events,
            "input_tokens": self.input_tokens,
            "cached_input_tokens": self.cached_input_tokens,
            "output_tokens": self.output_tokens,
            "reasoning_output_tokens": self.reasoning_output_tokens,
            "total_tokens": self.total_tokens,
            "api_cost_est": round(self.api_cost_est, 6),
        }


def safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(TZ)


def normalize_model(value: Any) -> str:
    text = str(value or "unknown").strip().lower()
    if text == "gpt-5.6":
        return "gpt-5.6-sol"
    return text or "unknown"


def tool_category(name: str, record_type: str = "") -> str:
    text = f"{name} {record_type}".lower()
    if any(word in text for word in ("shell", "exec", "write_stdin", "wait")):
        return "terminal"
    if any(word in text for word in ("apply_patch", "patch")):
        return "file_edit"
    if any(word in text for word in ("spawn_agent", "wait_agent", "send_message", "followup", "list_agents")):
        return "multi_agent"
    if any(word in text for word in ("web_search", "web.run", "search_query")):
        return "web_search"
    if any(word in text for word in ("view_image", "image_generation", "imagegen")):
        return "visual"
    if any(word in text for word in ("update_plan", "request_user_input", "goal")):
        return "planning"
    if any(word in text for word in ("mcp", "plugin")):
        return "mcp_plugin"
    if any(word in text for word in ("git", "github", "gh_")):
        return "git_github"
    return "other"


def valid_signal(signal: str) -> bool:
    low = signal.lower()
    if low in SKILL_DENY or low.startswith("$env:") or low.startswith("@app."):
        return False
    body = signal[1:]
    if signal.startswith("@"):
        return "-" in body or ":" in body or low in {"@sites", "@github", "@data-analytics"}
    return "-" in body or ":" in body or low in {"$imagegen"}


def load_pricing(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if int(data.get("unit_tokens", 0)) <= 0 or not isinstance(data.get("models"), dict):
        raise ValueError(f"Invalid pricing file: {path}")
    return data


def rate_for(model: str, pricing: dict[str, Any]) -> dict[str, float] | None:
    normalized = normalize_model(model)
    for prefix in sorted(pricing["models"], key=len, reverse=True):
        if normalized == prefix or normalized.startswith(prefix + "-"):
            return pricing["models"][prefix]
    return None


def price_usage(model: str, usage: dict[str, int], pricing: dict[str, Any]) -> tuple[float, tuple[float, float, float]]:
    rate = rate_for(model, pricing)
    if not rate:
        return 0.0, (0.0, 0.0, 0.0)
    unit = int(pricing["unit_tokens"])
    non_cached = max(0, usage["input_tokens"] - usage["cached_input_tokens"])
    parts = (
        non_cached * float(rate["input"]) / unit,
        usage["cached_input_tokens"] * float(rate["cached_input"]) / unit,
        usage["output_tokens"] * float(rate["output"]) / unit,
    )
    return sum(parts), parts


def all_jsonl(codex_home: Path) -> list[Path]:
    found: list[Path] = []
    for child in ("sessions", "archived_sessions"):
        root = codex_home / child
        if root.exists():
            found.extend(root.rglob("*.jsonl"))
    return sorted(found)


def scan_logs(codex_home: Path):
    usage_records: list[tuple[datetime, str, str, str, dict[str, int]]] = []
    tool_records: list[tuple[datetime, str]] = []
    skill_records: list[tuple[datetime, str]] = []
    files = all_jsonl(codex_home)

    for path in files:
        model, effort, mode = "unknown", "unknown", "default"
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = parse_dt(obj.get("timestamp"))
                payload = obj.get("payload") or {}
                if not ts or not isinstance(payload, dict):
                    continue
                record_type = str(obj.get("type") or "")

                if record_type == "turn_context":
                    model = normalize_model(payload.get("model") or model)
                    effort = str(payload.get("effort") or effort)
                    collaboration = payload.get("collaboration_mode") or {}
                    if isinstance(collaboration, dict):
                        mode = str(
                            collaboration.get("mode")
                            or collaboration.get("name")
                            or collaboration.get("type")
                            or collaboration.get("kind")
                            or (collaboration.get("settings") or {}).get("mode")
                            or "default"
                        )
                    continue

                if record_type == "event_msg":
                    event_type = str(payload.get("type") or "")
                    usage = (payload.get("info") or {}).get("last_token_usage")
                    if isinstance(usage, dict):
                        values = {
                            "input_tokens": safe_int(usage.get("input_tokens")),
                            "cached_input_tokens": safe_int(usage.get("cached_input_tokens")),
                            "output_tokens": safe_int(usage.get("output_tokens")),
                            "reasoning_output_tokens": safe_int(usage.get("reasoning_output_tokens")),
                            "total_tokens": safe_int(usage.get("total_tokens")),
                        }
                        if not values["total_tokens"]:
                            values["total_tokens"] = values["input_tokens"] + values["output_tokens"]
                        usage_records.append((ts, model, effort, mode, values))
                    if event_type == "user_message":
                        message = str(payload.get("message") or "")
                        for match in SKILL_RE.finditer(message):
                            signal = match.group(0)
                            if valid_signal(signal):
                                skill_records.append((ts, signal))
                    event_tool = {
                        "mcp_tool_call_end": "mcp_plugin",
                        "image_generation_end": "visual",
                        "web_search_end": "web_search",
                        "patch_apply_end": "file_edit",
                    }.get(event_type)
                    if event_tool:
                        tool_records.append((ts, event_tool))

                elif record_type == "response_item":
                    item_type = str(payload.get("type") or "")
                    if item_type in {"function_call", "custom_tool_call", "tool_search_call", "web_search_call", "image_generation_call"}:
                        name = str(payload.get("name") or item_type)
                        tool_records.append((ts, tool_category(name, item_type)))
    return files, usage_records, tool_records, skill_records


def resolve_window(records, args) -> tuple[date, date]:
    if not records:
        raise SystemExit("No token usage records were found in the selected Codex home.")
    latest = max(item[0].date() for item in records)
    earliest = min(item[0].date() for item in records)
    end = date.fromisoformat(args.to_date) if args.to_date else latest
    if args.from_date:
        start = date.fromisoformat(args.from_date)
    elif args.days and args.days > 0:
        start = end - timedelta(days=args.days - 1)
    else:
        start = earliest
    if start > end:
        raise SystemExit("The selected start date is after the end date.")
    return start, end


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


TOKEN_FIELDS = ["events", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "api_cost_est"]


def aggregate(output: Path, pricing: dict[str, Any], files, usages, tools, signals, start: date, end: date):
    total = Stats()
    by_model: dict[str, Stats] = defaultdict(Stats)
    by_day: dict[str, Stats] = defaultdict(Stats)
    by_day_model: dict[tuple[str, str], Stats] = defaultdict(Stats)
    by_effort: dict[str, Stats] = defaultdict(Stats)
    by_mode: dict[str, Stats] = defaultdict(Stats)
    cost_parts = Counter()
    unknown_tokens = 0

    for ts, model, effort, mode, usage in usages:
        if not start <= ts.date() <= end:
            continue
        cost, parts = price_usage(model, usage, pricing)
        if not rate_for(model, pricing):
            unknown_tokens += usage["total_tokens"]
        for bucket in (total, by_model[model], by_day[ts.date().isoformat()], by_day_model[(ts.date().isoformat(), model)], by_effort[effort], by_mode[mode]):
            bucket.add(usage, cost)
        cost_parts["non_cached_input"] += parts[0]
        cost_parts["cached_input"] += parts[1]
        cost_parts["output"] += parts[2]

    if total.events == 0:
        raise SystemExit("No token usage records fall inside the selected Beijing-time window.")

    model_rows = [dict(model=name, **stats.row(), api_priced=bool(rate_for(name, pricing))) for name, stats in sorted(by_model.items(), key=lambda item: item[1].total_tokens, reverse=True)]
    daily_rows = [dict(date_bj=name, **stats.row()) for name, stats in sorted(by_day.items())]
    daily_model_rows = [dict(date_bj=day, model=model, **stats.row()) for (day, model), stats in sorted(by_day_model.items())]
    effort_rows = [dict(effort=name, **stats.row()) for name, stats in sorted(by_effort.items(), key=lambda item: item[1].total_tokens, reverse=True)]
    mode_rows = [dict(mode=name, **stats.row()) for name, stats in sorted(by_mode.items(), key=lambda item: item[1].total_tokens, reverse=True)]
    tool_counts = Counter(category for ts, category in tools if start <= ts.date() <= end)
    signal_counts = Counter(signal for ts, signal in signals if start <= ts.date() <= end)
    tool_rows = [{"category": key, "calls": value} for key, value in tool_counts.most_common()]
    signal_rows = [{"signal": key, "mentions": value} for key, value in signal_counts.most_common()]

    peak = max(daily_rows, key=lambda row: int(row["total_tokens"]))
    summary = {
        "generated_at_bj": datetime.now(TZ).isoformat(timespec="seconds"),
        "timezone": "Asia/Shanghai",
        "source_roots": ["~/.codex/sessions", "~/.codex/archived_sessions"],
        "jsonl_files_read": len(files),
        "date_start_bj": start.isoformat(),
        "date_end_bj": end.isoformat(),
        "natural_days": (end - start).days + 1,
        "active_days": len(daily_rows),
        **total.row(),
        "non_cached_input_tokens": max(0, total.input_tokens - total.cached_input_tokens),
        "cache_share": total.cached_input_tokens / total.input_tokens if total.input_tokens else 0,
        "api_cost_parts": {key: round(value, 6) for key, value in cost_parts.items()},
        "unknown_pricing_tokens": unknown_tokens,
        "peak_day": peak,
        "pricing_verified_at": pricing.get("verified_at"),
        "pricing_scope": pricing.get("scope"),
        "pricing_exclusions": pricing.get("exclusions", []),
        "privacy_note": "Aggregate usage only; no message text, tool arguments, raw IDs, authentication data, or absolute source paths are exported.",
    }

    output.mkdir(parents=True, exist_ok=True)
    fields = TOKEN_FIELDS
    write_csv(output / "model_usage.csv", model_rows, ["model", *fields, "api_priced"])
    write_csv(output / "daily_usage.csv", daily_rows, ["date_bj", *fields])
    write_csv(output / "daily_model_usage.csv", daily_model_rows, ["date_bj", "model", *fields])
    write_csv(output / "effort_usage.csv", effort_rows, ["effort", *fields])
    write_csv(output / "mode_usage.csv", mode_rows, ["mode", *fields])
    write_csv(output / "tool_category_usage.csv", tool_rows, ["category", "calls"])
    write_csv(output / "skill_signals.csv", signal_rows, ["signal", "mentions"])
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary, model_rows, daily_rows, daily_model_rows, effort_rows, mode_rows, tool_rows, signal_rows


# Poster palette and helpers -------------------------------------------------
W, H = 1500, 3400
PAPER_TOP, PAPER_BOTTOM = (248, 244, 232), (238, 229, 207)
NAVY, COBALT, RED, GOLD, TEAL = "#082B61", "#0B55C9", "#E84B36", "#EEAE24", "#4F9C93"
INK, MUTED, GRID, PALE, WHITE = "#102748", "#586A7B", "#B8C3C7", "#DFE3DF", "#FFFDF5"
BASE_COLORS = {"gpt-5.6-sol": COBALT, "gpt-5.5": RED, "gpt-5.6-terra": GOLD, "gpt-5.6-luna": TEAL, "unknown": "#97A4AA", "codex-auto-review": "#C7C0AF", "other": "#97A4AA"}


def color_tuple(value: str):
    value = value.lstrip("#")
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def mix(a, b, amount: float):
    ca = color_tuple(a) if isinstance(a, str) else a
    cb = color_tuple(b) if isinstance(b, str) else b
    return tuple(round(ca[i] * (1 - amount) + cb[i] * amount) for i in range(3))


def font_candidates(style: str):
    windows = Path("C:/Windows/Fonts")
    mapping = {
        "display": [windows / "impact.ttf", windows / "bahnschrift.ttf", Path("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf")],
        "cn_display": [windows / "Source Han Serif SC Heavy (TrueType).ttf", windows / "Noto Sans SC Bold (TrueType).otf", Path("/System/Library/Fonts/PingFang.ttc"), Path("/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc")],
        "bold": [windows / "Noto Sans SC Bold (TrueType).otf", windows / "Dengb.ttf", Path("/System/Library/Fonts/PingFang.ttc"), Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc")],
        "body": [windows / "Noto Sans SC (TrueType).otf", windows / "Deng.ttf", Path("/System/Library/Fonts/PingFang.ttc"), Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")],
        "mono": [windows / "bahnschrift.ttf", windows / "consola.ttf", Path("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf")],
    }
    return mapping.get(style, mapping["body"])


def load_font(size: int, style="body"):
    for candidate in font_candidates(style):
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def fonts():
    return {
        "title_en": load_font(158, "display"), "title_num": load_font(142, "display"), "title_cn": load_font(118, "cn_display"),
        "subtitle": load_font(44, "bold"), "hero": load_font(204, "display"), "metric": load_font(76, "display"),
        "section": load_font(34, "bold"), "h3": load_font(26, "bold"), "body": load_font(23), "body_b": load_font(23, "bold"),
        "small": load_font(18), "small_b": load_font(18, "bold"), "tiny": load_font(15), "tiny_b": load_font(15, "bold"),
        "mono": load_font(21, "mono"), "mono_small": load_font(17, "mono"),
    }


def fmt_tokens(value, decimals=2):
    number = int(float(value or 0))
    if number >= 1_000_000_000:
        return f"{number / 1_000_000_000:.{decimals}f}B"
    if number >= 1_000_000:
        return f"{number / 1_000_000:.{decimals}f}M"
    if number >= 1_000:
        return f"{number / 1_000:.1f}K"
    return str(number)


def fmt_money(value):
    number = float(value or 0)
    return f"${number:,.0f}" if abs(number - round(number)) < 0.5 else f"${number:,.2f}"


def make_background():
    image = Image.new("RGB", (W, H), PAPER_TOP)
    draw = ImageDraw.Draw(image)
    for y in range(H):
        draw.line((0, y, W, y), fill=mix(PAPER_TOP, PAPER_BOTTOM, y / H))
    noise = Image.effect_noise((W, H), 7).convert("L")
    noise = ImageOps.colorize(noise, (218, 208, 188), (255, 253, 246)).convert("RGBA")
    image = Image.blend(image.convert("RGBA"), noise, 0.12)
    fibers = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(fibers)
    random.seed(260902)
    for _ in range(1600):
        x, y = random.randrange(W), random.randrange(H)
        fd.line((x, y, x + random.randint(3, 22), y + random.choice((-1, 0, 1))), fill=(70, 58, 40, 12), width=1)
    return Image.alpha_composite(image, fibers)


def text(draw, f, xy, value, style="body", fill=INK, anchor=None):
    draw.text(xy, str(value), font=f[style], fill=fill, anchor=anchor)


def distressed(image, xy, value, font, fill, seed):
    box = font.getbbox(value)
    width, height = box[2] - box[0] + 8, box[3] - box[1] + 8
    mask = Image.new("L", (width, height), 0)
    md = ImageDraw.Draw(mask)
    md.text((4 - box[0], 4 - box[1]), value, font=font, fill=255)
    rnd = random.Random(seed)
    for _ in range(max(24, width * height // 2600)):
        x, y = rnd.randrange(width), rnd.randrange(height)
        radius = rnd.randint(1, 3)
        md.ellipse((x - radius, y - radius, x + radius, y + radius), fill=0)
    ink = Image.new("RGBA", (width, height), color_tuple(fill) + (255,))
    image.alpha_composite(Image.composite(ink, Image.new("RGBA", (width, height)), mask), xy)


def rule(draw, y):
    draw.line((60, y, 1440, y), fill=COBALT, width=3)
    draw.line((60, y + 7, 1440, y + 7), fill=mix(COBALT, WHITE, 0.55), width=1)


def section(draw, f, y, label, note=""):
    draw.ellipse((62, y + 1, 96, y + 35), fill=COBALT)
    text(draw, f, (79, y + 18), "•", "h3", WHITE, "mm")
    text(draw, f, (112, y), label, "section", NAVY)
    if note:
        text(draw, f, (1435, y + 15), note, "small_b", NAVY, "rm")


def palette_and_groups(model_rows):
    ordered = [row["model"] for row in model_rows]
    top = ordered[:4]
    palette = dict(BASE_COLORS)
    extras = ["#7357B8", "#6F7E38", "#B66E29", "#447EAD"]
    for index, model in enumerate(top):
        palette.setdefault(model, extras[index % len(extras)])
    return top, palette


def build_days(summary, daily_rows, daily_model_rows, top_models):
    start, end = date.fromisoformat(summary["date_start_bj"]), date.fromisoformat(summary["date_end_bj"])
    days = [start + timedelta(days=index) for index in range((end - start).days + 1)]
    totals = {date.fromisoformat(row["date_bj"]): int(row["total_tokens"]) for row in daily_rows}
    model_values = defaultdict(lambda: defaultdict(int))
    for row in daily_model_rows:
        day = date.fromisoformat(row["date_bj"])
        key = row["model"] if row["model"] in top_models else "other"
        model_values[day][key] += int(row["total_tokens"])
    return days, totals, model_values


def cubic(p0, p1, p2, p3, steps=60):
    points = []
    for index in range(steps + 1):
        u, q = index / steps, 1 - index / steps
        points.append((q**3 * p0[0] + 3 * q*q*u*p1[0] + 3*q*u*u*p2[0] + u**3*p3[0], q**3*p0[1] + 3*q*q*u*p1[1] + 3*q*u*u*p2[1] + u**3*p3[1]))
    return points


def draw_ticket_and_cables(image, f, summary, top_models, palette):
    draw = ImageDraw.Draw(image)
    x, y = 1260, 205
    for index, model in enumerate(reversed(top_models[:4])):
        color = palette[model]
        dx, dy = (index % 2) * 12 - 6, 58 - index * 12
        draw.polygon([(x - 80 + dx, y + dy), (x + 108 + dx, y + dy + 26), (x + 86 + dx, y + dy + 66), (x - 102 + dx, y + dy + 40)], fill=color, outline=NAVY)
    ticket = Image.new("RGBA", (250, 170), (0, 0, 0, 0))
    td = ImageDraw.Draw(ticket)
    td.rectangle((8, 8, 238, 156), fill=WHITE, outline=NAVY, width=3)
    td.rectangle((22, 22, 224, 142), outline=mix(NAVY, WHITE, 0.35), width=2)
    td.text((32, 30), "TOKEN ARCHIVE", font=load_font(15, "mono"), fill=NAVY)
    td.text((32, 58), fmt_tokens(summary["total_tokens"], 2), font=load_font(56, "display"), fill=NAVY)
    td.text((34, 122), f"{summary['natural_days']} DAYS / BJ TIME", font=load_font(13, "mono"), fill=MUTED)
    image.alpha_composite(ticket.rotate(-13, Image.Resampling.BICUBIC, expand=True), (1195, 50))
    cables = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cables)
    for index, model in enumerate(top_models[:4]):
        points = cubic((1282 + index * 26, 322), (1480 - index * 5, 690), (1300 + index * 18, 1530), (1393, 2095 + index * 95))
        cd.line(points, fill=color_tuple(palette[model]) + (165,), width=3)
    image.alpha_composite(cables)


def draw_trend(draw, f, box, days, totals, model_values, top_models, palette, peak):
    x, y, w, h = box
    cx, cy, cw, ch = x + 76, y + 65, w - 96, h - 105
    ceiling = math.ceil(max(totals.values()) / 100_000_000) * 100_000_000
    for fraction in (0, .5, 1):
        gy = cy + ch * (1 - fraction)
        draw.line((cx, gy, cx + cw, gy), fill=mix(GRID, WHITE, .2), width=2)
        text(draw, f, (cx - 12, gy), fmt_tokens(ceiling * fraction, 0), "tiny_b", NAVY, "rm")
    draw.line((cx, cy, cx, cy + ch), fill=NAVY, width=2)
    draw.line((cx, cy + ch, cx + cw, cy + ch), fill=NAVY, width=2)
    order = ["other", *reversed(top_models)]
    cumulative = [0] * len(days)
    for model in order:
        lower = list(cumulative)
        values = [model_values[day].get(model, 0) for day in days]
        cumulative = [lower[i] + values[i] for i in range(len(days))]
        upper = [(cx + cw * i / max(1, len(days)-1), cy + ch * (1 - value / ceiling)) for i, value in enumerate(cumulative)]
        bottom = [(cx + cw * i / max(1, len(days)-1), cy + ch * (1 - lower[i] / ceiling)) for i in reversed(range(len(days)))]
        draw.polygon(upper + bottom, fill=mix(palette.get(model, "#97A4AA"), WHITE, .1), outline=mix(palette.get(model, "#97A4AA"), NAVY, .18))
    ticks = [days[0]] + [date(days[0].year, month, 1) for month in range(days[0].month + 1, 13) if date(days[0].year, month, 1) <= days[-1]]
    if days[-1].year > days[0].year:
        ticks += [date(days[-1].year, month, 1) for month in range(1, days[-1].month + 1)]
    if ticks and (days[-1] - ticks[-1]).days < 7 and ticks[-1] != days[-1]:
        ticks.pop()
    if not ticks or ticks[-1] != days[-1]:
        ticks.append(days[-1])
    for item in ticks:
        px = cx + cw * (item - days[0]).days / max(1, len(days)-1)
        text(draw, f, (px, cy + ch + 15), f"{item.month:02d}/{item.day:02d}", "mono_small", NAVY, "ma")
    peak_date = date.fromisoformat(peak["date_bj"])
    px = cx + cw * (peak_date - days[0]).days / max(1, len(days)-1)
    py = cy + ch * (1 - int(peak["total_tokens"]) / ceiling)
    draw.ellipse((px-11, py-11, px+11, py+11), fill=RED, outline=WHITE, width=3)
    text(draw, f, (min(cx+cw-8, px+28), max(cy+6, py-12)), f"峰值 {fmt_tokens(peak['total_tokens'], 1)} · {peak_date.month}月{peak_date.day}日", "small_b", NAVY, "la")
    legend_x = x + w - 650
    for index, model in enumerate([*top_models, "other"]):
        lx = legend_x + index * 128
        draw.rectangle((lx, y + 10, lx + 22, y + 27), fill=palette.get(model, "#97A4AA"))
        label = model.replace("gpt-", "").upper() if model != "other" else "其它"
        text(draw, f, (lx + 28, y + 18), label, "tiny_b", NAVY, "lm")


def heat_color(value, maximum):
    if value <= 0:
        return PALE
    fraction = math.sqrt(value / maximum)
    if fraction < .25:
        return mix("#DCE8ED", "#7CAFE8", fraction / .25)
    if fraction < .68:
        return mix("#7CAFE8", COBALT, (fraction-.25)/.43)
    return mix(COBALT, NAVY, (fraction-.68)/.32)


def draw_heatmap(draw, f, box, days, totals):
    x, y, w, h = box
    start = days[0] - timedelta(days=days[0].weekday())
    end = days[-1] + timedelta(days=6-days[-1].weekday())
    weeks = ((end-start).days+1)//7
    label_w, gap = 145, 8
    gx, cell_w, cell_h = x+label_w, (w-label_w)/7, (h-62)/weeks
    maximum = max(totals.values())
    for index, label in enumerate("周一 周二 周三 周四 周五 周六 周日".split()):
        text(draw, f, (gx+index*cell_w+cell_w/2, y+6), label, "small_b", NAVY, "ma")
    for week in range(weeks):
        row_start = start + timedelta(days=week*7)
        row_end = min(row_start+timedelta(days=6), days[-1])
        text(draw, f, (x, y+39+week*cell_h+cell_h/2), f"{row_start.month}/{row_start.day:02d}—{row_end.month}/{row_end.day:02d}", "mono_small", NAVY, "lm")
        for dow in range(7):
            current = row_start + timedelta(days=dow)
            cx, cy = gx+dow*cell_w, y+38+week*cell_h
            in_range = days[0] <= current <= days[-1]
            value = totals.get(current, 0)
            fill = heat_color(value, maximum) if in_range else mix(PALE, WHITE, .45)
            draw.rounded_rectangle((cx+gap/2, cy+3, cx+cell_w-gap/2, cy+cell_h-3), radius=8, fill=fill)
            if in_range:
                foreground = WHITE if value/maximum > .11 else NAVY
                text(draw, f, (cx+14, cy+cell_h/2), f"{current.day:02d}", "tiny_b", foreground, "lm")
                label = "—" if value == 0 else ("<1M" if value < 1_000_000 else fmt_tokens(value, 0))
                text(draw, f, (cx+cell_w-14, cy+cell_h/2), label, "tiny_b", foreground, "rm")
    lx, ly = x+w-360, y-38
    text(draw, f, (lx-45, ly+12), "低", "tiny_b", NAVY, "rm")
    for index in range(8):
        draw.rectangle((lx+index*34, ly, lx+31+index*34, ly+24), fill=heat_color(maximum*(index/7)**2, maximum))
    text(draw, f, (lx+284, ly+12), "高", "tiny_b", NAVY, "lm")


def display_model_rows(model_rows, top_models):
    result, other = [], {"model": "other", **{field: 0 for field in TOKEN_FIELDS}}
    for row in model_rows:
        if row["model"] in top_models:
            result.append(dict(row))
        else:
            for field in TOKEN_FIELDS:
                other[field] += float(row[field]) if field == "api_cost_est" else int(row[field])
    if other["total_tokens"]:
        result.append(other)
    return result


def draw_models(draw, f, box, model_rows, top_models, palette):
    x, y, w, h = box
    rows = display_model_rows(model_rows, top_models)
    total = sum(int(row["total_tokens"]) for row in rows) or 1
    maximum = max(int(row["total_tokens"]) for row in rows)
    row_h = h / len(rows)
    for index, row in enumerate(rows):
        model, yy = row["model"], y+index*row_h
        color = palette.get(model, "#97A4AA")
        label = model.upper() if model != "other" else "其它 / 未定价"
        value, share = int(row["total_tokens"]), int(row["total_tokens"])/total
        draw.line((x, yy+row_h-3, x+w, yy+row_h-3), fill=mix(GRID, WHITE, .15), width=1)
        draw.rectangle((x, yy+12, x+12, yy+row_h-15), fill=color)
        text(draw, f, (x+28, yy+16), label, "h3", NAVY)
        text(draw, f, (x+28, yy+52), f"输入 {fmt_tokens(row['input_tokens'], 2)} · 输出 {fmt_tokens(row['output_tokens'], 2)}", "tiny", MUTED)
        bx, by, bw = x+350, yy+25, w-670
        draw.rounded_rectangle((bx, by, bx+bw, by+28), radius=14, fill=mix(PALE, WHITE, .18))
        draw.rounded_rectangle((bx, by, bx+max(18, bw*value/maximum), by+28), radius=14, fill=color)
        text(draw, f, (bx+bw+25, yy+17), fmt_tokens(value, 2), "mono", NAVY)
        text(draw, f, (bx+bw+180, yy+17), f"{share*100:.1f}%", "mono", color)
        cost = float(row["api_cost_est"])
        text(draw, f, (x+w, yy+51), f"API估算 {fmt_money(cost) if cost else '未定价'}", "tiny_b", color if cost else MUTED, "ra")


def donut(draw, center, radius, values, colors):
    total, start = sum(values) or 1, -90
    cx, cy = center
    for value, color in zip(values, colors):
        end = start + 360*value/total
        draw.pieslice((cx-radius, cy-radius, cx+radius, cy+radius), start=start, end=end, fill=color)
        start = end
    draw.ellipse((cx-radius*.58, cy-radius*.58, cx+radius*.58, cy+radius*.58), fill=WHITE)


def draw_cost(draw, f, box, summary):
    x, y, _, _ = box
    parts = summary["api_cost_parts"]
    values = [float(parts.get("cached_input", 0)), float(parts.get("non_cached_input", 0)), float(parts.get("output", 0))]
    labels, colors = ["缓存输入", "非缓存输入", "输出"], [COBALT, GOLD, RED]
    donut(draw, (x+180, y+185), 154, values, colors)
    text(draw, f, (x+180, y+164), "$", "metric", NAVY, "mm")
    text(draw, f, (x+180, y+224), "API", "tiny_b", MUTED, "mm")
    total = sum(values) or 1
    for index, (label, value, color) in enumerate(zip(labels, values, colors)):
        yy = y+42+index*96
        draw.ellipse((x+388, yy+9, x+418, yy+39), fill=color)
        text(draw, f, (x+438, yy), label, "h3", NAVY)
        text(draw, f, (x+438, yy+43), fmt_money(value), "body_b", color)
        text(draw, f, (x+575, yy+45), f"{value/total*100:.1f}%", "small_b", NAVY)


def draw_efforts(draw, f, box, effort_rows):
    x, y, w, _ = box
    total = sum(int(row["total_tokens"]) for row in effort_rows) or 1
    values = {row["effort"]: int(row["total_tokens"]) for row in effort_rows}
    order = [("ultra", COBALT), ("high", NAVY), ("xhigh", RED), ("medium", GOLD)]
    maximum = max(values.get(name, 0) for name, _ in order) or 1
    rnd = random.Random(556)
    for index, (name, color) in enumerate(order):
        value, yy = values.get(name, 0), y+38+index*82
        text(draw, f, (x, yy+16), name, "h3", NAVY, "lm")
        start_x, end_x = x+142, x+w-102
        length = max(30, (end_x-start_x)*value/maximum)
        for lane in range(18):
            y0 = yy-18+lane*2.1+rnd.uniform(-1.2, 1.2)
            draw.line(cubic((start_x, y0), (start_x+length*.35, y0-12), (start_x+length*.74, y0+15), (start_x+length, y0+rnd.uniform(-7, 7)), 32), fill=mix(color, WHITE, .2+lane/80), width=1)
        text(draw, f, (x+w, yy+16), f"{value/total*100:.1f}%", "mono", color, "rm")


def draw_summary(draw, f, box, summary, daily_rows, model_rows, modes, tools, signals):
    x, y, w, h = box
    end = date.fromisoformat(summary["date_end_bj"])
    daily = {date.fromisoformat(row["date_bj"]): int(row["total_tokens"]) for row in daily_rows}
    last7 = sum(daily.get(end-timedelta(days=index), 0) for index in range(7))
    top = model_rows[0]
    metrics = [("自然日 / 活跃日", f"{summary['natural_days']} / {summary['active_days']}", "日历"), ("最近 7 天", fmt_tokens(last7, 2), "脉冲"), ("峰值日", fmt_tokens(summary['peak_day']['total_tokens'], 1), summary['peak_day']['date_bj'][5:].replace('-', '/')), ("主力模型", f"{int(top['total_tokens'])/int(summary['total_tokens'])*100:.1f}%", top['model'].upper())]
    col_w = w/4
    for index, (label, value, note) in enumerate(metrics):
        xx = x+index*col_w
        if index:
            draw.line((xx, y, xx, y+126), fill=COBALT, width=2)
        text(draw, f, (xx+20, y+2), label, "small_b", NAVY)
        text(draw, f, (xx+20, y+36), value, "metric", NAVY)
        text(draw, f, (xx+20, y+110), note, "tiny_b", RED if index == 2 else MUTED)
    mode_total = sum(int(row["total_tokens"]) for row in modes) or 1
    default_share = next((int(row["total_tokens"])/mode_total for row in modes if row["mode"] == "default"), 0)
    tool_total = sum(int(row["calls"]) for row in tools)
    top_tool = tools[0] if tools else {"category": "—", "calls": 0}
    skill_text = " · ".join(f"{row['signal']} ×{row['mentions']}" for row in signals[:3]) or "未检测到显式技能标记"
    draw.rounded_rectangle((x, y+155, x+w, y+h), radius=18, fill=mix(PALE, WHITE, .34), outline=mix(COBALT, WHITE, .5), width=2)
    text(draw, f, (x+22, y+182), "工作方式", "small_b", NAVY)
    text(draw, f, (x+142, y+182), f"DEFAULT {default_share*100:.1f}%", "small_b", COBALT)
    text(draw, f, (x+390, y+182), f"工具调用 {tool_total:,}", "small_b", NAVY)
    text(draw, f, (x+600, y+182), f"首位 {top_tool['category'].upper()} {int(top_tool['calls']):,}", "small_b", RED)
    text(draw, f, (x+22, y+222), "技能信号", "small_b", NAVY)
    text(draw, f, (x+142, y+222), skill_text, "mono_small", MUTED)


def render(output, summary, model_rows, daily_rows, daily_model_rows, effort_rows, mode_rows, tool_rows, signal_rows):
    if int(summary["natural_days"]) > 112:
        raise SystemExit("Poster range exceeds 112 natural days. Re-run with --days 100 or an explicit shorter date window.")
    f = fonts()
    top_models, palette = palette_and_groups(model_rows)
    days, totals, model_values = build_days(summary, daily_rows, daily_model_rows, top_models)
    image = make_background()
    draw_ticket_and_cables(image, f, summary, top_models, palette)
    draw = ImageDraw.Draw(image)
    distressed(image, (60, 52), "Codex", f["title_en"], NAVY, 101)
    day_label = str(summary["natural_days"])
    distressed(image, (515, 56), day_label, f["title_num"], RED, 102)
    day_width = f["title_num"].getlength(day_label)
    text(draw, f, (535 + day_width, 172), "天", "subtitle", RED, "ls")
    distressed(image, (60, 202), "历史用量图谱", f["title_cn"], NAVY, 103)
    text(draw, f, (64, 350), f"累计消耗 {int(summary['total_tokens'])/100_000_000:.2f}亿 Token", "subtitle", COBALT)
    text(draw, f, (65, 407), f"{summary['date_start_bj'].replace('-', '.')}—{summary['date_end_bj'].replace('-', '.')} · 北京时间聚合", "small_b", NAVY)
    draw.line((575, 422, 1000, 422), fill="#7CAFE8", width=2)
    distressed(image, (64, 444), fmt_tokens(summary["total_tokens"], 2), f["hero"], COBALT, 109)
    text(draw, f, (70, 620), f"输入 {fmt_tokens(summary['input_tokens'], 2)} · 输出 {fmt_tokens(summary['output_tokens'], 2)} · 推理输出 {fmt_tokens(summary['reasoning_output_tokens'], 2)}", "h3", NAVY)
    draw.line((840, 465, 840, 642), fill=NAVY, width=2)
    text(draw, f, (885, 470), "缓存命中率", "body_b", NAVY)
    text(draw, f, (885, 505), f"{summary['cache_share']*100:.2f}%", "metric", COBALT)
    text(draw, f, (1170, 470), "API 等价估算", "body_b", NAVY)
    text(draw, f, (1170, 505), fmt_money(summary["api_cost_est"]), "metric", RED)
    text(draw, f, (1172, 585), "基础文本费率 · 非账单", "tiny_b", MUTED)
    rule(draw, 670)
    section(draw, f, 700, "每日用量 × 模型结构", "北京时间 · 分模型堆叠")
    draw_trend(draw, f, (60, 742, 1375, 330), days, totals, model_values, top_models, palette, summary["peak_day"])
    rule(draw, 1088)
    section(draw, f, 1120, "日期用量热力图", "空白为无记录")
    draw_heatmap(draw, f, (60, 1190, 1375, 740), days, totals)
    rule(draw, 1946)
    section(draw, f, 1978, "模型消耗档案", "TOKEN / 占比 / API 估算")
    draw_models(draw, f, (65, 2030, 1315, 480), model_rows, top_models, palette)
    text(draw, f, (65, 2518), f"未定价模型合计 {fmt_tokens(summary['unknown_pricing_tokens'], 2)}，不计入 API 等价成本。", "tiny_b", MUTED)
    rule(draw, 2550)
    section(draw, f, 2582, "成本构成", "官方基础文本费率 · 未含长上下文与工具费")
    draw_cost(draw, f, (60, 2630, 665, 340), summary)
    draw.line((750, 2630, 750, 2942), fill=COBALT, width=2)
    text(draw, f, (792, 2582), "推理强度", "section", NAVY)
    draw_efforts(draw, f, (792, 2630, 590, 340), effort_rows)
    rule(draw, 2984)
    section(draw, f, 3015, "用量摘要")
    draw_summary(draw, f, (60, 3063, 1375, 245), summary, daily_rows, model_rows, mode_rows, tool_rows, signal_rows)
    text(draw, f, (60, 3342), "来源：Codex 本地 JSONL 聚合｜仅导出结构化用量，不含消息正文、工具参数与真实会话 ID", "tiny", MUTED)
    text(draw, f, (1440, 3342), f"API 费率核验：{summary['pricing_verified_at']}", "tiny_b", NAVY, "ra")
    draw.rectangle((52, 3375, 1448, 3392), fill=COBALT)
    for x in range(58, 1440, 24):
        draw.rectangle((x, 3378, x+10, 3389), fill=WHITE if (x//24)%3 == 0 else mix(COBALT, NAVY, .35))
    poster = output / "codex_historical_usage_atlas.png"
    image.convert("RGB").save(poster, quality=96, dpi=(144, 144))
    return poster


def validate(output, summary, model_rows, daily_rows, daily_model_rows, poster):
    failures = []
    fields = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]
    for field in fields:
        expected = int(summary[field])
        for name, rows in (("models", model_rows), ("days", daily_rows), ("daily_models", daily_model_rows)):
            actual = sum(int(row[field]) for row in rows)
            if actual != expected:
                failures.append(f"{field}/{name}: {actual} != {expected}")
    model_cost = sum(float(row["api_cost_est"]) for row in model_rows)
    if not math.isclose(model_cost, float(summary["api_cost_est"]), abs_tol=.00001):
        failures.append("API cost does not reconcile to model rows")
    with Image.open(poster) as image:
        if image.size != (W, H) or image.mode != "RGB":
            failures.append(f"Unexpected poster format: {image.size} {image.mode}")
        unexpected = {key: value for key, value in image.info.items() if key.lower() not in {"dpi"}}
        if unexpected:
            failures.append(f"Unexpected PNG metadata: {sorted(unexpected)}")
    sensitive = re.compile(r"(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+|auth\.json|session_id|C:\\Users\\)", re.I)
    for path in output.glob("*.json"):
        if path.name == "validation.json":
            continue
        if sensitive.search(path.read_text(encoding="utf-8-sig", errors="replace")):
            failures.append(f"Sensitive pattern in {path.name}")
    for path in output.glob("*.csv"):
        if sensitive.search(path.read_text(encoding="utf-8-sig", errors="replace")):
            failures.append(f"Sensitive pattern in {path.name}")
    digest = hashlib.sha256(poster.read_bytes()).hexdigest().upper()
    result = {
        "status": "passed" if not failures else "failed",
        "poster": str(poster.resolve()),
        "dimensions": [W, H],
        "bytes": poster.stat().st_size,
        "sha256": digest,
        "data_window_bj": [summary["date_start_bj"], summary["date_end_bj"]],
        "total_tokens": summary["total_tokens"],
        "api_cost_est": summary["api_cost_est"],
        "checks": ["aggregate reconciliation", "model/day cube reconciliation", "API cost reconciliation", "PNG format", "sensitive-pattern scan"],
        "failures": failures,
    }
    (output / "validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if failures:
        raise SystemExit(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def parse_args():
    parser = argparse.ArgumentParser(description="Generate a privacy-safe Codex historical usage infographic poster.")
    parser.add_argument("--codex-home", type=Path, default=Path.home() / ".codex")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--days", type=int, default=100, help="Inclusive day window anchored on the latest token event; 0 means all history.")
    parser.add_argument("--from-date", help="Inclusive Beijing-time date, YYYY-MM-DD.")
    parser.add_argument("--to-date", help="Inclusive Beijing-time date, YYYY-MM-DD.")
    parser.add_argument("--pricing", type=Path, default=DEFAULT_PRICING)
    return parser.parse_args()


def main():
    args = parse_args()
    pricing = load_pricing(args.pricing.resolve())
    files, usages, tools, signals = scan_logs(args.codex_home.expanduser().resolve())
    start, end = resolve_window(usages, args)
    payload = aggregate(args.output.resolve(), pricing, files, usages, tools, signals, start, end)
    summary, model_rows, daily_rows, daily_model_rows, effort_rows, mode_rows, tool_rows, signal_rows = payload
    poster = render(args.output.resolve(), *payload)
    result = validate(args.output.resolve(), summary, model_rows, daily_rows, daily_model_rows, poster)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
