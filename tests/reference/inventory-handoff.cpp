// OUR independent manual FXGS0040895A..00408A43 model, NOT original execution.
// Native first-local initialization gate / ANY-pre -> ALL-local207 ->201.
// Only EMPTY owned201 is modeled; no legacy SN/ItemID/DATE reinterpretation,
// SQL / premium / financial effects, native pool mutation or client oracle.
#include <array>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include "inventory-handoff-levels.h"
using Bytes = std::vector<unsigned char>;
static void byte(Bytes& b, std::uint32_t n) { b.push_back(static_cast<unsigned char>(n ^ 0x5aU)); }
static void word(Bytes& b, std::uint32_t n) {
  n ^= 0xa569U; b.push_back(static_cast<unsigned char>(n >> 8)); b.push_back(static_cast<unsigned char>(n));
}
static void dword(Bytes& b, std::uint32_t n) {
  n ^= 0x96ca5395U;
  for (int i = 3; i >= 0; --i) b.push_back(static_cast<unsigned char>(n >> (i * 8)));
}
static void text(Bytes& b, const std::string& s) { word(b, static_cast<std::uint32_t>(s.size())); b.insert(b.end(), s.begin(), s.end()); }
static std::string hex(const Bytes& b) {
  constexpr char alphabet[] = "0123456789abcdef"; std::string s;
  for (const auto n : b) { s += alphabet[n >> 4]; s += alphabet[n & 15]; }
  return s;
}
static int level(std::int32_t exp) {
  int n = 1;
  while (n < static_cast<int>(levels.size()) && exp >= levels[static_cast<std::size_t>(n)]) ++n;
  return n;
}
struct Row {
  unsigned type; std::uint32_t item; std::int32_t amount, period; std::string attr, description;
};
static Row row(unsigned who, unsigned index) {
  constexpr std::array<std::int32_t, 5> amounts{{-1, 65535, 65536, -2147483647 - 1, 2147483647}};
  constexpr std::array<std::int32_t, 4> periods{{-1, 99999, 100000, 65536}};
  return {(who * 31 + index * 7) & 255U, who ? 0x80000000U : 7U,
    amounts[index % amounts.size()], periods[index % periods.size()],
    "pre-attribute" + std::to_string(who), "pre-description" + std::to_string(who)};
}
static void rowJSON(unsigned who, unsigned index) {
  const auto r = row(who, index);
  std::cout << "{\"SN\":" << (31 + who * 100 + index) << ",\"Type\":" << r.type
    << ",\"ItemSn\":" << r.item << ",\"StockSn\":" << (0xffffffffU - index)
    << ",\"Slot\":255,\"Amount\":" << r.amount << ",\"ValidityPeriod\":" << r.period
    << ",\"ValidityLevel\":2147483647,\"strAttr\":\"" << r.attr
    << "\",\"Description\":\"" << r.description << "\"}";
}
struct Packet { unsigned type; Bytes bytes; };
static void emit(unsigned gameAttr, const std::vector<unsigned>& counts, const std::vector<bool>& initialized) {
  constexpr std::array<std::int32_t, 2> exp{{250000, 0}};
  std::vector<Packet> packets;
  Packet info{210, {}}; byte(info.bytes, 210); byte(info.bytes, gameAttr); packets.push_back(info);
  bool inventory = false;
  if (!initialized[0]) {
    Packet catalog{202, {}}; byte(catalog.bytes, 202); word(catalog.bytes, 2);
    for (unsigned i = 0; i < 2; ++i) {
      dword(catalog.bytes, i ? 0x80000000U : 7U); byte(catalog.bytes, i ? 100 : 101);
      text(catalog.bytes, "catalog-attribute" + std::to_string(i));
      dword(catalog.bytes, static_cast<std::uint32_t>(-7)); dword(catalog.bytes, 0x80000000U); dword(catalog.bytes, 0x7fffffffU);
      text(catalog.bytes, "catalog-name" + std::to_string(i));
    }
    packets.push_back(catalog); inventory = true;
  }
  bool anyPre = false;
  for (const auto count : counts) if (count > 0) anyPre = true;
  if (anyPre) {
    Packet pre{207, {}}; byte(pre.bytes, 207); byte(pre.bytes, static_cast<unsigned>(counts.size()));
    for (unsigned who = 0; who < counts.size(); ++who) {
      byte(pre.bytes, counts[who]); // includes EMPTY local users
      for (unsigned index = 0; index < counts[who]; ++index) {
        const auto r = row(who, index);
        byte(pre.bytes, r.type); dword(pre.bytes, r.item); word(pre.bytes, static_cast<std::uint32_t>(r.amount));
        word(pre.bytes, who ? 0 : static_cast<std::uint32_t>(level(exp[who])));
        word(pre.bytes, r.period < 100000 ? static_cast<std::uint32_t>(r.period) : 0);
        text(pre.bytes, r.attr); text(pre.bytes, r.description);
      }
    }
    packets.push_back(pre); inventory = true;
  }
  if (inventory) {
    Packet owned{201, {}}; byte(owned.bytes, 201); byte(owned.bytes, static_cast<unsigned>(counts.size()));
    for (unsigned who = 0; who < counts.size(); ++who) dword(owned.bytes, 0);
    packets.push_back(owned);
  }
  static bool first = true; if (!first) std::cout << ','; first = false;
  std::cout << "{\"GameAttr\":" << gameAttr << ",\"Users\":[";
  for (unsigned who = 0; who < counts.size(); ++who) {
    if (who) std::cout << ',';
    std::cout << "{\"Initialized\":" << (initialized[who] ? "true" : "false") << ",\"Exp\":" << exp[who]
      << ",\"Level\":" << level(exp[who]) << ",\"Rows\":[";
    for (unsigned index = 0; index < counts[who]; ++index) { if (index) std::cout << ','; rowJSON(who, index); }
    std::cout << "]}";
  }
  std::cout << "],\"Expected\":[";
  bool comma = false;
  for (const auto& p : packets) {
    if (comma) std::cout << ',';
    comma = true;
    std::cout << "{\"Opcode\":" << p.type << ",\"Hex\":\"" << hex(p.bytes) << "\"}";
  }
  std::cout << "]}";
}
int main() {
  std::cout << "{\"Model\":\"manual native handoff publication order/group207/EMPTY201; NOT execution, financial/SQL authority or client proof\",\"Cases\":[";
  for (const auto attr : {0U, 1U, 2U, 255U}) {
    for (const auto a : {0U, 1U, 29U, 30U}) for (const bool first : {false, true}) emit(attr, {a}, {first});
    for (const auto a : {0U, 1U, 29U, 30U}) for (const auto b : {0U, 1U, 29U, 30U})
      for (const bool first : {false, true}) for (const bool second : {false, true}) emit(attr, {a, b}, {first, second});
  }
  std::cout << "]}\n";
}
