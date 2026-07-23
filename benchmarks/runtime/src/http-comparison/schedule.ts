import { HTTP_STACKS, type HttpStack } from "./types.js";

const seedValue = (seed: string): number => {
  let value = 2_166_136_261;
  for (const character of seed) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0 || 1;
};

const randomFor = (seed: string): (() => number) => {
  let state = seedValue(seed);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
};

/**
 * Returns one seeded permutation of every stack per iteration. This keeps each
 * contiguous block balanced while varying order to limit temporal drift.
 */
export const interleavedHttpStackSchedule = (
  iterations: number,
  seed: string,
): readonly HttpStack[] => {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError("Iterations must be a positive safe integer.");
  }
  if (seed.length === 0) {
    throw new TypeError("A non-empty HTTP comparison schedule seed is required.");
  }

  const random = randomFor(seed);
  const schedule: HttpStack[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const block = [...HTTP_STACKS];
    for (let index = block.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      const current = block[index]!;
      block[index] = block[swapIndex]!;
      block[swapIndex] = current;
    }
    schedule.push(...block);
  }
  return Object.freeze(schedule);
};
