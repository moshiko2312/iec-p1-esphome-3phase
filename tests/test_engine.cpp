// Host tests for esphome/common/iec_p1.h (plans + cost engine).
// Build: g++ -std=c++17 -Wall -Wextra -I esphome/common -o /tmp/t tests/test_engine.cpp && /tmp/t
#define IECP1_HOST_TEST
#include "iec_p1.h"

#include <cstdio>

using namespace iecp1;

static int failures = 0;
#define CHECK(cond)                                           \
  do {                                                        \
    if (!(cond)) {                                            \
      std::printf("    FAIL line %d: %s\n", __LINE__, #cond); \
      failures++;                                             \
    }                                                         \
  } while (0)
static bool near(double a, double b, double tol = 0.001) { return std::fabs(a - b) < tol; }

// 2026-11-01 is a Sunday.
static LocalTime at(int day, int hour, int minute, int month = 11, int year = 2026) {
  LocalTime t;
  t.valid = true;
  t.year = year;
  t.month = month;
  t.day = day;
  t.minute = hour * 60 + minute;
  const int32_t dn = days_from_civil(year, month, day);
  t.dow = (int) ((dn + 4) % 7);  // 1970-01-01 was a Thursday
  t.epoch = (uint32_t) dn * 86400u + (uint32_t) t.minute * 60u - 2 * 3600u;  // Israel winter time
  return t;
}

int main() {
  std::printf("1. Calendar helpers\n");
  CHECK(at(1, 12, 0).dow == 0);   // Sunday
  CHECK(at(6, 12, 0).dow == 5);   // Friday
  CHECK(days_in_month(2028, 2) == 29);
  CHECK(days_in_month(2026, 2) == 28);
  CHECK(days_in_month(2026, 11) == 30);

  std::printf("2. Night window 23:00-07:00 Sun-Thu crossing midnight\n");
  const Plan night{"night", 5, 1, {{SUN_TO_THU, 23 * 60, 7 * 60, 20}}};
  CHECK(discount_at(night, 4, 23 * 60 + 30) == 20);  // Thu 23:30
  CHECK(discount_at(night, 5, 2 * 60) == 20);        // Fri 02:00 belongs to Thu
  CHECK(discount_at(night, 5, 23 * 60 + 30) == 5);   // Fri 23:30 not in plan
  CHECK(discount_at(night, 6, 2 * 60) == 5);         // Sat 02:00 belongs to Fri
  CHECK(discount_at(night, 0, 2 * 60) == 5);         // Sun 02:00 belongs to Sat
  CHECK(discount_at(night, 0, 23 * 60) == 20);       // Sun 23:00
  CHECK(discount_at(night, 1, 7 * 60) == 5);         // 07:00 is exclusive
  CHECK(window_label(night.windows[0]) == "\xE2\x81\xA6" "23:00\xE2\x80\x93" "07:00" "\xE2\x81\xA9");

  std::printf("3. Day window, first match wins, weekly average\n");
  const Plan day{"day", 0, 2, {{SUN_TO_THU, 7 * 60, 17 * 60, 15}, {EVERY_DAY, 0, 24 * 60 - 1, 3}}};
  CHECK(discount_at(day, 2, 9 * 60) == 15);
  CHECK(discount_at(day, 6, 9 * 60) == 3);
  const Plan every_night{"n", 0, 1, {{EVERY_DAY, 23 * 60, 7 * 60, 20}}};
  CHECK(near(weekly_average(every_night), 20.0 * 8 / 24));
  const Plan flat{"flat", 7, 0, {}};
  CHECK(near(weekly_average(flat), 7));
  CHECK(match_window(flat, 3, 600) == -1);

  std::printf("4. Engine: first day partial, second day full, third day compares\n");
  Engine e;
  e.set_price(0.5f, 0, 0.5f, "");
  double meter = 1000.0;
  e.on_energy(meter, at(2, 10, 0));          // baseline only
  CHECK(near(e.energy_today(), 0));
  meter += 2.0;
  e.on_energy(meter, at(2, 12, 0));
  CHECK(near(e.energy_today(), 2.0));
  CHECK(near(e.cost_today(), 1.0));
  e.minute_tick(at(3, 0, 0));                // midnight caught on time
  CHECK(near(e.energy_today(), 0));
  CHECK(std::isnan(e.yesterday_so_far(at(3, 0, 0))));  // day 2 was partial
  // Day 3: 1 kWh per hour from 00:00 to 24:00, price 0.5 then 0.4 after 12:00
  for (int h = 1; h <= 24; h++) {
    if (h == 13) e.set_price(0.4f, 20, 0.6352f, "12:00\xE2\x80\x93" "24:00");
    meter += 1.0;
    if (h < 24) {
      e.on_energy(meter, at(3, h, 0));
    } else {
      e.minute_tick(at(4, 0, 0));
      e.on_energy(meter, at(4, 0, 0));
    }
  }
  // 12 kWh at 0.5 + 11 kWh at 0.4 belong to day 3; the 24th hour arrived after midnight.
  CHECK(near(e.energy_month(), 2 + 23 + 1));
  CHECK(near(e.energy_today(), 1.0));
  const float y_noon = e.yesterday_so_far(at(4, 12, 0));
  CHECK(near(y_noon, 12.0, 0.01));
  e.on_energy(meter + 18.0, at(4, 12, 0));   // 1 + 18 = 19 kWh today by noon
  CHECK(near(e.compared_to_yesterday(at(4, 12, 0)), (19.0 - 12.0) / 12.0 * 100.0, 0.5));
  CHECK(std::isnan(e.compared_to_yesterday(at(4, 0, 10))));  // too early in the day
  meter += 18.0;

  std::printf("5. Meter replaced / impossible jump -> baseline only\n");
  const float month_before = e.energy_month();
  e.on_energy(5.0, at(4, 13, 0));
  e.on_energy(5.5, at(4, 13, 1));
  CHECK(near(e.energy_month(), month_before + 0.5));
  CHECK(e.rebaselines() == 1);
  e.on_energy(5.5 + 1000.0, at(4, 13, 2));
  CHECK(near(e.energy_month(), month_before + 0.5));
  CHECK(e.rebaselines() == 2);

  std::printf("6. Peak, cost now, baseload\n");
  e.on_power(0.4f, at(4, 14, 0));
  e.on_power(3.2f, at(4, 14, 7));
  e.on_power(1.0f, at(4, 14, 9));
  CHECK(near(e.peak_kw(), 3.2));
  CHECK(e.peak_time() == "14:07");
  CHECK(near(e.cost_now(), 1.0 * 0.4));
  e.minute_tick(at(4, 14, 10));   // average of the three samples = 1.533
  e.on_power(0.25f, at(4, 15, 0));
  e.minute_tick(at(4, 15, 1));
  CHECK(near(e.baseload(at(4, 15, 2)), 0.25));
  CHECK(near(e.baseload_cost(at(4, 15, 2)), 0.25 * 720 * 0.6352, 0.01));
  CHECK(std::isnan(e.baseload(at(6, 16, 0))));  // older than 24 hours

  std::printf("7. Forecast and month rollover\n");
  CHECK(std::isnan(e.forecast_month(at(1, 12, 0), 31.97f)));  // first day of a month
  const float cm = e.cost_month();
  const float fc = e.forecast_month(at(4, 12, 0), 31.97f);
  CHECK(near(fc, cm / 3.5 * 30 + 31.97, 0.01));
  e.minute_tick(at(1, 0, 0, 12));   // December 1st
  CHECK(near(e.energy_month(), 0));
  CHECK(near(e.cost_month(), 0));

  std::printf("8. Reset Statistics keeps the baseline and lifetime cost\n");
  const float total = e.cost_total();
  e.reset_statistics(at(1, 10, 0, 12));
  CHECK(near(e.energy_today(), 0));
  CHECK(near(e.cost_total(), total));
  e.on_energy(5.5 + 1000.0 + 2.0, at(1, 10, 5, 12));
  CHECK(near(e.energy_today(), 2.0));

  std::printf("9. Stored data with another layout is ignored\n");
  Stats bad = e.stats();
  bad.magic = 0;
  Engine fresh;
  fresh.adopt(bad);
  CHECK(std::isnan(fresh.stats().last_energy));
  fresh.adopt(e.stats());
  CHECK(near(fresh.energy_today(), 2.0));


  std::printf("10. IEC time-of-use: seasons\n");
  const int SEASON_EXPECTED[12] = {0, 0, 1, 1, 1, 2, 2, 2, 2, 1, 1, 0};  // Jan..Dec
  for (int m = 1; m <= 12; m++)
    CHECK(&tou_season(m) == &TOU_SEASONS[SEASON_EXPECTED[m - 1]]);
  CHECK(std::string(tou_season(2).name) == "חורף");
  CHECK(std::string(tou_season(3).name) == "מעבר");
  CHECK(std::string(tou_season(9).name) == "קיץ");
  CHECK(std::string(tou_season(10).name) == "מעבר");
  CHECK(std::string(tou_season(12).name) == "חורף");
  // Current table (Electricity Authority, from 2026-07-01), ILS/kWh incl. VAT
  CHECK(near(TOU_SEASONS[0].off_peak, 0.4663) && near(TOU_SEASONS[0].peak, 1.1470));
  CHECK(near(TOU_SEASONS[1].off_peak, 0.4578) && near(TOU_SEASONS[1].peak, 0.4958));
  CHECK(near(TOU_SEASONS[2].off_peak, 0.5042) && near(TOU_SEASONS[2].peak, 1.7223));

  std::printf("11. IEC time-of-use: peak boundaries\n");
  // dow: 0 = Sunday ... 6 = Saturday
  CHECK(tou_is_peak(1, 6, 18 * 60));            // winter Saturday 18:00 = peak (every day)
  CHECK(tou_is_peak(12, 5, 17 * 60));           // winter Friday 17:00 = peak
  CHECK(!tou_is_peak(1, 2, 16 * 60 + 59));      // winter 16:59 = off-peak
  CHECK(!tou_is_peak(1, 2, 22 * 60));           // winter 22:00 = off-peak (end is exclusive)
  CHECK(tou_is_peak(7, 4, 17 * 60));            // summer Thursday 17:00 = peak
  CHECK(tou_is_peak(7, 4, 22 * 60 + 59));       // summer Thursday 22:59 = peak
  CHECK(!tou_is_peak(7, 4, 23 * 60));           // summer 23:00 = off-peak
  CHECK(!tou_is_peak(7, 5, 18 * 60));           // summer Friday 18:00 = off-peak
  CHECK(!tou_is_peak(8, 6, 20 * 60));           // summer Saturday = off-peak
  CHECK(tou_is_peak(3, 0, 18 * 60));            // transition Sunday 18:00 = peak
  CHECK(!tou_is_peak(11, 6, 18 * 60));          // transition Saturday 18:00 = off-peak
  CHECK(!tou_is_peak(5, 1, 22 * 60 + 30));      // transition 22:30 = off-peak
  CHECK(tou_is_peak(5, 1, 21 * 60 + 59) && !tou_is_peak(6, 1, 23 * 60 + 30));  // May 31 vs June
  CHECK(near(tou_price(7, 3, 18 * 60), TOU_SEASONS[2].peak));
  CHECK(near(tou_price(7, 5, 18 * 60), TOU_SEASONS[2].off_peak));
  CHECK(near(tou_price(1, 6, 18 * 60), TOU_SEASONS[0].peak));

  std::printf("12. IEC time-of-use: labels and weekly average\n");
  CHECK(tou_label(7, 3, 18 * 60) == "שיא " "\xE2\x81\xA6" "17:00\xE2\x80\x93" "23:00" "\xE2\x81\xA9");
  CHECK(tou_label(1, 6, 18 * 60) == "שיא " "\xE2\x81\xA6" "17:00\xE2\x80\x93" "22:00" "\xE2\x81\xA9");
  CHECK(tou_label(7, 3, 10 * 60) == "שפל עד " "\xE2\x81\xA6" "17:00" "\xE2\x81\xA9");
  CHECK(tou_label(7, 3, 23 * 60 + 30) == "שפל מ-" "\xE2\x81\xA6" "23:00" "\xE2\x81\xA9");
  CHECK(tou_label(7, 5, 18 * 60) == "שפל כל היום");
  const double summer = (5 * 6 * TOU_SEASONS[2].peak + (168 - 30) * TOU_SEASONS[2].off_peak) / 168.0;
  CHECK(near(tou_weekly_average(7), summer, 0.0005));
  const double winter = (7 * 5 * TOU_SEASONS[0].peak + (168 - 35) * TOU_SEASONS[0].off_peak) / 168.0;
  CHECK(near(tou_weekly_average(1), winter, 0.0005));
  const Plan tou_plan{"tou", TOU, 0, {}};
  CHECK(is_tou(tou_plan) && !is_tou(flat) && !is_tou(Plan{"c", NAN, 0, {}}));

  std::printf(failures ? "\n%d check(s) FAILED\n" : "\nAll checks passed\n", failures);
  return failures ? 1 : 0;
}
