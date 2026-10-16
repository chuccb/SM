// Manually translated fixed-width reference for FXGS CGameContext::Init
// (0041CD9B), CGameSession::Update bomb block (0041DC31), CGameClock
// (0041ABCF/0041B843..0041B874/0041CE1F). Does NOT execute the original EXE, use a client
// capture, import TypeScript, or simulate map collisions. Includes the SIGNED
// sync interval comparison (.lst 0041550A..0041551C jl). Regenerate explicitly.
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>
struct Point { int32_t x=0, y=0; };
struct Bomb {
 uint32_t serial; uint8_t moving; uint8_t pad[3]; int32_t ms;
 uint8_t row, col, power, pad2; uint32_t paused;
};
struct Context {
 int32_t houseCount[8]; Bomb bombs[150]; int32_t boxes[250], obstacles[195];
 int32_t count; uint32_t nextSerial; uint32_t stateTimes[8]; Point ghosts[8];
 int32_t nextBox, bula[26][45], houses[13][15];
};
static_assert(sizeof(Bomb)==20 && sizeof(Context)==0x288c);
static_assert(offsetof(Context,boxes)==3032 && offsetof(Context,obstacles)==4032);
static_assert(offsetof(Context,count)==4812 && offsetof(Context,stateTimes)==4820);
static_assert(offsetof(Context,ghosts)==4852 && offsetof(Context,nextBox)==4916);
static_assert(offsetof(Context,bula)==4920 && offsetof(Context,houses)==9600);
void init(Context &c) {
 std::memset(c.boxes,0,1000); std::memset(c.obstacles,0,780);
 c.count=0; c.nextSerial=0; c.nextBox=126;
 for(auto &row:c.houses) for(auto &x:row) x=-1;
 for(auto &row:c.bula) for(auto &x:row) x=-1;
 for(auto &x:c.houseCount) x=0;
}
struct Event { uint32_t serial; uint8_t landed; };
std::vector<Event> update(Context &c,uint32_t delta) {
 std::vector<Event> events;
 for(int32_t i=0; i<c.count; i++) {
  Bomb &b=c.bombs[i];
  if(b.paused==0 || b.moving==1) b.ms=int32_t(uint32_t(b.ms)-delta);
  if(b.ms<=0) {
   if(b.moving==1) { events.push_back({b.serial,1}); b.ms=2000; b.moving=0; }
   else {
    events.push_back({b.serial,0}); --c.count;
    if(c.count>0) { std::memcpy(&c.bombs[i],&c.bombs[c.count],20); --i; }
   }
  }
 }
 return events;
}
std::string body(const std::vector<Event> &e) {
 const char *hex="0123456789abcdef"; std::string s;
 auto byte=[&](uint8_t n){s+=hex[n>>4];s+=hex[n&15];};
 byte(152^0x5a); byte(uint8_t(e.size())^0x5a);
 for(auto v:e) { uint16_t id=uint16_t(v.serial)^0xa569; byte(id>>8);byte(id);byte(v.landed^0x5a); }
 return s;
}
void emitBomb(const Bomb &b) {
 std::cout<<"{\"SerialNo\":"<<b.serial<<",\"State\":"<<int(b.moving)<<",\"RemainingMilliseconds\":"<<b.ms
  <<",\"Row\":"<<int(b.row)<<",\"Column\":"<<int(b.col)<<",\"Power\":"<<int(b.power)<<",\"RemotelyPaused\":"<<(b.paused?"true":"false")<<"}";
}
struct Clock { uint32_t stopped=0,start=0,end=0,suspended=0; std::vector<std::string> errors;
 void resume(uint32_t t){ if(suspended){stopped+=t-suspended;suspended=0;}else errors.push_back("resume"); }
 void act(const std::string &op,uint32_t t) {
  if(op=="start"){stopped=0;end=0;start=t;}
  if(op=="end")end=t;
  if(op=="suspend"){if(suspended){errors.push_back("suspend");resume(t);}suspended=t;}
  if(op=="resume")resume(t);
 }
};
struct Action { const char *op; uint32_t time; };
void clockScenario(const char *name,const std::vector<Action> &actions) {
 Clock c;std::cout<<"{\"name\":\""<<name<<"\",\"steps\":[";bool first=true;
 for(auto a:actions) { if(!first)std::cout<<",";first=false;c.act(a.op,a.time);
  std::cout<<"{\"op\":\""<<a.op<<"\",\"time\":"<<a.time<<",\"stopped\":"<<c.stopped<<",\"start\":"<<c.start
   <<",\"end\":"<<c.end<<",\"elapsed\":"<<uint32_t(a.time-c.start)<<",\"real\":"<<uint32_t(c.end-c.start)<<",\"errors\":[";
  for(size_t i=0;i<c.errors.size();i++){if(i)std::cout<<",";std::cout<<"\""<<c.errors[i]<<"\"";}std::cout<<"]}";
 }
 std::cout<<"]}";
}
int main() {
 std::cout<<"{\"provenance\":\"Manually translated C++ FXGS reference, not executed official code or client captures\",\"initialBombs\":[";
 Context c{};init(c);
 const Bomb input[]={
  {0,0,{0,0,0},2800,1,2,3,0,0}, {1,0,{0,0,0},1000,2,3,4,0,1},
  {2,1,{0,0,0},100,3,4,5,0,1}, {3,0,{0,0,0},0,4,5,6,0,0},
  {4,1,{0,0,0},0,5,6,7,0,0}
 };
 c.count=5;std::copy(std::begin(input),std::end(input),c.bombs);
 for(int i=0;i<c.count;i++){if(i)std::cout<<",";emitBomb(c.bombs[i]);}
 std::cout<<"],\"bombSteps\":[";bool first=true;
 for(uint32_t delta:{0u,100u,1900u,800u,2000u}) {
  if(!first) { std::cout<<","; }
  first=false;auto events=update(c,delta);
  std::cout<<"{\"delta\":"<<delta<<",\"events\":[";
  for(size_t i=0;i<events.size();i++){if(i)std::cout<<",";std::cout<<"{\"SerialNo\":"<<events[i].serial<<",\"Landed\":"<<(events[i].landed?"true":"false")<<"}";}
  std::cout<<"],\"body\":\""<<body(events)<<"\",\"bombs\":[";
  for(int i=0;i<c.count;i++){if(i)std::cout<<",";emitBomb(c.bombs[i]);}std::cout<<"]}";
 }
 std::cout<<"],\"clocks\":[";
 clockScenario("pause-is-accounting-not-freeze",{{"start",100},{"read",150},{"suspend",160},{"read",200},{"suspend",220},{"resume",250},{"resume",260},{"end",280},{"read",300}});
 std::cout<<",";
 clockScenario("DWORD-rollover",{{"start",0xfffffff0u},{"read",5},{"suspend",10},{"resume",25},{"end",40},{"read",55}});
 std::cout<<",";
 clockScenario("native-quirks-no-silent-fix",{{"start",0},{"suspend",0},{"resume",10},{"suspend",20},{"start",30},{"resume",50},{"end",70}});
 std::cout<<"],\"syncRates\":[";
 struct RateInput { uint32_t elapsed, stopped; };
 int32_t last=0;bool firstRate=true;
 for(auto input:std::vector<RateInput>{{4999,0},{5000,0},{7000,2000},{12000,2000},{0x7ffffff0u,0},{0x80000000u,0},{0x80001378u,0},{0xfffffff0u,0},{32,0},{4984,0}}) {
  const int32_t time=int32_t(input.elapsed-input.stopped);
  const bool allowed=time>=int32_t(uint32_t(last)+5000);
  if(allowed) last=time;
  if(!firstRate) { std::cout<<","; } firstRate=false;
  std::cout<<"{\"elapsed\":"<<input.elapsed<<",\"stopped\":"<<input.stopped<<",\"allowed\":"<<(allowed?"true":"false")<<"}";
 }
 std::cout<<"]}\n";
}
