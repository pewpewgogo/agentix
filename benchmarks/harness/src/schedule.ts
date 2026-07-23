import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256 } from "./hash.js";
import {
  HARNESS_SCHEMA_VERSION,
  SCHEDULE_SCHEMA_VERSION,
  type BenchmarkArm,
  type ScheduleDocument,
  type ScheduledRun,
  type TaskReference,
} from "./types.js";

class SeededRandom {
  #state: number;

  public constructor(seed: string) {
    const digest = sha256(seed);
    const parsed = Number.parseInt(digest.slice(0, 8), 16) >>> 0;
    this.#state = parsed === 0 ? 0x9e37_79b9 : parsed;
  }

  public next(): number {
    let state = this.#state;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.#state = state >>> 0;
    return this.#state / 0x1_0000_0000;
  }
}

const shuffle = <T>(values: readonly T[], random: SeededRandom): T[] => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random.next() * (index + 1));
    const value = result[index];
    const swapped = result[other];
    if (value === undefined || swapped === undefined) {
      throw new Error("The scheduler encountered an impossible array hole.");
    }
    result[index] = swapped;
    result[other] = value;
  }
  return result;
};

const validateTask = (task: TaskReference): void => {
  if (task.schemaVersion !== HARNESS_SCHEMA_VERSION) {
    throw new TypeError(`Task ${task.id} has an unsupported schema version.`);
  }
  if (task.id.trim().length === 0 || !Number.isSafeInteger(task.version) || task.version < 1) {
    throw new TypeError("Task references require a nonempty ID and positive version.");
  }
};

const validateTasks = (tasks: readonly TaskReference[]): void => {
  if (tasks.length !== 10) {
    throw new RangeError(
      `The confirmatory schedule requires exactly 10 tasks; received ${tasks.length}.`,
    );
  }
  const identities = new Set<string>();
  for (const task of tasks) {
    validateTask(task);
    const identity = `${task.id}@${task.version}`;
    if (identities.has(identity)) {
      throw new TypeError(`Duplicate task reference ${identity}.`);
    }
    identities.add(identity);
  }
};

interface Block {
  readonly blockId: string;
  readonly task: TaskReference;
  readonly repetition: number;
  readonly arms: readonly [BenchmarkArm, BenchmarkArm];
}

export const createConfirmatorySchedule = (input: {
  readonly tasks: readonly TaskReference[];
  readonly repetitions: number;
  readonly seed: string;
}): ScheduleDocument => {
  validateTasks(input.tasks);
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 5) {
    throw new RangeError("A confirmatory schedule requires at least five repetitions.");
  }
  if (input.seed.trim().length === 0) {
    throw new TypeError("A committed nonempty schedule seed is required.");
  }

  const random = new SeededRandom(input.seed);
  const blocks: Block[] = [];
  for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
    for (const task of input.tasks) {
      const frameworkFirst = random.next() < 0.5;
      blocks.push({
        blockId: `${task.id}@${task.version}#${repetition}`,
        task: { ...task },
        repetition,
        arms: frameworkFirst
          ? ["framework", "plain"]
          : ["plain", "framework"],
      });
    }
  }

  const runs: ScheduledRun[] = [];
  for (const block of shuffle(blocks, random)) {
    for (const arm of block.arms) {
      runs.push({
        ordinal: runs.length + 1,
        blockId: block.blockId,
        task: { ...block.task },
        arm,
        repetition: block.repetition,
      });
    }
  }

  const hashInput = {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    seed: input.seed,
    repetitions: input.repetitions,
    taskCount: input.tasks.length,
    runs,
  };
  return {
    ...hashInput,
    scheduleHash: sha256(canonicalJson(hashInput)),
  };
};

export interface ValidatedSchedule {
  readonly contentHash: string;
  readonly slotsByOrdinal: ReadonlyMap<number, ScheduledRun>;
}

export const validateScheduleDocument = (
  schedule: ScheduleDocument,
): ValidatedSchedule => {
  if (
    schedule.schemaVersion !== SCHEDULE_SCHEMA_VERSION ||
    schedule.taskCount !== 10 ||
    !Number.isSafeInteger(schedule.repetitions) ||
    schedule.repetitions < 5 ||
    schedule.seed.trim().length === 0
  ) {
    throw new TypeError("Malformed confirmatory schedule header.");
  }
  if (schedule.runs.length !== schedule.taskCount * schedule.repetitions * 2) {
    throw new TypeError("Confirmatory schedule has the wrong number of runs.");
  }
  const hashInput = {
    schemaVersion: schedule.schemaVersion,
    seed: schedule.seed,
    repetitions: schedule.repetitions,
    taskCount: schedule.taskCount,
    runs: schedule.runs,
  };
  if (schedule.scheduleHash !== sha256(canonicalJson(hashInput))) {
    throw new TypeError("Confirmatory schedule hash does not match its contents.");
  }

  const slotsByOrdinal = new Map<number, ScheduledRun>();
  const slotKeys = new Set<string>();
  const tasks = new Set<string>();
  const blocks = new Map<string, ScheduledRun[]>();
  for (const run of schedule.runs) {
    if (
      !Number.isSafeInteger(run.ordinal) ||
      run.ordinal < 1 ||
      run.ordinal > schedule.runs.length ||
      !Number.isSafeInteger(run.repetition) ||
      run.repetition < 1 ||
      run.repetition > schedule.repetitions ||
      (run.arm !== "framework" && run.arm !== "plain") ||
      run.blockId.trim().length === 0
    ) {
      throw new TypeError("Malformed scheduled run.");
    }
    validateTask(run.task);
    if (slotsByOrdinal.has(run.ordinal)) {
      throw new TypeError(`Duplicate schedule ordinal ${run.ordinal}.`);
    }
    const taskIdentity = `${run.task.id}@${run.task.version}`;
    const expectedBlock = `${taskIdentity}#${run.repetition}`;
    if (run.blockId !== expectedBlock) {
      throw new TypeError(`Scheduled block ID ${run.blockId} is inconsistent.`);
    }
    const slot = `${taskIdentity}|${run.arm}|${run.repetition}`;
    if (slotKeys.has(slot)) throw new TypeError(`Duplicate scheduled slot ${slot}.`);
    slotKeys.add(slot);
    tasks.add(taskIdentity);
    slotsByOrdinal.set(run.ordinal, run);
    const block = blocks.get(run.blockId) ?? [];
    block.push(run);
    blocks.set(run.blockId, block);
  }
  if (tasks.size !== 10 || blocks.size !== schedule.taskCount * schedule.repetitions) {
    throw new TypeError("Schedule does not contain exactly ten complete task series.");
  }
  for (let ordinal = 1; ordinal <= schedule.runs.length; ordinal += 1) {
    if (!slotsByOrdinal.has(ordinal)) throw new TypeError(`Missing schedule ordinal ${ordinal}.`);
  }
  for (const [blockId, block] of blocks) {
    if (
      block.length !== 2 ||
      new Set(block.map(({ arm }) => arm)).size !== 2 ||
      Math.abs(block[0]!.ordinal - block[1]!.ordinal) !== 1
    ) {
      throw new TypeError(`Malformed blocked arm pair ${blockId}.`);
    }
  }
  return {
    contentHash: sha256(canonicalJson(schedule)),
    slotsByOrdinal,
  };
};

export const writeCommittedSchedule = async (
  outputPath: string,
  schedule: ScheduleDocument,
): Promise<void> => {
  validateScheduleDocument(schedule);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(schedule, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
};
