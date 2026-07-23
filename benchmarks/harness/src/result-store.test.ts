import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, hashInstructionSet, sha256 } from "./hash.js";
import {
  DuplicateRunIdError,
  readImmutableRunResult,
  ResultIntegrityError,
  type RunRecordDraft,
  type WrittenRunResult,
  validateRunRecord,
  writeImmutableRunCorrection,
  writeImmutableRunResult,
} from "./result-store.js";
import {
  createUnavailableProviderUsage,
  deriveAccountedTokens,
} from "./telemetry.js";
import { HARNESS_SCHEMA_VERSION } from "./types.js";

const draft = (runId: string): RunRecordDraft => {
  const usage = createUnavailableProviderUsage(
    "scripted adapter has no token counters",
  );
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    mode: "smoke",
    identity: {
      schemaVersion: HARNESS_SCHEMA_VERSION,
      runId,
      task: { schemaVersion: HARNESS_SCHEMA_VERSION, id: "task-01", version: 1 },
      arm: "plain",
      repetition: 1,
      scheduleSeed: "seed",
      fixtureRevision: "fixture-v1",
      evaluatorRevision: "evaluator-v1",
      analysisRevision: "analysis-v1",
    },
    adapterId: "scripted",
    instructionHashes: hashInstructionSet({
      system: "system",
      developer: "developer",
      user: "user",
      tools: [],
      permissions: {},
      limits: {},
    }),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: "test",
      cpuModel: "test",
      cpuCount: 1,
      containerImage: null,
      hostClass: "test",
      packageManager: "npm-test",
      dependencyCachePolicy: "none",
      networkPolicy: "disabled",
      toolVersions: { node: process.version },
    },
    startedAt: "2040-01-01T00:00:00.000Z",
    endedAt: "2040-01-01T00:00:01.000Z",
    durationMs: 1_000,
    timeoutMs: 2_000,
    completionStatus: "completed",
    completionReason: "scripted completion",
    provider: "scripted",
    model: "scripted-v1",
    serviceTier: "local",
    reasoningConfiguration: { mode: "deterministic-script" },
    responseIds: [],
    usage,
    accountedTokens: deriveAccountedTokens(usage),
    cost: {
      availability: "unavailable",
      amount: null,
      currency: null,
      pricingSnapshotId: null,
      reason: "No pricing snapshot was supplied.",
    },
    preflight: [],
    interaction: {
      assistantTurns: 0,
      toolCalls: 0,
      toolCallsByType: {},
      failedToolCalls: 0,
      commands: 0,
      testCommands: [],
      failedAttempts: 0,
      retries: 0,
      filesOpened: [],
      uniqueSourceFilesOpened: [],
      repeatFileObservations: 0,
      unattributedFileObservations: 0,
      events: [],
    },
    patch: {
      filesModified: [],
      totalFilesModified: 0,
      generatedFilesModified: 0,
      linesAdded: 0,
      linesDeleted: 0,
      finalDiffHash: "0".repeat(64),
      finalManifestHash: "0".repeat(64),
    },
    evaluation: {
      checks: [],
      success: false,
      failureCategory: null,
      invalidRunReason: null,
    },
    finalSuccess: false,
  };
};

const rewriteRawRecord = async (
  written: WrittenRunResult,
  update: (payload: Record<string, unknown>) => void,
): Promise<void> => {
  const envelope = JSON.parse(
    await readFile(written.recordPath, "utf8"),
  ) as {
    payloadSha256: string;
    payload: Record<string, unknown>;
  };
  update(envelope.payload);
  envelope.payloadSha256 = sha256(canonicalJson(envelope.payload));
  const recordBytes = Buffer.from(`${canonicalJson(envelope)}\n`, "utf8");
  await writeFile(written.recordPath, recordBytes);
  const completion = JSON.parse(
    await readFile(written.completionPath, "utf8"),
  ) as Record<string, unknown>;
  completion["recordSha256"] = sha256(recordBytes);
  await writeFile(written.completionPath, `${canonicalJson(completion)}\n`);
};

