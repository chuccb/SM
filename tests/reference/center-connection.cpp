// OUR independent manual NATIVE Center CUser model. NOT the modern lease,
// supplied EXE, Windows API, actual pool/list/counter or Center TCP execution.
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
struct State{std::uint32_t free=0,connecting=0;unsigned type=99;std::int32_t index=5;std::uint32_t tick=17,auth=0;};
struct Target{unsigned type=10;std::int32_t index=0,count=5;bool exists=true,online=true;unsigned channel=0;};
struct Result{int result=0,reads=0;State state;};
static Result request(State s,const Target& t,std::uint32_t tick){Result o;o.state=s;if(s.free||s.connecting||(s.type==t.type&&s.index==t.index))return o;if((t.type!=1&&t.type!=10&&t.type!=11)||t.index<0||t.index>=t.count||!t.exists||!t.online)return o;if(t.channel==41&&s.auth!=1){o.result=2;return o;}o.result=1;o.reads=1;o.state.connecting=1;o.state.tick=tick;return o;}
static State route(State s,const Target& t){s.type=t.type;s.index=t.index;return s;}
static bool established(State s,unsigned type,std::int32_t index){return s.free==0&&s.connecting!=0&&s.type==type&&s.index==index;}
static State clear(State s){s.connecting=0;return s;}
static Result timeout(State s,std::uint32_t now){Result o;o.state=s;if(!s.connecting)return o;o.reads=1;if(static_cast<std::uint32_t>(now-s.tick)>17500U){o.result=1;if(!s.free){o.state.free=1;o.state.index=static_cast<std::int32_t>(0x80000000U);}}return o;}
static void stateJSON(State s){std::cout<<"{\"SetFree\":"<<s.free<<",\"Connecting\":"<<s.connecting<<",\"ServerType\":"<<s.type<<",\"ServerIndex\":"<<s.index<<",\"ConnectingTick\":"<<s.tick<<",\"Authencode\":"<<s.auth<<'}';}
static void targetJSON(const Target& t){std::cout<<"{\"Type\":"<<t.type<<",\"Index\":"<<t.index<<",\"RegisteredCount\":"<<t.count<<",\"Exists\":"<<(t.exists?"true":"false")<<",\"Connected\":"<<(t.online?"true":"false")<<",\"ChannelType\":"<<t.channel<<'}';}
static void resultJSON(const Result& o){std::cout<<"{\"Result\":"<<o.result<<",\"ClockReads\":"<<o.reads<<",\"State\":";stateJSON(o.state);std::cout<<'}';}
static void emit(const std::string& name,State s,Target t,std::uint32_t tick,std::uint32_t now,unsigned probeType,std::int32_t probeIndex,bool& first){if(!first)std::cout<<',';first=false;const auto check=request(s,t,tick);const auto routed=check.result==1?route(check.state,t):check.state;const auto valid=established(routed,probeType,probeIndex);std::cout<<"{\"Name\":\""<<name<<"\",\"Before\":";stateJSON(s);std::cout<<",\"Target\":";targetJSON(t);std::cout<<",\"RequestTick\":"<<tick<<",\"NowTick\":"<<now<<",\"ProbeType\":"<<probeType<<",\"ProbeIndex\":"<<probeIndex<<",\"Expected\":{\"Check\":";resultJSON(check);std::cout<<",\"Routed\":";stateJSON(routed);std::cout<<",\"Established\":"<<(valid?"true":"false")<<",\"EstablishedState\":";stateJSON(valid?clear(routed):routed);std::cout<<",\"Timeout\":";resultJSON(timeout(s,now));std::cout<<"}}";}
int main(){bool first=true;std::cout<<"{\"Model\":\"independent-manual-cpp-native-Center-connection-state-NOT-modern-lease-or-original-execution\",\"Cases\":[";
 for(unsigned type=0;type<256;type++)for(std::uint32_t auth:{0U,1U,257U,0xffffffffU}){State s;s.auth=auth;Target t;t.type=type;t.channel=41;emit("all-types-exact-DWORD-premium-auth-not-FXGS-byte",s,t,0xfffffff0U,37,t.type,t.index,first);}
 for(unsigned type:{1U,10U,11U})for(std::int32_t index:{static_cast<std::int32_t>(0x80000000U),-1,0,1,4,5,2147483647})for(std::int32_t count:{-1,0,1,5})for(unsigned mask=0;mask<4;mask++){State s;s.free=mask&1U;s.connecting=(mask>>1U)&1U;Target t;t.type=type;t.index=index;t.count=count;emit("signed-index-count-and-free-connecting-short-circuit",s,t,123,17517,t.type,t.index,first);}
 for(unsigned channel=0;channel<256;channel++)for(std::uint32_t auth:{0U,1U,257U}){State s;s.auth=auth;Target t;t.channel=channel;emit("all-channel-bytes-only41-needs-auth-DWORD1",s,t,123,17518,t.type,t.index,first);}
 for(unsigned mask=0;mask<4;mask++){State s;Target t;t.exists=(mask&1U)!=0;t.online=(mask&2U)!=0;emit("observed-missing-or-offline-server",s,t,123,17518,t.type,t.index,first);}
 for(std::uint32_t free:{0U,1U,2U})for(std::uint32_t connecting:{0U,1U,0xffffffffU})for(std::uint32_t start:{0U,1U,0x7fffffffU,0xfffffff0U})for(std::uint32_t delta:{0U,1U,17499U,17500U,17501U,0x7fffffffU,0x80000000U,0xffffffffU}){State s;s.free=free;s.connecting=connecting;s.tick=start;Target t;emit("unsigned-timeout-strict17500-wrap-and-one-shot-free",s,t,123,static_cast<std::uint32_t>(start+delta),s.type,s.index,first);}
 for(unsigned type=0;type<256;type++)for(unsigned mask=0;mask<4;mask++){State s;s.type=type;s.connecting=1;Target t;t.type=type;t.index=s.index;const auto ptype=(mask&1U)?((type+1U)&255U):type;const auto pindex=(mask&2U)?s.index+1:s.index;emit("check-established-exact-fields-even-unknown-type-no-timeout",s,t,123,0xffffffffU,ptype,pindex,first);}
 std::cout<<"],\"NativeGroupHazards\":[";first=true;
 // Original004097xx loops all CHECKs and bases SET-all on LAST result. CHECK
 // itself may mutate earlier users. Document, do NOT copy into modern authority.
 for(unsigned a=0;a<16;a++)for(unsigned b=0;b<16;b++){if(!first)std::cout<<',';first=false;State x,y;Target t;t.channel=41;x.type=y.type=1;x.index=y.index=0;x.free=a&1U;x.connecting=(a>>1U)&1U;x.auth=(a>>2U)&1U;if(a&8U)x.type=t.type,x.index=t.index;y.free=b&1U;y.connecting=(b>>1U)&1U;y.auth=(b>>2U)&1U;if(b&8U)y.type=t.type,y.index=t.index;const auto p=request(x,t,100),q=request(y,t,100);std::cout<<"{\"Before\":[";stateJSON(x);std::cout<<',';stateJSON(y);std::cout<<"],\"Target\":";targetJSON(t);std::cout<<",\"Checks\":["<<p.result<<','<<q.result<<"],\"NativeLastResult\":"<<q.result<<",\"AfterNativeLoop\":[";stateJSON(q.result==1?route(p.state,t):p.state);std::cout<<',';stateJSON(q.result==1?route(q.state,t):q.state);std::cout<<"]}";}
 std::cout<<"]}";
}
