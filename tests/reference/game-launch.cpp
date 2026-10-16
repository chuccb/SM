// Independent MANUAL fixed-width translation of narrow supplied FXGS branches:
// random-map0040C6D1, start-color00420F19, Launch00420BB3,
// Start0041BDCF, airplane probability004204EB, loading0041DF6B.
// Runs OUR C++ only. NOT native execution, client compatibility or verdict proof.
#include <array>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <vector>
struct Packet {
  std::vector<uint8_t> bytes;
  explicit Packet(uint8_t type) { one(type); }
  void one(uint32_t n) { bytes.push_back(uint8_t(n ^ 0x5au)); }
  void two(uint32_t n) { n ^= 0xa569u; bytes.push_back(uint8_t(n >> 8)); bytes.push_back(uint8_t(n)); }
  void four(uint32_t n) { n ^= 0x96ca5395u; for (int shift = 24; shift >= 0; shift -= 8) bytes.push_back(uint8_t(n >> shift)); }
  std::string hex() const { std::ostringstream out; out << std::hex << std::setfill('0'); for (auto b : bytes) out << std::setw(2) << unsigned(b); return out.str(); }
};
template<class T> void array(const T& data) { std::cout << '['; bool comma = false; for (auto v : data) { if (comma) { std::cout << ','; } comma = true; std::cout << +v; } std::cout << ']'; }
std::array<int,8> remap(std::array<int,8> before, int max_team) {
  if (max_team >= 8) return before;
  std::array<int,8> lookup{}; lookup.fill(-1);
  for (int b : before) lookup[b & 31] = b & 31;
  for (int bad : {1,2,4,7}) if (lookup[bad] != -1) for (int target : {0,3,5,6}) if (lookup[target] == -1) {
    lookup[bad] = target; lookup[target] = 0; break;
  }
  for (auto& b : before) b = (b & ~31) | lookup[b & 31];
  return before;
}
struct Map { int players, level, premium, teams, theme, practice, mission; };
constexpr std::array<Map,8> maps{{ {8,1,0,8,0,1,0}, {4,15,1,4,0,0,0}, {2,1,0,2,1,1,1}, {8,40,0,8,1,0,0},
  {6,10,0,8,2,1,2}, {8,1,1,4,2,1,0}, {4,1,0,4,1,0,0}, {8,20,0,8,0,0,1} }};
