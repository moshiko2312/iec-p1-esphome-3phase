// IEC P1 reader - on-device cost engine and supplier plan evaluation.
//
// Everything here is plain C++ so it can be unit-tested on a PC
// (tests/test_engine.cpp defines IECP1_HOST_TEST). On the device ESPHome
// includes this header after its own, and the YAML lambdas call iecp1::engine().
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>

#ifndef IECP1_HOST_TEST
#include "esphome/core/preferences.h"
#include "esphome/core/time.h"
#endif

namespace iecp1 {

// ---------------------------------------------------------------------------
// Supplier plans
// ---------------------------------------------------------------------------
// days: bitmask, Sunday = bit 0 ... Saturday = bit 6 (Sun-Thu = 0x1F, every day = 0x7F).
// from_min / to_min: minutes after midnight, to_min is exclusive. When from_min > to_min
// the window crosses midnight, and its part after midnight belongs to the day it started.
struct Window {
  uint8_t days;
  uint16_t from_min;
  uint16_t to_min;
  float pct;
};

// base_pct: discount outside every window. The first matching window wins.
struct Plan {
  const char *label;
  float base_pct;
  uint8_t count;
  Window windows[3];
};

constexpr uint8_t SUN_TO_THU = 0x1F;
constexpr uint8_t EVERY_DAY = 0x7F;

// dow: 0 = Sunday ... 6 = Saturday. minute: 0..1439. Returns the window index or -1.
inline int match_window(const Plan &plan, int dow, int minute) {
  for (int i = 0; i < plan.count && i < 3; i++) {
    const Window &w = plan.windows[i];
    if (w.from_min == w.to_min)
      continue;
    const bool today = (w.days >> dow) & 1;
    const bool yesterday = (w.days >> ((dow + 6) % 7)) & 1;
    if (w.from_min < w.to_min) {
      if (today && minute >= w.from_min && minute < w.to_min)
        return i;
    } else {
      if (today && minute >= w.from_min)
        return i;
      if (yesterday && minute < w.to_min)
        return i;
    }
  }
  return -1;
}

inline float discount_at(const Plan &plan, int dow, int minute) {
  const int i = match_window(plan, dow, minute);
  return i >= 0 ? plan.windows[i].pct : plan.base_pct;
}

// Time-weighted average discount over a week (15-minute steps). Used to price
// the always-on baseload, which runs through every window.
inline float weekly_average(const Plan &plan) {
  double total = 0;
  for (int slot = 0; slot < 7 * 96; slot++)
    total += discount_at(plan, slot / 96, (slot % 96) * 15);
  return (float) (total / (7 * 96));
}

// "23:00–07:00"
inline std::string window_label(const Window &w) {
  char buf[24];
  snprintf(buf, sizeof(buf), "%02u:%02u\xE2\x80\x93%02u:%02u", w.from_min / 60, w.from_min % 60, w.to_min / 60,
           w.to_min % 60);
  return buf;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------
// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
inline int32_t days_from_civil(int y, int m, int d) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned) (y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int32_t) doe - 719468;
}

inline int days_in_month(int y, int m) {
  static const int DAYS[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (m == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0))
    return 29;
  return DAYS[(m - 1) % 12];
}

// Local wall-clock time, independent of ESPHome so the engine can be tested.
struct LocalTime {
  bool valid{false};
  int year{0}, month{0}, day{0};
  int dow{0};       // 0 = Sunday
  int minute{0};    // minutes after midnight
  int second{0};
  uint32_t epoch{0};  // UTC seconds

  int32_t day_number() const { return days_from_civil(year, month, day); }
  int32_t month_key() const { return year * 12 + (month - 1); }
};

#ifndef IECP1_HOST_TEST
inline LocalTime to_local(const esphome::ESPTime &t) {
  LocalTime lt;
  lt.valid = t.is_valid();
  if (!lt.valid)
    return lt;
  lt.year = t.year;
  lt.month = t.month;
  lt.day = t.day_of_month;
  lt.dow = t.day_of_week - 1;
  lt.minute = t.hour * 60 + t.minute;
  lt.second = t.second;
  lt.epoch = (uint32_t) t.timestamp;
  return lt;
}
#endif

