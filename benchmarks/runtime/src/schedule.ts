export type RuntimeArm = "framework" | "plain";

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

export const interleavedArmSchedule = (
  iterations: number,
  seed: string,
): readonly RuntimeArm[] => {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new RangeError("Iterations must be a positive safe integer.");
  }
  if (seed.length === 0) throw new TypeError("A non-empty schedule seed is required.");
  const random = randomFor(seed);
  const schedule: RuntimeArm[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const block: readonly RuntimeArm[] = random() < 0.5
      ? ["framework", "plain"]
      : ["plain", "framework"];
    schedule.push(...block);
  }
  return Object.freeze(schedule);
};
