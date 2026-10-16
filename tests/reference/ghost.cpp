// OUR manual fixed-width translation of supplied FXGS ghost branches.
// Generate0041F3F1, Destroy0041B3FF, ownership0041CB51, departure0041AE53.
// Does not execute the official EXE or import any production TypeScript.
#include <array>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <set>
#include <sstream>
#include <string>
using A = std::array<int32_t,8>;
struct State { A slot{}, ghost{}; int32_t count=0; uint32_t last=0; };
struct Packet {
  std::ostringstream stream;
  void one(uint32_t value) { stream << std::hex << std::setfill('0') << std::setw(2) << unsigned(uint8_t(value ^ 0x5a)); }
};
int32_t add32(int32_t value, uint32_t delta) {
  const uint32_t bits = uint32_t(value) + delta; int32_t out; std::memcpy(&out,&bits,sizeof(out)); return out;
}
State image(unsigned mask, int32_t count) {
  State s; s.slot.fill(-1); s.ghost.fill(-1); s.count=count;
  for (int i=0; i<8; ++i) if (mask & (1u<<i)) { const int ghost=(3*i+1)%8; s.slot[i]=ghost; s.ghost[ghost]=i; }
  return s;
}
std::string generate(State &s, uint32_t now, uint32_t elapsed, uint32_t start, uint32_t frequency, int slot, uint8_t parameter) {
  if ((s.last!=0 && uint32_t(now-s.last)<frequency) || elapsed<start || s.count>=8) return {};
  if (s.slot[slot]!=-1) return {}; // native duplicate diag (silent if freq0), no mutation
  int ghost=0; while (ghost<8 && s.ghost[ghost]!=-1) ++ghost;
  if (ghost==8) return {};
  s.last=now; s.slot[slot]=ghost; s.ghost[ghost]=slot; s.count=add32(s.count,1);
  Packet p; p.one(166); p.one(unsigned(ghost)); p.one(unsigned(slot)|0x80u); p.one(parameter); return p.stream.str();
}
std::string destroy(State &s, int ghost) {
  const int slot=s.ghost[ghost]; if (slot==-1 || s.slot[slot]!=ghost) return {};
  s.ghost[ghost]=-1; s.slot[slot]=-1; s.count=add32(s.count,0xffffffffu);
  Packet p; p.one(167); p.one(unsigned(ghost)); return p.stream.str();
}
void array(const A &a) { std::cout << '['; bool comma=false; for (auto v:a) { if (comma) std::cout << ','; comma=true; std::cout << v; } std::cout << ']'; }
void state(const State &s) { std::cout << "{\"BySlot\":"; array(s.slot); std::cout << ",\"ByGhost\":"; array(s.ghost); std::cout << ",\"Count\":" << s.count << ",\"Last\":" << s.last << '}'; }
void result(const State &before, const State &after, const std::string &packet) {
  std::cout << ",\"Before\":"; state(before); std::cout << ",\"After\":"; state(after); std::cout << ",\"Packet\":\"" << packet << "\"}";
}
int population(unsigned mask) { int n=0; for (int i=0; i<8; ++i) n += (mask>>i)&1u; return n; }
struct Map { int index; int32_t start,frequency; };
constexpr std::array<Map,5> maps{{{200,0,0},{22,40,20},{194,50,3},{-1,0,20},{-1,-1,-1}}};
int main() {
  std::cout << "{\"Evidence\":\"Independent manual C++ ghost translation; NOT original execution/client/security proof\",\"Maps\":[";
  bool comma=false;
  for (auto m:maps) { if (comma) std::cout << ','; comma=true; std::cout << "{\"Index\":" << m.index << ",\"StartSeconds\":" << m.start << ",\"FrequencySeconds\":" << m.frequency << '}'; }
  std::cout << "],\"Generate\":["; comma=false;
  for (unsigned mask=0; mask<256; ++mask) for (int32_t count:std::set<int32_t>{population(mask),8}) for (int slot=0; slot<8; ++slot) {
    const auto before=image(mask,count); auto after=before; const uint8_t parameter=std::array<uint8_t,5>{{0,1,127,128,255}}[(mask+unsigned(slot))%5];
    const auto packet=generate(after,0,0,0,0,slot,parameter);
    if (comma) std::cout << ',';
    comma=true; std::cout << "{\"Mask\":" << mask << ",\"Slot\":" << slot << ",\"Parameter\":" << unsigned(parameter); result(before,after,packet);
  }
  std::cout << "],\"Destroy\":["; comma=false;
  for (unsigned mask=0; mask<256; ++mask) for (int32_t count:std::set<int32_t>{population(mask),0,8}) for (int ghost=0; ghost<8; ++ghost) {
    const auto before=image(mask,count); auto after=before; const auto packet=destroy(after,ghost);
    if (comma) std::cout << ',';
    comma=true; std::cout << "{\"Mask\":" << mask << ",\"Ghost\":" << ghost; result(before,after,packet);
  }
  std::cout << "],\"SignedCounts\":["; comma=false;
  for (unsigned mask:{0u,0x49u}) for (int32_t count:{std::numeric_limits<int32_t>::min(),-1,0,7,8,9,std::numeric_limits<int32_t>::max()}) for (int op:{0,1,2}) {
    const auto before=image(mask,count); auto after=before; const int target=op==0?0:1;
    const auto packet=op==2?destroy(after,target):generate(after,0,0,0,0,target,255);
    if (comma) std::cout << ',';
    comma=true; std::cout << "{\"Operation\":" << (op==2?152:151) << ",\"Target\":" << target << ",\"Parameter\":255"; result(before,after,packet);
  }
  std::cout << "],\"Timings\":["; comma=false;
  for (unsigned map=0; map<maps.size(); ++map) for (uint32_t tick:{0u,100u,0xfffffff0u}) for (uint32_t stopped:{0u,0x7fffffffu}) {
    const uint32_t start=uint32_t(maps[map].start)*1000u, frequency=uint32_t(maps[map].frequency)*1000u;
    for (bool bootstrap:{false,true}) for (uint32_t delta:bootstrap?std::set<uint32_t>{0u,frequency-1u,frequency,frequency+1u,0xffffffffu}:std::set<uint32_t>{0xffffffffu,0u,1u}) for (int actor=0; actor<(bootstrap?2:1); ++actor) {
      auto before=image(0,0); std::string first;
      if (bootstrap) first=generate(before,tick+start,start,start,frequency,0,128);
      const uint32_t now=tick+start+delta; auto after=before;
      const auto packet=generate(after,now,uint32_t(now-tick),start,frequency,actor,255);
      if (comma) std::cout << ',';
      comma=true; std::cout << "{\"Map\":" << map << ",\"Start\":" << tick << ",\"Stopped\":" << stopped << ",\"Bootstrap\":" << (bootstrap?"true":"false") << ",\"FirstPacket\":\"" << first << "\",\"Now\":" << now << ",\"Actor\":" << actor;
      result(before,after,packet);
    }
  }
  std::cout << "]}\n";
}
