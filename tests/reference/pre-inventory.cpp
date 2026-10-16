// OUR manual native InitPreInventory0040ACF4 /20700416CA9 model.
// Independent from TypeScript and its codec. Uses read-only PE level INPUTS.
// Procedure/premium outcomes are OBSERVATIONS, not executed effects or ACKs.
#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>
#include "pre-inventory-levels.h"
using Bytes=std::vector<unsigned char>;
static std::int64_t s32(std::int64_t n){const auto u=static_cast<std::uint32_t>(n);return u<0x80000000U?u:static_cast<std::int64_t>(u)-0x100000000LL;}
static int level(std::int64_t exp){int n=1;while(n<static_cast<int>(levels.size())&&exp>=levels[static_cast<std::size_t>(n)])++n;return n;}
static std::string hex(const std::string& s){static constexpr char h[]="0123456789abcdef";std::string out;for(unsigned char c:s){out+=h[c>>4];out+=h[c&15];}return out;}
static std::string hex(const Bytes& s){return hex(std::string(s.begin(),s.end()));}
static void b(Bytes& o,std::int64_t n,bool coded){o.push_back(static_cast<unsigned char>(static_cast<std::uint32_t>(n)^(coded?0x5aU:0U)));}
static void w(Bytes& o,std::int64_t n,bool coded){const auto u=static_cast<std::uint32_t>(n)^(coded?0xa569U:0U);o.push_back(static_cast<unsigned char>(u>>8));o.push_back(static_cast<unsigned char>(u));}
static void d(Bytes& o,std::int64_t n,bool coded){const auto u=static_cast<std::uint32_t>(n)^(coded?0x96ca5395U:0U);for(int i=3;i>=0;--i)o.push_back(static_cast<unsigned char>(u>>(i*8)));}
static void str(Bytes& o,const std::string& s,bool coded){w(o,static_cast<std::int64_t>(s.size()),coded);o.insert(o.end(),s.begin(),s.end());}
struct Row{std::uint32_t sn=0xfedcba98U,item=7,stock=0x89abcdefU;unsigned type=23,slot=255;std::int64_t amount=3,period=99999,validity=32768;std::string description="PRE description",attr="PRE attribute";};
struct Obs{Row row;bool premium=true;std::int64_t exec=0,ret=0;};
struct State{unsigned auth=0;std::int64_t exp=250,money=37,cached=2,dynamic=2,simple=3;std::uint32_t games=0xffffffffU;};
struct Case{std::string name="fixture",encoding="big5";bool opened=true;State initial;std::map<std::uint32_t,unsigned> defs{{7,2}},packetDefs;bool separatePacketDefs=false;std::vector<Obs> input{{}};};
struct Result{State state;unsigned reads=0,fetched=0;std::vector<Row> rows;std::vector<unsigned> missing;std::vector<std::string> events;};
static void state(std::ostream& out,const State& s){out<<"{\"ID\":\"Native\",\"GlobalSerialNo\":2309737967,\"Authencode\":"<<s.auth<<",\"Exp\":"<<s.exp<<",\"Money\":"<<s.money<<",\"Level\":"<<s.cached<<",\"DynamicModified\":"<<s.dynamic<<",\"SimpleInfoModified\":"<<s.simple<<",\"GamesSinceFlush\":"<<s.games<<'}';}
static void row(std::ostream& o,const Row& r){o<<"{\"SN\":"<<r.sn<<",\"Type\":"<<r.type<<",\"ItemSn\":"<<r.item<<",\"StockSn\":"<<r.stock<<",\"Slot\":"<<r.slot<<",\"Amount\":"<<s32(r.amount)<<",\"ValidityPeriod\":"<<s32(r.period)<<",\"ValidityLevel\":"<<s32(r.validity)<<",\"DescriptionHex\":\""<<hex(r.description)<<"\",\"AttrHex\":\""<<hex(r.attr)<<"\"}";}
static Result load(const Case& c){Result r;r.state=c.initial;if(!c.opened)return r;unsigned next=0;
 for(;;){r.reads++;if(next>=c.input.size())break;const unsigned index=next++;const auto& o=c.input[index];const auto& v=o.row;r.fetched++;if(r.rows.size()>=30)break;
  const auto def=c.defs.find(v.item);if(def==c.defs.end()){r.missing.push_back(index);continue;}const unsigned category=def->second;
  const auto event=[&](const std::string& kind,const std::string& fields=""){r.events.push_back("{\"RowIndex\":"+std::to_string(index)+",\"Kind\":\""+kind+"\""+fields+"}");};
  int truncate=0;
  if(category==9){event("SetPremiumTicket",",\"ValidityPeriod\":"+std::to_string(s32(v.period))+",\"Result\":"+(o.premium?"true":"false"));if(o.premium&&r.state.auth!=1)event("SendAuthenCode",",\"GlobalSerialNo\":2309737967,\"Authencode\":1");truncate=1;}
  if(category==101){const auto old=r.state.cached;r.state.exp=std::max<std::int64_t>(0,s32(r.state.exp+s32(v.amount)));r.state.dynamic=1;r.state.cached=level(r.state.exp);const int direction=r.state.cached>old?1:(r.state.cached<old?-1:0);if(direction)r.state.simple=1;event("IncDecExp",",\"Delta\":"+std::to_string(s32(v.amount))+",\"ExpAfter\":"+std::to_string(r.state.exp)+",\"LevelAfter\":"+std::to_string(r.state.cached)+",\"Direction\":"+std::to_string(direction));event("SetLevel",",\"Level\":"+std::to_string(r.state.cached));truncate=1;}
  if(category==100){r.state.money=std::clamp<std::int64_t>(s32(r.state.money+s32(v.amount)),0,1000000);r.state.dynamic=1;event("IncDecMoney",",\"Delta\":"+std::to_string(s32(v.amount))+",\"MoneyAfter\":"+std::to_string(r.state.money));truncate=1;}
  if(category==100||category==101){event("DeferFlushModifiedInfo",",\"Force\":1");r.state.games=0;r.state.dynamic=0;r.state.simple=0;event("WriteUserDynInfo",",\"Exp\":"+std::to_string(r.state.exp)+",\"Money\":"+std::to_string(r.state.money));}
  const bool ok=s32(o.exec)>=0&&s32(o.ret)>=0;
  std::ostringstream call;call<<",\"Call\":{\"PreInventorySn\":"<<s32(v.sn)<<",\"UserID\":\"Native\",\"ItemSN\":"<<s32(v.item)<<",\"StockSN\":"<<s32(v.stock)<<",\"Slot\":"<<v.slot<<",\"Unit\":"<<s32(v.amount)<<",\"ValidityPeriod\":"<<s32(v.period)<<",\"UserLevel\":"<<s32(r.state.cached+s32(v.validity))<<",\"TruncateOnly\":"<<truncate<<"},\"ExecResult\":"<<s32(o.exec)<<",\"ReturnValue\":"<<s32(o.ret)<<",\"Result\":"<<(ok?"true":"false");event("LoadOnUserInventory",call.str());
  if(ok){event("AppendPreInventory",",\"Index\":"+std::to_string(r.rows.size()));r.rows.push_back(v);}
 }
 return r;
}
static Bytes packet(const Case& c,const Result& r,bool coded,unsigned& emitted){Bytes out;b(out,207,coded);b(out,1,coded);b(out,static_cast<std::int64_t>(r.rows.size()),coded);emitted=0;const auto& defs=c.separatePacketDefs?c.packetDefs:c.defs;
 for(const auto& v:r.rows){const auto def=defs.find(v.item);if(def==defs.end())continue;++emitted;b(out,v.type,coded);d(out,v.item,coded);w(out,s32(v.amount),coded);w(out,def->second==101?r.state.cached:0,coded);w(out,s32(v.period)<100000?s32(v.period):0,coded);str(out,v.attr,coded);str(out,v.description,coded);}return out;
}
static void defs(std::ostream& o,const std::map<std::uint32_t,unsigned>& rows){o<<'[';bool comma=false;for(const auto& e:rows){if(comma)o<<',';comma=true;o<<"{\"SN\":"<<e.first<<",\"Category\":"<<e.second<<'}';}o<<']';}
static bool first=true;
static void emit(const Case& c){if(!first)std::cout<<',';first=false;const auto r=load(c);unsigned emitted=0;const auto coded=packet(c,r,true,emitted),plain=packet(c,r,false,emitted);
 std::cout<<"{\"Name\":\""<<c.name<<"\",\"Encoding\":\""<<c.encoding<<"\",\"Opened\":"<<(c.opened?"true":"false")<<",\"Initial\":";state(std::cout,c.initial);std::cout<<",\"Definitions\":";defs(std::cout,c.defs);std::cout<<",\"PacketDefinitions\":";defs(std::cout,c.separatePacketDefs?c.packetDefs:c.defs);std::cout<<",\"Input\":[";bool comma=false;for(const auto& v:c.input){if(comma)std::cout<<',';comma=true;std::cout<<"{\"Row\":";row(std::cout,v.row);std::cout<<",\"PremiumTicketResult\":"<<(v.premium?"true":"false")<<",\"ExecResult\":"<<s32(v.exec)<<",\"ReturnValue\":"<<s32(v.ret)<<'}';}
 std::cout<<"],\"Expected\":{\"After\":";state(std::cout,r.state);std::cout<<",\"Rows\":[";comma=false;for(const auto& v:r.rows){if(comma)std::cout<<',';comma=true;row(std::cout,v);}std::cout<<"],\"Events\":[";comma=false;for(const auto& v:r.events){if(comma)std::cout<<',';comma=true;std::cout<<v;}std::cout<<"],\"MissingDefinitionRows\":[";comma=false;for(auto v:r.missing){if(comma)std::cout<<',';comma=true;std::cout<<v;}std::cout<<"],\"RowsetReads\":"<<r.reads<<",\"FetchedRows\":"<<r.fetched<<",\"SuccessfulRows\":"<<r.rows.size()<<",\"PacketMalformed\":"<<(emitted!=r.rows.size()?"true":"false")<<",\"PacketHex\":\""<<hex(coded)<<"\",\"PlainPacketHex\":\""<<hex(plain)<<"\"}}";
}
int main(){std::cout<<"{\"Model\":\"manual independent InitPreInventory trace and207, NOT native execution, SQL, durable effects, transfer authority or client proof\",\"Cases\":[";
 for(unsigned category=0;category<256;category++)for(int outcome=0;outcome<4;outcome++){Case c;c.name="all-category-vs-Type-and-both-procedure-results";c.defs={{7,category}};c.input[0].row.type=(category+17)%256;c.input[0].exec=(outcome&1)?-1:0;c.input[0].ret=(outcome&2)?-1:0;c.input[0].premium=(outcome&1)==0;emit(c);}
 for(unsigned auth=0;auth<256;auth++)for(bool premium:{false,true})for(bool success:{false,true}){Case c;c.name="all-FXGS-auth-BYTEs-premium-does-not-change-local-auth";c.initial.auth=auth;c.defs={{7,9}};c.input[0].premium=premium;c.input[0].ret=success?0:-1;emit(c);}
 for(unsigned type=0;type<256;type++){Case c;c.name="all-source-Type-BYTEs-never-dispatch-category";c.input[0].row.type=type;c.defs={{7,type%2?100U:101U}};emit(c);}
 for(unsigned category:{100U,101U})for(auto start:{-2147483648LL,-1LL,0LL,37LL,999999LL,1000000LL,2147483647LL})for(auto delta:{-2147483648LL,-1000001LL,-1LL,0LL,1LL,1000001LL,2147483647LL})for(bool success:{false,true}){Case c;c.name="signed-wrap-before-clamp-prefix-survives-failure";c.initial.exp=start;c.initial.money=start;c.initial.cached=449;c.defs={{7,category}};c.input[0].row.amount=delta;c.input[0].ret=success?0:-1;emit(c);}
 for(unsigned count:{0U,1U,29U,30U,31U,32U})for(unsigned kind:{0U,1U,2U}){Case c;c.name="success30-not-read-limit-extra-fetch";c.input.clear();if(kind==1)c.defs.clear();for(unsigned i=0;i<count;i++){Obs o;o.row.sn=i;o.ret=kind==2?-1:0;c.input.push_back(o);}emit(c);}
 {Case c;c.name="80-missing-70-failed-30-success-plus-unprocessed-row";c.input.clear();for(unsigned i=0;i<181;i++){Obs o;o.row.sn=i;if(i<80)o.row.item=999;else if(i<150)o.ret=-1;c.input.push_back(o);}emit(c);}
 for(auto period:{-2147483648LL,-1LL,0LL,65535LL,65536LL,99999LL,100000LL,100001LL,2147483647LL})for(auto validity:{-2147483648LL,-32768LL,0LL,32767LL,65535LL,2147483647LL}){Case c;c.name="period-gate-and-32bit-validity-level-not-16bit";c.input[0].row.period=period;c.input[0].row.validity=validity;c.initial.cached=449;emit(c);}
 for(auto key:{0U,65535U,65536U,0x7fffffffU,0x80000000U,0xffffffffU}){Case c;c.name="SN-ItemSn-StockSn-separate-signed-SQL-longs";c.defs={{key,101}};c.input[0].row.sn=key^0x12345678U;c.input[0].row.item=key;c.input[0].row.stock=key^0xabcdef01U;c.input[0].row.amount=0xffff1234U;emit(c);}
 {Case c;c.name="ordered-XP-money-premium-failed-then-success";c.defs={{1,101},{2,2},{3,100},{4,9}};c.input.clear();for(unsigned i=0;i<8;i++){Obs o;o.row.item=(i%4)+1;o.row.amount=100000;o.exec=i<4?-1:0;c.input.push_back(o);}emit(c);}
 {Case c;c.name="duplicate-premium-sends-again-without-local-ACK";c.defs={{7,9}};c.input.resize(3);emit(c);}
 {Case c;c.name="rowset-open-failure-no-prefix-no-reads";c.opened=false;c.defs={{7,101}};emit(c);}
 {Case c;c.name="removed-definition-native-header-body-mismatch-modern-reject";c.separatePacketDefs=true;emit(c);}
 {Case c;c.name="packet-category-generation-not-copied-from-load";c.separatePacketDefs=true;c.packetDefs={{7,101}};emit(c);}
 for(const auto& encoding:std::array<std::string,3>{"big5","cp949","utf8"}){Case c;c.name="raw-codepage-attribute-before-description";c.encoding=encoding;auto& v=c.input[0].row;v.attr=encoding=="big5"?std::string("\xa4\xa4\xa4\xe5",4):(encoding=="cp949"?std::string("\xb0\xa1",2):std::string("\xe4\xb8\xad\xf0\x9f\x8e\xae",7));v.description=v.attr+" / description";emit(c);}
 std::cout<<"]}\n";
}
