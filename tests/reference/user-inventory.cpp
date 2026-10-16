// OUR independent manual model of the supplied native READ-SIDE instructions.
// Not native execution, Win32/OLEDB/CTime emulation, SQL restore, grants or shop.
// InitUserInventory0040AF55 AFTER InitPreInventory; dates are supplied f64 DATE
// observations, not calendar/Unix conversions. 201/105 remain scalar bodies.
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

using Bytes=std::vector<unsigned char>;
static std::int64_t s32(std::int64_t n){const auto u=static_cast<std::uint32_t>(n);return u<0x80000000U?u:static_cast<std::int64_t>(u)-0x100000000LL;}
static std::int32_t s16(std::int64_t n){const auto u=static_cast<std::uint16_t>(n);return u<0x8000U?u:static_cast<std::int32_t>(u)-0x10000;}
static void b(Bytes& out,std::uint32_t n,bool scalar=true){out.push_back(static_cast<unsigned char>(n^(scalar?0x5aU:0U)));}
static void w(Bytes& out,std::uint32_t n,bool scalar=true){n^=scalar?0xa569U:0U;out.push_back(static_cast<unsigned char>(n>>8U));out.push_back(static_cast<unsigned char>(n));}
static void d(Bytes& out,std::uint32_t n,bool scalar=true){n^=scalar?0x96ca5395U:0U;for(int i=3;i>=0;--i)out.push_back(static_cast<unsigned char>(n>>(8*i)));}
static void str(Bytes& out,const std::string& value,bool scalar=true){w(out,static_cast<std::uint32_t>(value.size()),scalar);out.insert(out.end(),value.begin(),value.end());}
static Bytes date(double value){static_assert(sizeof(double)==8,"f64 DATE required");std::uint64_t bits=0;std::memcpy(&bits,&value,8);Bytes out;for(int i=0;i<8;i++)out.push_back(static_cast<unsigned char>(bits>>(8*i)));return out;}
static std::string hex(const Bytes& data){static constexpr char digits[]="0123456789abcdef";std::string out;for(auto x:data){out+=digits[x>>4U];out+=digits[x&15U];}return out;}
static std::string hex(const std::string& data){return hex(Bytes(data.begin(),data.end()));}
struct Definition {std::uint32_t sn;unsigned category;std::string attr;std::int64_t a,c,e;};
struct Record {std::uint32_t sn=7,stock=0xfedcba98U;unsigned slot=0;std::int64_t amount=3;double time=50000.5;std::int64_t level=32767;std::string verbose="owned row NOT catalog name";};
struct Row {Record r;Definition item;};
struct Del {unsigned index;std::uint32_t sn;bool level,time;};
struct Case {std::string name="fixture",encoding="big5";std::vector<Definition> defs;std::vector<Record> records;std::vector<double> clock={45000.25};std::int64_t level=1,fake=7;int icon=3;std::uint32_t iconSN=0x12345678U;int category=2,position=0;std::int64_t sn=7;std::string attr="Item/Fixture";};
struct Result {std::vector<Row> rows;std::vector<Del> deletes;std::vector<unsigned> missing;unsigned reads=0,fetched=0,counted=0,clocks=0;bool hasFake=false,hasIcon=false;std::int64_t fake=0;std::uint32_t iconSN=0;};
static Result load(const Case& c){
 std::map<std::uint32_t,Definition> defs;for(auto r:c.defs)defs.emplace(r.sn,r);
 Result result;std::size_t next=0;
 for(;;){result.reads++;if(next==c.records.size())break;auto row=c.records[next++];result.fetched++;if(result.counted>=400)break;
  const auto found=defs.find(row.sn);if(found==defs.end()){result.missing.push_back(static_cast<unsigned>(next-1));result.counted++;continue;}
  if(c.clock.empty())throw std::runtime_error("model attempted absent clock");
  const bool badLevel=c.level>=s16(row.level);const double now=c.clock[std::min<std::size_t>(result.clocks,c.clock.size()-1)];result.clocks++;
  const bool badTime=now>row.time;
  if(badLevel||badTime){result.deletes.push_back({static_cast<unsigned>(next-1),found->second.sn,badLevel,badTime});continue;}
  row.amount=s32(row.amount);row.level=s16(row.level);result.rows.push_back({row,found->second});
  if(row.slot!=255){if(found->second.category==5){result.hasIcon=true;result.iconSN=found->second.sn;}if(found->second.category==6){result.hasFake=true;result.fake=s32(found->second.a);}}
  result.counted++;
 }
 return result;
}
template<class Predicate>static const Row* first(const std::vector<Row>& rows,Predicate predicate){for(const auto& row:rows)if(predicate(row))return &row;return nullptr;}
static const Row* loaded(const std::vector<Row>& rows,int category){return first(rows,[&](const Row& r){return static_cast<int>(r.item.category)==category&&r.r.slot!=255;});}
static const Row* deco(const std::vector<Row>& rows,int category,int position){return first(rows,[&](const Row& r){return static_cast<int>(r.item.category)==category&&s32(r.item.c)==position&&r.r.slot!=255;});}
static Bytes inventory(const Result& result,bool scalar=true){Bytes out;b(out,201,scalar);d(out,static_cast<std::uint32_t>(result.rows.size()),scalar);for(const auto& row:result.rows){d(out,row.r.sn,scalar);b(out,row.r.slot,scalar);d(out,static_cast<std::uint32_t>(row.r.amount),scalar);str(out,row.r.verbose,scalar);const auto raw=date(row.r.time);out.insert(out.end(),raw.begin(),raw.end());}return out;}
static Bytes list(const Result& result,int category){Bytes out;unsigned count=0;for(const auto& r:result.rows)if(static_cast<int>(r.item.category)==category)count++;w(out,count);for(const auto& r:result.rows)if(static_cast<int>(r.item.category)==category)w(out,r.r.sn);return out;}
static Bytes accessories(const Result& result){Bytes out;unsigned count=0;for(int p=0;p<9;p++)if(deco(result.rows,10,p))count++;b(out,count);if(count){b(out,3);for(int p=0;p<9;p++){const auto* row=deco(result.rows,10,p);if(row){b(out,static_cast<unsigned>(p));w(out,static_cast<std::uint32_t>(row->item.a));}}}
 count=0;for(int p=0;p<5;p++)if(deco(result.rows,12,p))count++;b(out,count);if(count){b(out,3);for(int p=0;p<5;p++){const auto* row=deco(result.rows,12,p);if(row){d(out,static_cast<std::uint32_t>(row->item.a));d(out,static_cast<std::uint32_t>(row->item.c));d(out,static_cast<std::uint32_t>(row->item.e));}}}
 const auto* tail=loaded(result.rows,14);d(out,tail?static_cast<std::uint32_t>(tail->item.e):0U);return out;}
