// OUR independent manual C++ translation of the supplied FXGS routines:
// 0041EA50 (pickup), 0041ECA3 (obstacle), 0041F28B (event notification),
// 0041E8E7 (UNROUTED throw kernel), 004090EC (money mutation).
// NOT an original binary execution, packet capture, authorization or client oracle.
// No TypeScript/production imports. Signed32 arithmetic uses defined uint32 ADD
// and explicit two's-complement interpretation, rather than C++ signed overflow.
#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
using bytes = std::vector<uint8_t>;
std::string hex(const bytes& b) {
 const char* digits = "0123456789abcdef"; std::string out;
 for (auto v : b) { out += digits[v >> 4]; out += digits[v & 15]; }
 return out;
}
void one(bytes& b, uint32_t n) { b.push_back(uint8_t(n ^ 0x5a)); }
void two(bytes& b, uint32_t n) { n ^= 0xa569; b.push_back(n >> 8); b.push_back(n); }
void str(bytes& b, const std::string& s) { two(b, s.size()); b.insert(b.end(), s.begin(), s.end()); }
bytes packet(int opcode, const std::vector<int>& fields) {
 bytes b; one(b, opcode); for (auto v : fields) one(b, v); return b;
}
bytes fields(const std::vector<int>& values) {
 bytes b; for (auto v : values) one(b, v); return b;
}
int64_t signed32(uint32_t value) { return value < 0x80000000u ? int64_t(value) : int64_t(value) - 0x100000000ll; }
int64_t money(int64_t before, int64_t delta) {
 return std::min<int64_t>(1000000, std::max<int64_t>(0, signed32(uint32_t(before) + uint32_t(delta))));
}
const std::array<int, 8> amounts = {10,20,50,100,200,500,5000,-1000};
const std::array<int64_t, 6> states = {0,1,-1,2,-2147483648ll,2147483647ll};
void separator(bool& first) { if (!first) std::cout << ",\n"; first = false; }
void claim(int slot, int box, int item, int64_t state) {
 const bool take = state == 0, cash = item >= 25 && item <= 32;
 const auto response = packet(156, cash ? std::vector<int>{slot,box,item,1} : std::vector<int>{slot,box,item});
 std::cout << "{\"Slot\":" << slot << ",\"Box\":" << box << ",\"Item\":" << item << ",\"State\":" << state
 << ",\"Claimed\":" << (take ? "true" : "false") << ",\"NativeMoney\":" << (cash ? "true" : "false")
 << ",\"Request\":\"" << hex(packet(144,{slot,box,item})) << "\",\"Response\":";
 if (take) std::cout << '"' << hex(response) << '"'; else std::cout << "null";
 std::cout << '}';
}
void preview(int slot, int box, int item, int auth, int draw, int64_t before, int64_t amount) {
 const int multiplier = auth == 1 ? draw % 2 + 1 : 1;
 const int64_t delta = signed32(uint32_t(multiplier) * uint32_t(amount));
 std::cout << "{\"Slot\":" << slot << ",\"Box\":" << box << ",\"Item\":" << item << ",\"Authencode\":" << auth
 << ",\"Draw\":" << draw << ",\"Before\":" << before << ",\"Amount\":" << amount << ",\"Multiplier\":" << multiplier
 << ",\"Delta\":" << delta << ",\"After\":" << money(before, delta) << ",\"RandomDraws\":" << (auth == 1 ? 1 : 0)
 << ",\"DiagnosticAmountExceeded\":" << (delta > 10000 ? "true" : "false")
 << ",\"Response\":\"" << hex(packet(156,{slot,box,item,multiplier})) << "\"}";
}
int main() {
 std::cout << "{\n\"Provenance\":\"OUR standalone manual C++ models of FXGS0041EA50/0041ECA3/0041F28B/0041E8E7/004090EC; NOT captured traffic or original execution. Resource money rows25..32 and deltas are frozen from supplied FastFile metadata, independently checked by tests. Throw has NO ordinary request mapping;153 is default.\",\n";
 std::cout << "\"BoxClaims\":[\n"; bool first = true;
 for (int slot=0; slot<3; ++slot) for (int box=0; box<250; ++box) for (int item : {0,70}) {
  separator(first); claim(slot,box,item,0);
 }
 std::cout << "\n],\n\"ItemClaims\":[\n"; first = true;
 for (int slot=0; slot<3; ++slot) for (int item=0; item<71; ++item) for (auto state : states) {
  separator(first); claim(slot,(item*37+slot)%250,item,state);
 }
 std::cout << "\n],\n\"Obstacles\":[\n"; first = true;
 for (int position=0; position<256; ++position) for (auto state : states) {
  separator(first); const int slot=position%3, index=(position&15)+15*(position>>4); const bool valid=index<195, take=valid && state==0;
  std::cout << "{\"Slot\":" << slot << ",\"Position\":" << position << ",\"Index\":" << index << ",\"State\":" << state
  << ",\"Valid\":" << (valid?"true":"false") << ",\"Claimed\":" << (take?"true":"false")
  << ",\"Request\":\"" << hex(packet(145,{slot,position})) << "\",\"Response\":";
  if (take) std::cout << '"' << hex(packet(157,{slot,position})) << '"'; else std::cout << "null";
  std::cout << '}';
 }
 std::cout << "\n],\n\"Throws\":[\n"; first = true;
 for (int slot=0; slot<3; ++slot) for (int value=0; value<256; ++value) for (int64_t state : {0,1,-1,2}) {
  separator(first); const int box=value%250; const std::vector<int> f={(value%16)*16+slot,box,value,255-value,(value*37)&255,(value*197+7)&255};
  std::cout << "{\"Slot\":" << slot << ",\"Box\":" << box << ",\"State\":" << state << ",\"Fields\":[";
  for (size_t i=0;i<f.size();++i) { if (i) std::cout << ','; std::cout << f[i]; }
  std::cout << "],\"Body\":\"" << hex(fields(f)) << "\",\"Response\":\"" << hex(packet(172,f)) << "\"}";
 }
 std::cout << "\n],\n\"InvalidThrows\":[\n"; first = true;
 for (int slot=0;slot<3;++slot) for (int box=250;box<256;++box) {
  separator(first); std::cout << "{\"Slot\":" << slot << ",\"Body\":\"" << hex(fields({slot,box,255,128,0,1})) << "\"}";
 }
 for (int slot=8;slot<16;++slot) for (int high=0;high<16;++high) {
  separator(first); std::cout << "{\"Slot\":" << slot << ",\"Body\":\"" << hex(fields({high*16+slot,249,255,128,0,1})) << "\"}";
 }
 std::cout << "\n],\n\"Events\":[\n"; first = true;
 const std::array<std::string,3> names={"Alice","Partner","Bob"};
 // FULL native CString at0048F010, NOT just IDA's leading db '%s' row.
 const std::string announcementSuffix =
 "\xb4\xd4\xb2\xb2\xbc\xad\x20\xc0\xcc\xba\xa5\xc6\xae\x20\xbe\xc6\xc0\xcc\xc5\xdb"
 "\xc0\xbb\x20\xc8\xb9\xb5\xe6\xc7\xcf\xbc\xcc\xbd\xc0\xb4\xcf\xb4\xd9\x21\x20\xc3"
 "\xe0\xc7\xcf\xc7\xd5\xb4\xcf\xb4\xd9\x21\x0a\xc0\xda\xbc\xbc\xc7\xd1\x20\xb3\xbb"
 "\xbf\xeb\xc0\xba\x20\xc8\xa8\xc6\xe4\xc0\xcc\xc1\xf6\xb8\xa6\x20\xc2\xfc\xb0\xed"
 "\xc7\xcf\xbc\xbc\xbf\xe4\x7e\x0a"
 ;
 const std::vector<std::string> labels={"","LucciPocket0","%n%n:%s",std::string(255,'X'),std::string(1024,'Y'),"\xa4\xa4\xa4\xe5"};
 for (int user=0;user<3;++user) for (const auto& label:labels) {
  separator(first); const int socket=user==2?1:0, self=user==2?0:user;
  bytes input=packet(149,{self}), output=packet(30,{}); str(input,label); str(output,names[user]+announcementSuffix);
  std::cout << "{\"Socket\":" << socket << ",\"Self\":" << self << ",\"Name\":\"" << names[user]
  << "\",\"LabelHex\":\"" << hex(bytes(label.begin(),label.end())) << "\",\"Request\":\"" << hex(input) << "\",\"Response\":\"" << hex(output) << "\"}";
 }
 std::cout << "\n],\n\"InvalidEvents\":[\n"; first = true;
 for (int socket=0;socket<2;++socket) for (int self=(socket==0?2:1);self<256;++self) {
  separator(first); std::cout << "{\"Socket\":" << socket << ",\"Self\":" << self << ",\"Request\":\"" << hex(packet(149,{self})) << "\"}";
 }
 std::cout << "\n],\n\"MoneyKernel\":[\n"; first = true;
 const std::array<int64_t,10> balances={-2147483648ll,-1,0,1,999,999999,1000000,1000001,2147483646ll,2147483647ll};
 const std::array<int64_t,13> deltas={-2147483648ll,-2147483647ll,-1000001,-1000000,-1000,-1,0,1,1000,5000,1000000,2147483646ll,2147483647ll};
 for (auto before:balances) for (auto delta:deltas) {
  separator(first); std::cout << "{\"Before\":" << before << ",\"Delta\":" << delta << ",\"After\":" << money(before,delta) << '}';
 }
 std::cout << "\n],\n\"MoneyPreviews\":[\n"; first = true; int serial=0;
 for (int item=25;item<33;++item) for (int auth:{0,1,2,255}) for (int draw:{0,1,2,32766,32767}) for (int64_t before:{0,1,999999,1000000,2147483647}) {
  separator(first); preview(serial%3,(serial*37)%250,item,auth,draw,before,amounts[item-25]); ++serial;
 }
 std::cout << "\n],\n\"SyntheticMoneyPreviews\":[\n"; first = true;
 const std::array<int64_t,5> synthetic={5001,2147483647ll,-2147483648ll,-1073741825ll,0};
 for (int item=0;item<5;++item) for (int draw:{0,1}) {
  separator(first); preview(item%3,item,item,1,draw,1000,synthetic[item]);
 }
 std::cout << "\n]}\n";
}
