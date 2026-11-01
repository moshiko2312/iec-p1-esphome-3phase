// Mocks for run_lambda_test.py. Mirrors only the ESPHome API the lambdas use.
#define IECP1_HOST_TEST
#include "iec_p1.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#define ESP_LOGW(tag, fmt, ...) std::printf("    [W][%s] " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) std::printf("    [I][%s] " fmt "\n", tag, ##__VA_ARGS__)

struct StringRef {  // same comparisons as esphome::StringRef
  const char *base{nullptr};
  size_t len{0};
  bool empty() const { return len == 0; }
  const char *c_str() const { return base; }
};
inline bool operator==(const StringRef &a, const char *b) { return a.len == strlen(b) && memcmp(a.base, b, a.len) == 0; }

struct MockSensor { float state{NAN}; int n{0}; void publish_state(float v) { state = v; n++; } };
struct MockText { std::string state; void publish_state(const std::string &v) { state = v; } };
struct MockNumber { float state; };
struct MockSwitch { bool state; };
struct MockSelect {
  std::string option;
  StringRef current_option() const { return StringRef{option.c_str(), option.size()}; }
};
struct MockTime { iecp1::LocalTime t; iecp1::LocalTime now() const { return t; } };
namespace iecp1 { inline LocalTime to_local(const LocalTime &t) { return t; } }
struct MockPrefs { int syncs{0}; void sync() { syncs++; } };
// The device build has load()/save(); the host build only needs them to exist.
namespace iecp1 { inline void noop() {} }
#define load() stats()
#define save() stats()

MockSelect *supplier_plan = new MockSelect{"ללא הנחה"};
MockNumber *base_price = new MockNumber{0.6352f}, *fixed_charge = new MockNumber{31.97f},
           *custom_discount = new MockNumber{0}, *custom_window_start = new MockNumber{23},
           *custom_window_end = new MockNumber{7}, *custom_window_discount = new MockNumber{0};
MockSwitch *custom_window_sun_thu = new MockSwitch{false};
MockSensor *price_sensor = new MockSensor, *discount_sensor = new MockSensor, *energy_today = new MockSensor,
           *energy_month = new MockSensor, *cost_today = new MockSensor, *cost_month = new MockSensor,
           *cost_total = new MockSensor, *yesterday_so_far = new MockSensor, *compared_to_yesterday = new MockSensor,
           *cost_now = new MockSensor, *peak_today = new MockSensor, *forecast_month = new MockSensor,
           *baseload = new MockSensor, *baseload_cost = new MockSensor;
MockText *discount_window = new MockText, *peak_time = new MockText;
MockTime *sntp_time = new MockTime;
MockPrefs *global_preferences = new MockPrefs;

// @@LAMBDAS@@

static int failures = 0;
#define CHECK(c) do { if (!(c)) { std::printf("    FAIL line %d: %s\n", __LINE__, #c); failures++; } } while (0)
static bool near(double a, double b) { return std::fabs(a - b) < 0.0005; }

static iecp1::LocalTime at(int dow, int hour, int minute) {
  iecp1::LocalTime t;
  t.valid = true; t.year = 2026; t.month = 11; t.day = 1 + dow; t.dow = dow;
  t.minute = hour * 60 + minute; t.epoch = 1793000000u;
  return t;
}

int main() {
  std::printf("1. No discount\n");
  sntp_time->t = at(4, 23, 30);
  @@UPDATE_PRICE@@(0, 0);
  CHECK(near(price_sensor->state, 0.6352));
  CHECK(discount_sensor->state == 0);
  CHECK(discount_window->state.empty());

  std::printf("2. Custom plan: 5%% always, 20%% 23-07 Sun-Thu\n");
  supplier_plan->option = "מותאם אישית";
  custom_discount->state = 5; custom_window_discount->state = 20; custom_window_sun_thu->state = true;
  @@UPDATE_PRICE@@(0, 0);  // Thursday 23:30
  CHECK(discount_sensor->state == 20);
  CHECK(near(price_sensor->state, 0.6352 * 0.8));
  CHECK(discount_window->state == "23:00\xE2\x80\x93" "07:00");
  sntp_time->t = at(5, 23, 30);  // Friday night: not in the window
  @@UPDATE_PRICE@@(0, 0);
  CHECK(discount_sensor->state == 5);
  CHECK(discount_window->state.empty());

  std::printf("3. Unknown plan label and missing clock\n");
  supplier_plan->option = "לא קיים";
  @@UPDATE_PRICE@@(0, 0);
  CHECK(discount_sensor->state == 0);
  supplier_plan->option = "מותאם אישית";
  sntp_time->t = iecp1::LocalTime{};
  @@UPDATE_PRICE@@(0, 0);
  CHECK(discount_sensor->state == 5);  // base only until the clock is set

  std::printf(failures ? "\n%d check(s) FAILED\n" : "\nAll checks passed\n", failures);
  return failures;
}
