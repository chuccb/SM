// Shared manual model remains independent of the TypeScript implementation.
#include "scoring-model.h"

static void ints(const Ints& a) {
  std::cout << '[';
  for (int i = 0; i < 8; ++i) { if (i) std::cout << ','; std::cout << a[i]; }
  std::cout << ']';
}
static std::string stateHex(const State& state) {
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  // Canonical LE words, NOT a native pointer or in-process object dump.
  for (size_t i = 0; i < sizeof(state) / 4; ++i) {
    uint32_t word;
    std::memcpy(&word, reinterpret_cast<const uint8_t*>(&state) + 4 * i, 4);
    for (int shift = 0; shift < 32; shift += 8) out << std::setw(2) << ((word >> shift) & 0xffu);
  }
  return out.str();
}
static void snapshot(const char* name, const Model& m, const Players& players, const Ints& states) {
  std::cout << "{\"Name\":\"" << name << "\",\"State\":\"" << stateHex(m.s) << "\",\"Rewards\":[";
  for (int i = 0; i < 8; ++i) {
    if (i) std::cout << ',';
    std::cout << '[' << m.Money(i) << ',' << m.Reward(i, 100, 50, 200) << ',' << m.Reward(i, 10, 0, 50) << ',' << m.KillSave(i) << ']';
  }
  std::cout << "],\"Win\":[";
  for (int i = 0; i < 8; ++i) { if (i) std::cout << ','; std::cout << (m.Win(i, players, states) ? "true" : "false"); }
  std::cout << "],\"Detail\":[";
  for (int i = 0; i < 8; ++i) { if (i) std::cout << ','; if (players[i].Level) std::cout << m.Detail(i, players); else std::cout << "null"; }
  std::cout << "]}";
}
struct Action { std::string Kind; int Victim = 0, Actor = 0, Value = 0; };
static void room(const std::string& name, const Players& players, const Ints& states, bool channel, const std::vector<Action>& actions, int premium) {
  std::cout << "{\"Name\":\"" << name << "\",\"PremiumChannel\":" << (channel ? "true" : "false") << ",\"Players\":[";
  for (int i = 0; i < 8; ++i) {
    if (i) std::cout << ',';
    const auto& p = players[i];
    if (!p.Level) std::cout << "null";
    else std::cout << "{\"Level\":" << p.Level << ",\"Color\":" << p.Color << ",\"Socket\":" << p.Socket << ",\"Authencode\":" << p.Authencode << '}';
  }
  std::cout << "],\"States\":"; ints(states);
  std::cout << ",\"Premium\":" << premium << ",\"Actions\":[";
  for (size_t i = 0; i < actions.size(); ++i) {
    if (i) std::cout << ',';
    const auto& a = actions[i];
    std::cout << "{\"Kind\":\"" << a.Kind << "\",\"Victim\":" << a.Victim << ",\"Actor\":" << a.Actor << ",\"Value\":" << a.Value << '}';
  }
  Model m(channel); m.Init(players);
  std::cout << "],\"Snapshots\":["; snapshot("Init", m, players, states);
  m.Teams(players); std::cout << ','; snapshot("Teams", m, players, states);
  for (const auto& a : actions) {
    if (a.Kind == "kill") m.Killer(a.Victim, a.Actor);
    else if (a.Kind == "save") m.Saver(a.Victim, a.Actor);
    else if (a.Kind == "nice") m.s.nice[a.Actor] = a.Value;
  }
  std::cout << ','; snapshot("Actions", m, players, states);
  m.s.premium = premium; std::cout << ','; snapshot("Premium", m, players, states);
  m.Init(players); std::cout << ','; snapshot("Reset", m, players, states);
  std::cout << "]}";
}
struct Decision { bool Ready = false, Forced = false, Conflict = false; int Color = -1; std::vector<int> Counted; };
static Decision endDecision(const Players& players, const Ints& states) {
  Decision d;
  for (int i = 0; i < 8; ++i)
    if ((players[i].Level && states[i] == 5) || states[i] == 6) d.Forced = true;
  if (!d.Forced)
    for (int i = 0; i < 8; ++i) if (players[i].Level && (states[i] == 0 || states[i] == 3)) return d;
  d.Ready = true;
  for (int i = 0; i < 8; ++i) {
    if (!players[i].Level) continue;
    if (states[i] == 2 || states[i] == 5 || states[i] == 6) {
      if (d.Color != -1 && d.Color != players[i].Color) { d.Color = -1; d.Conflict = true; return d; }
      d.Color = players[i].Color;
    }
    d.Counted.push_back(i);
  }
  return d;
}
static Ints house(const Players& players, Ints states, const Ints& counts) {
  std::array<bool, 8> eligible{};
  for (int i = 0; i < 8; ++i) if (players[i].Level && states[i] != 1 && states[i] != 4) eligible[players[i].Color] = true;
  int best = -1, winner = -1;
  bool tie = false;
  for (int color = 0; color < 8; ++color) if (eligible[color]) {
    if (counts[color] > best) { best = counts[color]; winner = color; tie = false; }
    else if (counts[color] == best) tie = true;
  }
  for (int i = 0; i < 8; ++i) if (players[i].Level) {
    if (tie || winner == -1) states[i] = 7;
    else if (players[i].Color == winner && states[i] != 1) states[i] = 6;
  }
  return states;
}
static uint32_t rng = 0x20031117u;
static uint32_t draw() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return rng; }
int main() {
  std::cout << "{\"Evidence\":\"Manual C++ translation; binary64 arithmetic + float32 stores, not original execution\",\"Levels\":[";
  std::vector<int32_t> probes{INT32_MIN, INT32_MIN + 1, -2147484, -2147483, -10000000, -1, 0, 1, INT32_MAX};
  for (int32_t n : levels) { probes.push_back(n - 1); probes.push_back(n); probes.push_back(n + 1); }
  for (size_t i = 0; i < probes.size(); ++i) {
    if (i) std::cout << ',';
    const auto n = probes[i];
    std::cout << "[" << n << ',' << level(n) << ',' << percentage(n) << ']';
  }
  std::cout << "],\"Rooms\":[";
  bool comma = false;
  const auto emit = [&](const std::string& name, const Players& p, const Ints& states, bool channel, const std::vector<Action>& actions, int premium) {
    if (comma) std::cout << ',';
    comma = true; room(name, p, states, channel, actions, premium);
  };
  emit("empty", Players{}, Ints{}, false, {}, 1);
  emit("one", Players{{{1,0,1,0}}}, Ints{}, true, {}, 1);
  emit("same-socket", Players{{{1,0,1,1},{450,7,1,0}}}, Ints{}, true, {{"kill",1,0,0},{"save",1,0,0}}, 1);
  emit("duel", Players{{{1,0,1,0},{1,3,2,1}}}, Ints{{2,1,1,1,1,1,1,1}}, false, {}, 1);
  emit("one-team-two-sockets", Players{{{1,3,1,0},{450,3,2,1}}}, Ints{}, false, {}, 0);
  Players six{{{1,0,1,1},{450,0,1,0},{80,0,2,0},{225,3,2,0},{15,3,3,0},{449,3,3,2}}};
  std::vector<Action> awards{{"kill",3,0,0},{"kill",3,0,0},{"kill",4,0,0},{"save",1,0,0},{"save",1,0,0},{"save",2,0,0},{"nice",0,0,1}};
  emit("three-v-three", six, Ints{{2,6,2,1,1,1,1,1}}, false, awards, 1);
  emit("premium-three-v-three", six, Ints{{2,6,2,1,1,1,1,1}}, true, awards, 0);
  Players holes{}; holes[0] = {450,7,1,2}; holes[7] = {1,0,2,1};
  emit("holes", holes, Ints{{2,1,1,1,1,1,1,6}}, false, {{"save",7,0,0},{"save",0,0,0}}, -1);
  for (int iteration = 0; iteration < 40; ++iteration) {
    Players p{}; Ints states{}; states.fill(1);
    const int n = iteration % 8 + 1, offset = static_cast<int>(draw() % 8);
    for (int i = 0; i < n; ++i) {
      const int slot = (3 * i + offset) % 8;
      const int auths[] = {0,1,2,255};
      p[slot] = {static_cast<int>(draw() % 450) + 1, static_cast<int>(draw() % 8), i / 2 + 1, auths[draw() % 4]};
      states[slot] = static_cast<int>(draw() % 8);
    }
    std::vector<Action> actions;
    for (int actor = 0; actor < 8; ++actor) if (p[actor].Level) {
      const int kills = static_cast<int>(draw() % 14);
      for (int k = 0; k < kills; ++k) actions.push_back({"kill",(actor+1)%8,actor,0});
      for (int victim = 0; victim < 8; ++victim) if (draw() % 3 == 0) {
        actions.push_back({"save",victim,actor,0}); actions.push_back({"save",victim,actor,0});
      }
      actions.push_back({"nice",0,actor,static_cast<int>(draw() % 2)});
    }
    emit("deterministic-" + std::to_string(iteration), p, states, iteration % 2 != 0, actions, iteration % 3);
  }
  std::cout << "],\"Decisions\":[";
  Players dp{}; dp[0] = {1,0,1,0}; dp[1] = {1,3,1,0}; dp[2] = {1,0,2,0};
  for (int pattern = 0; pattern < 512; ++pattern) {
    if (pattern) std::cout << ',';
    Ints states{}; states.fill(1);
    for (int i = 0; i < 3; ++i) states[i] = (pattern >> (3*i)) & 7;
    // Include empty-slot 5/6 to pin the native precedence/occupancy difference.
    states[7] = pattern % 3 == 0 ? 6 : (pattern % 3 == 1 ? 5 : 1);
    const auto d = endDecision(dp, states);
    Ints counts{}; counts[0] = pattern % 5; counts[3] = (pattern / 5) % 5;
    std::cout << "{\"States\":"; ints(states);
    std::cout << ",\"Ready\":" << (d.Ready ? "true" : "false") << ",\"Forced\":" << (d.Forced ? "true" : "false")
      << ",\"WinningColor\":" << d.Color << ",\"ConflictingClaims\":" << (d.Conflict ? "true" : "false") << ",\"CountedSlots\":[";
    for (size_t i = 0; i < d.Counted.size(); ++i) { if (i) std::cout << ','; std::cout << d.Counted[i]; }
    std::cout << "],\"HouseCounts\":"; ints(counts);
    std::cout << ",\"HouseStates\":"; ints(house(dp, states, counts));
    std::cout << '}';
  }
  std::cout << "]}\n";
}
