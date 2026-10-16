// Manual STATIC translation of SendGameResult 0041FF51, IncDecExp 00416A1D,
// GetLookLevel 00416E47 and Win/Draw/Lose 0041D1C1..0041D219.
// Reuses ONLY the independent C++ calculator model, NEVER the TS rewrite.
// This does NOT execute supplied binaries or prove original-client behavior.
#include "scoring-model.h"
#include "game-result-rules.h"

struct User {
  uint32_t Serial = 0;
  int32_t Exp = 0, Money = 0, Win = 0, Draw = 0, Lose = 0;
  int CachedLevel = 0;
  int32_t FakeLevel = 0, IconEnabled = 0, IconSN = 0;
  int DynamicModified = 0, SimpleModified = 0;
  uint32_t Games = 0;
  int IncDecExp(int32_t delta) {
    Exp = std::max(0, signed32(static_cast<uint32_t>(Exp) + static_cast<uint32_t>(delta)));
    DynamicModified = 1;
    const int next = level(Exp);
    if (next == CachedLevel) return 0;
    const int direction = next > CachedLevel ? 1 : -1;
    CachedLevel = next; SimpleModified = 1;
    return direction;
  }
  int LookLevel() const {
    return std::clamp(signed32(static_cast<uint32_t>(CachedLevel) + static_cast<uint32_t>(FakeLevel)), 1, 450);
  }
};
struct Case {
  std::string Name;
  bool Premium = false;
  uint32_t Duration = 45001;
  int Winner = 0, CalculatorPremium = -1;
  Players Launch{};
  std::array<User, 8> Users{};
  Ints CurrentColors{}, States{}, Shop{}, Kills{}, Saves{}, Departed{};
};
static Case base(const std::string& name) {
  Case c; c.Name = name;
  c.Launch = Players{{{1,0,1,1},{450,0,1,1},{80,0,2,0},{225,3,2,1},{15,3,3,0},{449,3,3,255}}};
  c.States = Ints{{2,6,2,1,1,1,1,1}};
  c.Shop[3] = 1;
  c.Kills = Ints{{3,0,0,2,0,257,0,0}};
  c.Saves = Ints{{2,1,0,0,1,0,0,0}};
  for (int i = 0; i < 8; ++i) {
    c.CurrentColors[i] = c.Launch[i].Color;
    if (!c.Launch[i].Level) continue;
    auto& u = c.Users[i]; const int n = c.Launch[i].Level;
    u.Serial = 0x81020300u + static_cast<uint32_t>(i) * 0x10203u;
    u.Exp = n == 450 ? INT32_MAX - 10 : levels[n] - 1;
    u.Money = 37 + 7 * i; u.Win = 10 + i; u.Draw = 20 + i; u.Lose = 30 + i;
    u.CachedLevel = n; u.FakeLevel = i == 0 ? 0 : i == 1 ? INT32_MAX : 17 - 5 * i;
    u.IconEnabled = i % 2; u.IconSN = 5000 + i;
    u.DynamicModified = i % 2; u.SimpleModified = i == 3 ? 7 : 0;
    u.Games = static_cast<uint32_t>(i);
  }
  return c;
}
static void ints(const Ints& a) {
  std::cout << '[';
  for (int i = 0; i < 8; ++i) { if (i) std::cout << ','; std::cout << a[i]; }
  std::cout << ']';
}
static void snapshot(const User& u, int slot) {
  std::cout << "{\"Dynamic\":{\"ID\":\"Result" << slot << "\",\"Money\":" << u.Money
    << ",\"Exp\":" << u.Exp << ",\"Win\":" << u.Win << ",\"Draw\":" << u.Draw << ",\"Lose\":" << u.Lose
    << "},\"Level\":" << u.CachedLevel << ",\"FakeLevel\":" << u.FakeLevel
    << ",\"LevelIconEnabled\":" << u.IconEnabled << ",\"LevelIconSN\":" << u.IconSN
    << ",\"DynamicModified\":" << u.DynamicModified << ",\"SimpleInfoModified\":" << u.SimpleModified
    << ",\"GamesSinceFlush\":" << u.Games << '}';
}
struct Packet {
  std::vector<uint8_t> bytes;
  void Byte(int n) { bytes.push_back(static_cast<uint8_t>(n) ^ 0x5au); }
  void Word(int n) {
    const auto v = static_cast<uint16_t>(n) ^ 0xa569u;
    bytes.push_back(static_cast<uint8_t>(v >> 8)); bytes.push_back(static_cast<uint8_t>(v));
  }
  void Dword(uint32_t n) {
    const uint32_t v = n ^ 0x96ca5395u;
    for (int shift = 24; shift >= 0; shift -= 8) bytes.push_back(static_cast<uint8_t>(v >> shift));
  }
  std::string Hex() const {
    std::ostringstream out; out << std::hex << std::setfill('0');
    for (uint8_t n : bytes) out << std::setw(2) << static_cast<int>(n);
    return out.str();
  }
};
static void emit(const Case& c) {
  Model model(c.Premium); model.Init(c.Launch); model.Teams(c.Launch);
  model.s.premium = c.CalculatorPremium;
  for (int i = 0; i < 8; ++i) {
    for (int n = 0; n < c.Kills[i]; ++n) model.Killer(0, i);
    for (int victim = 0; victim < c.Saves[i]; ++victim) model.Saver(victim, i);
  }
  Players current = c.Launch;
  bool special = false, shop = false;
  int premiumTeammates = 0;
  for (int i = 0; i < 8; ++i) {
    current[i].Color = c.CurrentColors[i];
    if (c.Departed[i]) current[i].Level = 0;
    if (c.States[i] == 5 || c.States[i] == 6 || c.States[i] == 7) special = true;
    if (!current[i].Level) continue;
    if (c.Shop[i] && current[i].Color != c.Winner) shop = true;
    if (model.s.colors[i] == c.Winner && current[i].Authencode == 1) ++premiumTeammates;
  }
  float ratio = 1;
  if (c.Duration <= 15000u) ratio = 0;
  else if (c.Duration <= 45000u) {
    float ramp; const uint32_t bits = rampBits; std::memcpy(&ramp, &bits, 4);
    ratio = f32(static_cast<double>(c.Duration - 15000u) * static_cast<double>(ramp));
  }
  Packet packet; packet.Byte(163); packet.Byte(special); packet.Byte(c.Winner);
  packet.Byte(0); packet.Byte(0); packet.Byte(shop);
  std::cout << "{\"Name\":\"" << c.Name << "\",\"PremiumChannel\":" << (c.Premium ? "true" : "false")
    << ",\"WinningColor\":" << c.Winner << ",\"Duration\":" << c.Duration
    << ",\"CalculatorPremium\":" << c.CalculatorPremium << ",\"Players\":[";
  for (int i = 0; i < 8; ++i) {
    if (i) std::cout << ',';
    const auto& p = c.Launch[i];
    if (!p.Level) { std::cout << "null"; continue; }
    std::cout << "{\"Level\":" << p.Level << ",\"Color\":" << p.Color << ",\"Socket\":" << p.Socket
      << ",\"Authencode\":" << p.Authencode << ",\"GlobalSerialNo\":" << c.Users[i].Serial << ",\"State\":";
    snapshot(c.Users[i], i); std::cout << '}';
  }
  std::cout << "],\"CurrentColors\":"; ints(c.CurrentColors);
  std::cout << ",\"States\":"; ints(c.States);
  std::cout << ",\"ShopAttempts\":"; ints(c.Shop);
  std::cout << ",\"KillCounts\":"; ints(c.Kills);
  std::cout << ",\"SaveCounts\":"; ints(c.Saves);
  std::cout << ",\"Departed\":"; ints(c.Departed);
  std::cout << ",\"Expected\":{\"ExperienceScale\":" << ratio
    << ",\"HasLapOrHouseState\":" << (special ? "true" : "false")
    << ",\"DifferentColorShopItemAttempted\":" << (shop ? "true" : "false") << ",\"Players\":[";
  std::vector<int> rankSlots;
  for (int i = 0; i < 8; ++i) {
    if (i) std::cout << ',';
    const auto& p = current[i];
    packet.Byte(p.Level ? 1 : 0);
    if (!p.Level) { std::cout << "null"; continue; }
    User after = c.Users[i];
    model.s.premium = p.Authencode == 1;
    const bool isDraw = c.Winner == -1, isWin = !isDraw && p.Color == c.Winner;
    const int category = isDraw ? 3 : isWin ? static_cast<int>(model.Win(i, current, c.States)) : 2;
    int detail = !c.Premium && p.Authencode == 1 ? 3 : 0;
    int delta = 0, direction = 0; double multiplier = 1;
    if (!model.s.invalid) {
      int reward;
      if (isDraw) reward = model.Reward(i, 10, 0, 50);
      else if (isWin) {
        multiplier = shop ? shopMultiplier : 1;
        if (model.s.own[i] >= 2 && premiumTeammates >= 2) multiplier += premiumBonus;
        reward = model.Reward(i, 100, 50, 200);
      } else reward = model.KillSave(i);
      delta = static_cast<int32_t>(reward * static_cast<double>(ratio) * multiplier);
      direction = after.IncDecExp(delta);
      if (isDraw) after.Draw = inc32(after.Draw);
      else if (isWin) { after.Win = inc32(after.Win); detail = model.Detail(i, current); }
      else after.Lose = inc32(after.Lose);
      after.DynamicModified = 1;
    }
    int oldPercent = percentage(c.Users[i].Exp);
    const int newPercent = percentage(after.Exp);
    if (oldPercent > newPercent) oldPercent = 0;
    if (detail == 3 && delta == 0) detail = 0;
    const bool up = direction > 0;
    if (up) rankSlots.push_back(i);
    packet.Dword(after.Serial); packet.Byte(category); packet.Byte(model.s.killCount[i]); packet.Byte(model.s.saveCount[i]);
    packet.Word(oldPercent); packet.Word(newPercent); packet.Word(after.LookLevel()); packet.Byte(up); packet.Byte(detail);
    std::cout << "{\"Slot\":" << i << ",\"GlobalSerialNo\":" << after.Serial << ",\"Category\":" << category
      << ",\"KillCount\":" << model.s.killCount[i] << ",\"SaveCount\":" << model.s.saveCount[i]
      << ",\"ExperienceDelta\":" << delta << ",\"LevelDirection\":" << direction
      << ",\"OldPercentage\":" << oldPercent << ",\"NewPercentage\":" << newPercent
      << ",\"LookLevel\":" << after.LookLevel() << ",\"LevelUp\":" << (up ? "true" : "false")
      << ",\"Detail\":" << detail << ",\"WinMultiplier\":" << multiplier << ",\"Before\":";
    snapshot(c.Users[i], i); std::cout << ",\"After\":"; snapshot(after, i); std::cout << '}';
  }
  std::cout << "],\"RankUpdateSlots\":[";
  for (size_t i = 0; i < rankSlots.size(); ++i) { if (i) std::cout << ','; std::cout << rankSlots[i]; }
  std::cout << "],\"CalculatorPremiumAfter\":" << model.s.premium << ",\"Packet\":\"" << packet.Hex() << "\"}}";
}
int main() {
  std::cout << std::setprecision(17);
  std::cout << "{\"Evidence\":\"Manual C++ static model, NOT native execution, settlement or client evidence\",\"Cases\":[";
  bool comma = false;
  const auto output = [&](const Case& c) { if (comma) std::cout << ','; comma = true; emit(c); };
  const uint32_t durations[] = {0,1,14999,15000,15001,15002,29999,30000,44999,45000,45001,UINT32_MAX};
  for (bool premium : {false, true}) for (int winner : {-1,0,3}) for (uint32_t duration : durations) {
    auto c = base(std::string(premium ? "premium" : "normal") + "-w" + std::to_string(winner) + "-t" + std::to_string(duration));
    c.Premium = premium; c.Winner = winner; c.Duration = duration; output(c);
  }
  auto c = base("shop-attempt-on-winner-only"); c.Shop.fill(0); c.Shop[0] = 1; output(c);
  c = base("empty-shop-and-lap-state"); c.Shop.fill(0); c.Shop[7] = 1; c.CurrentColors[7] = 7; c.States[7] = 5; output(c);
  c = base("empty-house-tie-state"); c.States[7] = 7; output(c);
  c = base("extra-empty-winning-state-affects-category"); c.States[7] = 6; output(c);
  c = base("current-versus-cached-colors"); c.CurrentColors[1] = 3; c.CurrentColors[4] = 0; output(c);
  c = base("solo-launch-team-has-no-premium-cohort-bonus"); c.Launch[2].Color = 7; c.CurrentColors[2] = 0; output(c);
  c = base("single-team-multiple-sockets-is-valid");
  for (int i = 0; i < 6; ++i) { c.Launch[i].Color = c.CurrentColors[i] = 0; c.States[i] = 2; }
  output(c);
  c = base("departed-two-local-players"); c.Departed[0] = c.Departed[1] = 1; c.States[0] = c.States[1] = 1; output(c);
  c = base("same-socket-invalid");
  for (int i = 2; i < 8; ++i) c.Launch[i] = Player{};
  output(c);
  c = base("single-invalid"); for (int i = 1; i < 8; ++i) c.Launch[i] = Player{}; output(c);
  c = base("all-empty"); c.Launch = Players{}; output(c);
  c = base("signed-result-counter-wrap"); c.Users[0].Win = INT32_MAX; c.Users[3].Lose = INT32_MAX; output(c);
  c = base("zero-delta-refreshes-stale-cached-levels"); c.Duration = 15000;
  c.Users[0].Exp = levels[200]; c.Users[1].Exp = 0; output(c);
  c = base("different-color-shop-flag-on-draw"); c.Winner = -1; c.Premium = true; output(c);
  c = base("valid-unused-winner-color"); c.Winner = 7; c.Premium = true; output(c);
  std::cout << "],\"ExperienceTransitions\":[";
  const int32_t oldValues[] = {INT32_MIN, -1, 0, 1, levels[1] - 1, levels[1], levels[100] - 1, levels[449], INT32_MAX};
  const int32_t deltas[] = {INT32_MIN, -221, -1, 0, 1, 221, INT32_MAX};
  comma = false;
  for (int32_t old : oldValues) for (int32_t delta : deltas) {
    if (comma) std::cout << ',';
    comma = true;
    User u; u.Exp = old; u.CachedLevel = level(old);
    const int before = u.CachedLevel, direction = u.IncDecExp(delta);
    std::cout << "{\"BeforeExp\":" << old << ",\"Delta\":" << delta << ",\"BeforeLevel\":" << before
      << ",\"AfterExp\":" << u.Exp << ",\"AfterLevel\":" << u.CachedLevel << ",\"Direction\":" << direction
      << ",\"DynamicModified\":" << u.DynamicModified << ",\"SimpleInfoModified\":" << u.SimpleModified << '}';
  }
  std::cout << "]}";
}
