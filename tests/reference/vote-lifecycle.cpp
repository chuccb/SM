// OUR manual native vote-state/StartGame marker projection. Native whole
// function hashes are checked separately; supplied code/APIs never execute.
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using U=std::uint32_t;
template<class T>void arrayJSON(const T&a){std::cout<<'[';bool first=true;for(auto n:a){if(!first)std::cout<<',';first=false;std::cout<<n;}std::cout<<']';}
std::string beginBody(U tick,U sequence,U key,U start,U frequency,bool cipher){std::vector<unsigned char>b;auto byte=[&](U v){b.push_back(static_cast<unsigned char>(v^(cipher?0x5aU:0U)));};auto dword=[&](U v){v^=cipher?0x96ca5395U:0U;for(int shift=24;shift>=0;shift-=8)b.push_back(static_cast<unsigned char>(v>>shift));};byte(150);dword(tick);dword(sequence^key);dword(start);dword(frequency);const char*h="0123456789abcdef";std::string s;for(auto v:b){s+=h[v>>4];s+=h[v&15];}return s;}
int main(){std::cout<<"{\"Model\":\"OUR manual native RequestFailed/116/150/164 vote preservation and clock marker projection; NOT original execution, SQL, private authority or complete-client proof\",\"Cases\":[";unsigned cases=0;const std::array<U,8>edges{{0,1,2,3,4,0x7fffffffU,0x80000000U,0xffffffffU}},ticks{{0,1,0xfffffffeU,0xffffffffU,0x80000000U,123,0x7fffffffU,17}};
 for(U probe=0;probe<256;++probe)for(unsigned slot=0;slot<8;++slot){std::array<U,8>votes{};for(unsigned i=0;i<8;++i)votes[i]=edges[(i+slot)%8];votes[slot]=probe;const U target=probe%3==0?0U:probe%3==1?0xffffffffU:0x81234567U,tick=ticks[slot],sequence=0xffffffffU-probe,key=0x9a5bcdefU,start=probe%2?0xffffffffU:2U,frequency=probe,suspended=0x80000000U+probe;
 if(cases++){std::cout<<',';}std::cout<<"{\"Target\":"<<target<<",\"Votes\":";arrayJSON(votes);std::cout<<",\"TargetsAfter\":["<<target<<','<<target<<','<<target<<",0],\"StartTick\":"<<tick<<",\"Suspended\":"<<suspended<<",\"ClockAfter\":{\"Start\":"<<tick<<",\"End\":0,\"Stopped\":0,\"Suspended\":"<<suspended<<"},\"Sequence\":"<<sequence<<",\"Key\":"<<key<<",\"GhostStart\":"<<start<<",\"GhostFrequency\":"<<frequency<<",\"Scalar150\":\""<<beginBody(tick,sequence,key,start,frequency,true)<<"\",\"Plain150\":\""<<beginBody(tick,sequence,key,start,frequency,false)<<"\"}";
 }
 std::cout<<"],\"CaseCount\":"<<cases<<"}\n";
}
