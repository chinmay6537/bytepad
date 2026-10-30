// libc++ has no <bits/stdc++.h>, which GCC users rely on. This covers what the
// WASI build of libc++ supports, leaving out threads and networking.
export const BITS_STDCPP = `#pragma once
#include <algorithm>
#include <array>
#include <bitset>
#include <cassert>
#include <cctype>
#include <cfloat>
#include <chrono>
#include <climits>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <exception>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <list>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <queue>
#include <random>
#include <set>
#include <sstream>
#include <stack>
#include <stdexcept>
#include <string>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>
`;

// Turbo C style helpers are still taught in many courses. Input stays line based,
// so getch() waits for Enter rather than a single key press.
export const CONIO_H = `#pragma once
#include <stdio.h>
#ifdef __cplusplus
extern "C" {
#endif
static inline void clrscr(void) { fputs("\\033[2J\\033[H", stdout); }
static inline int getch(void) { return getchar(); }
static inline int getche(void) { return getchar(); }
#ifdef __cplusplus
}
#endif
`;

// wasi-libc only flushes stdout at exit or a full buffer when it is not a real
// terminal, so printf("Enter: ") would stay invisible until after scanf returned.
export const RUNTIME_PRELUDE = `#include <stdio.h>
__attribute__((constructor)) static void __bytepad_unbuffered(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
}
`;

// This WASI libc++abi is built without exception support, so nothing can catch.
// Defining these keeps programs that merely contain `throw` linking, and a throw
// that actually fires stops the program with an explanation instead.
export const CPP_EXCEPTION_SHIM = `
#include <stdlib.h>
extern "C" void *__cxa_allocate_exception(unsigned long size) { return malloc(size ? size : 1); }
extern "C" [[noreturn]] void __cxa_throw(void *, void *, void (*)(void *)) {
  fputs("\\nThis program threw a C++ exception, which browser builds cannot catch.\\n"
        "To use exceptions, open the Input tab and turn on \\"Compile on Wandbox with GCC\\".\\n", stderr);
  abort();
}
`;
