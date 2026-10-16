// OUR independent observed pre -> owned model. NO supplied binary, SQL or API.
// Models source prefix order/failure, AFTER-XP level, separate30/400 counters,
// per-known-row DATE comparisons and201/207 bytes; never an effects/ACK oracle.
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>
#include "inventory-initialization-levels.h"
using Bytes=std::vector<unsigned char>;
static std::int64_t s32(std::int64_t v){const auto u=static_cast<std::uint32_t>(v);return u<0x80000000U?u:static_cast<std::int64_t>(u)-0x100000000LL;}
static int level(std::int64_t exp){int i=1;while(i<static_cast<int>(levels.size())&&exp>=levels[static_cast<std::size_t>(i)])++i;return i;}
static void byte(Bytes& b,std::int64_t n,bool c){b.push_back(static_cast<unsigned char>(static_cast<std::uint32_t>(n)^(c?0x5aU:0)));}
static void word(Bytes& b,std::int64_t n,bool c){const auto v=static_cast<std::uint32_t>(n)^(c?0xa569U:0);b.push_back(static_cast<unsigned char>(v>>8));b.push_back(static_cast<unsigned char>(v));}
static void dword(Bytes& b,std::int64_t n,bool c){const auto v=static_cast<std::uint32_t>(n)^(c?0x96ca5395U:0);for(int i=3;i>=0;--i)b.push_back(static_cast<unsigned char>(v>>(i*8)));}
static void text(Bytes& b,const std::string& s,bool c){word(b,static_cast<std::int64_t>(s.size()),c);b.insert(b.end(),s.begin(),s.end());}
static std::string hex(const Bytes& b){constexpr char h[]="0123456789abcdef";std::string s;for(auto v:b){s+=h[v>>4];s+=h[v&15];}return s;}
static Bytes dateBytes(double value){std::uint64_t bits;std::memcpy(&bits,&value,8);Bytes b;for(int i=0;i<8;++i)b.push_back(static_cast<unsigned char>(bits>>(i*8)));return b;}
struct Definition{unsigned category;std::int64_t attr;};
static const std::map<unsigned,Definition> defs{{7,{2,1}},{8,{101,1}},{9,{100,1}},{10,{9,1}},{11,{5,1}},{12,{6,-17}}};
struct Pre{unsigned sn=31,item=7;std::int64_t amount=3,exec=0,ret=0;};
struct Owned{unsigned item=7,slot=255;std::int64_t amount=3;double date=46025;int validity=32767;std::string verbose="OWNED";};
struct Case{bool preOpen=true,ownedOpen=true,negative=false;unsigned preScenario=0,ownedScenario=0;std::int64_t step=1000;std::vector<Pre> pre;std::vector<Owned> owned;};
struct Result{std::int64_t exp=0,money=37;int cached=1,dynamic=2,simple=3;std::uint32_t games=0xffffffffU;unsigned preReads=0,preFetched=0,reads=0,fetched=0,counted=0,clocks=0;std::vector<unsigned> preRows,preMissing,rows,missing;std::vector<std::string> events;std::vector<std::int64_t> userLevels;std::vector<std::array<unsigned,3>> deleted;bool icon=false,fake=false;unsigned iconSN=0;std::int64_t fakeLevel=0;};
static Case make(unsigned p,unsigned o,bool preOpen,bool ownedOpen){Case c;c.preScenario=p;c.ownedScenario=o;c.preOpen=preOpen;c.ownedOpen=ownedOpen;
 switch(p){case 0:break;case 1:c.pre={{31,7,3,0,0}};break;case 2:c.pre={{31,8,levels[5],0,0}};break;case 3:c.pre={{31,8,levels[5],-1,0}};break;case 4:c.pre={{31,9,2147483647,0,-1}};break;case 5:c.pre={{30,999,3,0,0},{31,8,levels[5],-1,0},{32,9,100,0,0},{33,10,3,0,0},{34,7,3,0,0}};break;case 6:for(unsigned i=0;i<30;++i)c.pre.push_back({31+i,7,3,0,0});c.pre.push_back({100,8,levels[5],0,0});break;case 7:c.pre={{31,8,levels[5],-1,0}};for(unsigned i=0;i<30;++i)c.pre.push_back({32+i,7,3,0,0});c.pre.push_back({100,9,100,0,0});break;}
 switch(o){case 0:break;case 1:c.owned={{7,255,3,46025,3,"LEVEL"},{11,0,3,46025,32767,"ICON"},{12,0,3,46025,32767,"FAKE"}};break;case 2:c.owned={{999,255,3,46024,1,"MISSING"},{7,255,3,46024,32767,"EQUAL"},{7,255,3,46024,32767,"LATER"},{7,255,3,46025,-32768,"SIGNED"}};break;case 3:c.negative=true;c.step=43200000;c.owned={{7,255,3,-1.25,32767,"MORNING"},{7,255,3,-1.25,32767,"AFTERNOON"}};break;}
 return c;}
