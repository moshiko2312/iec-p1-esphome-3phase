# Israel household electricity plans: notes and open questions

Verified on 2026-11-01. The data is in `israel_electricity_plans.json`. This file covers what is uncertain.

## How sourcing worked

- Most supplier sites are JavaScript-only (Cellcom, Partner, IEC) or block crawlers (HOT, Pazgas campaign pages). Others returned errors (Amisragas, Pazgas). Direct downloads were blocked by this environment's egress policy, so only pages the fetch tool could render were used.
- **Primary sources read (`secondary_only: false`):**
  - Super Power: super-power.co.il, page last modified 2026-10-26.
  - Cellcom Energy: agreement-summary PDFs on contentepi.cellcom.co.il.
  - Bezeq Energy: agreement PDFs v3 (03/2026, smart meter) and v2 (03/26, basic meter), plus the Bezeq blog.
  - Regulated tariffs: Bezeq's tariff appendix "נכון ליום 01/07/2026" and Electricity Authority decisions 63609 and 78206.
- **Secondary only (`secondary_only: true`):**
  - Partner Power, HOT Energy, Amisragas, Pazgas, and Cellcom's 6% fixed plan.
  - Figures come from Supermarker (TheMarker), which says it checked the supplier site and terms on 2026-10-02 and quotes them.
  - They were cross-checked against Kamazeole (2026-10-19/22), Shtipser (2026-09-27), Arbiter (2026-10-23), EasySwitch (09/2026) and SolarIsrael (2026-10-23). All of these agree on every current plan listed.
  - `supplier_reference` holds the supplier URL the secondary source cites, which could not be read here.
- **Cellcom PDFs have no printed date.** Each has a document code of the form `NNNNN-MMYY-01`, such as `18923-0626-01`. That probably means month/year (06/2026), but this is inferred, so `source_date` is null and `source_date_note` explains.

## Market structure

- **Seven household brands are active:** Super Power, Cellcom Energy, Bezeq Energy, Partner Power, HOT Energy, Amisragas Energy and Pazgas.
- **Supergas = Electra Power = Super Power.** The legal entity "אלקטרה פאוור (2019) בע"מ" was formerly "סופרגז אנרגיה בע"מ". It now trades as Super Power (סופר פאוור), also styled Supergas Power, and is part of the Electra group. There is no separate Supergas electricity supplier.
- **Rami Levy Energy** was approved by the Energy Minister (July 2025) but had published no household plans as of late Sept/Oct 2026 (Shtipser, Kamaze).
- **Golan, 019, Ofek, Doral:** no household electricity brand found. "Dorad Energy" (דוראד אנרגיה) is a generator/licensee behind HOT Energy and Pazgas, not a retail brand.

## Window semantics (important for the HA logic)

1. **Crossing midnight.** `sun-thu 23:00-07:00` is anchored to the start day, matching wording like "23:00 עד 07:00 למחרת בימים א'-ה'". No supplier says clearly whether Fri 00:00-07:00 (the tail of Thursday night) is discounted:
   - Partner says the window runs to "07:00 the next day" but also that "Fridays and Saturdays are at full tariff", which contradicts itself.
   - Bezeq's agreement just says "Sun-Thu 23:00-07:00".
   - Suggest making this a toggle: `night_tail_friday: true/false`. The same question applies to Sun 00:00-07:00 (the tail of Saturday night), which the start-day reading excludes.
2. **Holidays.** Only Bezeq excludes holidays and holiday eves explicitly, for its day and night plans.
   - Bezeq's holiday list: Rosh Hashana (2 days), Yom Kippur, Sukkot day 1, Shemini Atzeret, Pesach days 1 and 7, Shavuot, Independence Day.
   - Bezeq does not define the hours of a holiday eve.
   - All other suppliers are silent (`excludes_holidays: null`). Treat a holiday like the weekday it falls on, or offer a toggle.
3. **Cellcom "חסכון משתלם" (7.5%)** applies all hours but only Sun-Thu, written as `00:00-24:00` on sun-thu. Fri/Sat are at full tariff.
4. **Cellcom "חסכון בלילה" (15%)** runs every night including Fri and Sat. This comes from Cellcom's marketing as quoted by three comparison sites. The agreement PDF just says 23:00-07:00 with no day limit.

## Discount mechanics

- Every discount applies to the kWh (energy) charge only. Fixed distribution and supply charges and the kVA capacity charge are always billed in full.
- **Social discount (Super Power):** customers entitled to the IEC social/eligibility discount use it first on the first 400 kWh/month, and the plan discount applies to the rest. Other suppliers don't publish how they combine the two.
- **Partner fixed plan:** 5% in months 1-12, 6% in months 13-24, 7% from month 25 (`discount_schedule`). The HA package needs a "supply start date" input.
- **Cellcom "חשבון קטן הנחה גדולה":** the month's total consumption charge picks one rate for the whole month (10% up to 149 ILS, 8% to 199, 6% to 299, 5% at 300 and above). It is not applied in marginal steps. `discount_pct` = 10 is the maximum; use `discount_tiers`.
- **Pazgas Yellow:** this is cashback to the Yellow app, not a bill discount (`bill_discount: false`, `discount_pct: 0`). Caps are 50 ILS/month and 600 ILS/year, and a quarter with less than 50 ILS accrued is erased.
- **Fees** (`monthly_fee_ils`):
  - Pazgas: 2.90 ILS/month incl. VAT, charged even with zero usage.
  - Partner: 8.10 ILS/month standing-order fee. It is unclear whether credit-card payers pay it.
  - Super Power: its 05/2026 agreement allows an operating fee, but no amount is published.
  - Plan-switch fees: Cellcom 19.90 ILS through a representative; Partner 4.90-59.90 ILS; Super Power and Bezeq free.
