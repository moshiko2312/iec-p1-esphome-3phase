#!/usr/bin/env python3
"""Generate the supplier-plan tables from plans/israel_electricity_plans.json.

Writes two places, so the firmware and the gold UI always agree:
  esphome/common/plans.yaml   select options + C++ PLANS table
  esphome/ui/app.js           PLAN_META (provider, plan name, hours, percent)

The device stores the chosen plan by its position in the list, so plans are
only ever appended: the order is fixed in plans/order.txt (one label per line).
New labels are added at the end of that file automatically; a label that
disappears from the JSON is kept as "(הופסק)" so positions don't shift.

Usage: python3 tools/gen_plans.py [--check]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "plans" / "israel_electricity_plans.json"
ORDER = ROOT / "plans" / "order.txt"
PLANS_YAML = ROOT / "esphome" / "common" / "plans.yaml"
APP_JS = ROOT / "esphome" / "ui" / "app.js"

FIXED = ["ללא הנחה", "מותאם אישית"]  # always first, in this order
DAY_BITS = {"sun": 0x01, "mon": 0x02, "tue": 0x04, "wed": 0x08, "thu": 0x10, "fri": 0x20, "sat": 0x40}
DAY_HE = {"sun": "א׳", "mon": "ב׳", "tue": "ג׳", "wed": "ד׳", "thu": "ה׳", "fri": "ו׳", "sat": "ש׳"}
ORDERED_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]


def clean(s: str) -> str:
    # ASCII quotes become Hebrew gershayim, so labels stay safe in YAML, C++ and URLs
    return s.strip().replace('"', "״").replace("'", "׳")


def label_of(plan: dict) -> str:
    return f"{clean(plan['provider_he'])} – {clean(plan['plan_he'])}"


def minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def days_mask(days: list[str]) -> int:
    mask = 0
    for d in days:
        mask |= DAY_BITS[d.lower()[:3]]
    return mask


def days_text(days: list[str]) -> str:
    idx = sorted(ORDERED_DAYS.index(d.lower()[:3]) for d in days)
    if len(idx) == 7:
        return "כל יום"
    # contiguous run like Sun–Thu
    if idx == list(range(idx[0], idx[-1] + 1)) and len(idx) > 2:
        return f"{DAY_HE[ORDERED_DAYS[idx[0]]]}–{DAY_HE[ORDERED_DAYS[idx[-1]]]}"
    return ", ".join(DAY_HE[ORDERED_DAYS[i]] for i in idx)


def pct_text(p: float) -> str:
    return f"{p:g}%"


def plan_windows(plan: dict) -> list[dict]:
    """Normalise to [{days, from, to, pct}], each window carrying its own percent."""
    out = []
    for w in plan.get("windows") or []:
        out.append({
            "days": w.get("days") or ORDERED_DAYS,
            "from": w["from"],
            "to": w["to"],
            "pct": float(w.get("discount_pct", plan["discount_pct"])),
        })
    if len(out) > 3:
        raise SystemExit(f"{label_of(plan)}: more than 3 windows, the firmware table holds 3")
    return out


def base_pct(plan: dict) -> float:
    """Discount outside the windows: the flat percent for all-hours plans, else 0 unless given."""
    if not plan.get("windows"):
        return float(plan["discount_pct"])
    return float(plan.get("base_pct", 0))


def load() -> tuple[list[str], dict[str, dict]]:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    plans = {}
    for p in data["plans"]:
        if p.get("discount_pct") is None:
            continue  # nothing to compute with
        lab = label_of(p)
        if lab in plans:
            raise SystemExit(f"duplicate plan label: {lab}")
        plans[lab] = p

    order = [l.strip() for l in ORDER.read_text(encoding="utf-8").splitlines() if l.strip()] if ORDER.exists() else []
    order = [l for l in order if l not in FIXED]
    for lab in plans:
        if lab not in order:
            order.append(lab)
    return FIXED + order, plans


def cxx_str(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def yaml_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def build(order: list[str], plans: dict[str, dict]) -> tuple[str, str, str, dict]:
    opt_lines, tbl_lines, meta = [], [], {}
    for lab in order:
        if lab == "ללא הנחה":
            opt_lines.append(f'      - {yaml_str(lab)}')
            tbl_lines.append(f'              {{{cxx_str(lab)}, 0, 0, {{}}}},')
            continue
        if lab == "מותאם אישית":
            opt_lines.append(f'      - {yaml_str(lab)}')
            tbl_lines.append(f'              {{{cxx_str(lab)}, NAN, 0, {{}}}},')
            meta[lab] = {"plan": lab, "hours": "הנחה ושעות שתגדיר בעצמך"}
            continue
        p = plans.get(lab)
        if p is None:
            # discontinued: keep the slot, no discount
            shown = f"{lab} (הופסק)"
            opt_lines.append(f'      - {yaml_str(shown)}')
            tbl_lines.append(f'              {{{cxx_str(shown)}, 0, 0, {{}}}},')
            meta[shown] = {"provider": lab.split(" – ")[0], "plan": lab.split(" – ", 1)[-1] + " (הופסק)"}
            continue
        wins = plan_windows(p)
        base = base_pct(p)
        cw = ", ".join(
            f"{{0x{days_mask(w['days']):02X}, {minutes(w['from'])}, {minutes(w['to'])}, {w['pct']:g}f}}" for w in wins
        )
        opt_lines.append(f'      - {yaml_str(lab)}')
        tbl_lines.append(f'              {{{cxx_str(lab)}, {base:g}f, {len(wins)}, {{{cw}}}}},')
        if wins:
            hours = "; ".join(f"{w['from']}–{w['to']} {days_text(w['days'])}" for w in wins)
            pcts = sorted({w["pct"] for w in wins})
            pct = "/".join(pct_text(x) for x in pcts)
            if base:
                hours += f"; {pct_text(base)} בשאר השעות"
        else:
            hours, pct = "כל השעות", pct_text(base)
        if p.get("time_limit"):
            hours += f" ({p['time_limit']})"
        meta[lab] = {"provider": clean(p["provider_he"]), "plan": clean(p["plan_he"]), "hours": hours, "pct": pct}
    return "\n".join(opt_lines), "\n".join(tbl_lines), json.dumps(meta, ensure_ascii=False, indent=2), meta


def replace_between(text: str, start: str, end: str, body: str, path: Path) -> str:
    pat = re.compile(rf"(^[ \t]*{re.escape(start)}[^\n]*\n)(.*?)(^[ \t]*{re.escape(end)})", re.S | re.M)
    if not pat.search(text):
        raise SystemExit(f"{path}: markers {start} / {end} not found")
    return pat.sub(lambda m: m.group(1) + body + "\n" + m.group(3), text, count=1)


def main() -> None:
    check = "--check" in sys.argv
    order, plans = load()
    opts, table, meta_json, _ = build(order, plans)

    y = PLANS_YAML.read_text(encoding="utf-8")
    y2 = replace_between(y, "# BEGIN PLANS", "# END PLANS", opts, PLANS_YAML)
    y2 = replace_between(y2, "// BEGIN PLANS", "// END PLANS", table, PLANS_YAML)

    js = APP_JS.read_text(encoding="utf-8")
    js2 = re.sub(
        r"(/\* BEGIN PLANS[^\n]*\*/\n).*?(\n/\* END PLANS \*/)",
        lambda m: m.group(1) + f"const PLAN_META = {meta_json};" + m.group(2),
        js, count=1, flags=re.S,
    )

    changed = (y2 != y) or (js2 != js)
    if check:
        if changed:
            raise SystemExit("plan tables are out of date: run tools/gen_plans.py")
        print("plan tables up to date")
        return
    PLANS_YAML.write_text(y2, encoding="utf-8")
    APP_JS.write_text(js2, encoding="utf-8")
    ORDER.write_text("\n".join(order) + "\n", encoding="utf-8")
    print(f"{len(order)} plans written ({len(order) - len(FIXED)} from suppliers)")


if __name__ == "__main__":
    main()
