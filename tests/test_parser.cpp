// Host test harness for the P1 parser. run_parser_test.py pastes the lambda body
// from esphome/common/p1.yaml in place of the LAMBDA_BODY marker below.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

#define ESP_LOGW(tag, fmt, ...) std::printf("    [W][%s] " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) std::printf("    [I][%s] " fmt "\n", tag, ##__VA_ARGS__)

static uint32_t now_ms = 1000;
uint32_t millis() { return now_ms; }

namespace sensor {
struct Sensor {
  const char *name;
  float state{NAN};
  bool has{false};
  int publishes{0};
  explicit Sensor(const char *n) : name(n) {}
  void publish_state(float v) { state = v; has = true; publishes++; }
  bool has_state() const { return has; }
};
}  // namespace sensor

namespace binary_sensor {
struct BinarySensor {
  bool state{false};
  bool has{false};
  int publishes{0};
  void publish_state(bool v) { state = v; has = true; publishes++; }
  bool has_state() const { return has; }
};
}  // namespace binary_sensor

struct MockUart {
  std::deque<uint8_t> rx;
  int available() const { return (int) rx.size(); }
  bool read_byte(uint8_t *c) {
    if (rx.empty()) return false;
    *c = rx.front();
    rx.pop_front();
    return true;
  }
  void feed(const std::string &s) { rx.insert(rx.end(), s.begin(), s.end()); }
};

#define S(x) sensor::Sensor *x = new sensor::Sensor(#x)
S(energy_t1); S(energy_t2); S(energy_t3); S(export_t1); S(export_t2); S(export_t3);
S(energy_total); S(export_total); S(tariff); S(power); S(power_export);
S(power_l1); S(power_l2); S(power_l3); S(voltage_l1); S(voltage_l2); S(voltage_l3);
S(current_l1); S(current_l2); S(current_l3); S(p1_crc_errors);
binary_sensor::BinarySensor *p1_data = new binary_sensor::BinarySensor();
MockUart *uart_p1 = new MockUart();

static std::vector<sensor::Sensor *> all_values() {
  return {energy_t1, energy_t2, energy_t3, export_t1, export_t2, export_t3, energy_total, export_total,
          tariff, power, power_export, power_l1, power_l2, power_l3, voltage_l1, voltage_l2, voltage_l3,
          current_l1, current_l2, current_l3};
}

void tick() {
// @@LAMBDA_BODY@@
}

