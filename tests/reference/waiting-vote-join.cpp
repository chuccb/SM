// OUR manual004198FD/004199E5/00423D8D/0041AF4B/00422849 projection.
// No TS policy/user/codec import, original execution, SQL or permission proof.
// Color and resolved bomber choices are OBSERVATIONS, not another map oracle.
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using U=std::uint32_t;using Row=std::array<unsigned,3>;using Info=std::array<Row,8>;
template<class T>void arrayJSON(const T&a){std::cout<<'[';bool f=true;for(auto n:a){if(!f)std::cout<<',';f=false;std::cout<<n;}std::cout<<']';}
void infoJSON(const Info&a){std::cout<<'[';for(unsigned i=0;i<8;++i){if(i)std::cout<<',';arrayJSON(a[i]);}std::cout<<']';}
void strJSON(const std::string&s){std::cout<<'"';for(unsigned char c:s){if(c=='"'||c=='\\')std::cout<<'\\';std::cout<<c;}std::cout<<'"';}
struct Packet{bool cipher;std::vector<unsigned char>b;void byte(unsigned n){b.push_back(static_cast<unsigned char>(n^(cipher?0x5aU:0U)));}void word(unsigned n){n^=cipher?0xa569U:0U;b.push_back(static_cast<unsigned char>(n>>8));b.push_back(static_cast<unsigned char>(n));}void dword(U n){n^=cipher?0x96ca5395U:0U;for(int shift=24;shift>=0;shift-=8)b.push_back(static_cast<unsigned char>(n>>shift));}void raw(unsigned n){b.push_back(static_cast<unsigned char>(n));}void str(const std::string&s){word(unsigned(s.size()));for(unsigned char c:s)raw(c);}std::string hex()const{const char*h="0123456789abcdef";std::string s;for(auto v:b){s+=h[v>>4];s+=h[v&15];}return s;}};
Packet scalar(unsigned opcode,bool cipher){Packet p{cipher,{}};p.byte(opcode);return p;}
Packet user(unsigned slot,int newSelf,const Row&state,bool cipher){Packet p=scalar(105,cipher);const bool self=newSelf>=0;p.byte(slot);p.dword(self?0xfedcba90U+unsigned(newSelf):0x81234000U+slot);p.byte(self?1:0);p.byte(slot%2?7:0);if(self)p.byte(255);for(auto b:state)p.raw(b);std::string name=self?"New"+std::to_string(newSelf):"Old"+std::to_string(slot);if(!self&&slot==3)name="\xa4\xa4\xa4\xe5";p.str(name);p.byte(slot%2);p.word(1);p.dword(0);p.dword(0);p.word(0);p.byte(0);p.byte(0);p.dword(0);return p;}
void bodies(const std::array<bool,8>&occupied,const Info&info,const std::vector<int>&slots,bool cipher){std::vector<Packet>self,room;auto ack=scalar(81,cipher);ack.byte(0);self.push_back(ack);for(int slot=0;slot<8;++slot){int local=-1;for(unsigned i=0;i<slots.size();++i)if(slots[i]==slot)local=int(i);if(occupied[slot]||local>=0)self.push_back(user(unsigned(slot),local,info[slot],cipher));else{auto p=scalar(107,cipher);p.byte(unsigned(slot));for(auto b:info[slot])p.raw(b);self.push_back(p);}}auto map=scalar(112,cipher);map.word(200);self.push_back(map);self.push_back(map);self.push_back(scalar(93,cipher));for(unsigned i=0;i<slots.size();++i)room.push_back(user(unsigned(slots[i]),int(i),info[slots[i]],cipher));std::cout<<"{\"Self\":[";bool first=true;for(const auto&p:self){if(!first)std::cout<<',';first=false;strJSON(p.hex());}std::cout<<"],\"Room\":[";first=true;for(const auto&p:room){if(!first)std::cout<<',';first=false;strJSON(p.hex());}std::cout<<"]}";}
int main(){std::cout<<std::boolalpha<<"{\"Model\":\"OUR manual waiting-vote join field/scalar snapshot model; color/bomber observations; NOT original execution, native SQL, authority, resource policy or complete-client oracle\",\"Cases\":[";unsigned cases=0;
 for(unsigned mask=1;mask<255;++mask){unsigned population=0;for(unsigned i=0;i<8;++i)population+=(mask>>i)&1U;if(population<2)continue;
  for(unsigned closed:{0U,0x55U,(~mask)&255U})for(unsigned count:{1U,2U}){
   std::array<bool,8>occupied{};Info info{};std::array<U,8>votes{};int chief=-1;for(int i=0;i<8;++i){occupied[i]=((mask>>i)&1U)!=0;if(occupied[i]&&chief<0)chief=i;info[i]={0xe0U|(((closed>>i)&1U)?1U:0U)|(((unsigned(i)+mask)%2)?0x1cU:0U),0xc0U|(unsigned(i)*3U&63U),0xe0U|(unsigned(i)&7U)};votes[i]=occupied[i]?(unsigned(i)%4U):(unsigned(i)%2?0xffffffffU:0U);}info[chief][0]|=2;
   std::vector<unsigned>bombers;for(unsigned i=0;i<count;++i)bombers.push_back(i?10U:5U);const unsigned color=(mask+count)&7U;auto after=info;auto used=occupied;std::vector<int>slots;bool accepted=true;for(auto bomber:bombers){int slot=-1;for(int i=0;i<8;++i)if(!used[i]&&!(after[i][0]&1)){slot=i;break;}if(slot<0){accepted=false;break;}used[slot]=true;slots.push_back(slot);after[slot][0]&=0xe1U;after[slot][1]=(after[slot][1]&0xc0U)|bomber;after[slot][2]=(after[slot][2]&0xe0U)|color;}
   if(cases++){std::cout<<',';}std::cout<<"{\"Occupied\":";arrayJSON(occupied);std::cout<<",\"SlotInfo\":";infoJSON(info);std::cout<<",\"Votes\":";arrayJSON(votes);std::cout<<",\"TargetSerialNo\":2166572391,\"ChiefSlot\":"<<chief<<",\"Bombers\":";arrayJSON(bombers);std::cout<<",\"PrimaryColor\":"<<color<<",\"Accepted\":"<<accepted;
   if(accepted){std::cout<<",\"Slots\":";arrayJSON(slots);std::cout<<",\"AfterInfo\":";infoJSON(after);std::cout<<",\"Scalar\":";bodies(occupied,after,slots,true);std::cout<<",\"Plain\":";bodies(occupied,after,slots,false);}std::cout<<'}';
  }
 }
 std::cout<<"],\"CaseCount\":"<<cases<<"}\n";
}
