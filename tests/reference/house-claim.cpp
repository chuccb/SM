// OUR manual fixed-width translation, NOT native EXE execution or client proof.
// Native capacity failures deliberately recorded as malformed, not reproduced by TS.
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using Cell = std::array<unsigned,2>;
using Drop = std::array<unsigned,3>;
struct Body {
  std::string hex;
  void byte(unsigned x) { static constexpr char digits[] = "0123456789abcdef"; x = (x & 255u) ^ 0x5au; hex += digits[x>>4]; hex += digits[x&15]; }
};
template<class T> void numbers(const T &a) { std::cout << '['; bool first = true; for (auto x : a) { if (!first) std::cout << ','; first=false; std::cout << +x; } std::cout << ']'; }
template<class T> void rows(const T &a) { std::cout << '['; bool first=true; for (const auto &r : a) { if (!first) std::cout << ','; first=false; numbers(r); } std::cout << ']'; }
void sep(bool &first) { if (!first) std::cout << ','; first=false; }
void emit(unsigned slot, unsigned color, unsigned next, uint32_t money, const std::vector<Cell> &cells, const std::vector<Drop> &drops, unsigned pattern=0, int32_t count=0) {
  std::array<int32_t,195> before, after; before.fill(-1);
  if (pattern) for (unsigned i=0; i<195; ++i) if (i % pattern == 0) before[i] = int32_t((i+3)%8);
  after=before;
  std::array<int32_t,8> beforeCounts{}, counts{}; beforeCounts[color%8] = count; counts=beforeCounts;
  std::vector<Cell> accepted;
  Body request, response;
  request.byte(161); request.byte(slot); request.byte(cells.size());
  for (auto c : cells) {
    request.byte(c[0]); request.byte(c[1]);
    if (c[0]>=13 || c[1]>=15 || after[c[0]*15+c[1]]!=-1) continue;
    accepted.push_back(c); after[c[0]*15+c[1]]=int32_t(slot);
    if (color<8) counts[color]=int32_t(uint32_t(counts[color])+1u);
  }
  request.byte(drops.size());
  for (auto d : drops) for (auto x : d) request.byte(x);
  response.byte(178); response.byte(slot); response.byte(accepted.size());
  for (auto c : accepted) { response.byte(c[0]); response.byte(c[1]); }
  response.byte(5); response.byte(drops.size()); // Native patches REQUESTED, including exhaustion.
  unsigned allocated=0;
  for (auto d : drops) {
    if (next+allocated>=250) break;
    response.byte(d[0]); response.byte(next+allocated++); response.byte(d[1]); response.byte(d[2]);
  }
  uint32_t wrapped = money + uint32_t(5u*accepted.size());
  uint32_t wallet = (wrapped & 0x80000000u) ? 0u : (wrapped>1000000u ? 1000000u : wrapped);
  std::cout << "{\"Slot\":" << slot << ",\"Color\":" << color << ",\"Next\":" << next << ",\"Money\":" << money << ",\"MoneyAfter\":" << wallet << ",\"Delta\":" << 5u*accepted.size()
    << ",\"Cells\":"; rows(cells); std::cout << ",\"Drops\":"; rows(drops);
  std::cout << ",\"StatesBefore\":"; numbers(before); std::cout << ",\"StatesAfter\":"; numbers(after);
  std::cout << ",\"CountsBefore\":"; numbers(beforeCounts); std::cout << ",\"CountsAfter\":"; numbers(counts);
  std::cout << ",\"Accepted\":"; rows(accepted);
  std::cout << ",\"Allocated\":" << allocated << ",\"Safe\":" << (allocated==drops.size() ? "true" : "false")
    << ",\"Request\":\"" << request.hex << "\",\"NativeResponse\":\"" << response.hex << "\"}";
}
std::vector<Drop> drops(unsigned n) { std::vector<Drop> out; for (unsigned i=0; i<n; ++i) out.push_back({(i*73u+255u)&255u,(i*37u+128u)&255u,(i*11u+90u)&255u}); return out; }
int main() {
  std::cout << "{\"Evidence\":\"Independent manual C++ of supplied FXGS house161/178/5-money instructions; NOT original execution, drop meaning, spawn authorization, restart or original-client proof. Safe=false records native malformed requested drop count; TS intentionally rejects atomically.\",\"Cases\":[";
  bool first=true;
  // Full byte coordinate domain, partitioned into <=255-pair native requests.
  for (unsigned begin=0; begin<65536; begin+=255) {
    std::vector<Cell> cells;
    for (unsigned i=begin; i<65536 && i<begin+255; ++i) cells.push_back({i>>8,i&255u});
    sep(first); emit((begin/255)%8,(begin/255)%8,126,0,cells,{});
  }
  // Count0..255, duplicates, previous ownership, ordered sparse successes.
  for (unsigned n=0; n<256; ++n) {
    std::vector<Cell> cells;
    for (unsigned i=0; i<n; ++i) cells.push_back(i%7==0 ? Cell{0,0} : Cell{(i*7)%14,(i*11)%16});
    sep(first); emit(n%8,(n*3)%8,126,999999,cells,drops(n%7),5);
  }
  // All possible live allocator offsets and byte-count boundaries, incl failures.
  for (unsigned next=126; next<=250; ++next) {
    unsigned available=250-next;
    std::vector<unsigned> ns{0,1,available,available+1,255};
    for (unsigned i=0; i<ns.size(); ++i) {
      bool repeated=false; for (unsigned j=0; j<i; ++j) if (ns[i]==ns[j]) repeated=true;
      if (repeated) continue;
      sep(first); emit(next%8,next%8,next,37,{{0,0},{0,0},{12,14},{13,0},{0,15}},drops(ns[i]));
    }
  }
  // All three opaque BYTE domains, and the joint255-cell/124-drop maximum.
  for (unsigned value=0; value<256; ++value) {
    sep(first); emit(value%8,value%8,126,0,{},{{value,255-value,(value*73)&255u}});
  }
  std::vector<Cell> maximum;
  for (unsigned row=0;row<13;++row) for(unsigned col=0;col<15;++col) maximum.push_back({row,col});
  while(maximum.size()<255) maximum.push_back({0,0});
  sep(first); emit(1,7,126,1000000,maximum,drops(124),0,2147483647);
  // Slot vs COLOR, no premium multiplier, native count wrap and wallet signed ADD.
  for (unsigned slot=0; slot<8; ++slot) for (unsigned color : {0u,1u,7u,8u,31u})
    for (uint32_t money : {0u,999025u,999999u,1000000u,2147483640u,2147483647u}) {
      std::vector<Cell> cells;
      for (unsigned row=0; row<13; ++row) for (unsigned column=0; column<15; ++column) cells.push_back({row,column});
      sep(first); emit(slot,color,126,money,cells,{},0,2147483647);
    }
  std::cout << "]}\n";
}