- **Plans not available on TOU tariff (תעו"ז):** Bezeq, HOT, Partner, Pazgas and Cellcom windowed plans. Cellcom moves TOU customers to 6% on the generation component.
- **HOT and solar:** HOT plans are not for homes with a solar export meter.

## Conflicts and items needing manual confirmation

| Item | Conflict | What the JSON uses |
|---|---|---|
| HOT "חוסכים קבוע" | Supermarker: 6% for HOT or NEXT TV customers. Arbiter and Kamazeole: also HOT mobile. Kamazeole's headline says 7%. Energycenter mentions "eTriple 10%". Ynet (2025-02) gave 7% triple / 10% quad / 6% NEXT, which is likely old. | 6% |
| Cellcom 6% fixed ("חוסכים קבוע"/"חסכון פלוס") | Listed by ICE (2026-08-02) and EasySwitch (09/2026), but not by Supermarker, Kamazeole or Shtipser in Oct 2026. Ynet 2025: 5% then 6%. | `status: unverified_current`; probably legacy |
| Cellcom "חשבון קטן הנחה גדולה" | Cellcom still hosts the PDF (undated) and Ynet mentioned it 2026-05-03. Missing from all October 2026 lists, and Kamazeole's plan URL now shows the 4 current plans. | `status: unverified_current`; PDF says a continuous (smart) meter is required |
| Cellcom "חסכון משתלם" meter | Supermarker and Shtipser: basic meter OK. Kamazeole: smart only. The PDF does not require a continuous meter (unlike Cellcom's windowed plans). | `meter: any` |
| Super Power POWER duration | Kamazeole says 6.5% "for the first year". The supplier site says "הנחה קבועה (24/7)" with no limit. | `time_limit: null` |
| Super Power seasonal plans | Summer 2026 had a "שעון קיץ" plan: 21%, Sun-Thu, 20:00-02:00 per ICE 2026-07-28 (Ynet 2026-05-03 says 23:00-02:00). Ynet also mentioned a 12% plan, 06:00-18:00, 7 days a week, for online sign-ups. Neither is on super-power.co.il as of 2026-10-26. The 10X10 plan (10%, 10:00-22:00, Sun-Thu) appears to be the current online-only plan. | Not included as plans |
| Ynet 2026-05-03 hours for Super Power day/night | The article swaps the hours ("17:00-7:00" for day). | Ignored; supplier site is authoritative |
| Cellcom family plan days | ICE (2026-08) says "daily". The PDF and Supermarker say Sun-Thu. | Sun-Thu |
| Amisragas gas-customer definition | Only from Poenta (2025-03) and Arbiter (2026-10): central gas in the building, or cylinders ordered in the last 1.5 years. Amisragas pages could not be fetched. | As stated |

## Regulated tariff (IEC / Electricity Authority)

- **Flat household rate from 2026-07-01:** 53.83 ag/kWh excl. VAT, so 63.52 ag/kWh incl. 18% VAT.
  - Source: Bezeq's appendix reproducing the Authority tariff book. Supermarker shows the same.
  - The Jan-Jun 2026 rate was 54.51 excl. VAT (decision 78206, appendix E).
  - Tariffs update every 1 Jan and 1 Jul, so the next change is expected 2027-01-01.
- **Fixed charge** is per month; a bi-monthly bill shows about 2x.
  - Single-phase: 9.97 + 15.60 = 25.57 ILS excl. VAT (30.17 incl.).
  - Three-phase below 3x100A: 11.56 + 15.53 = 27.09 excl. VAT (31.97 incl.).
  - Capacity: 6.18 ILS per kVA per year excl. VAT (7.29 incl.), times connection size.
- **TOU (תעו"ז):** there is no separate household TOU product.
  - Households may opt in to the low-voltage TOU (2 blocks: peak and off-peak).
  - Seasons: winter = Dec-Feb; transition = Mar-May and Oct-Nov; summer = Jun-Sep.
  - Peak hours: winter 17:00-22:00 every day; transition 17:00-22:00 Sun-Thu; summer 17:00-23:00 Sun-Thu. Everything else is off-peak.
  - Prices: see JSON (summer peak 172.23 ag incl. VAT; transition off-peak 45.78 ag).
  - TOU fixed charge is higher: 56.21 ILS/month incl. VAT for connections below 3x100A.
  - The winter Friday/Saturday hours rest on Supermarker and water-energy.co.il (citing tariff book table 5.1-1). The underlying decision 63609 lists a separate Friday winter peak (16:00-21:00) in its table, but its text says that was merged into 17:00-22:00.
  - The July 2026 tariff book PDF exists on gov.il, but its tables could not be extracted with the tools available.
- The tariff book lists a section 5.5 "תעו"ז לסקטור הביתי" and a table 5.2-2 "תעו"ז פשוט ... וולונטרי". Their contents could not be read, so it is not confirmed whether 5.5 holds anything beyond the voluntary low-voltage TOU.
