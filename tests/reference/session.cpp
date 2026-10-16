// Manually translated, FIXED-WIDTH reference, NOT execution of official code.
// FXGS .c/.lst: LaunchGameStage 00420BB3; shuffle 0041DAFD; DoStartGame
// 0041BDCF; OnUDPPeerInfo 0041CE45; TCP ready 0041D431; UDP ready 0041B506
// (EMPTY retn 18h); CUdpLossRegulator 004161AC..004165C0; timeout 0041DF6C.
// Never imports TypeScript or loads/executes an original executable.
#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using Slots = std::array<int, 8>;
using Matrix = std::array<uint32_t, 64>;
struct Host { uint32_t address; uint16_t port; };
bool equal(Host a, Host b) { return a.address == b.address && a.port == b.port; }
struct Packet {
  bool cipher;
  std::vector<uint8_t> bytes;
  explicit Packet(bool c = true) : cipher(c) {}
  void byte(uint8_t n) { bytes.push_back(n ^ (cipher ? 0x5a : 0)); }
  void word(uint16_t n) {
    n ^= cipher ? 0xa569 : 0; bytes.push_back(n >> 8); bytes.push_back(n);
  }
  void dword(uint32_t n) {
    n ^= cipher ? 0x96ca5395u : 0;
    for (int shift = 24; shift >= 0; shift -= 8) bytes.push_back(n >> shift);
  }
};
std::string hex(const std::vector<uint8_t> &b) {
  static const char digits[] = "0123456789abcdef";
  std::string s;
  for (uint8_t n : b) { s += digits[n >> 4]; s += digits[n & 15]; }
  return s;
}
uint8_t crc8(const std::vector<uint8_t> &bytes) {
  uint8_t crc = 0;
  for (auto b : bytes) {
    crc ^= b;
    for (int bit = 0; bit < 8; ++bit)
      crc = uint8_t((crc << 1) ^ ((crc & 0x80) ? 7 : 0));
  }
  return crc;
}
std::string datagram(const Packet &packet) {
  std::vector<uint8_t> b{uint8_t(packet.bytes.size() + 1)};
  b.insert(b.end(), packet.bytes.begin(), packet.bytes.end());
  b.push_back(crc8(b));
  return hex(b);
}
template<class T> void arrayJSON(const T &values) {
  std::cout << '[';
  bool comma = false;
  for (auto value : values) {
    if (comma) std::cout << ',';
    comma = true; std::cout << value;
  }
  std::cout << ']';
}
void launch(const char *name, uint16_t map, int capacity, uint32_t time,
            const Slots &selected, const Slots &colors, const std::vector<int> &draws) {
  std::vector<int> positions;
  for (int i = 0; i < capacity; ++i) positions.push_back(i);
  size_t used = 0;
  auto draw = [&]() {
    if (used == draws.size()) throw std::runtime_error("missing draw");
    return draws[used++];
  };
  for (int i = 1; i < capacity; ++i) {
    int j = draw() % (i + 1); std::swap(positions[i], positions[j]);
  }
  Slots bombers, spawns; bombers.fill(-1); spawns.fill(-1);
  Packet out; out.byte(116); out.dword(time); out.word(map);
  out.byte(uint8_t(std::count_if(selected.begin(), selected.end(), [](int n) { return n >= 0; })));
  int next = 0;
  for (int i = 0; i < 8; ++i) if (selected[i] >= 0) {
    int bomber = selected[i];
    if (bomber == 10) {
      if (draw() % 30 != 0) bomber = draw() % 8;
      else { bomber = 8; if (draw() % 3 != 0) ++bomber; }
    }
    bombers[i] = bomber; spawns[i] = positions[next++];
    out.byte(i); out.byte(0); out.byte(spawns[i]); out.byte(bomber); out.byte(colors[i]);
  }
  if (used != draws.size()) throw std::runtime_error("unused draw");
  std::cout << "{\"name\":\"" << name << "\",\"map\":" << map << ",\"capacity\":" << capacity
            << ",\"time\":" << time << ",\"selected\":";
  arrayJSON(selected); std::cout << ",\"colors\":"; arrayJSON(colors);
  std::cout << ",\"draws\":"; arrayJSON(draws);
  std::cout << ",\"bombers\":"; arrayJSON(bombers);
  std::cout << ",\"spawns\":"; arrayJSON(spawns);
  std::cout << ",\"body\":\"" << hex(out.bytes) << "\"}";
}
void begin(uint16_t map, uint32_t time, uint32_t sequence, uint32_t key,
           uint32_t ghostStart, uint32_t ghostFreq) {
  Packet out; out.byte(150); out.dword(time); out.dword(sequence ^ key);
  out.dword(ghostStart); out.dword(ghostFreq);
  std::cout << "{\"map\":" << map << ",\"time\":" << time << ",\"sequence\":" << sequence
            << ",\"key\":" << key << ",\"ghostStart\":" << ghostStart << ",\"ghostFreq\":" << ghostFreq
            << ",\"nextSequence\":" << uint32_t(sequence + 1) << ",\"body\":\"" << hex(out.bytes) << "\"}";
}
void peerCase(const char *name, Host observed, Host first, Host second) {
  std::array<Host, 3> hosts{{observed, {0, 0}, {0, 0}}};
  std::array<Host, 2> candidates{{first, second}};
  for (int i = 0; i < 2; ++i) if (candidates[i].address != 0) {
    bool seen = false;
    for (int j = 0; j <= i; ++j) seen |= equal(hosts[j], candidates[i]);
    if (!seen) hosts[i + 1] = candidates[i];
  }
  const uint32_t joinTime = 0x12345678;
  Packet out; out.byte(120);
  for (int slot = 0; slot < 8; ++slot) {
    out.byte(slot == 0 ? 1 : 0);
    if (slot == 0) {
      for (auto h : hosts) { out.dword(h.address); out.word(h.port); }
      out.dword(joinTime);
    }
  }
  std::cout << "{\"name\":\"" << name << "\",\"joinTime\":" << joinTime << ",\"observed\":["
            << observed.address << ',' << observed.port << "],\"candidates\":[["
            << first.address << ',' << first.port << "],[" << second.address << ',' << second.port
            << "]],\"hosts\":[";
  for (size_t i = 0; i < hosts.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << '[' << hosts[i].address << ',' << hosts[i].port << ']';
  }
  std::cout << "],\"body\":\"" << hex(out.bytes) << "\"}";
}
std::vector<int> regulate(Matrix loss, Slots sockets, const std::array<int, 8> &primary) {
  std::vector<int> rejected;
  for (;;) {
    std::array<int, 8> incomingPlusOutgoing{}, outgoing{};
    for (int i = 0; i < 8; ++i) if (sockets[i] >= 0 && primary[i]) {
      for (int j = 0; j < 8; ++j)
        if (sockets[j] >= 0 && primary[j] && loss[8 * i + j]) {
          ++outgoing[i]; ++incomingPlusOutgoing[i]; ++incomingPlusOutgoing[j];
        }
    }
    int selected = -1, degree = 0, fewestOutgoing = 0x7fffffff;
    for (int i = 0; i < 8; ++i) if (sockets[i] >= 0) {
      if (incomingPlusOutgoing[i] > degree ||
          (incomingPlusOutgoing[i] == degree && fewestOutgoing > outgoing[i])) {
        fewestOutgoing = outgoing[i]; selected = i; degree = incomingPlusOutgoing[i];
      }
    }
    if (selected == -1 || degree == 0) break;
    for (int i = 0; i < 8; ++i) { loss[8 * selected + i] = 0; loss[8 * i + selected] = 0; }
    rejected.push_back(selected);
    int socket = sockets[selected];
    for (int &id : sockets) if (id == socket) id = -1;
  }
  return rejected;
}
int main() {
  std::cout << "{\"provenance\":\"Manually translated C++ session reference; no official EXE execution or client captures\",\"launches\":[";
  launch("fixed-one-player", 200, 8, 0x11223344u,
         {0,-1,-1,-1,-1,-1,-1,-1}, {3,0,0,0,0,0,0,0}, {0,1,2,3,4,5,6});
  std::cout << ',';
  launch("holes-and-all-random-branches", 22, 8, 0x7ffffff0u,
         {10,-1,7,10,-1,-1,10,-1}, {0,0,3,5,0,0,6,0}, {0,2,1,4,3,6,5,1,15,30,0,60,1});
  std::cout << ',';
  launch("six-spawns-not-eight", 191, 6, 0xfffffff0u,
         {0,4,10,-1,-1,-1,-1,-1}, {0,3,5,0,0,0,0,0}, {32767,0,1,9,7,29,32767});
  std::cout << "],\"begin\":[";
  begin(22, 0x80000010u, 42, 0x7fff, 40, 20); std::cout << ',';
  begin(194, 0xfffffff0u, 0xffffffffu, 0x11223344u, 50, 3);
  std::cout << "],\"peers\":[";
  peerCase("observed-duplicate-leaves-hole", {0xcb007109u,40000}, {0xcb007109u,40000}, {0x0a010203u,6000}); std::cout << ',';
  peerCase("same-IP-different-port-is-not-duplicate", {0xcb007109u,40000}, {0xcb007109u,40001}, {0xcb007109u,40002}); std::cout << ',';
  peerCase("duplicate-second-advertisement", {0xcb007109u,40000}, {0x0a010203u,6000}, {0x0a010203u,6000}); std::cout << ',';
  peerCase("zero-address-ignores-nonzero-port", {0xcb007109u,40000}, {0,4321}, {0x0a010203u,6000}); std::cout << ',';
  peerCase("no-advertisements", {0xcb007109u,40000}, {0,0}, {0,0});
  Packet udp(false); udp.byte(11); udp.dword(0x11223344u); udp.word(7); udp.dword(0x10203040u);
  udp.dword(0x0a010203u); udp.word(4321); udp.dword(0); udp.word(0);
  Packet legacy = udp; legacy.bytes[0] = 1; legacy.dword(3618572696u);
  for (auto n : {8,3,3,6,9,3,3,5}) legacy.byte(n);
  Packet ready; ready.byte(109); ready.dword(3618572696u);
  for (auto n : {8,3,3,6,9,3,3,5}) ready.byte(n);
  std::cout << "],\"udp\":{\"peerBody\":\"" << hex(udp.bytes) << "\",\"peerDatagram\":\"" << datagram(udp)
            << "\",\"legacyReadyBody\":\"" << hex(legacy.bytes) << "\",\"legacyReadyDatagram\":\"" << datagram(legacy)
            << "\",\"tcpReadyBody\":\"" << hex(ready.bytes) << "\"},\"deadlines\":[";
  bool comma = false;
  for (uint32_t first : {0u,0x7ffffff0u,0xfffffff0u}) {
    for (uint32_t limit : {8000u,25000u,30000u}) {
      for (uint32_t delta : {limit-1,limit,limit+1}) {
        if (comma) std::cout << ',';
        comma = true; uint32_t now = first + delta;
        std::cout << "{\"first\":" << first << ",\"now\":" << now << ",\"limit\":" << limit
                  << ",\"expired\":" << (uint32_t(now-first) > limit ? "true" : "false") << '}';
      }
    }
  }
  std::cout << "],\"graphs\":[";
  const std::array<int, 3> slots{{0,2,7}};
  const Slots sockets{{0,-1,1,-1,-1,-1,-1,2}};
  const std::array<int, 8> primary{{1,0,1,0,0,0,0,1}};
  for (uint32_t mask = 0; mask < 512; ++mask) {
    if (mask) std::cout << ',';
    Matrix matrix{};
    for (int bit = 0; bit < 9; ++bit)
      matrix[slots[bit/3]*8 + slots[bit%3]] = (mask >> bit) & 1u;
    std::cout << "{\"mask\":" << mask << ",\"eject\":";
    arrayJSON(regulate(matrix,sockets,primary)); std::cout << '}';
  }
  std::cout << "]}\n";
}
