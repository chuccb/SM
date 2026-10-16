// OUR independent manual C++ translation of FXGS0041EE05 case0 and201 layout.
// Reads the supplied archive as DATA, NEVER executes its EXE/DAT. No production
// parser/codec/session/SQL imports. Native signed SUB uses defined uint32 wrap.
// The native invalid-paid decrement/flags are recorded, NOT reproduced by TS.
// SQLite Unix-expiry/zero -> OLE date is a MODERN bridge, NOT native DB parity.
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>
using Bytes=std::vector<uint8_t>;
std::string hex(const Bytes& b) {const char* h="0123456789abcdef";std::string s;for(auto v:b){s+=h[v>>4];s+=h[v&15];}return s;}
void one(Bytes& b,uint32_t v){b.push_back(uint8_t(v^0x5a));}
void two(Bytes& b,uint32_t v){v^=0xa569;b.push_back(uint8_t(v>>8));b.push_back(uint8_t(v));}
void four(Bytes& b,uint32_t v){v^=0x96ca5395;for(int shift=24;shift>=0;shift-=8)b.push_back(uint8_t(v>>shift));}
void str(Bytes& b,const std::string& s){two(b,unsigned(s.size()));b.insert(b.end(),s.begin(),s.end());}
Bytes read(const std::string& path){std::ifstream f(path,std::ios::binary);if(!f)throw std::runtime_error("open archive");return Bytes(std::istreambuf_iterator<char>(f),{});}
uint32_t u32(const Bytes& b,size_t& p){if(p+4>b.size())throw std::runtime_error("truncated data");uint32_t n=0;for(int i=0;i<4;++i)n|=uint32_t(b[p++])<<(8*i);return n;}
void skip(const Bytes& b,size_t& p){const auto n=u32(b,p);if(n>127||p+n>b.size())throw std::runtime_error("resource string");p+=n;}
std::vector<int64_t> types(const std::string& base){
 const auto index=read(base+".idx");size_t p=0;const auto n=u32(index,p);uint32_t offset=0,length=0;
 for(uint32_t i=0;i<n;++i){const auto size=u32(index,p);if(p+size>index.size())throw std::runtime_error("index key");
  const std::string name(index.begin()+p,index.begin()+p+size);p+=size;const auto o=u32(index,p),l=u32(index,p);
  if(name=="Attr/ItemAttr"){offset=o;length=l;}}
 if(!length)throw std::runtime_error("missing ItemAttr");
 std::ifstream file(base+".idd",std::ios::binary);file.seekg(offset);Bytes b(length);file.read(reinterpret_cast<char*>(b.data()),length);
 if(!file){throw std::runtime_error("archive data");}
 p=0;u32(b,p);u32(b,p);const auto ships=u32(b,p);
 for(uint32_t i=0;i<ships;++i){u32(b,p);skip(b,p);for(int j=0;j<8;++j)u32(b,p);}
 std::vector<int64_t> out;
 while(p<b.size()){skip(b,p);skip(b,p);u32(b,p);u32(b,p);const auto v=u32(b,p);out.push_back(v<0x80000000u?int64_t(v):int64_t(v)-0x100000000ll);for(int j=0;j<5;++j)u32(b,p);}
 return out;
}
bool allowed(int64_t t){if(t>22)return t>=23&&(t<=28||(t>30&&t<=32));if(t==22)return true;return t>=11&&(t<=13||t==21);}
void sep(bool& first){if(!first)std::cout<<',';first=false;}
void emit(const std::vector<int64_t>& ts,unsigned index,unsigned slot,unsigned state,unsigned q,int64_t amount,bool resident,unsigned channel){
 const bool valid=index<ts.size(),effect=valid&&allowed(ts[index]),ignored=q>0&&channel==108;
 const uint32_t sn=resident?0x12345678u:0x23456789u,x=std::array<uint32_t,8>{0,1,255,256,0x80ff,0xff80,0xffff,0x1234}[slot],y=uint16_t(x^0xa75c),opaque=(index*37+slot*19)&255;
 Bytes request,response;one(request,146);one(request,slot);two(request,x);two(request,y);one(request,opaque);one(request,index);one(request,q);if(q)four(request,sn);
 int64_t after=amount;bool dirty=false,shop=false,refresh=false;std::string status;
 if(ignored)status="ignored";
 else {
  if(q){shop=true;if(!resident)status="missing";else{dirty=true;const uint32_t wrapped=uint32_t(amount)-q;after=wrapped<0x80000000u?int64_t(wrapped):int64_t(wrapped)-0x100000000ll;
    if(after<0){after=0;status="underflow";}}}
  if(status.empty()){if(!valid)status="invalid-index";else if(!effect)status="invalid-type";else{status="relayed";refresh=ts[index]==22&&state==3;}}
 }
 if(status=="relayed"){one(response,159);one(response,slot);two(response,x);two(response,y);one(response,opaque);one(response,index);one(response,q);}
 const std::string modern=ignored?"ignored":effect&&(!q||(resident&&amount>0&&amount<=0x7fffffffll&&amount>=q))?"relayed":"rejected";
 std::cout<<"{\"ItemIndex\":"<<index<<",\"Type\":";if(valid)std::cout<<ts[index];else std::cout<<"null";
 std::cout<<",\"Slot\":"<<slot<<",\"PlayerState\":"<<state<<",\"Quantity\":"<<q<<",\"BeforeAmount\":"<<amount<<",\"Resident\":"<<(resident?"true":"false")
 <<",\"ChannelType\":"<<channel<<",\"InventorySN\":"<<sn<<",\"X\":"<<x<<",\"Y\":"<<y<<",\"Opaque\":"<<opaque
 <<",\"NativeStatus\":\""<<status<<"\",\"ModernStatus\":\""<<modern<<"\",\"NativeAmount\":"<<after<<",\"NativeDirty\":"<<(dirty?1:0)<<",\"NativeShop\":"<<(shop?1:0)<<",\"NativeNice\":"<<(shop?1:0)
 <<",\"NativeRefreshTime\":"<<(refresh?"true":"false")<<",\"Request\":\""<<hex(request)<<"\",\"NativeResponse\":";
 if(response.empty())std::cout<<"null";else std::cout<<'"'<<hex(response)<<'"';std::cout<<'}';
}
void inventory(unsigned users,unsigned rows,unsigned seed){
 Bytes b;one(b,201);one(b,users);std::cout<<"{\"Users\":[";
 for(unsigned u=0;u<users;++u){if(u)std::cout<<',';std::cout<<'[';four(b,rows);
  for(unsigned i=0;i<rows;++i){if(i)std::cout<<',';const uint32_t sn=0x12345678u+u*19+i,slot=std::array<unsigned,5>{0,1,127,128,255}[(seed+i)%5],amount=std::array<uint32_t,5>{0,1,255,65536,0x7fffffffu}[(seed+u+i)%5];
   const uint32_t expiry=std::array<uint32_t,6>{0,1,86400,946684800,1700000001,0xffffffffu}[(seed+u+i)%6];
   const std::string verbose=i%2?"amount-before-description":"";four(b,sn);one(b,slot);four(b,amount);str(b,verbose);
   const double date=expiry?double(expiry)/86400.0+25569.0:0.0;uint64_t bits;static_assert(sizeof(date)==sizeof(bits));std::memcpy(&bits,&date,sizeof(bits));
   for(int shift=0;shift<64;shift+=8)b.push_back(uint8_t(bits>>shift));
   std::cout<<"{\"SN\":"<<sn<<",\"Slot\":"<<slot<<",\"Amount\":"<<amount<<",\"ExpireDate\":"<<expiry<<",\"Verbose\":\""<<verbose<<"\"}";
  }std::cout<<']';
 }std::cout<<"],\"Response\":\""<<hex(b)<<"\"}";
}
int main(int argc,char** argv){try{
 if(argc!=2){throw std::runtime_error("expected archive base");}
 const auto ts=types(argv[1]);
 std::cout<<"{\"Evidence\":\"OUR independent manual C++ of native case0 and201 byte layout, reading native resource archive as data. NOT original execution/client/physics/shop proof. Native invalid-paid early decrement/flags are recorded, TS rejects those atomically. Inventory Unix-expiry/zero -> OLE mapping is MODERN policy, NOT recovered native DateCreated/StockSn catalog parity.\",\"ResourceTypes\":[";
 for(size_t i=0;i<ts.size();++i){if(i)std::cout<<',';std::cout<<ts[i];}
 std::cout<<"],\"TypePredicates\":[";bool first=true;std::vector<int64_t> effects={-2147483648ll,-1};for(int i=0;i<=35;++i)effects.push_back(i);effects.push_back(99);effects.push_back(2147483647);
 for(auto t:effects){sep(first);std::cout<<"{\"Type\":"<<t<<",\"Allowed\":"<<(allowed(t)?"true":"false")<<'}';}
 std::cout<<"],\"Cases\":[";first=true;
 for(unsigned index=0;index<ts.size()+2;++index)for(unsigned slot=0;slot<8;++slot)for(unsigned state:{0u,3u,4u})for(unsigned q:{0u,1u,255u}){
  sep(first);emit(ts,index<ts.size()?index:index==ts.size()?unsigned(ts.size()):255,slot,state,q,256,true,0);}
 for(unsigned index=0;index<ts.size()+2;++index)for(unsigned q:{0u,1u,255u}){sep(first);emit(ts,index<ts.size()?index:index==ts.size()?unsigned(ts.size()):255,2,3,q,256,false,108);}
 for(unsigned index:{44u,45u,67u,255u})for(int64_t amount:{0ll,1ll,2ll,254ll,255ll,256ll,2147483647ll,-1ll,-2147483648ll})for(unsigned q:{0u,1u,2u,255u})for(bool resident:{false,true}){
  sep(first);emit(ts,index,1,3,q,amount,resident,0);}
 std::cout<<"],\"Inventory201\":[";first=true;
 for(unsigned users:{1u,2u})for(unsigned rows:{0u,1u,3u,6u})for(unsigned seed=0;seed<6;++seed){sep(first);inventory(users,rows,seed);}
 std::cout<<"]}\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
