// OUR independent fixed-width manual translation of OnRequestAirplane0041D7C0.
// No execution of the original binary, no production TS/packet/world imports.
// Native count0/>3 only diagnoses, then falls through. We model safe <=10;
// production deliberately rejects >3 (modern hardening), not native parity.
#include <array>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>
using Entry = std::array<uint8_t,4>;
using Entries = std::vector<Entry>;
struct State { uint32_t last=0; std::array<int32_t,250> box{}; };
struct Outcome { std::string decision, packet; };
void seed(State &s, uint32_t salt) {
  for (uint32_t i=0;i<s.box.size();++i) { const uint32_t bits=(i+1u)*0x01020304u^salt; std::memcpy(&s.box[i],&bits,4); }
}
uint32_t fingerprint(const State &s) {
  uint32_t h=2166136261u;
  for (int32_t v:s.box) for (int shift=0;shift<32;shift+=8) h=(h ^ uint8_t(uint32_t(v)>>shift))*16777619u;
  return h; // Test-only full250-word fingerprint, NOT a protocol/security hash.
}
struct Packet {
  std::ostringstream stream;
  void one(uint32_t v) { stream << std::hex << std::setfill('0') << std::setw(2) << unsigned(uint8_t(v^0x5au)); }
  void four(uint32_t v) { v ^= 0x96ca5395u; for (int shift=24;shift>=0;shift-=8) stream << std::hex << std::setfill('0') << std::setw(2) << unsigned(uint8_t(v>>shift)); }
};
Outcome request(State &s, uint32_t now, const Entries &entries) {
  if (now<uint32_t(s.last+7000u)) return {"throttled",{}};
  // No chief, map-initial/frequency, stopped/elapsed time, RNG or sync manager.
  for (auto row:entries) if (row[1]>=250) return {"invalid-box",{}};
  const uint32_t when=now+2000u;
  Packet p; p.one(171); p.four(when); p.one(uint32_t(entries.size()));
  for (auto row:entries) for (auto v:row) p.one(v);
  for (auto row:entries) s.box[row[1]]=0;
  s.last=when; return {"accepted",p.stream.str()};
}
Entries records(int count, int base, bool duplicate=false) {
  Entries out;
  for (int i=0;i<count;++i) out.push_back(Entry{{uint8_t(base+i*73),uint8_t(duplicate?base:(base+i*83)%250),uint8_t((base^0xaa)+i*7),uint8_t(255-base+i*11)}});
  return out;
}
void entries(const Entries &rows) {
  std::cout << '['; bool comma=false;
  for (auto row:rows) { if (comma) std::cout << ','; comma=true; std::cout << '['; for (int i=0;i<4;++i) { if (i) std::cout << ','; std::cout << unsigned(row[i]); } std::cout << ']'; }
  std::cout << ']';
}
void after(const State &s, const Outcome &out) {
  std::cout << "{\"Last\":" << s.last << ",\"StateHash\":" << fingerprint(s) << ",\"Cleared\":[";
  bool comma=false; for (unsigned i=0;i<s.box.size();++i) if (!s.box[i]) { if (comma) std::cout << ','; comma=true; std::cout << i; }
  std::cout << "],\"Decision\":\"" << out.decision << "\",\"Packet\":\"" << out.packet << "\"}";
}
int main() {
  std::cout << "{\"Evidence\":\"Independent manual C++ airplane translation; NOT original execution/client/security proof\",\"Bodies\":[";
  bool comma=false; unsigned serial=0; uint32_t now=7000; State s;
  auto body=[&](const Entries &rows) {
    const uint32_t salt=0x13579bdfu^(++serial*0x9e3779b9u); seed(s,salt); const auto out=request(s,now,rows);
    if (comma) std::cout << ',';
    comma=true; std::cout << "{\"Tick\":" << now << ",\"Seed\":" << salt << ",\"Entries\":"; entries(rows); std::cout << ",\"After\":"; after(s,out); std::cout << '}'; now+=9000u;
  };
  for (int box=0;box<250;++box) for (int count=1;count<=3;++count) for (bool duplicate:{false,true}) body(records(count,box,duplicate));
  for (int field:{0,2,3}) for (unsigned value=0;value<256;++value) { Entry e{{17,uint8_t(value%250),127,255}}; e[field]=uint8_t(value); body(Entries{e}); }
  std::cout << "],\"Sequences\":["; comma=false;
  constexpr std::array<uint32_t,11> firsts{{0u,6999u,7000u,7001u,0x7fffffffu,0x80000000u,0xffffdcd7u,0xffffdcd8u,0xfffff82fu,0xfffff830u,0xffffffffu}};
  for (uint32_t start:{0u,100u,0xfffffff0u}) for (uint32_t stopped:{0u,0x80000000u}) for (unsigned i=0;i<firsts.size();++i) {
    const auto first=firsts[i]; const auto a=records(int(i%4),70); State probe; seed(probe,0x10203040u); request(probe,first,a);
    const uint32_t deadline=probe.last+7000u;
    for (uint32_t second:std::set<uint32_t>{0u,first,deadline-1u,deadline,deadline+1u,0x7fffffffu,0x80000000u,0xffffffffu}) {
      State state; seed(state,0x10203040u); const auto b=records(int((i+1)%4),200);
      if (comma) std::cout << ',';
      comma=true; std::cout << "{\"Start\":" << start << ",\"Stopped\":" << stopped << ",\"Seed\":270544960,\"Steps\":[";
      unsigned n=0;
      for (const auto &step:std::array<std::pair<uint32_t,Entries>,2>{{{first,a},{second,b}}}) {
        if (n++) std::cout << ',';
        const auto out=request(state,step.first,step.second); std::cout << "{\"Tick\":" << step.first << ",\"Entries\":"; entries(step.second); std::cout << ",\"After\":"; after(state,out); std::cout << '}';
      }
      std::cout << "]}";
    }
  }
  std::cout << "],\"InvalidBoxes\":["; comma=false;
  for (int count=1;count<=3;++count) for (int bad=0;bad<count;++bad) for (int box=250;box<256;++box) {
    State state; seed(state,0x10203040u); auto rows=records(count,1); rows[bad][1]=uint8_t(box); const auto out=request(state,7000,rows);
    if (comma) std::cout << ',';
    comma=true; std::cout << "{\"Seed\":270544960,\"Tick\":7000,\"Entries\":"; entries(rows); std::cout << ",\"After\":"; after(state,out); std::cout << '}';
  }
  std::cout << "],\"NativeDiagnosticCounts\":["; comma=false;
  for (int count:{0,4,5,6,7,8,9,10}) {
    State state; seed(state,0x10203040u); const auto rows=records(count,100); const auto out=request(state,7000,rows);
    if (comma) std::cout << ',';
    comma=true; std::cout << "{\"Seed\":270544960,\"Tick\":7000,\"Entries\":"; entries(rows); std::cout << ",\"After\":"; after(state,out); std::cout << '}';
  }
  std::cout << "]}\n";
}
