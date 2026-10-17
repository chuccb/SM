// OUR manually composed ordinary0041BA8D ->00424F78 ->0041BA8D model.
// Neither source executable, TS policy nor Windows clock executes here.
// Observed input states include unreachable/corrupt ballots; NOT a network oracle.
#include <array>
#include <cstdint>
#include <iostream>
#include <vector>
using U=std::uint32_t;
template<class T>void arrayJSON(const T& a){std::cout<<'[';bool first=true;for(auto n:a){if(!first)std::cout<<',';first=false;std::cout<<n;}std::cout<<']';}
void helper(U time,bool reset){std::cout<<"{\"CanStartTime\":"<<time<<",\"CanStart\":"<<(!reset)<<",\"OddSlot\":"<<(!reset)<<",\"LastTimeEvenSlot\":"<<(reset?0:19)<<",\"WarnedBan\":"<<(!reset)<<",\"WarnedTime\":"<<(reset?0:23)<<",\"WarnedBanOddSlot\":"<<(!reset)<<",\"WarnedTimeOddSlot\":"<<(reset?0:29)<<'}';}
int main(){
 std::cout<<std::boolalpha<<"{\"Model\":\"OUR manual ordinary departure/vote/chief Init composition; NOT original execution, callback/authority/SQL or network reachability proof\",\"Cases\":[";
 const std::vector<std::vector<int>> profiles{{1,1,1,1},{2,2,1,1},{1,1,2,1,1,1}};unsigned cases=0;
 for(const auto& counts:profiles)for(unsigned code=0;code<64;++code)for(unsigned departing=0;departing<counts.size();++departing)for(int targetGroup:{1,2}){
  std::array<int,8> keys,remaining;keys.fill(-1);std::array<U,8> votes{};int n=0,target=-1,chief=-1;
  for(unsigned key=0;key<counts.size();++key)for(int self=0;self<counts[key];++self){const int slot=n++;keys[slot]=int(key);votes[slot]=key==unsigned(targetGroup)?0:U((code>>(2*(unsigned(slot)%3)))&3);if(key==unsigned(targetGroup))target=slot;if(int(key)==(code%2?int(departing):0)&&chief<0)chief=slot;}
  if(code%7==0 && keys[n-1]!=targetGroup)votes[n-1]=0xffffffffU;
  remaining=keys;auto afterVotes=votes;std::vector<int> resets;std::vector<U> times;const U base=code%2?0xfffffffeU:30102U,step=code%3?1U:17U;
  const bool chiefLeft=keys[chief]==int(departing);for(int i=0;i<8;++i)if(keys[i]==int(departing)){remaining[i]=-1;afterVotes[i]=0;}
  int nextChief=chief;if(chiefLeft){nextChief=-2;for(int i=0;i<8;++i)if(remaining[i]>=0){nextChief=i;break;}resets.push_back(int(departing));times.push_back(base);}
  unsigned total=0,yes=0,no=0;for(int i=0;i<8;++i)if(remaining[i]>=0 && afterVotes[i]){++total;if(afterVotes[i]==2)++yes;else if(afterVotes[i]==3)++no;}
  int result=-1,eject=-1;U afterTarget=0x81234560U+U(target);
  if(remaining[target]<0){result=4;afterTarget=0;}
  else if(2*yes>total){result=2;eject=remaining[target];afterTarget=0;}
  else if(2*no>=total || yes+no>=total){result=3;afterTarget=0;}
  if(eject>=0 && nextChief>=0 && remaining[nextChief]==eject){resets.push_back(eject);times.push_back(base+U(times.size())*step);}
  if(cases++){std::cout<<',';}
  std::cout<<"{\"Counts\":";arrayJSON(counts);std::cout<<",\"Chief\":"<<chief<<",\"TargetSlot\":"<<target<<",\"Depart\":"<<departing<<",\"Votes\":";arrayJSON(votes);
  std::cout<<",\"TimeBase\":"<<base<<",\"TimeStep\":"<<step<<",\"Expected\":{\"RemainingPlayers\":";arrayJSON(remaining);std::cout<<",\"RemainingVotes\":";arrayJSON(afterVotes);
  std::cout<<",\"RemainingChief\":"<<nextChief<<",\"TargetAfter\":"<<afterTarget<<",\"Result\":"<<result<<",\"EjectSocket\":"<<eject<<",\"ResetKeys\":";arrayJSON(resets);std::cout<<",\"ClockReads\":";arrayJSON(times);std::cout<<",\"After\":";helper(times.empty()?17:times.back(),!times.empty());std::cout<<"}}";
 }
 std::cout<<"],\"CaseCount\":"<<cases<<"}\n";
}