describe("immutable result store", () => {
  it("writes, hashes, reads, and deeply freezes raw records and artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentix-results-"));
    const written = await writeImmutableRunResult({
      resultsRoot: root,
      draft: draft("run-001"),
      artifacts: [
        { name: "provider/raw.json", mediaType: "application/json", data: "{}\n" },
      ],
    });
    expect(written.record.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(written.record)).toBe(true);
    expect(Object.isFrozen(written.record.identity)).toBe(true);

    const read = await readImmutableRunResult(root, "run-001");
    expect(read).toEqual(written.record);
    expect(Object.isFrozen(read.artifacts)).toBe(true);

    await expect(
      writeImmutableRunResult({
        resultsRoot: root,
        draft: draft("run-001"),
        artifacts: [],
      }),
    ).rejects.toBeInstanceOf(DuplicateRunIdError);
  });

  it("rejects traversal, truncated results, and artifact tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentix-results-invalid-"));
    await expect(
      writeImmutableRunResult({
        resultsRoot: root,
        draft: draft("../escape"),
        artifacts: [],
      }),
    ).rejects.toBeInstanceOf(ResultIntegrityError);
    await expect(
      writeImmutableRunResult({
        resultsRoot: root,
        draft: {
          ...draft("run-bad-accounting"),
          accountedTokens: {
            availability: "available",
            value: 0,
            source: "provider_total",
            formula: "fabricated",
          },
        },
        artifacts: [],
      }),
    ).rejects.toThrow(/accounted tokens do not match/u);
    expect(await readdir(root)).toEqual([]);

    await expect(writeImmutableRunResult({
      resultsRoot: root,
      draft: draft("run-duplicate-artifacts"),
      artifacts: [
        { name: "same.txt", mediaType: "text/plain", data: "one" },
        { name: "same.txt", mediaType: "text/plain", data: "two" },
      ],
    })).rejects.toThrow(/Duplicate artifact name/u);
    expect(await readdir(root)).toEqual([]);

    expect(() => validateRunRecord({
      ...draft("run-cross-field"),
      finalSuccess: true,
      artifacts: [],
    }, "run-cross-field")).toThrow(/Final success disagrees/u);

    await mkdir(join(root, "run-truncated"));
    await writeFile(join(root, "run-truncated", "raw-result.json"), "{\"broken\":");
    await expect(
      readImmutableRunResult(root, "run-truncated"),
    ).rejects.toBeInstanceOf(ResultIntegrityError);

    await writeImmutableRunResult({
      resultsRoot: root,
      draft: draft("run-tampered"),
      artifacts: [
        { name: "raw.txt", mediaType: "text/plain", data: "original" },
      ],
    });
    await writeFile(
      join(root, "run-tampered", "artifacts", "raw.txt"),
      "tampered",
    );
    await expect(
      readImmutableRunResult(root, "run-tampered"),
    ).rejects.toThrow(/Artifact hash mismatch/u);
  });

  it("writes append-only corrections bound to the exact superseded record", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentix-corrections-"));
    const original = await writeImmutableRunResult({
      resultsRoot: root,
      draft: draft("run-original"),
      artifacts: [
        { name: "provider/raw.json", mediaType: "application/json", data: "{}\n" },
      ],
    });
    const originalBytes = await readFile(original.recordPath);

    const corrected = await writeImmutableRunCorrection({
      resultsRoot: root,
      draft: {
        ...draft("run-corrected"),
        completionReason: "corrected operator transcription",
      },
      artifacts: [],
      supersededRunId: "run-original",
      reason: "The original completion reason was transcribed incorrectly.",
      recordedAt: "2040-01-02T00:00:00.000Z",
    });

    expect(corrected.record.correction).toEqual({
      schemaVersion: 1,
      supersededRunId: "run-original",
      supersededRecordSha256: sha256(originalBytes),
      reason: "The original completion reason was transcribed incorrectly.",
      recordedAt: "2040-01-02T00:00:00.000Z",
    });
    expect(await readImmutableRunResult(root, "run-corrected"))
      .toEqual(corrected.record);
    expect(await readFile(original.recordPath)).toEqual(originalBytes);

    const chained = await writeImmutableRunCorrection({
      resultsRoot: root,
      draft: draft("run-corrected-again"),
      artifacts: [],
      supersededRunId: "run-corrected",
      reason: "A second independently reviewed correction was required.",
      recordedAt: "2040-01-03T00:00:00.000Z",
    });
    expect((await readImmutableRunResult(root, "run-corrected-again")).correction)
      .toEqual(chained.record.correction);

    await expect(writeImmutableRunCorrection({
      resultsRoot: root,
      draft: draft("run-corrected"),
      artifacts: [],
      supersededRunId: "run-original",
      reason: "Must not overwrite the first correction.",
      recordedAt: "2040-01-04T00:00:00.000Z",
    })).rejects.toBeInstanceOf(DuplicateRunIdError);
  });

  it("rejects forged, malformed, cross-cell, and hash-tampered corrections", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentix-corrections-invalid-"));
    await writeImmutableRunResult({
      resultsRoot: root,
      draft: draft("run-source"),
      artifacts: [],
    });

    await expect(writeImmutableRunCorrection({
      resultsRoot: root,
      draft: draft("run-missing-source"),
      artifacts: [],
      supersededRunId: "run-does-not-exist",
      reason: "The superseded record must already be retained.",
      recordedAt: "2040-01-02T00:00:00.000Z",
    })).rejects.toThrow(/incomplete|missing/u);

    await expect(writeImmutableRunResult({
      resultsRoot: root,
      draft: {
        ...draft("run-forged"),
        correction: {
          schemaVersion: 1,
          supersededRunId: "run-source",
          supersededRecordSha256: "0".repeat(64),
          reason: "forged",
          recordedAt: "2040-01-02T00:00:00.000Z",
        },
      } as unknown as RunRecordDraft,
      artifacts: [],
    })).rejects.toThrow(/correction provenance/u);

    await expect(writeImmutableRunCorrection({
      resultsRoot: root,
      draft: draft("run-empty-reason"),
      artifacts: [],
      supersededRunId: "run-source",
      reason: "   ",
      recordedAt: "2040-01-02T00:00:00.000Z",
    })).rejects.toThrow(/Correction reason/u);

    await expect(writeImmutableRunCorrection({
      resultsRoot: root,
      draft: {
        ...draft("run-other-cell"),
        identity: {
          ...draft("run-other-cell").identity,
          task: {
            schemaVersion: HARNESS_SCHEMA_VERSION,
            id: "task-02",
            version: 1,
          },
        },
      },
      artifacts: [],
      supersededRunId: "run-source",
      reason: "Attempted cross-cell replacement.",
      recordedAt: "2040-01-02T00:00:00.000Z",
    })).rejects.toThrow(/scheduled identity/u);

    const corrected = await writeImmutableRunCorrection({
      resultsRoot: root,
      draft: draft("run-link-tampered"),
      artifacts: [],
      supersededRunId: "run-source",
      reason: "Valid before the link is tampered.",
      recordedAt: "2040-01-02T00:00:00.000Z",
    });
    await rewriteRawRecord(corrected, (payload) => {
      const correction = payload["correction"] as Record<string, unknown>;
      correction["supersededRecordSha256"] = "f".repeat(64);
    });

    await expect(readImmutableRunResult(root, "run-link-tampered"))
      .rejects.toThrow(/Superseded record hash/u);

    const missingHash = await writeImmutableRunCorrection({
      resultsRoot: root,
      draft: draft("run-link-missing-hash"),
      artifacts: [],
      supersededRunId: "run-source",
      reason: "Valid before the link hash is removed.",
      recordedAt: "2040-01-02T00:00:00.000Z",
    });
    await rewriteRawRecord(missingHash, (payload) => {
      const correction = payload["correction"] as Record<string, unknown>;
      delete correction["supersededRecordSha256"];
    });
    await expect(readImmutableRunResult(root, "run-link-missing-hash"))
      .rejects.toThrow(/Superseded record hash/u);
  });

  it("rejects cyclic correction provenance even if every local envelope is rehashed", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentix-correction-cycle-"));
    const first = await writeImmutableRunResult({
      resultsRoot: root,
      draft: draft("run-cycle-first"),
      artifacts: [],
    });
    const second = await writeImmutableRunResult({
      resultsRoot: root,
      draft: draft("run-cycle-second"),
      artifacts: [],
    });
    const addCorrection = (
      payload: Record<string, unknown>,
      supersededRunId: string,
    ): void => {
      payload["correction"] = {
        schemaVersion: 1,
        supersededRunId,
        supersededRecordSha256: "0".repeat(64),
        reason: "Tampered cyclic lineage.",
        recordedAt: "2040-01-02T00:00:00.000Z",
      };
    };
    await rewriteRawRecord(first, (payload) => {
      addCorrection(payload, "run-cycle-second");
    });
    await rewriteRawRecord(second, (payload) => {
      addCorrection(payload, "run-cycle-first");
    });

    await expect(readImmutableRunResult(root, "run-cycle-first"))
      .rejects.toThrow(/cycle/u);
  });
});
