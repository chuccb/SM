/** The CRT rand/srand linked into the shipped game and shop servers, read
 *  from the PEs themselves:
 *  FxServer: srand 0046EA52, rand 0046EA5F, __getptd 00474611.
 *  FxShop:   srand 00462800, rand 0046280D, __getptd 00467658.
 *  This is a compatibility PRNG, NOT a source of cryptographic randomness.
 *
 *  The native state belongs to CRT thread-local data (+0x14). Keep instances
 *  owned by an execution context; do not share one global across services,
 *  and do not reseed for every request, socket or room.
 */
export const RAND_MAX = 0x7fff;
const RAND_MULTIPLIER = 0x343fd;
const RAND_INCREMENT = 0x269ec3;
const RAND_DEFAULT_SEED = 1; // __getptd: 00474659

export class CRand {
  private state: number;

  constructor(seed = RAND_DEFAULT_SEED) {
    this.state = seed >>> 0;
  }

  /** srand(unsigned int): stores all 32 bits, including zero. */
  srand(seed: number): void {
    this.state = seed >>> 0;
  }

  /** imul/add wrap at 32 bits; the output is (state >> 16) & RAND_MAX. */
  rand(): number {
    this.state = (Math.imul(this.state, RAND_MULTIPLIER) + RAND_INCREMENT) >>> 0;
    return (this.state >>> 16) & RAND_MAX;
  }

  /** _STL::random_shuffle<int *> (FxServer.exe 0041DAFD).
   * Forward swaps: exactly n-1 draws, with moduli 2,3,...,n. A backward
   * Fisher-Yates shuffle has different output for the SAME rand stream. */
  random_shuffle(values: number[]): void {
    for (let i = 1; i < values.length; i++) {
      const other = this.rand() % (i + 1);
      [values[i], values[other]] = [values[other]!, values[i]!];
    }
  }
}
