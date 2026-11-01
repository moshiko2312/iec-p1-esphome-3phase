#!/usr/bin/env python3
"""Generate the supplier-plan tables from plans/israel_electricity_plans.json.

Writes two places, so the firmware and the gold UI always agree:
  esphome/common/plans.yaml   select options + C++ PLANS table
  esphome/ui/app.js           PLAN_META (provider, plan name, hours, percent)
  esphome/common/iec_p1.h     TOU season table, for plans with "special": "tou"

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
HEADER = ROOT / "esphome" / "common" / "iec_p1.h"

FIXED = ["ללא הנחה", "מותאם אישית"]  # always first, in this order
DAY_BITS = {"sun": 0x01, "mon": 0x02, "tue": 0x04, "wed": 0x08, "thu": 0x10, "fri": 0x20, "sat": 0x40}
DAY_HE = {"sun": "א׳", "mon": "ב׳", "tue": "ג׳", "wed": "ד׳", "thu": "ה׳", "fri": "ו׳", "sat": "ש׳"}
ORDERED_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]


def clean(s: str) -> str:
    # ASCII quotes become Hebrew gershayim, so labels stay safe in YAML, C++ and URLs
    return s.strip().replace('"', "״").replace("'", "׳")


# Short names for labels; the research file keeps the full legal names.
SHORT = [
    ("super power", "סופר פאוור"), ("cellcom", "סלקום"), ("bezeq", "בזק"), ("partner", "פרטנר"),
    ("hot", "הוט"), ("amisragas", "אמישראגז"), ("pazgas", "פזגז"), ("israel electric", "חברת החשמל"),
    ("iec", "חברת החשמל"),
]


def provider_of(plan: dict) -> str:
    en = (plan.get("provider_en") or "").lower()
    for key, he in SHORT:
        if en.startswith(key):
            return he
    return clean(plan["provider_he"])


def label_of(plan: dict) -> str:
    return f"{provider_of(plan)} – {clean(plan['plan_he'])}"


ORDINAL = {1: "שנה ראשונה", 13: "שנה שנייה", 25: "משנה שלישית"}


def expand(plan: dict) -> list[dict]:
    """One selectable entry per plan; tenure schedules become one entry per step."""
    sched = plan.get("discount_schedule")
    if not sched:
        return [plan]
    out = []
    for step in sched:
        q = dict(plan)
        q.pop("discount_schedule", None)
        q["discount_pct"] = step["pct"]
        q["plan_he"] = f"{plan['plan_he']} ({ORDINAL.get(step['from_month'], 'מחודש ' + str(step['from_month']))})"
        q["time_limit"] = None
        out.append(q)
    return out


def usable(plan: dict) -> bool:
    """Plans the firmware can price exactly: a percent off the kWh charge."""
    if plan.get("special"):
        return True
    if plan.get("status") == "unverified_current":
        return False          # not offered any more as far as we can tell
    if plan.get("discount_tiers"):
        return False          # depends on the bill total, not on the time of day
    if plan.get("bill_discount") is False:
        return False          # cashback elsewhere, the bill itself is full price
    return (plan.get("discount_pct") or 0) > 0


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
    for raw in data["plans"]:
        if not usable(raw):
            continue
        for p in expand(raw):
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


def cfloat(x: float) -> str:
    """C++ float literal: 21 -> 21.0f, 7.5 -> 7.5f (an integer with an f suffix doesn't compile)."""
    t = f"{x:g}"
    if "." not in t and "e" not in t:
        t += ".0"
    return t + "f"


def yaml_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


SEASONS = ["winter", "transition", "summer"]  # order of TOU_SEASONS in iec_p1.h
SEASON_HE = {"winter": "חורף", "transition": "מעבר", "summer": "קיץ"}


def load_tou() -> dict:
    tou = json.loads(DATA.read_text(encoding="utf-8")).get("tou_tariff")
    if not tou:
        raise SystemExit(f"{DATA}: a plan has \"special\": \"tou\" but there is no tou_tariff section")
    months = sorted(m for s in SEASONS for m in tou["seasons"][s])
    if months != list(range(1, 13)):
        raise SystemExit("tou_tariff.seasons must cover every month exactly once")
    for s in SEASONS:
        wins = tou["peak_windows"][s]
        if len(wins) != 1 or minutes(wins[0]["from"]) >= minutes(wins[0]["to"]):
            raise SystemExit(f"tou_tariff.peak_windows.{s}: the firmware expects one same-day window")
    return tou


def tou_header_block(tou: dict) -> str:
    """The TOU_* constants for iec_p1.h (prices in ILS incl. VAT)."""
    prices = tou["prices_agorot_incl_vat"]
    rows = []
    for s in SEASONS:
        w = tou["peak_windows"][s][0]
        rows.append(
            f'    {{{cxx_str(SEASON_HE[s])}, {prices[s]["off_peak"] / 100:.4f}f, {prices[s]["peak"] / 100:.4f}f, '
            f'0x{days_mask(w["days"]):02X}, {minutes(w["from"])}, {minutes(w["to"])}}},'
        )
    of_month = [next(i for i, s in enumerate(SEASONS) if m in tou["seasons"][s]) for m in range(1, 13)]
    return "\n".join([
        f'constexpr const char *TOU_EFFECTIVE_FROM = {cxx_str(tou["effective_from"])};',
        "constexpr TouSeason TOU_SEASONS[3] = {",
        *rows,
        "};",
        f"constexpr uint8_t TOU_SEASON_OF_MONTH[12] = {{{', '.join(map(str, of_month))}}};",
    ])


def tou_hours(tou: dict) -> str:
    parts = []
    for s in SEASONS:
        w = tou["peak_windows"][s][0]
        parts.append(f"{SEASON_HE[s]} {w['from']}–{w['to']} {days_text(w['days'])}")
    return "שיא: " + "; ".join(parts) + ". מחיר לפי עונה ושעה, בלי הנחה"


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
        special = p.get("special")
        if special == "tou":
            # IEC time-of-use: priced from TOU_SEASONS in iec_p1.h, not by a discount
            opt_lines.append(f'      - {yaml_str(lab)}')
            tbl_lines.append(f'              {{{cxx_str(lab)}, iecp1::TOU, 0, {{}}}},')
            meta[lab] = {"provider": provider_of(p), "plan": clean(p["plan_he"]),
                         "hours": tou_hours(load_tou()), "special": "tou"}
            continue
        if special:
            raise SystemExit(f"{lab}: unknown special plan type {special!r}")
        wins = plan_windows(p)
        base = base_pct(p)
        cw = ", ".join(
            f"{{0x{days_mask(w['days']):02X}, {minutes(w['from'])}, {minutes(w['to'])}, {cfloat(w['pct'])}}}" for w in wins
        )
        opt_lines.append(f'      - {yaml_str(lab)}')
        tbl_lines.append(f'              {{{cxx_str(lab)}, {cfloat(base)}, {len(wins)}, {{{cw}}}}},')
        if wins:
            hours = "; ".join(
                (f"כל היום, {days_text(w['days'])}" if w["from"] == "00:00" and w["to"] == "24:00"
                 else f"{w['from']}–{w['to']} {days_text(w['days'])}")
                for w in wins)
            pcts = sorted({w["pct"] for w in wins})
            pct = "/".join(pct_text(x) for x in pcts)
            if base:
                hours += f"; {pct_text(base)} בשאר השעות"
        else:
            hours, pct = "כל השעות", pct_text(base)
        notes = []
        if p.get("meter") == "smart":
            notes.append("מונה חכם")
        if p.get("excludes_holidays"):
            notes.append("לא בחגים")
        if p.get("monthly_fee_ils"):
            notes.append(f"דמי מנוי ₪{p['monthly_fee_ils']:g} לחודש")
        if p.get("time_limit"):
            notes.append(str(p["time_limit"]))
        if notes:
            hours += f". {', '.join(notes)}"
        meta[lab] = {"provider": provider_of(p), "plan": clean(p["plan_he"]), "hours": hours, "pct": pct}
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

    h = HEADER.read_text(encoding="utf-8")
    h2 = h
    if any(p.get("special") == "tou" for p in plans.values()):
        h2 = replace_between(h, "// BEGIN TOU", "// END TOU", tou_header_block(load_tou()), HEADER)

    changed = (y2 != y) or (js2 != js) or (h2 != h)
    if check:
        if changed:
            raise SystemExit("plan tables are out of date: run tools/gen_plans.py")
        print("plan tables up to date")
        return
    PLANS_YAML.write_text(y2, encoding="utf-8")
    APP_JS.write_text(js2, encoding="utf-8")
    HEADER.write_text(h2, encoding="utf-8")
    ORDER.write_text("\n".join(order) + "\n", encoding="utf-8")
    print(f"{len(order)} plans written ({len(order) - len(FIXED)} from suppliers)")


if __name__ == "__main__":
    main()
