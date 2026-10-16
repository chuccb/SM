// INDEPENDENT MANUAL static translation of supplied FXGS routines, not original
// executable execution or a client oracle. No production TS/packet dependencies.
// DestroyPlayer0041BA8D, ghost0041AE53, Base00419580/00419EE1/0041A723,
// List00423DB6/00423D3B/00423E55/0042404B, sync00415150,
// CBanChief00401010..00401115, history00406F68.
#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <map>
#include <string>
#include <vector>
using A = std::array<int, 8>;
template<class T> void array(const T &a) {
  std::cout << '['; bool comma = false;
  for (auto v : a) { if (comma) std::cout << ','; comma = true; std::cout << +v; }
  std::cout << ']';
}
struct Body {
  std::string s;
  void raw(uint8_t v) { constexpr char h[]="0123456789abcdef"; s += h[v >> 4]; s += h[v & 15]; }
  void byte(uint8_t v) { raw(v ^ 0x5a); }
  void word(uint16_t v) { v ^= 0xa569; raw(v >> 8); raw(v); }
  void dword(uint32_t v) { v ^= 0x96ca5395u; for (int i=3; i>=0; --i) raw(v >> (8*i)); }
};
struct Chief {
  std::array<uint32_t, 9> w{}; // null placeholder for vptr at +0
  uint32_t now = 0;
  void odd(bool value) { w[3]=value; w[4]=value ? now : 0; w[7]=0; w[8]=0; }
  void can(bool value) { w[5]=0; w[6]=0; w[1]=now; w[2]=value; }
  void warn(bool value) { w[5]=value; w[6]=value ? now : 0; }
  void oddWarn(bool value) { w[7]=value; w[8]=value ? now : 0; }
  void init() { odd(false); can(false); }
  std::string bytes() const {
    Body b; for (auto v:w) for (int i=0; i<4; ++i) b.raw(v >> (8*i)); return b.s;
  }
};
std::vector<int> history(std::vector<int> prior, int room) {
  if (std::find(prior.begin(), prior.end(), room) == prior.end()) {
    if (prior.size()==5) prior.erase(prior.begin());
    prior.push_back(room);
  }
  return prior;
}
void removal(const A &players, std::vector<int> locals, int chief, bool playing,
             unsigned ghosts, bool notify, bool stopped, bool &comma) {
  if (comma) std::cout << ',';
  comma=true;
  constexpr uint32_t serial=0x89abcde0u;
  A byPlayer{}, byGhost{}, afterPlayers=players, flags{}, bomber{}, color{};
  byPlayer.fill(-1); byGhost.fill(-1);
  std::array<uint32_t, 8> votes{};
  std::array<uint32_t, 144> matrix{};
  for (int i=0; i<144; ++i) matrix[i]=100+i;
  int ghostCount=0;
  for (int i=0; i<8; ++i) {
    flags[i]=0xe0 | (i%3==0 ? 28 : i%3==1 ? 8 : 4) | (i==chief ? 2 : 0);
    bomber[i]=0xc0+i+1; color[i]=0xa0+i; votes[i]=i+1;
    if (players[i]>=0 && (ghosts & (1u<<i))) {
      int g=(i+3)%8; byPlayer[i]=g; byGhost[g]=i; ++ghostCount;
    }
  }
  const A initialGhosts=byPlayer, initialFlags=flags;
  auto previous = ghosts%2 ? std::vector<int>{15,17,1,7,9} : std::vector<int>{15,2,1,7,9};
  auto afterHistory=history(previous,17);
  Chief ban; ban.now=500; ban.init(); ban.can(true); ban.odd(true); ban.warn(true); ban.oddWarn(true);
  std::map<int,std::vector<std::string>> packets;
  for (int peer:players) if (peer>=0) packets[peer];
  const auto broadcast=[&](const Body &b, const A &members) {
    std::vector<int> seen;
    for (int peer:members) if (peer>=0 && std::find(seen.begin(),seen.end(),peer)==seen.end()) {
      seen.push_back(peer); packets[peer].push_back(b.s);
    }
  };
  // All departing users still count as occupied during the ENTIRE ghost loop.
  for (int slot:locals) {
    const int ghost=byPlayer[slot]; if (ghost<0) continue;
    int next=-1;
    for (int i=0; i<8; ++i) if (players[i]>=0 && byPlayer[i]==-1) { next=i; break; }
    Body b; b.byte(next<0 ? 167 : 166); b.byte(ghost);
    if (next>=0) b.byte(next);
    broadcast(b,players);
    byPlayer[slot]=-1;
    if (next<0) byGhost[ghost]=-1;
    else { byPlayer[next]=ghost; byGhost[ghost]=next; }
    // IMPORTANT: this routine does NOT decrement native+936 on destruction.
  }
  const bool chiefLeft=players[chief]==1;
  for (int slot:locals) {
    afterPlayers[slot]=-1; flags[slot] &= ~2; votes[slot]=0;
    for (int i=0; i<8; ++i) { matrix[slot*12+i]=0; matrix[i*12+slot]=0; }
  }
  for (size_t i=0; i<locals.size(); ++i) {
    const int slot=locals[i]; Body b; b.byte(106); b.byte(slot); b.dword(serial+slot);
    broadcast(b,afterPlayers);
    if (notify && i+1==locals.size()) packets[1].push_back(b.s);
  }
  // Manual trusted ownership seed: two objects on the FIRST local player and
  // one on each survivor primary. It is not native DoStartGame execution.
  std::vector<std::array<int,2>> sync{{9,locals[0]},{2,locals[0]}};
  std::vector<int> primaries;
  for (int i=0; i<8; ++i) if (players[i]>=0 && players[i]!=1 &&
    std::find(primaries.begin(),primaries.end(),players[i])==primaries.end()) {
    primaries.push_back(players[i]); sync.push_back({16+i,i});
  }
  const auto beforeSync=sync;
  int count=0; for (int p:afterPlayers) if (p>=0) ++count;
  if (!stopped && count) {
    std::vector<int> ids;
    for (auto entry:sync) if (entry[1]==locals[0]) ids.push_back(entry[0]);
    std::sort(ids.begin(),ids.end());
    for (int id:ids) {
      Body b; b.byte(176); b.word(uint16_t(id)); b.dword(0); broadcast(b,afterPlayers);
      sync.erase(std::remove_if(sync.begin(),sync.end(),[id](auto entry){return entry[0]==id;}),sync.end());
    }
  }
  int nextChief=chief;
  if (chiefLeft) {
    ban.now=1600; ban.init(); nextChief=-2;
    for (int i=0; i<8; ++i) if (afterPlayers[i]>=0) { nextChief=i; break; }
    if (chief>=0) flags[chief] &= ~2;
    if (nextChief>=0) {
      flags[nextChief] |= 2;
      if (!playing) for (int i=0; i<8; ++i)
        if (afterPlayers[i]==afterPlayers[nextChief]) flags[i] &= ~0x1c;
    }
    const auto state=[&](int slot) {
      Body b; b.byte(107); b.byte(slot); b.raw(flags[slot]); b.raw(bomber[slot]); b.raw(color[slot]);
      broadcast(b,afterPlayers);
    };
    if (nextChief>=0) for (int i=0; i<8; ++i)
      if (afterPlayers[i]>=0 && i!=nextChief && afterPlayers[i]==afterPlayers[nextChief]) state(i);
    if (chief>=0) state(chief);
    if (nextChief>=0) state(nextChief);
  }
  std::cout << "{\"Players\":"; array(players);
  std::cout << ",\"Locals\":"; array(locals);
  std::cout << ",\"Chief\":" << chief << ",\"Playing\":" << (playing?"true":"false")
    << ",\"NotifySelf\":" << (notify?"true":"false") << ",\"SyncStopped\":" << (stopped?"true":"false")
    << ",\"GhostCount\":" << ghostCount << ",\"GhostOfPlayer\":"; array(initialGhosts);
  std::cout << ",\"SlotFlags\":"; array(initialFlags);
  std::cout << ",\"BeforeHistory\":"; array(previous);
  const auto objects=[](const auto &entries) {
    std::cout << '[';
    for (size_t i=0;i<entries.size();++i) {if(i)std::cout<<','; array(entries[i]);}
    std::cout << ']';
  };
  std::cout << ",\"SyncObjects\":"; objects(beforeSync);
  std::cout << ",\"AfterPlayers\":"; array(afterPlayers);
  std::cout << ",\"AfterFlags\":"; array(flags);
  std::cout << ",\"AfterGhostOfPlayer\":"; array(byPlayer);
  std::cout << ",\"AfterOwnerOfGhost\":"; array(byGhost);
  std::cout << ",\"AfterVotes\":"; array(votes);
  std::cout << ",\"AfterMatrix\":"; array(matrix);
  std::cout << ",\"AfterSyncObjects\":"; objects(sync);
  std::cout << ",\"AfterChief\":" << nextChief << ",\"AfterBangPok\":" << (nextChief==-2?"true":"false")
    << ",\"AfterBanChief\":\"" << ban.bytes() << "\",\"AfterHistory\":"; array(afterHistory);
  std::cout << ",\"Packets\":{";
  bool pc=false;
  for (const auto &entry:packets) {
    if(pc)std::cout<<',';
    pc=true; std::cout << '"' << entry.first << "\":[";
    for(size_t i=0;i<entry.second.size();++i) {if(i)std::cout<<',';std::cout<<'"'<<entry.second[i]<<'"';}
    std::cout << ']';
  }
  std::cout << "}}";
}
int main() {
  std::cout << "{\"Evidence\":\"Independent manual C++ static translation; NOT supplied executable execution or original-client verification\",\"Removals\":[";
  bool comma=false;
  const A group{{1,1,2,2,3,-1,-1,-1}};
  for (unsigned mask=0;mask<32;++mask) for(bool playing:{false,true}) for(bool chiefLeaves:{false,true}) for(bool notify:{false,true}) {
    const std::vector<int> locals=mask&8 ? std::vector<int>{1,0} : std::vector<int>{0,1};
    removal(group,locals,chiefLeaves?0:2,playing,mask,notify,(mask&4)!=0,comma);
  }
  for (const A &players : {A{{1,1,-1,-1,-1,-1,-1,-1}},A{{1,-1,-1,-1,-1,-1,-1,-1}}})
    for(unsigned mask=0;mask<(players[1]<0?2u:4u);++mask) for(bool playing:{false,true}) for(bool notify:{false,true})
      removal(players,players[1]<0?std::vector<int>{0}:std::vector<int>{0,1},0,playing,mask,notify,false,comma);
  std::cout << "],\"ChiefDeadlines\":["; comma=false;
  for (uint32_t start:{0u,4096u,0xfffffff0u})
    for (uint32_t age:{0u,1u,4999u,5000u,5001u,9999u,10000u,10001u,19999u,20000u,20001u,0x80000000u,0xffffffffu})
      for(bool full:{false,true}) for(bool manner:{false,true}) for(uint32_t multiplier:{0u,1u,3u,0xffffffffu}) {
        if(comma)std::cout<<',';
        comma=true;
        const uint32_t now=start+age, threshold=(full?10000u:20000u)*multiplier;
        std::cout << "{\"Start\":" << start << ",\"Now\":" << now << ",\"Full\":" << (full?"true":"false")
          << ",\"Manner\":" << (manner?"true":"false") << ",\"Multiplier\":" << multiplier
          << ",\"Ban\":" << (uint32_t(now-start)>threshold?"true":"false")
          << ",\"WarningDelay\":" << 10000u*multiplier << ",\"OddDelay\":" << 5000u*multiplier << '}';
      }
  std::cout << "],\"ChiefStateSteps\":["; comma=false;
  Chief chief;
  struct Step { uint32_t at; const char *method; bool value; };
  for(auto step:{Step{100,"Init",false},Step{0xfffffff0u,"SetOddSlot",true},Step{0xfffffff1u,"SetCanStart",true},
      Step{0xfffffff2u,"SetWarnedBan",true},Step{0xfffffff3u,"SetWarnedBanOddSlot",true},
      Step{0,"SetOddSlot",false},Step{1,"SetWarnedBan",false},Step{2,"SetWarnedBanOddSlot",true},
      Step{3,"SetCanStart",false},Step{4,"Init",false}}) {
    chief.now=step.at;
    const std::string method=step.method;
    if(method=="Init") chief.init(); else if(method=="SetOddSlot")chief.odd(step.value);
    else if(method=="SetCanStart")chief.can(step.value); else if(method=="SetWarnedBan")chief.warn(step.value);
    else chief.oddWarn(step.value);
    if(comma)std::cout<<',';
        comma=true;
    std::cout << "{\"At\":" << step.at << ",\"Method\":\"" << method << "\",\"Value\":" << (step.value?"true":"false")
      << ",\"Bytes\":\"" << chief.bytes() << "\"}";
  }
  std::cout << "]}\n";
}
