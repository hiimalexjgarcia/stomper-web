/**
 * Noise source — port of FUN_00407FD0.
 *
 * The original calls the Microsoft C runtime generator:
 *
 *     int _rand(void)
 *     {
 *         holdrand = holdrand * 214013 + 2531011;
 *         return (holdrand >> 16) & 0x7FFF;
 *     }
 *
 * FUN_00407FD0 then scales the result by 1 / 32767:
 *
 *     return _rand() * 3.051850947599719e-05;
 *
 * The CRT leaves `holdrand` initialised to 1 unless the program calls
 * _srand(), and STOMPER32.EXE never does.  Reproducing the exact LCG keeps
 * noise renders identical to the original instead of merely "random".
 */

export const RNG_SEED = 1;

/**
 * Advance the MSVC LCG and return `_rand() / 32767` in [0, 1].
 *
 * The state is kept as a signed 32-bit integer so the multiplication wraps
 * exactly like the original `int` overflow.
 */
export function nextRandom(state: number): { value: number; state: number } {
  const next = (Math.imul(state | 0, 214013) + 2531011) | 0;
  return { value: ((next >>> 16) & 0x7fff) / 32767, state: next };
}

/** Map `[0, 1]` to `[-1, 1]`, exactly like `(r + r) - 1.0` in the mixer. */
export function toSigned(value: number): number {
  return value * 2 - 1;
}
