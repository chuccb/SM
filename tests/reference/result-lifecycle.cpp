// Independent, manual fixed-width translation of narrowly audited FXGS .c/.lst:
// rank insert 00404EFD / update 00404F97; return 0041B0B7/0041B0DA;
// DeferHandleGameEnd 0041D31A; Update timeout 0041DC31, HandleGameTimeOut 0041B477.
// NOT original execution, client compatibility, verdict authority or SQL parity.
#include <array>
#include <cstdint>
#include <iostream>
#include <vector>
struct User { int level; uint32_t serial; };
using Users = std::array<User, 4>;
using Rank = std::vector<int>;
void insert(Rank &rank, const Users &users, int slot) {
  auto it = rank.begin();
  const auto &u = users[slot];
  for (; it != rank.end(); ++it) {
    const auto &other = users[*it];
    if (u.level > other.level || (u.level == other.level && u.serial < other.serial)) break;
  }
  rank.insert(it, slot);
}
void update(Rank &rank, const Users &users, int slot) {
  for (auto it = rank.begin(); it != rank.end(); ++it) if (*it == slot) {
    rank.erase(it); insert(rank, users, slot); return;
  }
}
template <class T> void array(const T &values) {
  bool comma = false; std::cout << '[';
  for (auto v : values) { if (comma) { std::cout << ','; } comma = true; std::cout << v; }
  std::cout << ']';
}
int main() {
  std::cout << "{\"Evidence\":\"Manual fixed-width C++ translation; NOT native execution or client/storage parity\",\"Rank\":[";
  bool comma = false;
  for (int family = 0; family < 2; ++family) for (int code = 0; code < 81; ++code) {
    Users users = family ? Users{{{10, 0x80000001u}, {10, 1}, {10, 0xffffffffu}, {10, 17}}}
                         : Users{{{1, 0x80000001u}, {2, 1}, {450, 0xffffffffu}, {225, 17}}};
    std::array<int, 4> before{}, after{}; std::array<uint32_t, 4> serials{};
    int digits = code;
    for (int i = 0; i < 4; ++i) {
      before[i] = users[i].level; serials[i] = users[i].serial;
      int target = before[i] + digits % 3 - 1; digits /= 3;
      after[i] = target < 1 ? 1 : target > 450 ? 450 : target;
    }
    Rank rank; for (int i = 0; i < 4; ++i) insert(rank, users, i);
    if (comma) { std::cout << ','; } comma = true;
    std::cout << "{\"Before\":"; array(before); std::cout << ",\"After\":"; array(after);
    std::cout << ",\"Serials\":"; array(serials); std::cout << ",\"Initial\":"; array(rank);
    std::cout << ",\"Steps\":[";
    for (int i = 0; i < 4; ++i) {
      if (i) std::cout << ',';
      users[i].level = after[i];
      // SendGameResult updates rank ONLY for the current positive cached-level
      // direction. Downward changes can intentionally leave the list unsorted.
      if (after[i] > before[i]) update(rank, users, i);
      array(rank);
    }
    std::cout << "]}";
  }
  std::cout << "],\"Return\":["; comma = false;
  for (uint32_t end : {0u, 1u, 0xfffffff0u, 0xfffffff9u, 0xffffffffu})
    for (uint32_t delta : {0u, 1u, 7999u, 8000u, 8001u, 0xfffffff0u, 0xffffffffu})
      for (int playing : {0, 1}) for (int phase : {0, 1, 2}) {
        const uint32_t now = end + delta;
        if (comma) { std::cout << ','; } comma = true;
        std::cout << "{\"End\":" << end << ",\"Now\":" << now << ",\"Playing\":" << playing
                  << ",\"Phase\":" << phase << ",\"Returns\":" << (playing && phase == 2 && uint32_t(now - end) > 8000u ? "true" : "false") << '}';
      }
  std::cout << "],\"ActiveTimeout\":["; comma = false;
  for (uint32_t elapsed : {0u, 1u, 179999u, 180000u, 180001u, 0x80000000u, 0xffffffffu})
    for (uint32_t stopped : {0u, 1u, 180000u, 0x80000000u, 0xffffffffu}) {
      if (comma) { std::cout << ','; } comma = true;
      std::cout << "{\"Elapsed\":" << elapsed << ",\"Stopped\":" << stopped
                << ",\"Expires\":" << (uint32_t(elapsed - stopped) > 180000u ? "true" : "false") << '}';
    }
  std::cout << "],\"SlotReturnBytes\":[";
  for (int byte = 0; byte < 256; ++byte) { if (byte) std::cout << ','; std::cout << (byte & 0xe3); }
  std::cout << "],\"ReturnBody\":\"fe5a\"}\n";
}