static Result run(const Case& c){Result r;if(!c.preOpen)return r;
 unsigned index=0;for(;;){++r.preReads;if(index>=c.pre.size())break;const auto i=index++;++r.preFetched;if(r.preRows.size()>=30)break;const auto& p=c.pre[i];const auto it=defs.find(p.item);if(it==defs.end()){r.preMissing.push_back(i);continue;}const auto cat=it->second.category;bool truncate=false;
  if(cat==9){r.events.push_back("SetPremiumTicket");r.events.push_back("SendAuthenCode");truncate=true;}
  if(cat==101){r.exp=std::max<std::int64_t>(0,s32(r.exp+p.amount));r.cached=level(r.exp);r.dynamic=1;r.events.push_back("IncDecExp");r.events.push_back("SetLevel");truncate=true;}
  if(cat==100){r.money=std::clamp<std::int64_t>(s32(r.money+p.amount),0,1000000);r.dynamic=1;r.events.push_back("IncDecMoney");truncate=true;}
  if(cat==100||cat==101){r.games=0;r.dynamic=0;r.simple=0;r.events.push_back("DeferFlushModifiedInfo");r.events.push_back("WriteUserDynInfo");}
  r.events.push_back("LoadOnUserInventory");r.userLevels.push_back(s32(r.cached+32768));if(s32(p.exec)>=0&&s32(p.ret)>=0){r.events.push_back("AppendPreInventory");r.preRows.push_back(i);}static_cast<void>(truncate);
 }
 if(!c.ownedOpen)return r;
 index=0;for(;;){++r.reads;if(index>=c.owned.size())break;const auto i=index++;++r.fetched;if(r.counted>=400)break;const auto& v=c.owned[i];const auto it=defs.find(v.item);if(it==defs.end()){r.missing.push_back(i);++r.counted;continue;}
  const std::int64_t elapsed=static_cast<std::int64_t>(r.clocks)*c.step;const auto seconds=(c.negative?21600LL:0LL)+elapsed/1000;const auto days=(c.negative?-1LL:46024LL)+seconds/86400;const auto fraction=static_cast<double>(seconds%86400)/86400.0;const double now=days<0?static_cast<double>(days)-fraction:static_cast<double>(days)+fraction;++r.clocks;
  const bool oldLevel=r.cached>=v.validity,oldDate=now>v.date;if(oldLevel||oldDate){r.deleted.push_back({i,oldLevel?1U:0U,oldDate?1U:0U});continue;}
  r.rows.push_back(i);++r.counted;if(v.slot!=255&&it->second.category==5){r.icon=true;r.iconSN=v.item;}if(v.slot!=255&&it->second.category==6){r.fake=true;r.fakeLevel=it->second.attr;}
 }return r;}
static Bytes packet(const Case& c,const Result& r,bool pre,bool coded){Bytes out;byte(out,pre?207:201,coded);byte(out,1,coded);if(pre){byte(out,static_cast<std::int64_t>(r.preRows.size()),coded);for(auto i:r.preRows){const auto& v=c.pre[i];byte(out,23,coded);dword(out,v.item,coded);word(out,v.amount,coded);word(out,defs.at(v.item).category==101?r.cached:0,coded);word(out,99999,coded);text(out,"PRE attribute",coded);text(out,"PRE description",coded);}}
 else{dword(out,static_cast<std::int64_t>(r.rows.size()),coded);for(auto i:r.rows){const auto& v=c.owned[i];dword(out,v.item,coded);byte(out,v.slot,coded);dword(out,v.amount,coded);text(out,v.verbose,coded);const auto b=dateBytes(v.date);out.insert(out.end(),b.begin(),b.end());}}return out;}
