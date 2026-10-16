// Standalone fixed-width C++ reference, manually translated from the supplied LS
// routines: 00429EB0, 00424DB0, 00424CA0, 0042A170, 0042B310.
// It does not load or execute any original EXE, and imports no TypeScript code.
// Header substitution is read independently from the original PE file sections.
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <vector>
using bytes = std::vector<uint8_t>;
uint32_t le(const bytes& b, size_t p) { return uint32_t(b.at(p)) | uint32_t(b.at(p+1))<<8 | uint32_t(b.at(p+2))<<16 | uint32_t(b.at(p+3))<<24; }
uint16_t le16(const bytes& b, size_t p) { return b.at(p) | uint16_t(b.at(p+1))<<8; }
void putle(bytes& b, size_t p, uint32_t n) { for(int i=0;i<4;i++) b.at(p+i)=n>>(8*i); }
void appendbe(bytes& b, uint32_t n, int size) { for(int i=size-1;i>=0;i--) b.push_back(n>>(i*8)); }
bytes stream(const bytes& input, uint32_t key) {
 bytes output(input.size()); uint32_t k=key^0x53351d9c; size_t n=input.size()/4;
 if(n) { putle(output,0,le(input,0)^k); for(size_t j=1;j<n;j++) { k-=1674226915; putle(output,j*4,k^le(input,j*4)^le(input,j*4-4)); } k=le(input,4*n-4); }
 for(size_t j=0;j<input.size()%4;j++) output[n*4+j]=input[n*4+j]^(k>>(8*j));
 return output;
}
uint8_t crc8(uint32_t seed, const bytes& data) {
 uint8_t v=seed; for(auto x:data) { v^=x; for(int i=0;i<8;i++) v=uint8_t((v<<1)^((v&128)?7:0)); } return v;
}
uint32_t crc32(uint32_t seed, const bytes& data) {
 uint32_t v=seed; for(auto x:data) { v^=uint32_t(x)<<24; for(int i=0;i<8;i++) v=(v<<1)^((v&0x80000000)?0x04c11db7:0); } return v;
}
std::string hex(const bytes& v) { const char *digits="0123456789abcdef"; std::string s; for(auto x:v) {s+=digits[x>>4];s+=digits[x&15];} return s; }
bytes body(int degree) {
 bytes b; appendbe(b,3^(degree?0x5a:0),1); appendbe(b,255^(degree?0x5a:0),1);
 appendbe(b,0x1234^(degree?0xa569:0),2); appendbe(b,0x89abcdefu^(degree?0x96ca5395:0),4);
 const std::string text="Alice"; appendbe(b,text.size()^(degree?0xa569:0),2); b.insert(b.end(),text.begin(),text.end());
 return b;
}
bytes read(const char *name) { std::ifstream f(name,std::ios::binary); if(!f) throw std::runtime_error("missing PE"); return bytes(std::istreambuf_iterator<char>(f),{}); }
size_t pe_offset(const bytes& pe, uint32_t va) {
 size_t h=le(pe,0x3c), table=h+24+le16(pe,h+20); uint32_t rva=va-le(pe,h+24+28);
 for(int i=0;i<le16(pe,h+6);i++) { size_t p=table+i*40; if(rva>=le(pe,p+12)&&rva<le(pe,p+12)+le(pe,p+16)) return rva-le(pe,p+12)+le(pe,p+20); }
 throw std::runtime_error("VA unmapped");
}
int main(int argc, char **argv) {
 if(argc!=2) return 2; auto pe=read(argv[1]); size_t table=pe_offset(pe,0x00499f60);
 std::cout<<"{\n\"provenance\":\"Standalone C++ reference of LS 00429EB0/00424DB0/00424CA0/0042A170/0042B310; not captured client traffic\",\n\"streams\":[\n";
 bool first=true;
 for(uint32_t key: {0u,40u,0x11223344u,0xffffffffu}) for(int length=0;length<=35;length++) {
  bytes input(length); for(int i=0;i<length;i++) input[i]=i*37+11;
  if(!first) std::cout<<",\n";first=false;
  std::cout<<"{\"key\":"<<key<<",\"plain\":\""<<hex(input)<<"\",\"encrypted\":\""<<hex(stream(input,key))<<"\"}";
 }
 std::cout<<"\n],\n\"frames\":[\n"; first=true;
 for(int degree=0;degree<=2;degree++) for(uint32_t seq: {0u,40u,43u,0xfffffff0u}) {
  auto b=body(degree); bytes frame; frame.push_back(uint8_t((2+231)^(102+seq)));
  appendbe(frame,b.size()^(degree?0xa569:0),2);
  auto payload=degree?stream(b,seq):b; if(!degree&&seq) payload.at(0)=pe.at(table+2*256+3);
  frame.insert(frame.end(),payload.begin(),payload.end());
  if(degree==1) appendbe(frame,crc32(seq,b),4); if(degree==2) frame.push_back(crc8(seq,b));
  if(!first)std::cout<<",\n";first=false;
  std::cout<<"{\"degree\":"<<degree<<",\"sequence\":"<<seq<<",\"body\":\""<<hex(b)<<"\",\"frame\":\""<<hex(frame)<<"\"}";
 }
 std::cout<<"\n],\n\"crc\":["; first=true;
 for(uint32_t seed:{0u,40u,0x12345678u}) { bytes b={'1','2','3','4','5','6','7','8','9'};if(!first)std::cout<<",";first=false;std::cout<<"{\"seed\":"<<seed<<",\"crc8\":"<<unsigned(crc8(seed,b))<<",\"crc32\":"<<crc32(seed,b)<<"}"; }
 std::cout<<"]\n}\n";
}
