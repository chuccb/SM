// Independent manual fixed-width translation of FXGS Update 0041DC31:
// bombs 0041DD00..0041DE11, pending deaths 0041DE4F..0041DF49,
// claims-before-timers 0041DC95 and last-update DWORD 0041E0BD.
// No production TypeScript imports, no original executable and no client oracle.
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using States = std::array<uint8_t, 8>;
using Times = std::array<uint32_t, 8>;
template<class T> void array(const T &a) {
  std::cout << '['; bool comma = false;
  for (auto v : a) { if (comma) std::cout << ','; comma = true; std::cout << +v; }
  std::cout << ']';
}
uint32_t deadline(const States &states) {
  for (auto s : states) if (s != 1 && s != 3 && s != 4) return 10000;
  return 6000;
}
std::vector<int> deaths(States &states, Times &times, uint32_t elapsed) {
  const auto limit = deadline(states); std::vector<int> out;
  for (int slot = 0; slot < 8; ++slot) if (states[slot] == 3 && uint32_t(elapsed - times[slot]) >= limit) {
    out.push_back(slot); states[slot] = 1; times[slot] = elapsed;
  }
  return out;
}
struct Body {
  std::string s;
  void raw(uint8_t n) { constexpr char hex[] = "0123456789abcdef"; s += hex[n >> 4]; s += hex[n & 15]; }
  void byte(uint8_t n) { raw(n ^ 0x5a); }
  void word(uint16_t n) { n ^= 0xa569; raw(n >> 8); raw(n); }
};
std::string deathBody(const std::vector<int> &slots) {
  if (slots.empty()) return "";
  Body b; b.byte(159); b.byte(0x50); b.word(0); b.word(0); b.byte(uint8_t(slots.size()));
  for (auto slot : slots) { b.byte(slot); b.word(9999); b.word(9999); }
  return b.s;
}
struct Bomb { uint32_t serial; uint8_t state; int32_t ms; uint8_t row, col, power; bool paused; };
void bomb(const Bomb &b) {
  std::cout << "{\"SerialNo\":" << b.serial << ",\"State\":" << +b.state
    << ",\"RemainingMilliseconds\":" << b.ms << ",\"Row\":" << +b.row
    << ",\"Column\":" << +b.col << ",\"Power\":" << +b.power
    << ",\"RemotelyPaused\":" << (b.paused ? "true" : "false") << '}';
}
void bombs(const std::vector<Bomb> &values) {
  std::cout << '[';
  for (size_t i = 0; i < values.size(); ++i) { if (i) std::cout << ','; bomb(values[i]); }
  std::cout << ']';
}
std::string advanceBombs(std::vector<Bomb> &values, uint32_t delta) {
  struct Event { uint32_t serial; bool landed; }; std::vector<Event> events;
  for (size_t i = 0; i < values.size();) {
    auto &b = values[i];
    if (!b.paused || b.state == 1) b.ms = int32_t(uint32_t(b.ms) - delta);
    if (b.ms > 0) { ++i; continue; }
    events.push_back({b.serial, b.state == 1});
    if (b.state == 1) { b.ms = 2000; b.state = 0; ++i; }
    else { b = values.back(); values.pop_back(); }
  }
  if (events.empty()) return "";
  Body out; out.byte(152); out.byte(uint8_t(events.size()));
  for (auto e : events) { out.word(uint16_t(e.serial)); out.byte(e.landed); }
  return out.s;
}
void timerCase(const States &before, const Times &beforeTimes, uint32_t elapsed, bool &comma) {
  auto states = before; auto times = beforeTimes; auto limit = deadline(states);
  auto expired = deaths(states, times, elapsed);
  if (comma) std::cout << ',';
  comma = true;
  std::cout << "{\"States\":"; array(before); std::cout << ",\"Times\":"; array(beforeTimes);
  std::cout << ",\"Elapsed\":" << elapsed << ",\"Deadline\":" << limit << ",\"Expired\":"; array(expired);
  std::cout << ",\"AfterStates\":"; array(states); std::cout << ",\"AfterTimes\":"; array(times);
  std::cout << ",\"Body\":\"" << deathBody(expired) << "\"}";
}
int main() {
  std::cout << "{\"Evidence\":\"Independent manual C++ static model; NOT native execution, verdict authorization or client evidence\",\"StateTimers\":[";
  bool comma = false;
  for (uint8_t marker : {0, 1, 2, 3, 4, 5, 6, 7, 255})
    for (uint32_t elapsed : {0u, 1u, 5999u, 6000u, 9999u, 10000u, 0x80000000u, 0xffffffffu})
      for (uint32_t last : {0u, 1u, 0xfffffff0u}) {
        States states{}; states.fill(1); states[0] = 3; states[4] = 3; states[6] = marker;
        Times times{}; times[0] = last; times[4] = last + 250u; times[6] = last + 1u;
        timerCase(states, times, elapsed, comma);
      }
  std::cout << "],\"PendingMasks\":["; comma = false;
  const Times ages{{0u, 5999u, 6000u, 6001u, 9999u, 10000u, 0x80000000u, 0xffffffffu}};
  for (uint32_t mask = 0; mask < 256; ++mask) {
    States states{}; Times times{};
    for (int slot = 0; slot < 8; ++slot) {
      states[slot] = mask & (1u << slot) ? 3 : slot % 2 ? 4 : 1;
      times[slot] = 10000u - ages[slot];
    }
    timerCase(states, times, 10000u, comma);
  }
  std::vector<Bomb> values{{0,0,2800,1,2,3,false}, {1,1,100,2,3,4,true}, {2,0,1000,3,4,5,true}, {3,0,0,4,5,6,false}};
  std::cout << "],\"InitialBombs\":"; bombs(values);
  std::cout << ",\"Frames\":["; comma = false;
  States states{}; states.fill(1); states[0] = 3; Times times{};
  uint32_t last = 100, end = 0; int phase = 1; bool playing = true;
  for (uint32_t now : {6099u, 6100u, 6101u, 14101u, 14102u, 20000u}) {
    std::vector<int> opcodes; std::vector<std::string> bodies;
    if (playing) {
      if (phase == 2) {
        if (uint32_t(now - end) > 8000u) { opcodes.push_back(164); bodies.push_back("fe5a"); phase = 0; playing = false; }
      } else if (phase == 1) {
        // Both occupied slots are inactive only AFTER the previous timer pass.
        // The result/IncGame branch is deliberately not re-run later this tick.
        if (states[0] != 0 && states[0] != 3 && states[1] != 0 && states[1] != 3) {
          opcodes.push_back(163); phase = 2; end = now;
        } else {
          auto b = advanceBombs(values, uint32_t(now - last));
          if (!b.empty()) { opcodes.push_back(152); bodies.push_back(b); }
          auto d = deathBody(deaths(states, times, uint32_t(now - 100u)));
          if (!d.empty()) { opcodes.push_back(159); bodies.push_back(d); }
        }
      }
      last = now;
    }
    if (comma) std::cout << ',';
    comma = true;
    std::cout << "{\"Now\":" << now << ",\"Stage\":" << phase << ",\"Playing\":" << (playing ? "true" : "false")
      << ",\"LastUpdate\":" << last << ",\"End\":" << end << ",\"States\":"; array(states);
    std::cout << ",\"Times\":"; array(times); std::cout << ",\"Bombs\":"; bombs(values);
    std::cout << ",\"Opcodes\":"; array(opcodes); std::cout << ",\"NonResultBodies\":[";
    for (size_t i = 0; i < bodies.size(); ++i) { if (i) std::cout << ','; std::cout << '"' << bodies[i] << '"'; }
    std::cout << "]}";
  }
  std::cout << "]}\n";
}
