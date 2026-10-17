// OUR manual0041B509/0041B567 +948 store / opcode-only93/92 projection.
// No TS imports, official execution, clock, strategy, financial or client oracle.
#include <array>
#include <cstdint>
#include <iostream>
using U=std::uint32_t;
template<class T>void arrayJSON(const T&a){std::cout<<'[';bool first=true;for(auto n:a){if(!first)std::cout<<',';first=false;std::cout<<n;}std::cout<<']';}
int main(){std::cout<<std::boolalpha<<"{\"Model\":\"OUR manual native +948 setter and opcode-only snapshot; NOT original execution, mode issuance, Mod combat, clock, SQL or client proof\",\"Cases\":[";unsigned cases=0;const std::array<std::int64_t,4>before{{0,1,-2147483648LL,4294967295LL}};const std::array<U,8>edges{{0,1,2,3,4,0x7fffffffU,0x80000000U,0xffffffffU}};
 for(unsigned manner=0;manner<256;++manner)for(auto mode:before)for(unsigned request:{0U,1U}){std::array<U,8>votes{};for(unsigned i=0;i<8;++i)votes[i]=edges[(i+manner)%8];votes[manner%8]=manner;const U target=manner%2?0x89abcdefU:0U;const bool playing=(manner&2U)!=0;const unsigned opcode=request?92U:93U;
 if(cases++){std::cout<<',';}std::cout<<"{\"Before\":{\"GameType\":"<<mode<<",\"Playing\":"<<playing<<",\"Manner\":"<<manner<<",\"TargetSerialNo\":"<<target<<",\"Votes\":";arrayJSON(votes);std::cout<<"},\"Requested\":"<<request<<",\"Expected\":{\"GameType\":"<<request<<",\"Playing\":"<<playing<<",\"Manner\":"<<manner<<",\"TargetSerialNo\":"<<target<<",\"Votes\":";arrayJSON(votes);std::cout<<",\"Opcode\":"<<opcode<<"},\"Scalar\":\""<<(request?"06":"07")<<"\",\"Plain\":\""<<(request?"5c":"5d")<<"\"}";
 }
 std::cout<<"],\"CaseCount\":"<<cases<<"}\n";
}