std::vector<int> eligible(int players, int level, int theme, int practice, int min_teams, bool auth, int channel) {
  std::vector<int> out;
  if (players <= 0 || players > 8) return out;
  for (unsigned i = 0; i < maps.size(); ++i) { const auto& m = maps[i];
    if (m.players >= players && (theme == -1 || m.theme == theme) && (channel != 77 || !m.mission) &&
      (auth || (m.level <= level && (channel == 41 || m.premium != 1) && (!practice || practice == m.practice))) && min_teams <= m.teams) out.push_back(int(i));
  }
  return out;
}
int main() {
  std::cout << "{\"Evidence\":\"Independent manual C++ launch translation; NOT original execution/client/verdict proof\",\"Colors\":[";
  bool comma = false;
  for (int mask = 1; mask < 256; ++mask) for (int max_team : {4,8}) {
    std::vector<int> colors; for (int i = 0; i < 8; ++i) if (mask & (1 << i)) colors.push_back(i);
    std::array<int,8> before{}; for (int i = 0; i < 8; ++i) before[i] = 0xe0 | colors[unsigned(i) % colors.size()];
    const auto after = remap(before, max_team);
    std::vector<int> changed; for (int i = 0; i < 8; ++i) if (before[i] != after[i]) changed.push_back(i);
    if (comma) { std::cout << ','; } comma = true;
    std::cout << "{\"Mask\":" << mask << ",\"MaxTeams\":" << max_team << ",\"Before\":"; array(before);
    std::cout << ",\"After\":"; array(after); std::cout << ",\"Changed\":"; array(changed); std::cout << '}';
  }
  std::cout << "],\"MapMetadata\":["; comma = false;
  for (auto m : maps) { if (comma) { std::cout << ','; } comma = true;
    std::cout << "{\"Players\":" << m.players << ",\"Level\":" << m.level << ",\"Premium\":" << m.premium << ",\"Teams\":" << m.teams << ",\"Theme\":" << m.theme << ",\"Practice\":" << m.practice << ",\"Mission\":" << m.mission << '}'; }
  std::cout << "],\"RandomMaps\":["; comma = false;
  for (int players : {0,1,2,4,8,9}) for (int level : {1,20,450}) for (int theme : {-1,0,1,2,99})
    for (int channel : {0,41,77}) for (int auth : {0,1}) for (int practice : {0,1}) for (int min_teams : {0,4}) {
      const auto candidates = eligible(players,level,theme,practice,min_teams,auth != 0,channel);
      if (comma) { std::cout << ','; } comma = true;
      std::cout << "{\"Players\":" << players << ",\"Level\":" << level << ",\"Theme\":" << theme << ",\"Channel\":" << channel << ",\"Auth\":" << auth << ",\"Practice\":" << practice << ",\"MinimumTeams\":" << min_teams << ",\"Draw\":17,\"Expected\":" << (candidates.empty() ? -1 : candidates[17 % candidates.size()]) << ",\"Draws\":" << (candidates.empty()?0:1) << '}';
    }
  std::cout << "],\"Starts\":["; comma = false;
  struct StartMap { int index; uint32_t ghost, frequency, airplane, air_frequency; int sync; bool rebirth; };
  for (auto map : std::array<StartMap,4>{{{0,0,0,0,0,4,false},{22,40,20,0,0,0,true},{194,50,3,0,0,0,true},{200,0,0,60000,22000,0,false}}})
    for (uint32_t time : {0u,100u,0xfffffff0u}) for (uint32_t key : {1u,0x7fffu}) {
      Packet begin(150); begin.four(time); begin.four(1u ^ key); begin.four(map.ghost); begin.four(map.frequency);
      Packet airplane(173); airplane.four(map.airplane); airplane.four(map.air_frequency); airplane.one(4);
      for (const auto& pair : std::array<std::array<int,2>,4>{{{0,50},{1,40},{2,5},{5,5}}}) { airplane.one(unsigned(pair[0])); airplane.one(unsigned(pair[1])); }
      if (comma) { std::cout << ','; } comma = true;
      std::cout << "{\"Map\":" << map.index << ",\"Time\":" << time << ",\"Key\":" << key << ",\"Begin\":\"" << begin.hex() << "\",\"Airplane\":\"" << airplane.hex() << "\",\"GhostMilliseconds\":" << uint32_t(map.ghost * 1000u) << ",\"FrequencyMilliseconds\":" << uint32_t(map.frequency * 1000u) << ",\"NextSequence\":2,\"Sync\":" << map.sync << ",\"Rebirth\":" << (map.rebirth?"true":"false") << '}';
    }
  std::cout << "],\"Sequences\":["; comma = false;
  for (uint32_t sequence : {0u,1u,0xffffffffu}) for (uint32_t key : {0u,0x7fffu}) {
    Packet begin(150); begin.four(7); begin.four(sequence ^ key); begin.four(0); begin.four(0);
    if (comma) { std::cout << ','; } comma = true;
    std::cout << "{\"Before\":" << sequence << ",\"Key\":" << key << ",\"After\":" << uint32_t(sequence + 1u) << ",\"Begin\":\"" << begin.hex() << "\"}";
  }
  std::cout << "],\"Airplanes\":["; comma = false;
  for (int mission : {-1,0,1,2}) for (uint32_t initial : {60000u,0xffffffffu}) {
    Packet packet(173); packet.four(initial); packet.four(22000);
    const std::vector<std::array<int,2>> entries = mission == 1 ? std::vector<std::array<int,2>>{{24,60},{69,10},{70,10},{54,10},{0,5},{1,3},{2,1},{5,1}} : std::vector<std::array<int,2>>{{0,50},{1,40},{2,5},{5,5}};
    packet.one(unsigned(entries.size())); for (auto pair : entries) { packet.one(unsigned(pair[0])); packet.one(unsigned(pair[1])); }
    if (comma) { std::cout << ','; } comma = true;
    std::cout << "{\"Mission\":" << mission << ",\"Initial\":" << initial << ",\"Frequency\":22000,\"Packet\":\"" << packet.hex() << "\"}";
  }
  std::cout << "],\"LoadingDeadlines\":["; comma = false;
  for (uint32_t joined : {0u,100u,0xfffffff0u}) for (uint32_t age : {0u,24999u,25000u,25001u,29999u,30000u,30001u,0xffffffffu}) for (int playing : {0,1}) {
    if (comma) { std::cout << ','; } comma = true;
    const uint32_t now = joined + age;
    std::cout << "{\"Joined\":" << joined << ",\"Now\":" << now << ",\"Playing\":" << playing << ",\"Expired\":" << (uint32_t(now-joined) > (playing?25000u:30000u)?"true":"false") << '}';
  }
  std::cout << "]}\n";
}