// ---------------------------------------------------------------------------
// Cost engine
// ---------------------------------------------------------------------------
constexpr int SLOTS = 96;                   // 15-minute slots per day
constexpr double MAX_STEP_KWH = 500.0;      // a larger jump is a meter change, not consumption
constexpr float MIN_COMPARE_KWH = 0.3f;     // below this, "compared to yesterday" is noise

// Everything that survives a reboot. Plain data: saved to flash as one blob.
struct Stats {
  uint32_t magic;
  int32_t day_number;   // local day of the figures below, 0 = not started
  int32_t month_key;    // year * 12 + month - 1
  double last_energy;   // last Energy Total reading, NAN = no baseline yet
  double energy_today, energy_month, cost_today, cost_month, cost_total;
  uint8_t today_full;       // today has been followed since midnight
  uint8_t yesterday_valid;  // yesterday was followed for the whole day
  int16_t peak_minute;      // -1 = none
  float peak_kw;
  float today_profile[SLOTS];      // kWh used today by the end of each slot, NAN = not reached
  float yesterday_profile[SLOTS];  // same for yesterday
  float hour_min[24];              // lowest 1-minute average power per hour (kW)
  uint32_t hour_stamp[24];         // which hour (UTC epoch / 3600) each entry belongs to
};

constexpr uint32_t STATS_MAGIC = 0x49454331;  // "IEC1", bump when Stats changes

class Engine {
 public:
  Engine() { this->clear_all_(); }

  // ---- inputs -------------------------------------------------------------
  void set_price(float price, float discount, float weekly_avg_discount, const std::string &window) {
    this->price_ = price;
    this->discount_ = discount;
    this->weekly_avg_discount_ = weekly_avg_discount;
    this->window_ = window;
  }

  // Call on every Energy Total reading (kWh).
  void on_energy(double kwh, const LocalTime &t) {
    this->check_rollover(t);
    if (std::isnan(kwh))
      return;
    Stats &s = this->s_;
    if (!std::isnan(s.last_energy)) {
      const double delta = kwh - s.last_energy;
      if (delta < 0 || delta > MAX_STEP_KWH) {
        this->rebaselines_++;
      } else if (delta > 0) {
        s.energy_today += delta;
        s.energy_month += delta;
        if (!std::isnan(this->price_)) {
          const double cost = delta * this->price_;
          s.cost_today += cost;
          s.cost_month += cost;
          s.cost_total += cost;
        }
      }
    }
    s.last_energy = kwh;
    // A reading at 12:00 is the energy at the end of the 11:45-12:00 slot.
    if (t.valid && s.day_number != 0)
      this->record_profile_((t.minute + 14) / 15 - 1);
  }

  // Call on every Power reading (kW).
  void on_power(float kw, const LocalTime &t) {
    if (std::isnan(kw))
      return;
    this->power_ = kw;
    this->minute_sum_ += kw;
    this->minute_count_++;
    if (kw > this->s_.peak_kw || this->s_.peak_minute < 0) {
      this->s_.peak_kw = kw;
      this->s_.peak_minute = t.valid ? (int16_t) t.minute : (int16_t) -1;
    }
  }

  // Call once a minute (and once when the clock first syncs).
  void minute_tick(const LocalTime &t) {
    this->check_rollover(t);
    if (!t.valid)
      return;
    if (this->minute_count_ > 0) {
      const float avg = (float) (this->minute_sum_ / this->minute_count_);
      const uint32_t hour = t.epoch / 3600;
      const int idx = hour % 24;
      if (this->s_.hour_stamp[idx] != hour || std::isnan(this->s_.hour_min[idx])) {
        this->s_.hour_stamp[idx] = hour;
        this->s_.hour_min[idx] = avg;
      } else if (avg < this->s_.hour_min[idx]) {
        this->s_.hour_min[idx] = avg;
      }
    }
    this->minute_sum_ = 0;
    this->minute_count_ = 0;
  }

