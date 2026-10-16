// OUR independent hand-translated model, NOT native execution or SQL restore.
// FXGS0040F9FA unsigned std::map/insert_unique,0040F0EB and0040EFEE202.
// Do not import production parsers/codec, call supplied EXE or read user data.
#include <cstdint>
#include <iostream>
#include <map>
#include <string>
#include <vector>
#include <array>

struct Item { std::uint32_t sn; unsigned category; std::string attr; std::int64_t a,b,c; std::string name; };
using Bytes=std::vector<unsigned char>;
static void byte(Bytes& out,std::uint32_t n,bool scalar){out.push_back(static_cast<unsigned char>(n^(scalar?0x5aU:0U)));}
static void word(Bytes& out,std::uint32_t n,bool scalar){n^=scalar?0xa569U:0U;out.push_back(static_cast<unsigned char>(n>>8U));out.push_back(static_cast<unsigned char>(n));}
static void dword(Bytes& out,std::uint32_t n,bool scalar){n^=scalar?0x96ca5395U:0U;for(int i=3;i>=0;--i)out.push_back(static_cast<unsigned char>(n>>(8*i)));}
static void text(Bytes& out,const std::string& s,bool scalar){word(out,static_cast<std::uint32_t>(s.size()),scalar);out.insert(out.end(),s.begin(),s.end());}
static std::string hex(const Bytes& bytes){static constexpr char digits[]="0123456789abcdef";std::string out;for(auto b:bytes){out+=digits[b>>4U];out+=digits[b&15U];}return out;}
static std::string hex(const std::string& s){return hex(Bytes(s.begin(),s.end()));}
static std::int64_t signed32(std::int64_t x){std::uint32_t u=static_cast<std::uint32_t>(x);return u<0x80000000U?u:static_cast<std::int64_t>(u)-0x100000000LL;}
static std::map<std::uint32_t,Item> load(const std::vector<Item>& rows){std::map<std::uint32_t,Item> result;for(const auto& row:rows)result.emplace(row.sn,row);return result;}
static Bytes packet(const std::map<std::uint32_t,Item>& items,bool scalar){Bytes out;byte(out,202,scalar);word(out,static_cast<std::uint32_t>(items.size()),scalar);for(const auto& p:items){const auto& r=p.second;dword(out,r.sn,scalar);byte(out,r.category,scalar);text(out,r.attr,scalar);dword(out,static_cast<std::uint32_t>(r.a),scalar);dword(out,static_cast<std::uint32_t>(r.b),scalar);dword(out,static_cast<std::uint32_t>(r.c),scalar);text(out,r.name,scalar);}return out;}
static void row(const Item& r,bool canonical){std::cout<<"{\"SN\":"<<r.sn<<",\"Category\":"<<r.category<<",\"AttrHex\":\""<<hex(r.attr)<<"\",\"nAttr1\":"<<(canonical?signed32(r.a):r.a)<<",\"nAttr2\":"<<(canonical?signed32(r.b):r.b)<<",\"nAttr3\":"<<(canonical?signed32(r.c):r.c)<<",\"NameHex\":\""<<hex(r.name)<<"\"}";}
static bool first=true;
static void image(const std::string& encoding,const std::vector<Item>& source){if(!first)std::cout<<',';first=false;const auto items=load(source);std::cout<<"{\"Encoding\":\""<<encoding<<"\",\"Input\":[";bool comma=false;for(const auto& r:source){if(comma)std::cout<<',';comma=true;row(r,false);}std::cout<<"],\"Duplicate\":"<<(source.size()==items.size()?"false":"true")<<",\"Native\":[";comma=false;for(const auto& p:items){if(comma)std::cout<<',';comma=true;row(p.second,true);}std::cout<<"],\"BodyHex\":\""<<hex(packet(items,true))<<"\",\"PlainBodyHex\":\""<<hex(packet(items,false))<<"\"}";}
int main(){
 std::cout<<"{\"Model\":\"independent manual C++ UserItem map/202; NOT original execution, inventory mapping or shop pricing\",\"Cases\":[";
 const std::array<std::int64_t,6> v={0,1,-1,2147483647LL,2147483648LL,4294967295LL};
 for(unsigned category=0;category<256;++category)for(unsigned j=0;j<v.size();++j)image("big5",{{static_cast<std::uint32_t>(j%2==0?category:0xffffffffU-category),category,"Attr/Fixture",v[j],v[(j+1)%v.size()],v[(j+3)%v.size()],"Name/Fixture"}});
 image("big5",{});
 std::vector<Item> sort;
 for(std::uint32_t sn:{0xffffffffU,0x80000000U,0x7fffffffU,1U,0U})sort.push_back({sn,5,"",sn,0,-1,"names do NOT authorize"});
 image("big5",sort);
 sort.push_back({0xffffffffU,6,"different",7,8,9,"DUPLICATE: native keeps FIRST; modern rejects"});image("big5",sort);
 image("big5",{{17,6,std::string("\xa4\xa4\xa4\xe5",4),-2147483648LL,4294967295LL,2147483647LL,std::string("\xa4\xa4",2)}});
 image("cp949",{{0x80000001U,101,std::string("\xb0\xa1",2),-1,0,1,std::string("\xb3\xaa",2)}});
 image("utf8",{{0xffffffffU,255,std::string("\xe4\xb8\xad",3),0xffffffffLL,0x80000000LL,0,std::string("\xf0\x9f\x8e\xae",4)}});
 std::cout<<"],\"KeyProbes\":[";bool comma=false;const auto keys=load(sort);
 for(std::int64_t key:{-2147483648LL,-1LL,0LL,1LL,2LL,2147483647LL,2147483648LL,4294967295LL}){if(comma)std::cout<<',';comma=true;const auto it=keys.find(static_cast<std::uint32_t>(key));std::cout<<"{\"Input\":"<<key<<",\"Unsigned\":"<<static_cast<std::uint32_t>(key)<<",\"Found\":"<<(it==keys.end()?"false":"true")<<"}";}
 std::cout<<"],\"CountProbes\":[";comma=false;for(std::uint32_t count:{0U,1U,0xffffU,0x10000U,0x10001U}){if(comma)std::cout<<',';comma=true;Bytes out;word(out,count,true);std::cout<<"{\"Count\":"<<count<<",\"NativeWordHex\":\""<<hex(out)<<"\",\"ModernAllowed\":"<<(count<=0xffffU?"true":"false")<<"}";}
 std::cout<<"]}\n";
}