static std::int64_t fakeAfter(const Case& c,const Result& r){return r.hasFake?r.fake:c.fake;}
static std::int64_t lookAfter(const Case& c,const Result& r){return std::min<std::int64_t>(450,std::max<std::int64_t>(1,s32(c.level+fakeAfter(c,r))));}
static Bytes player(const Case& c,const Result& r,bool self){Bytes out;b(out,105);b(out,3);d(out,0x89abcdefU);b(out,self?1U:0U);b(out,0xf1);if(self){const auto* v=loaded(r.rows,4);b(out,v?static_cast<std::uint32_t>(v->item.a):255U);}out.insert(out.end(),{1,2,3});str(out,"Native");b(out,1);w(out,static_cast<std::uint32_t>(lookAfter(c,r)));d(out,(r.hasIcon||c.icon)?(r.hasIcon?r.iconSN:c.iconSN):0U);d(out,0xfedcba98U);w(out,0);const auto suffix=accessories(r);out.insert(out.end(),suffix.begin(),suffix.end());return out;}
static void record(const Record& r){std::cout<<"{\"ItemSn\":"<<r.sn<<",\"StockSn\":"<<r.stock<<",\"Slot\":"<<r.slot<<",\"Amount\":"<<r.amount<<",\"DateHex\":\""<<hex(date(r.time))<<"\",\"LevelCreated\":"<<r.level<<",\"VerboseHex\":\""<<hex(r.verbose)<<"\"}";}
static void item(const Definition& r){std::cout<<"{\"SN\":"<<r.sn<<",\"Category\":"<<r.category<<",\"AttrHex\":\""<<hex(r.attr)<<"\",\"nAttr1\":"<<r.a<<",\"nAttr2\":"<<r.c<<",\"nAttr3\":"<<r.e<<"}";}
static void resident(const Row& r){std::cout<<"{\"Record\":";record(r.r);std::cout<<",\"Definition\":";item({r.item.sn,r.item.category,r.item.attr,s32(r.item.a),s32(r.item.c),s32(r.item.e)});std::cout<<",\"Modified\":0}";}
static void pointer(const char* name,const Row* row){std::cout<<",\""<<name<<"\":";if(row)std::cout<<row->r.sn;else std::cout<<"null";}
static bool firstCase=true;
static void emit(const Case& c){if(!firstCase)std::cout<<',';firstCase=false;const auto r=load(c);std::cout<<"{\"Name\":\""<<c.name<<"\",\"Encoding\":\""<<c.encoding<<"\",\"Level\":"<<c.level<<",\"InitialFakeLevel\":"<<c.fake<<",\"InitialIconEnabled\":"<<c.icon<<",\"InitialIconSN\":"<<c.iconSN<<",\"CategoryProbe\":"<<c.category<<",\"PositionProbe\":"<<c.position<<",\"SNProbe\":"<<c.sn<<",\"AttributeHex\":\""<<hex(c.attr)<<"\",\"Definitions\":[";bool comma=false;for(const auto& v:c.defs){if(comma)std::cout<<',';comma=true;item(v);}std::cout<<"],\"Records\":[";comma=false;for(const auto& v:c.records){if(comma)std::cout<<',';comma=true;record(v);}std::cout<<"],\"ClockHex\":[";comma=false;for(auto v:c.clock){if(comma)std::cout<<',';comma=true;std::cout<<'"'<<hex(date(v))<<'"';}
 std::cout<<"],\"Expected\":{\"Rows\":[";comma=false;for(const auto& v:r.rows){if(comma)std::cout<<',';comma=true;resident(v);}std::cout<<"],\"RowsetReads\":"<<r.reads<<",\"FetchedRows\":"<<r.fetched<<",\"CountedRows\":"<<r.counted<<",\"ClockReads\":"<<r.clocks<<",\"MissingDefinitionRows\":[";comma=false;for(auto v:r.missing){if(comma)std::cout<<',';comma=true;std::cout<<v;}std::cout<<"],\"DeleteAttempts\":[";comma=false;for(const auto& v:r.deletes){if(comma)std::cout<<',';comma=true;std::cout<<"{\"RowIndex\":"<<v.index<<",\"ItemSn\":"<<v.sn<<",\"LevelExpired\":"<<(v.level?"true":"false")<<",\"DateExpired\":"<<(v.time?"true":"false")<<"}";}
 std::cout<<"],\"Equipment\":{";comma=false;if(r.hasFake){std::cout<<"\"FakeLevel\":"<<r.fake;comma=true;}if(r.hasIcon){if(comma)std::cout<<',';std::cout<<"\"LevelIconSN\":"<<r.iconSN;}std::cout<<"},\"FakeLevelAfter\":"<<fakeAfter(c,r)<<",\"IconEnabledAfter\":"<<(r.hasIcon?1:c.icon)<<",\"IconSNAfter\":"<<s32(r.hasIcon?r.iconSN:c.iconSN)<<",\"LookLevelAfter\":"<<lookAfter(c,r);
 pointer("FirstSN",first(r.rows,[&](const Row& v){return v.r.sn==static_cast<std::uint32_t>(c.sn);}));pointer("FromAllSN",first(r.rows,[&](const Row& v){return v.item.attr==c.attr;}));pointer("LoadedSN",loaded(r.rows,c.category));pointer("SlotDecoSN",deco(r.rows,10,c.position));pointer("CharDecoSN",deco(r.rows,12,c.position));
 const auto* function=first(r.rows,[&](const Row& v){return v.item.category==2&&v.item.attr==c.attr;});std::cout<<",\"Functional\":"<<(function?"true":"false")<<",\"InventoryHex\":\""<<hex(inventory(r))<<"\",\"PlainInventoryHex\":\""<<hex(inventory(r,false))<<"\",\"FilteredHex\":\""<<hex(list(r,c.category))<<"\",\"AccessoryHex\":\""<<hex(accessories(r))<<"\",\"Self105Hex\":";
 if(c.level>=1&&c.level<=450)std::cout<<'"'<<hex(player(c,r,true))<<'"';else std::cout<<"null";std::cout<<",\"Other105Hex\":";if(c.level>=1&&c.level<=450)std::cout<<'"'<<hex(player(c,r,false))<<'"';else std::cout<<"null";std::cout<<"}}";
}
static Definition def(std::uint32_t sn,unsigned category=2,std::int64_t a=0,std::int64_t c=0,std::int64_t e=0){return {sn,category,"Item/Fixture",a,c,e};}
static Record row(std::uint32_t sn=7,unsigned slot=0,std::int64_t amount=3,double time=50000.5,std::int64_t level=32767){Record r;r.sn=sn;r.slot=slot;r.amount=amount;r.time=time;r.level=level;return r;}
int main(){
 std::cout<<"{\"Model\":\"independent manual native inventory READ-SIDE projection/queries/201/105; NOT native execution, SQL/CTime conversion, pre-inventory, paid persistence or client proof\",\"Cases\":[";
 const std::array<std::uint32_t,6> keys={0U,65535U,65537U,0x7fffffffU,0x80000000U,0xffffffffU};const std::array<std::int64_t,6> attrs={0,1,-1,2147483647LL,2147483648LL,4294967295LL};
 for(unsigned category=0;category<256;category++)for(unsigned variant=0;variant<6;variant++){
  Case c;c.name="all-categories-slots-amounts";c.category=static_cast<int>(category);c.position=static_cast<int>(variant);c.sn=keys[variant]==0xffffffffU?-1LL:keys[variant];c.defs={def(keys[variant],category,attrs[variant],variant,attrs[(variant+2)%6])};c.records={row(keys[variant],variant%3==0?0U:(variant%3==1?254U:255U),variant%2==0?0:1)};emit(c);
 }
 for(auto threshold:{0LL,1LL,2LL,32767LL,32768LL,65535LL,-32768LL,-1LL})for(auto level:{-2147483648LL,0LL,1LL,2LL,449LL,450LL,2147483647LL})for(int delta=-1;delta<=1;delta++){
  Case c;c.name="signed-short-level-and-strict-date";c.level=level;c.defs={def(7)};c.records={row(7,0,3,45000.25+delta/86400.0,threshold)};emit(c);
 }
 for(double now:{-657434.0,-2.75,-1.0,-0.0,0.0,1.5,25569.0,2958465.75})for(int delta=-1;delta<=1;delta++){
  Case c;c.name="raw-DATE-no-epoch-or-permanent-zero";c.clock={now};c.defs={def(7)};c.records={row(7,0,3,now+delta/86400.0)};emit(c);
 }
 for(unsigned count:{0U,1U,399U,400U,401U,402U})for(bool missing:{false,true}){
  Case c;c.name=missing?"400-missing-counted-no-clock":"400-accepted-and-extra-GetNextRow";c.clock=missing?std::vector<double>{}:std::vector<double>{45000.25};if(!missing)c.defs={def(7)};for(unsigned i=0;i<count;i++)c.records.push_back(row());emit(c);
 }
 {Case c;c.name="1000-expired-then-400-accepted-not-SQL-LIMIT400";c.defs={def(7)};for(unsigned i=0;i<1000;i++)c.records.push_back(row(7,0,3,1.0));for(unsigned i=0;i<401;i++)c.records.push_back(row());emit(c);}
 {Case c;c.name="missing-never-deletes-or-samples-clock";c.clock={45000.0,45000.75,45000.5};c.defs={def(1),def(2,6,-17),def(3,5)};c.records={row(999,0,3,0.0,-1),row(1,0,3,45000.5),row(998,0,3,0.0,-1),row(2,0,3,45000.5),row(3,0,3,45000.5)};emit(c);}
 {Case c;c.name="same-SN-first-query-last-equipped-effects";c.defs={def(5,5),def(6,6,-5),def(7,6,8)};c.sn=5;c.records={row(5,255,0),row(5,0,9),row(6),row(7)};emit(c);}
 {Case c;c.name="category3-WORD-low-bits-no-dedup-no-StockSn";c.category=3;c.sn=0xaaaa1234U;c.defs={def(0xaaaa1234U,3),def(0xbbbb1234U,3)};c.records={row(0xaaaa1234U,255,0),row(0xbbbb1234U,0,-1)};emit(c);}
 for(auto amount:{-2147483648LL,-1LL,0LL,1LL,2147483647LL,2147483648LL,4294967295LL}){Case c;c.name="native-Amount-signed-DWORD-no-resident-filter";c.defs={def(7)};c.records={row(7,255,amount)};emit(c);}
 for(int position:{-1,0,1,4,5,8,9,2147483647}){
  Case c;c.name="all-equipped-positions-first-wins-no-Amount-or-date-recheck";c.position=position;c.category=14;c.sn=0x80000000U;std::uint32_t sn=100;
  c.defs.push_back(def(0x80000000U,4,0x123456fe));c.records.push_back(row(0x80000000U));
  for(int i=-1;i<=9;i++)for(int repeat=0;repeat<2;repeat++){c.defs.push_back(def(sn,10,0x12340000+i+repeat*100,i,-1));c.records.push_back(row(sn++,repeat?254U:0U,repeat?99:0));}
  for(int i=-1;i<=5;i++)for(int repeat=0;repeat<2;repeat++){c.defs.push_back(def(sn,12,-1+repeat,i,0x80000000LL+i));c.records.push_back(row(sn++,repeat?254U:0U,repeat?9:0));}
  c.defs.push_back(def(sn,14,0,0,0xdeadbeefU));c.records.push_back(row(sn++,255));c.defs.push_back(def(sn,14,0,0,0xabcdef01U));c.records.push_back(row(sn++,0,0));emit(c);
 }
 for(int category:{-1,256,2147483647}){Case c;c.name="category-query-int-not-wrapped-to-BYTE";c.category=category;c.defs={def(7,0)};c.records={row()};emit(c);}
 for(const auto& encoding:std::array<std::string,3>{"big5","cp949","utf8"}){Case c;c.name="raw-codepage-exact-attribute-and-Verbose";c.encoding=encoding;c.attr=encoding=="big5"?std::string("\xa4\xa4\xa4\xe5",4):(encoding=="cp949"?std::string("\xb0\xa1",2):std::string("\xe4\xb8\xad\xf0\x9f\x8e\xae",7));c.defs={def(7)};c.defs[0].attr=c.attr;auto r=row();r.verbose=c.attr;c.records={r};emit(c);}
 {Case c;c.name="same-attribute-wrong-category-not-functional";c.defs={def(7,3)};c.records={row(7,255,0)};emit(c);}
 {Case c;c.name="attribute-case-is-not-collation-or-Verbose";c.attr="item/fixture";c.defs={def(7,2)};auto r=row();r.verbose=c.attr;c.records={r};emit(c);}
 {Case c;c.name="negative-zero-DATE-bits-are-not-normalized";c.clock={0.0};c.defs={def(7)};c.records={row(7,0,3,-0.0)};emit(c);}
 std::cout<<"]}\n";
}
