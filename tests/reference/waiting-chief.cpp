// OUR manual fixed-width model, derived from supplied FXGS c/lst/PE.
// Never links/runs the supplied executable, Windows APIs, TS or client codec.
// CanStartGame is an OBSERVATION, not a second copy of the launch/map engine.
// Ordinary table callback models ONLY chief-left CBanChief::Init; identity,
// roster/sync/ghost/pool recovery is separately exercised through real handlers.
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

using U = std::uint32_t;
struct Clock {
  U base, increment;
  std::vector<U> reads;
  U get() { const U v = base + increment * static_cast<U>(reads.size()); reads.push_back(v); return v; }
};
struct State {
  U canTime = 0, can = 0, odd = 0, evenTime = 0, warned = 0, warnedTime = 0, oddWarned = 0, oddWarnedTime = 0;
  void setOdd(bool b, Clock& c) { odd = b; evenTime = b ? c.get() : 0; oddWarned = oddWarnedTime = 0; }
  void setCan(bool b, Clock& c) { warned = warnedTime = 0; canTime = c.get(); can = b; }
  void init(Clock& c) { setOdd(false, c); setCan(false, c); }
  void warn(bool oddBranch, Clock& c) {
    if (oddBranch) { oddWarned = 1; oddWarnedTime = c.get(); }
    else { warned = 1; warnedTime = c.get(); }
  }
};
struct Observation { bool playing, chief, super, manner; unsigned capacity, players; };
struct Output { State state; std::vector<unsigned> reasons; unsigned canCalls = 0; bool eject = false; };
static Output run(State state, const Observation& o, unsigned canResult, Clock& clock) {
  Output r{state, {}, 0, false};
  State& s = r.state;
  if (o.playing) { s.init(clock); return r; }
  if (!o.chief) return r;
  const U m = o.super ? 3U : 1U;
  const U entry = clock.get();
  const bool oddCapacity = o.manner ? (o.capacity % 2U != 0) : o.capacity <= 1;
  const auto remove = [&](unsigned reason) {
    r.reasons.push_back(reason); r.eject = true;
    s.init(clock); // ONLY ordinary chief-left callback; no imaginary DB effects
    if (reason == 3) s.setOdd(false, clock); else s.setCan(false, clock);
  };
  // HasAuthority(int)0041688A is xor eax,eax;ret4, so BOTH exemptions are false.
  if (oddCapacity) {
    if (!s.odd) s.setOdd(true, clock);
    else if (U(entry - s.evenTime) > U(5000U * m)) {
      if (!s.oddWarned) { s.warn(true, clock); r.reasons.push_back(1); }
      else if (U(entry - s.oddWarnedTime) > U(10000U * m)) { remove(3); return r; }
    }
  } else s.setOdd(false, clock);
  ++r.canCalls;
  if (canResult != 0) { s.setCan(false, clock); return r; }
  if (!s.can) { s.setCan(true, clock); return r; }
  const U readyDelay = (o.capacity == o.players ? 10000U : 20000U) * m;
  if (U(clock.get() - s.canTime) > readyDelay) {
    if (!s.warned) { s.warn(false, clock); r.reasons.push_back(0); }
    else if (U(entry - s.warnedTime) > U(10000U * m)) remove(2);
  }
  return r;
}
static std::string hex(const std::vector<unsigned char>& bytes) {
  const char* digits = "0123456789abcdef";
  std::string out;
  for (auto b : bytes) { out += digits[b >> 4]; out += digits[b & 15]; }
  return out;
}
static std::string image(const State& s) {
  std::vector<unsigned char> b;
  for (U n : {0U, s.canTime, s.can, s.odd, s.evenTime, s.warned, s.warnedTime, s.oddWarned, s.oddWarnedTime})
    for (unsigned i = 0; i < 4; ++i) b.push_back(static_cast<unsigned char>(n >> (i * 8)));
  return hex(b);
}
static std::string packet(unsigned reason, unsigned seconds) {
  const unsigned w = seconds ^ 0xa569U;
  return hex({static_cast<unsigned char>(121U ^ 0x5aU), static_cast<unsigned char>(reason ^ 0x5aU),
    static_cast<unsigned char>(w >> 8), static_cast<unsigned char>(w)});
}
static void stateJSON(const State& s) {
  std::cout << "{\"CanStartTime\":" << s.canTime << ",\"CanStart\":" << bool(s.can)
    << ",\"OddSlot\":" << bool(s.odd) << ",\"LastTimeEvenSlot\":" << s.evenTime
    << ",\"WarnedBan\":" << bool(s.warned) << ",\"WarnedTime\":" << s.warnedTime
    << ",\"WarnedBanOddSlot\":" << bool(s.oddWarned) << ",\"WarnedTimeOddSlot\":" << s.oddWarnedTime << '}';
}
static State phase(unsigned n, U marker) {
  State s; s.canTime = marker;
  if (n == 1 || n == 3 || n == 4 || n == 6 || n == 7) s.can = 1;
  if (n == 2 || n == 3 || n == 5 || n == 6 || n == 7) { s.odd = 1; s.evenTime = marker; }
  if (n == 3 || n == 4 || n == 7) { s.warned = 1; s.warnedTime = marker; }
  if (n == 3 || n == 5) { s.oddWarned = 1; s.oddWarnedTime = marker; }
  return s;
}
static unsigned caseCount = 0;
static void emit(const char* group, unsigned p, U marker, U delta, U increment, Observation o, unsigned can) {
  if (caseCount++) std::cout << ',';
  const State before = phase(p, marker);
  Clock c{U(marker + delta), increment, {}};
  const Output r = run(before, o, can, c);
  std::cout << "{\"Name\":\"" << group << '-' << caseCount << "\",\"Before\":";
  stateJSON(before);
  std::cout << ",\"Observation\":{\"Playing\":" << o.playing << ",\"ChiefAvailable\":" << o.chief
    << ",\"SuperChief\":" << o.super << ",\"Manner\":" << o.manner
    << ",\"Capacity\":" << o.capacity << ",\"PlayerCount\":" << o.players
    << "},\"TimeBase\":" << U(marker + delta) << ",\"TimeIncrement\":" << increment
    << ",\"CanStartResult\":" << can << ",\"After\":";
  stateJSON(r.state);
  std::cout << ",\"StateHex\":\"" << image(r.state) << "\",\"Notices\":[";
  const unsigned seconds = o.super ? 30U : 10U;
  for (std::size_t i = 0; i < r.reasons.size(); ++i) {
    if (i) std::cout << ',';
    const unsigned reason = r.reasons[i];
    std::cout << "{\"Reason\":" << reason << ",\"Seconds\":" << seconds
      << ",\"ChiefOnly\":" << (reason >= 2) << ",\"BodyHex\":\"" << packet(reason, seconds) << "\"}";
  }
  std::cout << "],\"Eject\":" << r.eject << ",\"ClockReads\":[";
  for (std::size_t i = 0; i < c.reads.size(); ++i) { if (i) std::cout << ','; std::cout << c.reads[i]; }
  std::cout << "],\"CanStartCalls\":" << r.canCalls << '}';
}
int main() {
  std::cout << std::boolalpha << "{\"Model\":\"OUR manual DeferBanChief plus ordinary chief-left timing callback; CanStartGame is an observation; NOT original execution, full removal, permission, grant, clock-provider or client proof\",\"Cases\":[";
  constexpr std::array<U, 19> deltas{{0U,4999U,5000U,5001U,9999U,10000U,10001U,14999U,15000U,15001U,19999U,20000U,20001U,29999U,30000U,30001U,59999U,60000U,60001U}};
  for (bool super : {false,true}) for (bool manner : {false,true})
    for (unsigned cap : {1U,3U,8U}) for (unsigned players : {cap,cap-1})
      for (unsigned p : {0U,1U,2U,3U}) for (U delta : deltas)
        emit("deadline",p,1000,delta,0,{false,true,super,manner,cap,players},0);
  // Independent +832/+833 grid; counts greater than capacity are observations,
  // NOT permission to manufacture such a live room through hardened handlers.
  for (bool super : {false,true}) for (bool manner : {false,true})
    for (unsigned cap = 0; cap <= 8; ++cap) for (unsigned count = 0; count <= 8; ++count)
      emit("capacity-not-count",1,1000,super ? 40000U : 15000U,0,{false,true,super,manner,cap,count},0);
  for (bool super : {false,true}) for (bool manner : {false,true})
    for (unsigned can = 0; can < 8; ++can) for (unsigned p : {3U,4U})
      emit("can-start-result",p,1000,60001,0,{false,true,super,manner,3,2},can);
  for (bool super : {false,true}) for (bool manner : {false,true})
    for (unsigned p : {6U,7U}) for (U delta : {10001U,20001U,30001U,60001U})
      emit("two-notice-order",p,1000,delta,7,{false,true,super,manner,3,2},0);
  for (U marker : {0U,0xfffffff0U}) for (U increment : {0U,7U,0xffffffffU})
    for (unsigned p : {1U,3U,4U,5U}) for (U delta : {10000U,10001U,30000U,30001U})
      emit("distinct-clock-wrap",p,marker,delta,increment,{false,true,false,true,3,2},0);
  for (bool playing : {false,true}) for (bool chief : {false,true})
    for (unsigned p : {0U,1U,3U,5U})
      emit("short-circuit",p,0xfffffff0U,60001,7,{playing,chief,true,true,3,2},7);
  std::cout << "],\"CaseCount\":" << caseCount << "}\n";
}
