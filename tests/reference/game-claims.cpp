// OUR manual fixed-width translation of supplied FXGS instructions, NOT an
// original-executable oracle. No production TypeScript implementation is linked.
// Native Bula has no bounds; classify/reject OUT-OF-PLANE cases as modern policy.
#include <array>
#include <cstdint>
#include <iostream>
#include <map>
#include <string>
#include <vector>

struct Body {
  std::string hex;
  void byte(unsigned value) {
    static constexpr char digits[] = "0123456789abcdef";
    value = (value & 255u) ^ 0x5au;
    hex += digits[value >> 4]; hex += digits[value & 15];
  }
  void word(unsigned value) {
    value = (value & 65535u) ^ 0xa569u;
    static constexpr char digits[] = "0123456789abcdef";
    for (unsigned b : {value >> 8, value & 255u}) {
      hex += digits[b >> 4]; hex += digits[b & 15];
    }
  }
};
template<class A> void array(const A &values) {
  std::cout << '['; bool first = true;
  for (auto value : values) { if (!first) std::cout << ','; first = false; std::cout << +value; }
  std::cout << ']';
}
void separator(bool &first) { if (!first) std::cout << ','; first = false; }
struct Cell { int row, column; };
void bula(unsigned state, const std::vector<Cell> &cells) {
  Body request, response;
  request.byte(160); request.byte(state); request.byte(cells.size());
  response.byte(177); response.byte(cells.size());
  std::map<int, int> writes;
  for (auto c : cells) {
    request.byte(c.row); request.byte(c.column);
    response.byte(c.row); response.byte(c.column); response.byte(state);
    writes[c.row * 45 + c.column] = int(state);
  }
  std::cout << "{\"State\":" << state << ",\"Request\":\"" << request.hex
    << "\",\"Response\":\"" << response.hex << "\",\"Writes\":[";
  bool first = true;
  for (auto entry : writes) {
    separator(first); std::cout << '[' << entry.first << ',' << entry.second << ']';
  }
  std::cout << "]}";
}
struct Lap {
  unsigned mask;
  std::array<uint32_t, 16> sort;
  std::array<unsigned, 8> prefix{};
  explicit Lap(unsigned occupied) : mask(occupied) { sort.fill(0xffffffffu); }
  void step(unsigned slot, unsigned first, unsigned second, uint32_t tick) {
    sort[2 * slot] = tick;
    sort[2 * slot + 1] = (255u - second) | ((255u - first) << 8);
    prefix[slot] = first;
    unsigned count = 0;
    std::array<unsigned, 8> ranks{}; ranks.fill(1);
    for (unsigned i = 0; i < 8; ++i) {
      if (!(mask & (1u << i))) continue;
      if ((sort[2 * i] & sort[2 * i + 1]) != 0xffffffffu) ++count;
      uint64_t left = (uint64_t(sort[2 * i + 1]) << 32) | sort[2 * i];
      for (unsigned j = i + 1; j < 8; ++j) {
        if (!(mask & (1u << j))) continue;
        uint64_t right = (uint64_t(sort[2 * j + 1]) << 32) | sort[2 * j];
        ++ranks[left <= right ? j : i];
      }
    }
    Body request, response;
    request.byte(155); request.byte(slot); request.byte(first); request.byte(second);
    response.byte(170); response.byte(count);
    for (unsigned i = 0; i < 8; ++i) {
      if (mask & (1u << i)) { response.byte(ranks[i]); response.byte(prefix[i]); }
      else { ranks[i] = 255; response.byte(255); response.byte(255); }
    }
    std::cout << "{\"Slot\":" << slot << ",\"First\":" << first << ",\"Second\":" << second
      << ",\"Tick\":" << tick << ",\"Reported\":" << count << ",\"Ranks\":";
    array(ranks); std::cout << ",\"Sort\":"; array(sort);
    std::cout << ",\"Prefix\":"; array(prefix);
    std::cout << ",\"Request\":\"" << request.hex << "\",\"Response\":\"" << response.hex << "\"}";
  }
};
void lapCase(unsigned mask, uint32_t one, uint32_t two, bool vacant) {
  Lap state(mask);
  unsigned low = 0, high = 7;
  while (!(mask & (1u << low))) ++low;
  while (!(mask & (1u << high))) --high;
  std::cout << "{\"Mask\":" << mask << ",\"Steps\":[";
  if (vacant && mask != 255) {
    unsigned slot = 0; while (mask & (1u << slot)) ++slot;
    state.step(slot, 127, 128, 0xffffffffu); std::cout << ',';
  }
  state.step(high, 0, 255, one); std::cout << ',';
  state.step(low, 255, 0, two); std::cout << ',';
  state.step(high, 255, 0, two); std::cout << ',';
  state.step(low, 255, 0, one); std::cout << ',';
  state.step(high, 255, 1, 0xffffffffu); std::cout << ',';
  state.step(high, 0, 0, 0u);
  std::cout << "]}";
}
int main() {
  std::cout << "{\"Evidence\":\"Independent manual C++ translation plus PE anchors; NOT native execution, client compatibility, spawn authorization or playable matches. Out-of-plane Bula classification is explicit modern memory safety.\",\"BulaCells\":[";
  bool first = true;
  for (int row = 0; row < 256; ++row) for (int column = 0; column < 256; ++column) {
    if (row * 45 + column >= 26 * 45) continue;
    separator(first); bula(unsigned((row * 11 + column * 13) & 255), {{row, column}});
  }
  std::cout << "],\"BulaOverruns\":["; first = true;
  for (int row = 0; row < 256; ++row) for (int column = 0; column < 256; ++column) {
    if (row * 45 + column < 26 * 45) continue;
    separator(first); std::cout << ((row << 8) | column);
  }
  std::cout << "],\"BulaBatches\":["; first = true;
  for (int count = 0; count < 256; ++count) {
    std::vector<Cell> cells;
    for (int i = 0; i < count; ++i) {
      int row = (i * 13 + count) % 26;
      int max = 26 * 45 - row * 45;
      if (max > 256) max = 256;
      cells.push_back({row, (i * 37) % max});
      if (i % 7 == 0) cells.back() = {0, 45}; // safe alias and repetitions
    }
    separator(first); bula(unsigned((count * 17) & 255), cells);
  }
  std::cout << "],\"LapTopologies\":["; first = true;
  for (unsigned mask = 1; mask < 256; ++mask) {
    unsigned n = 0; for (unsigned i = 0; i < 8; ++i) n += (mask >> i) & 1u;
    if (n < 2) continue;
    separator(first); lapCase(mask, 0x80000000u, 0x7fffffffu, true);
  }
  std::cout << "],\"LapBoundaries\":["; first = true;
  for (unsigned mask : {3u, 255u})
    for (uint32_t one : {0u, 1u, 0x7fffffffu, 0x80000000u, 0xfffffffeu, 0xffffffffu})
      for (uint32_t two : {0u, 1u, 0x7fffffffu, 0x80000000u, 0xfffffffeu, 0xffffffffu}) {
        separator(first); lapCase(mask, one, two, false);
      }
  std::cout << "],\"OpaqueEvents\":["; first = true;
  for (unsigned slot = 0; slot < 8; ++slot)
    for (unsigned one = 0; one < 256; ++one)
      for (unsigned two : {0u, 1u, 0x5au, 0x80u, 255u}) {
        Body request, response;
        for (Body *p : {&request, &response}) {
          p->byte(p == &request ? 146 : 159);
          p->byte(0x80 | slot); p->word(one * 257); p->word(two * 257);
          p->byte(one); p->byte(two);
        }
        separator(first);
        std::cout << "{\"Slot\":" << slot << ",\"First\":" << one << ",\"Second\":" << two
          << ",\"X\":" << one * 257 << ",\"Y\":" << two * 257
          << ",\"Request\":\"" << request.hex << "\",\"Response\":\"" << response.hex << "\"}";
      }
  std::cout << "]}\n";
}