  // Midnight and first-of-month resets. Returns true when the day changed.
  bool check_rollover(const LocalTime &t) {
    if (!t.valid)
      return false;
    Stats &s = this->s_;
    const int32_t day = t.day_number();
    if (s.day_number == 0) {  // first run ever (or after a reset of the stored data)
      s.day_number = day;
      s.month_key = t.month_key();
      s.today_full = 0;
      return false;
    }
    if (day == s.day_number)
      return false;

    const bool consecutive = day == s.day_number + 1;
    if (consecutive && s.today_full) {
      this->fill_profile_to_(SLOTS - 1);
      memcpy(s.yesterday_profile, s.today_profile, sizeof(s.today_profile));
      s.yesterday_valid = 1;
    } else {
      s.yesterday_valid = 0;
    }
    s.energy_today = 0;
    s.cost_today = 0;
    for (float &v : s.today_profile)
      v = NAN;
    s.peak_kw = 0;
    s.peak_minute = -1;
    // Today is complete only if the change was caught right at midnight.
    s.today_full = t.minute < 5 ? 1 : 0;
    if (t.month_key() != s.month_key) {
      s.energy_month = 0;
      s.cost_month = 0;
      s.month_key = t.month_key();
    }
    s.day_number = day;
    return true;
  }

  // "Reset Statistics": clears today, month, yesterday, peak and baseload.
  // The meter baseline and the lifetime cost total are kept.
  void reset_statistics(const LocalTime &t) {
    const double last = this->s_.last_energy;
    const double total = this->s_.cost_total;
    this->clear_all_();
    this->s_.last_energy = last;
    this->s_.cost_total = total;
    this->minute_sum_ = 0;
    this->minute_count_ = 0;
    this->check_rollover(t);
  }

  // ---- outputs ------------------------------------------------------------
  float price() const { return this->price_; }
  float discount() const { return this->discount_; }
  const std::string &window() const { return this->window_; }
  float energy_today() const { return (float) this->s_.energy_today; }
  float energy_month() const { return (float) this->s_.energy_month; }
  float cost_today() const { return (float) this->s_.cost_today; }
  float cost_month() const { return (float) this->s_.cost_month; }
  float cost_total() const { return (float) this->s_.cost_total; }
  float peak_kw() const { return this->s_.peak_minute < 0 ? NAN : this->s_.peak_kw; }
  int rebaselines() const { return this->rebaselines_; }

  std::string peak_time() const {
    if (this->s_.peak_minute < 0)
      return "";
    char buf[12];
    snprintf(buf, sizeof(buf), "%02d:%02d", this->s_.peak_minute / 60, this->s_.peak_minute % 60);
    return buf;
  }

  float cost_now() const {
    if (std::isnan(this->power_) || std::isnan(this->price_))
      return NAN;
    return this->power_ * this->price_;
  }

  // Yesterday's consumption from midnight up to the same time of day.
  float yesterday_so_far(const LocalTime &t) const {
    if (!t.valid || !this->s_.yesterday_valid)
      return NAN;
    const int slot = t.minute / 15;
    const float prev = slot > 0 ? this->s_.yesterday_profile[slot - 1] : 0.0f;
    const float end = this->s_.yesterday_profile[slot];
    if (std::isnan(prev) || std::isnan(end))
      return NAN;
    const float frac = ((t.minute % 15) * 60 + t.second) / 900.0f;
    return prev + (end - prev) * frac;
  }

  float compared_to_yesterday(const LocalTime &t) const {
    const float y = this->yesterday_so_far(t);
    if (std::isnan(y) || y < MIN_COMPARE_KWH)
      return NAN;
    return (float) ((this->s_.energy_today - y) / y * 100.0);
  }