// ---------------------------------------------------------------------------
static int failures = 0;
#define CHECK(cond)                                                    \
  do {                                                                 \
    if (!(cond)) {                                                     \
      std::printf("    FAIL line %d: %s\n", __LINE__, #cond);          \
      failures++;                                                      \
    }                                                                  \
  } while (0)
static bool near(float a, float b) { return std::fabs(a - b) < 0.0005f; }

static uint16_t crc16(const std::string &s) {
  uint16_t crc = 0;
  for (unsigned char ch : s) {
    crc ^= ch;
    for (int b = 0; b < 8; b++) crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
  }
  return crc;
}
static std::string lines(const std::vector<std::string> &v) {
  std::string out;
  for (auto &l : v) out += l + "\r\n";
  return out;
}
// Builds a telegram with a correct CRC footer from body lines (header included).
static std::string with_crc(const std::vector<std::string> &body) {
  std::string t = lines(body) + "!";
  char footer[8];
  std::snprintf(footer, sizeof(footer), "%04X\r\n", crc16(t));
  return t + footer;
}
static void reset_values() {
  for (auto *s : all_values()) { s->state = NAN; s->has = false; s->publishes = 0; }
}
static void run_all() {
  for (int i = 0; i < 5; i++) tick();
}

// Real telegram from a Kaifa MA110M (klimofey/iec-p1-esphome README). Footer 05F2.
static const std::string REAL_TELEGRAM = lines({
    "/KFM5KAIFA-METER",
    "",
    "1-3:0.2.8(50)",
    "0-0:1.0.0(251207001548W)",
    "0-0:96.1.1(K06725)",
    "1-0:1.8.11(000849.710*kWh)",
    "1-0:1.8.12(000000.000*kWh)",
    "1-0:1.8.13(003421.613*kWh)",
    "1-0:2.8.11(000000.000*kWh)",
    "1-0:2.8.12(000000.000*kWh)",
    "1-0:2.8.13(000000.000*kWh)",
    "0-0:96.14.1(03)",
    "1-0:1.7.0(00.610*kW)",
    "1-0:2.7.0(00.000*kW)",
    "0-0:96.13.0()",
    "1-0:32.7.0(232.0*V)",
    "1-0:31.7.0(002.9*A)",
    "1-0:99.1.0(1)(0-0:96.10.7)(1-0:1.29.0)(1-0:2.29.0)(251207001500W)(00)(000000.165*kWh)(000000.000*kWh)",
    "!05F2",
});

static void check_real_values() {
  CHECK(near(energy_t1->state, 849.710f));
  CHECK(near(energy_t2->state, 0.0f));
  CHECK(near(energy_t3->state, 3421.613f));
  CHECK(near(energy_total->state, 4271.323f));
  CHECK(near(export_total->state, 0.0f));
  CHECK(near(tariff->state, 3.0f));
  CHECK(near(power->state, 0.610f));
  CHECK(near(voltage_l1->state, 232.0f));
  CHECK(near(current_l1->state, 2.9f));
  CHECK(!power_l2->has_state());  // not in a single-phase telegram
}

int main() {
  std::printf("1. Real telegram, CRC 05F2, fed at once\n");
  uart_p1->feed(REAL_TELEGRAM);
  run_all();
  CHECK(p1_crc_errors->has_state() && p1_crc_errors->state == 0);
  check_real_values();
  CHECK(p1_data->state);

  std::printf("2. Same telegram fed in tiny chunks with ticks in between (incl. split inside values)\n");
  reset_values();
  for (size_t i = 0; i < REAL_TELEGRAM.size(); i += 7) {
    uart_p1->feed(REAL_TELEGRAM.substr(i, 7));
    tick();
    now_ms += 50;
  }
  check_real_values();
  CHECK(energy_t1->publishes == 1);

  std::printf("3. One corrupted digit -> nothing published, CRC error counted\n");
  reset_values();
  std::string bad = REAL_TELEGRAM;
  bad.replace(bad.find("000849.710"), 10, "000049.710");
  uart_p1->feed(bad);
  run_all();
  for (auto *s : all_values()) CHECK(!s->has_state());
  CHECK(p1_crc_errors->state == 1);

  std::printf("4. Truncated telegram followed by a good one -> only the good one counts\n");
  reset_values();
  uart_p1->feed(REAL_TELEGRAM.substr(0, REAL_TELEGRAM.find("1-0:1.8.13") + 14));
  tick();
  CHECK(!energy_t1->has_state());
  uart_p1->feed(REAL_TELEGRAM);
  run_all();
  check_real_values();
  CHECK(energy_t1->publishes == 1);
  CHECK(p1_crc_errors->state == 1);  // unchanged

  std::printf("5. Noise before the header and a missing CRC digit\n");
  reset_values();
  uart_p1->feed("\x00\xff garbage ) ( ! \r\n");
  std::string short_footer = REAL_TELEGRAM.substr(0, REAL_TELEGRAM.rfind('!')) + "!05F\r\n";
  uart_p1->feed(short_footer);
  run_all();
  for (auto *s : all_values()) CHECK(!s->has_state());
  CHECK(p1_crc_errors->state == 2);

  std::printf("6. Oversized telegram is discarded, the next one still parses\n");
  reset_values();
  uart_p1->feed("/" + std::string(4000, 'x'));
  run_all();
  uart_p1->feed(REAL_TELEGRAM);
  run_all();
  check_real_values();

  std::printf("7. Synthetic three-phase telegram (MA309M codes) with computed CRC\n");
  reset_values();
  const std::string three = with_crc({
      "/KFM5KAIFA-METER", "",
      "1-0:1.8.11(001234.500*kWh)", "1-0:1.8.12(000100.250*kWh)", "1-0:1.8.13(000010.125*kWh)",
      "1-0:2.8.11(000001.000*kWh)", "1-0:2.8.12(000002.000*kWh)", "1-0:2.8.13(000003.000*kWh)",
      "0-0:96.14.1(01)", "1-0:1.7.0(04.390*kW)", "1-0:2.7.0(00.000*kW)",
      "1-0:21.7.0(00.340*kW)", "1-0:41.7.0(02.940*kW)", "1-0:61.7.0(01.110*kW)",
      "1-0:32.7.0(226.0*V)", "1-0:52.7.0(225.0*V)", "1-0:72.7.0(225.4*V)",
      "1-0:31.7.0(001.8*A)", "1-0:51.7.0(013.4*A)", "1-0:71.7.0(005.0*A)",
  });
  uart_p1->feed(three);
  run_all();
  CHECK(near(energy_total->state, 1344.875f));
  CHECK(near(export_total->state, 6.0f));
  CHECK(near(power_l2->state, 2.94f));
  CHECK(near(voltage_l3->state, 225.4f));
  CHECK(near(current_l2->state, 13.4f));
  CHECK(near(tariff->state, 1.0f));
  CHECK(near(power->state, 4.39f));

  std::printf("8. Telegram missing one tariff -> no partial total\n");
  reset_values();
  uart_p1->feed(with_crc({"/KFM5KAIFA-METER", "", "1-0:1.8.11(000100.000*kWh)", "1-0:1.8.12(000200.000*kWh)",
                          "1-0:1.7.0(00.500*kW)"}));
  run_all();
  CHECK(near(energy_t1->state, 100.0f));
  CHECK(!energy_total->has_state());
  CHECK(near(power->state, 0.5f));

  std::printf("9. No data for 31 s -> P1 Data goes off\n");
  CHECK(p1_data->state);
  now_ms += 31000;
  tick();
  CHECK(!p1_data->state);
  uart_p1->feed(REAL_TELEGRAM);
  run_all();
  CHECK(p1_data->state);

  std::printf(failures ? "\n%d check(s) FAILED\n" : "\nAll checks passed\n", failures);
  return failures ? 1 : 0;
}