template<class T>static void list(const std::vector<T>& a){std::cout<<'[';for(unsigned i=0;i<a.size();++i){if(i)std::cout<<',';std::cout<<a[i];}std::cout<<']';}
static void emit(const Case& c){static bool first=true;if(!first)std::cout<<',';first=false;const auto r=run(c);const bool complete=c.preOpen&&c.ownedOpen;std::cout<<"{\"PreOpened\":"<<(c.preOpen?"true":"false")<<",\"OwnedOpened\":"<<(c.ownedOpen?"true":"false")<<",\"PreScenario\":"<<c.preScenario<<",\"OwnedScenario\":"<<c.ownedScenario<<",\"Negative\":"<<(c.negative?"true":"false")<<",\"Step\":"<<c.step<<",\"PreRows\":[";
 for(unsigned i=0;i<c.pre.size();++i){if(i)std::cout<<',';const auto& p=c.pre[i];std::cout<<"{\"SN\":"<<p.sn<<",\"ItemSn\":"<<p.item<<",\"Amount\":"<<p.amount<<",\"ExecResult\":"<<p.exec<<",\"ReturnValue\":"<<p.ret<<'}';}std::cout<<"],\"OwnedRows\":[";
 for(unsigned i=0;i<c.owned.size();++i){if(i)std::cout<<',';const auto& v=c.owned[i];std::cout<<"{\"ItemSn\":"<<v.item<<",\"Slot\":"<<v.slot<<",\"Amount\":"<<v.amount<<",\"DateHex\":\""<<hex(dateBytes(v.date))<<"\",\"LevelCreated\":"<<v.validity<<",\"Verbose\":\""<<v.verbose<<"\"}";}
 std::cout<<"],\"Expected\":{\"Stage\":\""<<(!c.preOpen?"pre-open-failed":(!c.ownedOpen?"owned-open-failed":"complete"))<<"\",\"After\":{\"ID\":\"Native\",\"GlobalSerialNo\":2309737967,\"Authencode\":0,\"Exp\":"<<r.exp<<",\"Money\":"<<r.money<<",\"Level\":"<<r.cached<<",\"DynamicModified\":"<<r.dynamic<<",\"SimpleInfoModified\":"<<r.simple<<",\"GamesSinceFlush\":"<<r.games<<"},\"PreRows\":";list(r.preRows);std::cout<<",\"PreMissing\":";list(r.preMissing);std::cout<<",\"PreReads\":"<<r.preReads<<",\"PreFetched\":"<<r.preFetched<<",\"Events\":[";for(unsigned i=0;i<r.events.size();++i){if(i)std::cout<<',';std::cout<<'"'<<r.events[i]<<'"';}std::cout<<"],\"UserLevels\":";list(r.userLevels);std::cout<<",\"Rows\":";list(r.rows);std::cout<<",\"Missing\":";list(r.missing);std::cout<<",\"Deletes\":[";for(unsigned i=0;i<r.deleted.size();++i){if(i)std::cout<<',';const auto& d=r.deleted[i];std::cout<<'['<<d[0]<<','<<d[1]<<','<<d[2]<<']';}std::cout<<"],\"Reads\":"<<r.reads<<",\"Fetched\":"<<r.fetched<<",\"Counted\":"<<r.counted<<",\"Clocks\":"<<r.clocks<<",\"Equipment\":{";if(r.fake)std::cout<<"\"FakeLevel\":"<<r.fakeLevel;if(r.fake&&r.icon)std::cout<<',';if(r.icon)std::cout<<"\"LevelIconSN\":"<<r.iconSN;std::cout<<'}';
 for(bool pre:{false,true}) { for(bool coded:{false,true}) { std::cout<<",\""<<(pre?"Pre":"Owned")<<(coded?"ScalarHex":"PlainHex")<<"\":"<<(complete?"\""+hex(packet(c,r,pre,coded))+"\"":"null"); } }
 std::cout<<"}}";
}
int main(){std::cout<<"{\"Model\":\"OUR independent observed pre-to-owned ordering/counters/After-level/201207 model, NOT SQL/financial/native DLL/client proof\",\"Cases\":[";for(unsigned p=0;p<8;++p)for(unsigned o=0;o<4;++o)for(bool pre:{false,true})for(bool owned:{false,true})emit(make(p,o,pre,owned));
 for(unsigned variant=0;variant<3;++variant){auto c=make(3,0,true,true);c.ownedScenario=100+variant;c.owned.clear();c.step=0;for(unsigned i=0;i<410;++i)c.owned.push_back({variant==1?999U:7U,255,3,46025,variant==2&&i<7?1:32767,"BOUND"});emit(c);}std::cout<<"]}\n";}
