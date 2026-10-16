#pragma once
// Manually translated STATIC evidence, NOT original executable execution.
// FXGS 0040B1BE..0040B6EB, 0041AAF1..0041AB68, 00420BB3 team-pair block,
// 0041B482 / 0041CA78 / 0041D31A / 0041CC68. No TS implementation is used.
// scoring-levels.h is generated directly from the matching LS/GS PE tables.
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>
#include "scoring-levels.h"

static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
static int32_t signed32(uint32_t n) { int32_t out; std::memcpy(&out, &n, 4); return out; }
static int32_t inc32(int32_t n) { return signed32(static_cast<uint32_t>(n) + 1u); }
static float f32(double n) { volatile float stored = static_cast<float>(n); return stored; }
static int level(int32_t exp) {
  int lo = 0, hi = static_cast<int>(levels.size());
  while (lo + 1 != hi) {
    const int mid = (lo + hi) / 2;
    if (exp >= levels[mid]) lo = mid; else hi = mid;
  }
  return hi;
}
static int32_t maxexp(int n) { return n < 0 || n >= static_cast<int>(levels.size()) ? INT32_MAX : levels[n]; }
static int percentage(int32_t exp) {
  const int n = level(exp);
  const int32_t lo = maxexp(n - 1), hi = maxexp(n);
  if (lo == INT32_MAX || hi == INT32_MAX) return 0;
  const uint32_t difference = static_cast<uint32_t>(exp) - static_cast<uint32_t>(lo);
  return signed32(difference * 1000u) / (hi - lo);
}
struct Player { int Level = 0, Color = 0, Socket = 0, Authencode = 0; };
using Players = std::array<Player, 8>;
using Ints = std::array<int32_t, 8>;
struct State {
  uint32_t vtable = 0;
  int32_t population = 0;
  float average = 0;
  std::array<float, 8> teams{}, weights{};
  std::array<int32_t, 64> saves{};
  Ints saveCount{}, killCount{}, opaque{}, nice{}, colors{}, teamCounts{}, own{}, other{};
  int32_t premium = 0, invalid = 1;
};
static_assert(sizeof(State) == 596);
static_assert(offsetof(State, weights) == 44 && offsetof(State, saves) == 76);
static_assert(offsetof(State, saveCount) == 332 && offsetof(State, killCount) == 364);
static_assert(offsetof(State, nice) == 428 && offsetof(State, colors) == 460);
static_assert(offsetof(State, own) == 524 && offsetof(State, other) == 556);
static_assert(offsetof(State, premium) == 588 && offsetof(State, invalid) == 592);
struct Model {
  State s;
  bool channel = false;
  explicit Model(bool premiumChannel) : channel(premiumChannel) {}
  void Init(const Players& players) {
    s = State{};
    s.colors.fill(-1);
    int firstSocket = 0;
    for (int i = 0; i < 8; ++i) {
      const auto& p = players[i];
      if (!p.Level) continue;
      if (!firstSocket) firstSocket = p.Socket;
      else if (firstSocket != p.Socket) s.invalid = 0;
      ++s.population;
      const double weight = std::sqrt(static_cast<double>(p.Level) + 100.0);
      s.average = f32(static_cast<double>(s.average) + weight);
      s.teams[p.Color] = f32(static_cast<double>(s.teams[p.Color]) + weight);
      ++s.teamCounts[p.Color];
      s.weights[i] = f32(weight);
      s.colors[i] = p.Color;
    }
    if (s.population) s.average = f32(static_cast<double>(s.average) / s.population);
    for (int color = 0; color < 8; ++color)
      if (s.teamCounts[color]) s.teams[color] = f32(static_cast<double>(s.teams[color]) / s.teamCounts[color]);
  }
  void Teams(const Players& players) {
    for (int i = 0; i < 8; ++i) {
      if (!players[i].Level) continue;
      s.own[i] = inc32(s.own[i]);
      for (int j = i + 1; j < 8; ++j) {
        if (!players[j].Level) continue;
        auto& counts = players[i].Color == players[j].Color ? s.own : s.other;
        counts[i] = inc32(counts[i]); counts[j] = inc32(counts[j]);
      }
    }
  }
  void Killer(int, int killer) { s.killCount[killer] = inc32(s.killCount[killer]); }
  void Saver(int victim, int saver) {
    if (s.saves[8 * saver + victim] == 0) {
      s.saves[8 * saver + victim] = 1;
      s.saveCount[saver] = inc32(s.saveCount[saver]);
    }
  }
  bool Context(int i) const {
    // Original reward callers use occupied slots only. The vacant-slot guard is
    // deliberate modern defense in BOTH reference harness and TS, not native OOB.
    const int color = s.colors[i];
    return !s.invalid && color >= 0 && color < 8 && s.teamCounts[color] && s.teams[color] != 0;
  }
  int Money(int i) const {
    if (!Context(i)) return 0;
    return std::clamp(300 * s.population / s.teamCounts[s.colors[i]] / 2, 200, 450);
  }
  int Reward(int i, double factor, int low, int high) const {
    if (!Context(i)) return 0;
    const int color = s.colors[i];
    const double mean = s.teams[color];
    const double base = s.population * static_cast<double>(s.average) * factor /
      (s.teamCounts[color] * mean) * (s.weights[i] / mean) * 0.5;
    const double withKills = base + static_cast<double>(s.killCount[i]) * 20.0;
    const int32_t n = signed32(static_cast<uint32_t>(static_cast<int64_t>(withKills + static_cast<double>(s.saveCount[i]) * 20.0)));
    const int capped = std::clamp(n, low, high);
    return (s.premium || channel) ? 11 * capped / 10 : capped;
  }
  int KillSave(int i) const {
    if (!channel || !Context(i)) return 0;
    const auto n = static_cast<int64_t>(static_cast<double>(s.killCount[i]) * 20.0 + static_cast<double>(s.saveCount[i]) * 20.0);
    return std::clamp(signed32(static_cast<uint32_t>(n)), 0, 140);
  }
  bool Win(int i, const Players& players, const Ints& states) const {
    if (s.own[i] <= 2) return false;
    bool otherLarge = false;
    int winners = 0;
    for (int j = 0; j < 8; ++j) {
      if (players[j].Color != players[i].Color && s.own[j] > 2) otherLarge = true;
      if (states[j] == 2 || states[j] == 6) ++winners;
    }
    return otherLarge && winners == s.own[i];
  }
  int Detail(int i, const Players& players) const {
    int result = players[i].Authencode == 1 ? 3 : 0;
    if (s.killCount[i] > 2 && s.killCount[i] == s.other[i]) {
      result = 1;
      if (s.own[i] > 2 && s.own[i] == s.saveCount[i] + 1) return 2;
    }
    return result;
  }
};
