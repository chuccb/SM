// OUR manual fixed-width translation of FXGS00424A3B/00423C70/00424F78.
// No TS imports, original execution, Windows APIs, SQL, clock, permission or
// removal adapter. Removal is an INTENT before publication, not final roster.
#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using U = std::uint32_t;
struct Actor { bool live=false; U serial=0; int socket=-1,self=0; std::string name,raw; };
struct State { std::array<Actor,8> a{}; std::array<U,8> votes{}; U target=0; int chief=0; };
struct Message { bool question=false; unsigned code=0; U target=0; std::string name,raw; std::vector<int> to; };
struct Query { int slot; bool super; };
struct Counts { unsigned total=0,yes=0,no=0,pending=0,other=0; };
struct Plan { U target=0; std::array<U,8> votes{}; int eject=-1; unsigned deferCalls=0; bool counted=false; Counts counts; std::vector<Message> messages; };
static std::vector<Query> queries;
static std::vector<int> locals(const State& s,int key) {
  std::vector<int> r; for (int i=0;i<8;++i) if(s.a[i].live && s.a[i].socket==key) r.push_back(i);
  std::sort(r.begin(),r.end(),[&](int a,int b){return s.a[a].self<s.a[b].self;});return r;
}
static std::vector<int> sockets(const State& s,int except=-1) {
  std::vector<int> r;for(const auto& a:s.a) if(a.live && a.socket!=except && std::find(r.begin(),r.end(),a.socket)==r.end()) r.push_back(a.socket);return r;
}
static Plan initial(const State& s) {Plan p;p.target=s.target;p.votes=s.votes;return p;}
static Message result(unsigned code,const std::vector<int>& to,const Actor* a=nullptr) {
  Message m;m.code=code;m.to=to;if(a){m.name=a->name;m.raw=a->raw;}return m;
}
static Plan defer(const State& s) {
  Plan p=initial(s);p.deferCalls=1;p.counted=true;int target=-1;
  for(int i=0;i<8;++i) if(s.a[i].live) {
    if(s.a[i].serial==s.target)target=i;
    const U v=s.votes[i];if(!v)continue;
    ++p.counts.total;if(v==2)++p.counts.yes;else if(v==3)++p.counts.no;else if(v==1)++p.counts.pending;else ++p.counts.other;
  }
  if(target<0){p.target=0;p.messages.push_back(result(4,sockets(s)));return p;}
  if(2*p.counts.yes>p.counts.total){p.target=0;p.eject=target;p.messages.push_back(result(2,sockets(s,s.a[target].socket),&s.a[target]));}
  else if(2*p.counts.no>=p.counts.total || p.counts.yes+p.counts.no>=p.counts.total){p.target=0;p.messages.push_back(result(3,sockets(s),&s.a[target]));}
  return p;
}
static bool functional(int slot,bool super,unsigned superMask,unsigned reflexMask){queries.push_back({slot,super});return ((super?superMask:reflexMask)&(1U<<slot))!=0;}
static Plan host(State s,int sender,U serial,unsigned immediate,unsigned superMask,unsigned reflexMask) {
  Plan p=initial(s);
  if(s.target){p.messages.push_back(result(1,{sender}));return p;}
  int target=-1;
  for(int i=0;i<8;++i){s.votes[i]=s.a[i].live && s.a[i].serial!=serial?1:0;if(s.a[i].live && s.a[i].serial==serial)target=i;}
  if(target<0){p=initial(s);p.target=0;return p;}
  if(immediate)for(int slot:locals(s,sender))if(functional(slot,true,superMask,reflexMask)){
    p=initial(s);p.target=0;p.eject=target;p.messages.push_back(result(4,sockets(s,s.a[target].socket)));return p;
  }
  for(int slot:locals(s,s.a[target].socket))if(functional(slot,false,superMask,reflexMask)){
    p=initial(s);p.target=0;p.eject=s.chief;p.messages.push_back(result(5,sockets(s,sender),&s.a[s.chief]));return p;
  }
  for(int slot:locals(s,s.a[target].socket))s.votes[slot]=0;
  for(int slot:locals(s,sender))s.votes[slot]=2;
  s.target=serial;p=defer(s);
  if(p.target){
    Message question;question.question=true;question.target=serial;question.name=s.a[target].name;question.raw=s.a[target].raw;int previous=-1;
    for(const auto& a:s.a)if(a.live && a.socket!=sender && a.socket!=s.a[target].socket && a.serial!=s.target && a.socket!=previous){question.to.push_back(a.socket);previous=a.socket;}
    p.messages.push_back(question);p.messages.push_back(result(0,{sender}));
  }
  return p;
}
static Plan respond(State s,int sender,U serial,unsigned answer) {
  if(!s.target || s.target!=serial)return initial(s);
  for(int slot:locals(s,sender)){if(s.votes[slot]!=1)return initial(s);s.votes[slot]=answer?2:3;}
  return defer(s);
}
struct Departure {State remaining; bool check=false;Plan plan;unsigned chiefInits=0;};
static Departure depart(State s,int key){
  Departure d;const bool chief=s.chief>=0 && s.chief<8 && s.a[s.chief].live && s.a[s.chief].socket==key;
  for(int i=0;i<8;++i)if(s.a[i].live && s.a[i].socket==key){s.a[i].live=false;s.votes[i]=0;}
  if(chief){s.chief=-2;for(int i=0;i<8;++i)if(s.a[i].live){s.chief=i;break;}d.chiefInits=1;}
  d.remaining=s;d.check=s.target!=0;
  if(d.check){d.plan=defer(s);if(d.plan.eject>=0 && s.chief>=0 && s.a[s.chief].socket==s.a[d.plan.eject].socket)++d.chiefInits;}
  return d;
}
static void stringJSON(const std::string& s){std::cout<<'"';const char* h="0123456789abcdef";for(unsigned char c:s){if(c=='"'||c=='\\')std::cout<<'\\'<<c;else if(c<32)std::cout<<"\\u00"<<h[c>>4]<<h[c&15];else std::cout<<c;}std::cout<<'"';}
template<class T>static void arrayJSON(const T& a){std::cout<<'[';bool first=true;for(auto n:a){if(!first)std::cout<<',';first=false;std::cout<<n;}std::cout<<']';}
static void stateJSON(const State& s){std::cout<<"{\"Actors\":[";for(int i=0;i<8;++i){if(i)std::cout<<',';const Actor& a=s.a[i];if(!a.live){std::cout<<"null";continue;}std::cout<<"{\"SerialNo\":"<<a.serial<<",\"SocketKey\":"<<a.socket<<",\"Self\":"<<a.self<<",\"Name\":";stringJSON(a.name);std::cout<<'}';}std::cout<<"],\"Votes\":";arrayJSON(s.votes);std::cout<<",\"TargetSerialNo\":"<<s.target<<",\"ChiefSlot\":"<<s.chief<<'}';}
struct Packet {
  bool cipher;std::vector<unsigned char> bytes;
  void byte(unsigned n){bytes.push_back(static_cast<unsigned char>(n^(cipher?0x5aU:0U)));}
  void word(unsigned n){n^=cipher?0xa569U:0U;bytes.push_back(static_cast<unsigned char>(n>>8));bytes.push_back(static_cast<unsigned char>(n));}
  void dword(U n){n^=cipher?0x96ca5395U:0U;for(int shift=24;shift>=0;shift-=8)bytes.push_back(static_cast<unsigned char>(n>>shift));}
  void str(const std::string& s){word(static_cast<unsigned>(s.size()));for(unsigned char c:s)bytes.push_back(c);}
};
static std::string body(const Message& m,bool cipher){Packet p{cipher,{}};p.byte(m.question?113:114);if(m.question){p.dword(m.target);p.str(m.raw);}else{p.byte(m.code);if(m.code==2||m.code==3||m.code==5)p.str(m.raw);}const char* h="0123456789abcdef";std::string s;for(auto b:p.bytes){s+=h[b>>4];s+=h[b&15];}return s;}
static void planJSON(const Plan& p,const State& s){
  std::cout<<"{\"After\":{\"Votes\":";arrayJSON(p.votes);std::cout<<",\"TargetSerialNo\":"<<p.target<<"},\"Eject\":";
  if(p.eject<0)std::cout<<"null";else std::cout<<"{\"Slot\":"<<p.eject<<",\"SocketKey\":"<<s.a[p.eject].socket<<",\"IncludeSelf\":true,\"NativePoolType\":4}";
  std::cout<<",\"Messages\":[";bool first=true;for(const auto& m:p.messages){if(!first)std::cout<<',';first=false;std::cout<<"{\"Message\":{\"Kind\":\""<<(m.question?"Question":"Result")<<'"';if(m.question){std::cout<<",\"TargetSerialNo\":"<<m.target<<",\"Name\":";stringJSON(m.name);}else{std::cout<<",\"Code\":"<<m.code;if(m.code==2||m.code==3||m.code==5){std::cout<<",\"Name\":";stringJSON(m.name);}}std::cout<<"},\"Recipients\":";arrayJSON(m.to);std::cout<<'}';}
  std::cout<<"],\"DeferCalls\":"<<p.deferCalls<<",\"Counts\":";if(!p.counted)std::cout<<"null";else std::cout<<"{\"Total\":"<<p.counts.total<<",\"Yes\":"<<p.counts.yes<<",\"No\":"<<p.counts.no<<",\"Pending\":"<<p.counts.pending<<",\"Other\":"<<p.counts.other<<'}';std::cout<<'}';
}
static void bodiesJSON(const Plan& p){std::cout<<"{\"Scalar\":[";bool first=true;for(const auto& m:p.messages){if(!first)std::cout<<',';first=false;stringJSON(body(m,true));}std::cout<<"],\"Plain\":[";first=true;for(const auto& m:p.messages){if(!first)std::cout<<',';first=false;stringJSON(body(m,false));}std::cout<<"]}";}
static State layout(const std::vector<unsigned>& counts,bool scatter=false){State s;std::array<int,8> order{{0,1,2,3,4,5,6,7}};if(scatter)order={{0,2,1,4,3,6,5,7}};unsigned at=0;int key=0;for(unsigned count:counts){for(unsigned self=0;self<count;++self){const int i=order[at++];auto& a=s.a[i];a={true,U(0x81234560U+unsigned(i)),key,int(self),"User"+std::to_string(i),"User"+std::to_string(i)};if(i==3){a.name="中文";a.raw="\xa4\xa4\xa4\xe5";}s.votes[i]=U(i+20);}++key;}return s;}
static unsigned cases=0;
static void emit(const char* name,const char* action,const State& s,int sender,U serial=0,unsigned value=0,unsigned superMask=0,unsigned reflexMask=0){
  queries.clear();Plan p;Departure d;const std::string op(action);
  if(op=="Host")p=host(s,sender,serial,value,superMask,reflexMask);else if(op=="Respond")p=respond(s,sender,serial,value);else if(op=="Defer")p=defer(s);else d=depart(s,sender);
  if(cases++){std::cout<<',';}
  std::cout<<"{\"Name\":\""<<name<<'-'<<cases<<"\",\"Action\":\""<<action<<"\",\"Observation\":";stateJSON(s);
  std::cout<<",\"Sender\":"<<sender<<",\"SerialNo\":"<<serial<<",\"Value\":"<<value<<",\"SuperMask\":"<<superMask<<",\"ReflexMask\":"<<reflexMask<<",\"Expected\":";
  if(op=="Departure"){std::cout<<"{\"Remaining\":";stateJSON(d.remaining);std::cout<<",\"Decision\":";if(d.check)planJSON(d.plan,d.remaining);else std::cout<<"null";std::cout<<",\"ChiefInitializations\":"<<d.chiefInits<<'}';}else planJSON(p,s);
  std::cout<<",\"Bodies\":";bodiesJSON(op=="Departure"?d.plan:p);std::cout<<",\"FunctionalCalls\":[";bool first=true;for(auto q:queries){if(!first)std::cout<<',';first=false;std::cout<<"{\"Slot\":"<<q.slot<<",\"Attribute\":\""<<(q.super?"Item/SuperChief":"Item/BanReflex")<<"\"}";}std::cout<<"]}";
}
int main(){
  std::cout<<std::boolalpha<<"{\"Model\":\"OUR manual native vote policy/scalar bodies and ordinary post-deletion observation; NOT original execution, live table/ghost/sync/removal, permission, SQL, clock or client proof\",\"Cases\":[";
  // All Yes/No/Pending/unknown-nonzero distributions for at most7 voters.
  for(unsigned total=0;total<=7;++total)for(unsigned yes=0;yes<=total;++yes)for(unsigned no=0;no<=total-yes;++no)for(unsigned pending=0;pending<=total-yes-no;++pending)for(bool missing:{false,true}){
    State s=layout({2,2,2,2});s.votes.fill(0);s.target=missing?0xffffffffU:s.a[7].serial;unsigned at=0;
    for(unsigned i=0;i<yes;++i){s.votes[at++]=2;}
    for(unsigned i=0;i<no;++i){s.votes[at++]=3;}
    for(unsigned i=0;i<pending;++i){s.votes[at++]=1;}
    while(at<total){s.votes[at++]=0xffffffffU;}
    emit("tally-distribution","Defer",s,0);
  }
  const std::vector<std::vector<unsigned>> profiles{{1,1},{1,2},{2,1},{2,2},{1,1,1},{2,1,1},{1,2,1},{2,2,2},{2,2,2,2}};
  for(const auto& profile:profiles)for(bool scatter:{false,true}){
    State s=layout(profile,scatter);const auto chiefs=locals(s,0),targets=locals(s,1);
    for(int chief:chiefs)for(int target:targets)for(unsigned immediate:{0U,1U,255U}){
      s.chief=chief;std::vector<unsigned> sm{0U},rm{0U};for(int slot:chiefs)sm.push_back(1U<<slot);for(int slot:targets)rm.push_back(1U<<slot);
      for(unsigned superMask:sm)for(unsigned reflexMask:rm)emit("host-functional-local-order","Host",s,0,s.a[target].serial,immediate,superMask,reflexMask);
    }
    emit("missing-target","Host",s,0,0xffffffffU,255,255,255);
    s.target=s.a[targets[0]].serial;emit("busy-before-self-fields","Host",s,0,s.a[chiefs[0]].serial,255,255,255);
  }
  constexpr std::array<U,6> statuses{{0,1,2,3,4,0xffffffffU}};
  for(bool reverse:{false,true})for(U first:statuses)for(U second:statuses)for(unsigned answer:{0U,1U,255U})for(bool match:{false,true}){
    State s=layout({2,2,2,2});if(reverse)std::swap(s.a[4].self,s.a[5].self);s.votes.fill(1);s.votes[0]=s.votes[1]=2;s.votes[2]=s.votes[3]=0;s.target=s.a[3].serial;
    const auto slots=locals(s,2);s.votes[slots[0]]=first;s.votes[slots[1]]=second;emit("response-prefix-and-reached-fields","Respond",s,2,match?s.target:0xffffffffU,answer);
  }
  for(unsigned code=0;code<64;++code)for(int key=0;key<4;++key)for(bool active:{false,true}){
    State s=layout({2,2,2,2},true);s.votes.fill(1);for(int i:locals(s,0))s.votes[i]=2;for(int i:locals(s,1))s.votes[i]=0;
    unsigned n=code;for(int i:locals(s,2)){s.votes[i]=1+(n%4);n/=4;}s.votes[locals(s,3)[0]]=1+(n%4);s.target=active?s.a[locals(s,1)[1]].serial:0;
    emit("departure-recount-not-live-destruction","Departure",s,key);
  }
  State empty;empty.chief=-1;emit("empty-defer","Defer",empty,0);
  std::cout<<"],\"CaseCount\":"<<cases<<"}\n";
}