  // Consumption cost so far projected to the end of the month, plus the fixed charge.
  float forecast_month(const LocalTime &t, float fixed_charge) const {
    if (!t.valid)
      return NAN;
    const double elapsed = (t.day - 1) + t.minute / 1440.0;
    if (elapsed < 1.0)
      return NAN;  // not enough of the month yet
    const double projected = this->s_.cost_month / elapsed * days_in_month(t.year, t.month);
    return (float) (projected + (std::isnan(fixed_charge) ? 0 : fixed_charge));
  }

  // Lowest 1-minute average power in the last 24 hours (kW).
  float baseload(const LocalTime &t) const {
    if (!t.valid)
      return NAN;
    const uint32_t hour = t.epoch / 3600;
    float best = NAN;
    for (int i = 0; i < 24; i++) {
      const uint32_t stamp = this->s_.hour_stamp[i];
      if (stamp == 0 || stamp + 24 <= hour || std::isnan(this->s_.hour_min[i]))
        continue;
      if (std::isnan(best) || this->s_.hour_min[i] < best)
        best = this->s_.hour_min[i];
    }
    return best;
  }

  // A 30-day month at the baseload, at the plan's week-average price.
  float baseload_cost(const LocalTime &t, float base_price) const {
    const float b = this->baseload(t);
    if (std::isnan(b) || std::isnan(base_price))
      return NAN;
    return b * 720.0f * base_price * (1.0f - this->weekly_avg_discount_ / 100.0f);
  }

  // ---- persistence ----------------------------------------------------------
  Stats &stats() { return this->s_; }

  // Takes stored data if it has the right layout.
  void adopt(const Stats &stored) {
    if (stored.magic == STATS_MAGIC)
      this->s_ = stored;
  }

#ifndef IECP1_HOST_TEST
  void load() {
    this->pref_ = esphome::global_preferences->make_preference<Stats>(PREF_KEY, true);
    Stats stored{};
    if (this->pref_.load(&stored))
      this->adopt(stored);
    this->saved_ = this->s_;
  }
  // Queues a write when something changed; ESPHome commits it at flash_write_interval.
  void save() {
    if (memcmp(&this->saved_, &this->s_, sizeof(Stats)) == 0)
      return;
    if (this->pref_.save(&this->s_))
      this->saved_ = this->s_;
  }
#endif

 protected:
  static constexpr uint32_t PREF_KEY = 0x1EC1A0B5;

  void clear_all_() {
    memset(&this->s_, 0, sizeof(Stats));
    Stats &s = this->s_;
    s.magic = STATS_MAGIC;
    s.last_energy = NAN;
    s.peak_minute = -1;
    for (int i = 0; i < SLOTS; i++) {
      s.today_profile[i] = NAN;
      s.yesterday_profile[i] = NAN;
    }
    for (float &v : s.hour_min)
      v = NAN;
  }

  // Carry the last known value forward so the profile never has holes.
  void fill_profile_to_(int slot) {
    float last = 0;
    for (int i = 0; i <= slot && i < SLOTS; i++) {
      if (std::isnan(this->s_.today_profile[i]))
        this->s_.today_profile[i] = last;
      else
        last = this->s_.today_profile[i];
    }
  }

  void record_profile_(int slot) {
    if (slot < 0 || slot >= SLOTS)
      return;
    if (slot > 0)
      this->fill_profile_to_(slot - 1);
    this->s_.today_profile[slot] = (float) this->s_.energy_today;
  }

  Stats s_;
  float price_{NAN};
  float discount_{0};
  float weekly_avg_discount_{0};
  std::string window_;
  float power_{NAN};
  double minute_sum_{0};
  uint32_t minute_count_{0};
  int rebaselines_{0};
#ifndef IECP1_HOST_TEST
  esphome::ESPPreferenceObject pref_;
  Stats saved_{};
#endif
};

inline Engine &engine() {
  static Engine instance;
  return instance;
}

}  // namespace iecp1
