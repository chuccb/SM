// OUR model: native201/207 bytes + MODERN explicit trusted resident transport.
// Native sources prove wire roles/conditions, NOT cached transport/SQL parity.
// No supplied executable, API, financial effect or original client runs.
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>
#include "resident-inventory-handoff-levels.h"
using Bytes = std::vector<unsigned char>;
static void byte(Bytes& b, std::uint32_t n) { b.push_back(static_cast<unsigned char>(n ^ 0x5aU)); }
static void word(Bytes& b, std::uint32_t n) {
  n ^= 0xa569U; b.push_back(static_cast<unsigned char>(n >> 8)); b.push_back(static_cast<unsigned char>(n));
}
static void dword(Bytes& b, std::uint32_t n) {
  n ^= 0x96ca5395U; for (int i = 3; i >= 0; --i) b.push_back(static_cast<unsigned char>(n >> (i * 8)));
}
static void text(Bytes& b, const std::string& s) { word(b, static_cast<std::uint32_t>(s.size())); b.insert(b.end(), s.begin(), s.end()); }
static Bytes date(double value) {
  static_assert(sizeof(double) == 8, "reference requires binary64");
  std::uint64_t bits; std::memcpy(&bits, &value, 8); Bytes b;
  for (unsigned i = 0; i < 8; ++i) b.push_back(static_cast<unsigned char>(bits >> (i * 8)));
  return b;
}
static std::string hex(const Bytes& b) {
  constexpr char digits[] = "0123456789abcdef"; std::string s;
  for (auto n : b) { s += digits[n >> 4]; s += digits[n & 15]; } return s;
}
static int level(std::int32_t exp) {
  int n = 1; while (n < static_cast<int>(levels.size()) && exp >= levels[static_cast<std::size_t>(n)]) ++n; return n;
}
struct Owned { unsigned item, slot; std::int32_t amount; double time; std::string verbose; };
static Owned row(unsigned who, unsigned index) {
  return {index ? 0x80000000U : 7U, index ? 255U : 0U, index ? 3 : -1,
    index ? -0.0 : -1.75, "NATIVE owned" + std::to_string(who) + "-" + std::to_string(index)};
}
static void ownedJSON(unsigned who, unsigned index) {
  const auto r = row(who, index);
  std::cout << "{\"ItemSn\":" << r.item << ",\"StockSn\":" << 0xfedcba98U - index << ",\"Slot\":" << r.slot
    << ",\"Amount\":" << r.amount << ",\"DateHex\":\"" << hex(date(r.time))
    << "\",\"LevelCreated\":-32768,\"Verbose\":\"" << r.verbose << "\",\"Category\":2,\"strAttr\":\"resident attribute\",\"nAttr1\":-17,\"nAttr2\":-2147483648,\"nAttr3\":2147483647,\"Modified\":" << (index ? 0 : 1) << '}';
}
static void preJSON(unsigned who, unsigned i) {
  std::cout << "{\"SN\":" << 31 + who * 100 + i << ",\"Type\":23,\"ItemSn\":" << (who ? 0x80000000U : 7U)
    << ",\"StockSn\":4294967295,\"Slot\":255,\"Amount\":-3,\"ValidityPeriod\":99999,\"ValidityLevel\":2147483647,\"strAttr\":\"PRE attribute\",\"Description\":\"PRE description\"}";
}
struct Packet { unsigned opcode; Bytes bytes; };
static void emit(unsigned attr, bool initialized, const std::vector<unsigned>& modes, const std::vector<unsigned>& preCounts) {
  constexpr std::array<std::int32_t, 2> exps{{250000, 0}};
  std::vector<Packet> packets;
  Packet info{210, {}}; byte(info.bytes, 210); byte(info.bytes, attr); packets.push_back(info);
  if (!initialized) {
    Packet catalog{202, {}}; byte(catalog.bytes, 202); word(catalog.bytes, 2);
    for (unsigned i = 0; i < 2; ++i) {
      dword(catalog.bytes, i ? 0x80000000U : 7U); byte(catalog.bytes, i ? 100 : 101);
      text(catalog.bytes, "catalog-attribute" + std::to_string(i)); dword(catalog.bytes, 0xfffffff9U);
      dword(catalog.bytes, 0x80000000U); dword(catalog.bytes, 0x7fffffffU); text(catalog.bytes, "catalog-name" + std::to_string(i));
    }
    packets.push_back(catalog);
  }
  bool anyPre = false; for (auto n : preCounts) if (n) anyPre = true;
  if (anyPre) {
    Packet pre{207, {}}; byte(pre.bytes, 207); byte(pre.bytes, static_cast<unsigned>(modes.size()));
    for (unsigned who = 0; who < modes.size(); ++who) {
      byte(pre.bytes, preCounts[who]);
      for (unsigned i = 0; i < preCounts[who]; ++i) {
        byte(pre.bytes, 23); dword(pre.bytes, who ? 0x80000000U : 7U); word(pre.bytes, 0xfffffffdU);
        word(pre.bytes, who ? 0 : static_cast<unsigned>(level(exps[who]))); word(pre.bytes, 99999);
        text(pre.bytes, "PRE attribute"); text(pre.bytes, "PRE description");
      }
    }
    packets.push_back(pre);
  }
  if (!initialized || anyPre) {
    Packet inventory{201, {}}; byte(inventory.bytes, 201); byte(inventory.bytes, static_cast<unsigned>(modes.size()));
    for (unsigned who = 0; who < modes.size(); ++who) {
      const auto count = modes[who] == 0 ? 1U : (modes[who] == 1 ? 0U : 2U); dword(inventory.bytes, count);
      for (unsigned i = 0; i < count; ++i) {
        const Owned v = modes[who] ? row(who, i) : Owned{100U + who, 255, static_cast<std::int32_t>(4 + who), 0.0, "LEGACY owned" + std::to_string(who)};
        dword(inventory.bytes, v.item); byte(inventory.bytes, v.slot); dword(inventory.bytes, static_cast<std::uint32_t>(v.amount)); text(inventory.bytes, v.verbose);
        const auto b = date(v.time); inventory.bytes.insert(inventory.bytes.end(), b.begin(), b.end());
      }
    }
    packets.push_back(inventory);
  }
  static bool first = true; if (!first) std::cout << ','; first = false;
  std::cout << "{\"GameAttr\":" << attr << ",\"Initialized\":" << (initialized ? "true" : "false") << ",\"Users\":[";
  unsigned reads = 0;
  for (unsigned who = 0; who < modes.size(); ++who) {
    if (who) std::cout << ',';
    const bool native = modes[who] != 0; if (!native) ++reads;
    std::cout << "{\"Mode\":" << modes[who] << ",\"Exp\":" << exps[who] << ",\"Level\":" << level(exps[who])
      << ",\"Presentation\":{\"FakeLevel\":" << (native ? -17 + static_cast<int>(who) * 23 : 0)
      << ",\"LevelIconEnabled\":" << (native && who ? 2 : 0) << ",\"LevelIconSN\":" << (native ? -19088744 : 0) << "},\"OwnedRows\":[";
    if (modes[who] == 2) for (unsigned i = 0; i < 2; ++i) { if (i) std::cout << ','; ownedJSON(who, i); }
    std::cout << "],\"PreRows\":[";
    for (unsigned i = 0; i < preCounts[who]; ++i) { if (i) std::cout << ','; preJSON(who, i); }
    std::cout << "]}";
  }
  std::cout << "],\"LegacyReads\":" << reads << ",\"Expected\":[";
  for (unsigned i = 0; i < packets.size(); ++i) { if (i) std::cout << ','; std::cout << "{\"Opcode\":" << packets[i].opcode << ",\"Hex\":\"" << hex(packets[i].bytes) << "\"}"; }
  std::cout << "]}";
}
int main() {
  std::cout << "{\"Model\":\"OUR native wire roles plus MODERN explicit resident/mixed-mode transport; NOT native initialization, SQL freshness, financial or client proof\",\"Cases\":[";
  for (unsigned attr : {0U, 1U, 255U}) for (bool initialized : {false, true}) {
    for (unsigned a : {0U, 1U, 2U}) for (unsigned pa : {0U, 1U}) emit(attr, initialized, {a}, {pa});
    for (unsigned a : {0U, 1U, 2U}) for (unsigned b : {0U, 1U, 2U}) for (unsigned pa : {0U, 1U}) for (unsigned pb : {0U, 1U}) emit(attr, initialized, {a, b}, {pa, pb});
  }
  emit(1, false, {2, 1}, {30, 30}); emit(1, true, {1, 2}, {0, 30}); std::cout << "]}\n";
}
