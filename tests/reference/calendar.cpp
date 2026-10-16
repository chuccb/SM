// OUR independent C++: native WORD/SHORT/field copies + STRICT portable
// Gregorian profile. Never execute original EXE/DAT/SQL or Windows APIs.
// Julian-day arithmetic here is independent of TS cumulative-year/month math.
#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>
struct DB { std::int32_t year; unsigned month, day, hour, minute, second; std::uint32_t fraction; };
using Bytes = std::vector<unsigned char>;
static bool leap(int y) { return y % 4 == 0 && (y % 100 != 0 || y % 400 == 0); }
static int monthDays(int y, unsigned m) {
  constexpr std::array<int, 12> days{{31,28,31,30,31,30,31,31,30,31,30,31}};
  return m >= 1 && m <= 12 ? days[m - 1] + (m == 2 && leap(y) ? 1 : 0) : 0;
}
static std::int64_t julian(int y, unsigned month, unsigned day) {
  const std::int64_t a = (14 - month) / 12, yy = y + 4800 - a, m = month + 12 * a - 3;
  return day + (153 * m + 2) / 5 + 365 * yy + yy / 4 - yy / 100 + yy / 400 - 32045;
}
static std::array<int, 3> civil(std::int64_t jd) {
  const auto a = jd + 32044, b = (4 * a + 3) / 146097, c = a - (146097 * b) / 4,
    d = (4 * c + 3) / 1461, e = c - (1461 * d) / 4, m = (5 * e + 2) / 153;
  return {{static_cast<int>(100 * b + d - 4800 + m / 10), static_cast<int>(m + 3 - 12 * (m / 10)), static_cast<int>(e - (153 * m + 2) / 5 + 1)}};
}
static bool valid(const DB& r) {
  const auto year = static_cast<std::uint16_t>(r.year);
  return year >= 100 && year <= 9999 && r.month >= 1 && r.month <= 12 && r.day >= 1 && r.day <= static_cast<unsigned>(monthDays(year, r.month)) && r.hour < 24 && r.minute < 60 && r.second < 60;
}
static double variant(const DB& r) {
  const auto days = julian(static_cast<std::uint16_t>(r.year), r.month, r.day) - julian(1899, 12, 30);
  const double fraction = static_cast<double>(r.hour * 3600 + r.minute * 60 + r.second) / 86400.0;
  return static_cast<double>(days) + (days < 0 ? -fraction : fraction);
}
static void le(Bytes& b, std::uint64_t n, unsigned size) { for (unsigned i = 0; i < size; ++i) b.push_back(static_cast<unsigned char>(n >> (i * 8))); }
static std::string hex(const Bytes& b) {
  constexpr char alphabet[] = "0123456789abcdef";std::string s;
  for (const auto v : b) { s += alphabet[v >> 4];s += alphabet[v & 15]; }return s;
}
static Bytes rawDouble(double n) { std::uint64_t bits = 0;std::memcpy(&bits, &n, sizeof(bits));Bytes b;le(b, bits, 8);return b; }
static void scalar(Bytes& b, std::uint32_t n, unsigned size, bool plain) {
  if (!plain) n ^= size == 1 ? 0x5aU : size == 2 ? 0xa569U : 0x96ca5395U;
  for (unsigned i = size; i > 0; --i) b.push_back(static_cast<unsigned char>(n >> ((i - 1) * 8)));
}
static Bytes packet(double date, bool plain) {
  Bytes b;scalar(b, 201, 1, plain);scalar(b, 1, 1, plain);scalar(b, 1, 4, plain);scalar(b, 0x80000000U, 4, plain);scalar(b, 255, 1, plain);scalar(b, 3, 4, plain);
  const std::string name = "calendar";scalar(b, static_cast<unsigned>(name.size()), 2, plain);b.insert(b.end(), name.begin(), name.end());
  const auto raw = rawDouble(date);b.insert(b.end(), raw.begin(), raw.end());return b;
}
static void object(const DB& r) {
  std::cout << "{\"year\":" << r.year << ",\"month\":" << r.month << ",\"day\":" << r.day << ",\"hour\":" << r.hour << ",\"minute\":" << r.minute << ",\"second\":" << r.second << ",\"fraction\":" << r.fraction << '}';
}
static void system(const DB& r, const std::string& weekday, const std::string& ms) {
  std::cout << '[' << static_cast<std::uint16_t>(r.year) << ',' << r.month << ',' << weekday << ',' << r.day << ',' << r.hour << ',' << r.minute << ',' << r.second << ',' << ms << ']';
}
static void emit(const DB& r, bool advances) {
  static unsigned index = 0;if (index) std::cout << ',';
  Bytes input;le(input, static_cast<std::uint16_t>(r.year), 2);le(input, r.month, 2);le(input, r.day, 2);le(input, r.hour, 2);le(input, r.minute, 2);le(input, r.second, 2);le(input, r.fraction, 4);
  std::cout << "{\"Name\":\"calendar-" << index++ << "\",\"Input\":";object(r);
  std::cout << ",\"InputHex\":\"" << hex(input) << "\",\"DBSystem\":";system(r, "null", "0");
  std::cout << ",\"RowSystem\":";system(r, "null", "null");
  auto reversed = r;reversed.fraction = 0;
  std::cout << ",\"Reverse\":";object(reversed);
  const bool supported = valid(r);
  std::cout << ",\"VariantHex\":";
  if (supported) std::cout << '"' << hex(rawDouble(variant(r))) << '"';else std::cout << "null";
  std::cout << ",\"PacketHex\":";if (supported) std::cout << '"' << hex(packet(variant(r), false)) << '"';else std::cout << "null";
  std::cout << ",\"PlainPacketHex\":";if (supported) std::cout << '"' << hex(packet(variant(r), true)) << '"';else std::cout << "null";
  std::cout << ",\"Advances\":[";
  if (supported && advances) {
    bool comma = false;
    for (const std::int64_t delta : {0LL,1LL,999LL,1000LL,60000LL,86400000LL,31622400000LL}) {
      if (comma) std::cout << ',';
      comma = true;
      const auto absolute = julian(r.year, r.month, r.day) * 86400000LL + static_cast<std::int64_t>(r.hour * 3600 + r.minute * 60 + r.second) * 1000 + delta;
      const auto jd = absolute / 86400000LL, rest = absolute % 86400000LL;
      std::cout << "{\"Delta\":" << delta << ",\"System\":";
      if (jd > julian(9999, 12, 31)) std::cout << "null,\"VariantHex\":null}";
      else {
        const auto date = civil(jd);DB next{date[0], static_cast<unsigned>(date[1]), static_cast<unsigned>(date[2]), static_cast<unsigned>(rest / 3600000), static_cast<unsigned>(rest / 60000 % 60), static_cast<unsigned>(rest / 1000 % 60), 0};
        system(next, std::to_string((jd + 1) % 7), std::to_string(rest % 1000));
        std::cout << ",\"VariantHex\":\"" << hex(rawDouble(variant(next))) << "\"}";
      }
    }
  }
  std::cout << "]}";
}
int main() {
  std::cout << "{\"Model\":\"manual PE field copies plus independent STRICT Gregorian/isolated clock math; NOT original Windows DLL, SQL, timezone or client oracle\",\"Cases\":[";
  for (const int year : {100,400,1582,1600,1753,1800,1899,1900,1904,1969,1970,1999,2000,2004,2024,2026,2100,2400,9999})
    for (unsigned month = 1; month <= 12; ++month)
      for (const unsigned day : {1U,15U,static_cast<unsigned>(monthDays(year, month))}) {
        emit({year,month,day,0,0,0,0}, false);
        emit({year,month,day,6,7,8,1}, false);
        emit({year,month,day,12,34,56,999999999}, day == 1);
        emit({year,month,day,23,59,59,0xffffffffU}, false);
      }
  for (const unsigned day : {29U,30U,31U}) for (const unsigned hour : {0U,6U,12U,23U}) emit({1899,12,day,hour,0,1,123456789}, true);
  const DB base{2026,1,2,3,4,5,123456789};
  for (const int year : {-32768,-1,0,29,30,49,50,99,10000,32767}) { auto r = base;r.year = year;emit(r, false); }
  for (const unsigned n : {0U,13U,65535U}) { auto r = base;r.month = n;emit(r, false); }
  for (const unsigned n : {0U,32U,65535U}) { auto r = base;r.day = n;emit(r, false); }
  for (const unsigned n : {24U,65535U}) { auto r = base;r.hour = n;emit(r, false); }
  for (const unsigned n : {60U,65535U}) { auto r = base;r.minute = n;emit(r, false);r = base;r.second = n;emit(r, false); }
  emit({1900,2,29,0,0,0,0}, false);emit({2100,2,29,0,0,0,0}, false);emit({2026,4,31,0,0,0,0}, false);
  std::cout << "]}\n";
}
