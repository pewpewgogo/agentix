#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readImmutableRunResult,
  sha256,
} from "@agentix/benchmark-harness";

import { analyzeExperiment } from "./analyze.js";
import { publishReportDirectory } from "./publication.js";
import { renderMarkdown } from "./render.js";
import { verifyExecutedAnalysisSourceManifest } from "./source-integrity.js";
import type { PublishedReportManifest } from "./types.js";
import {
  parseAnalysisConfiguration,
  parsePricingSnapshot,
  parseScheduleDocument,
} from "./validation.js";

const option = (name: string): string | undefined =>
  process.argv
    .slice(2)
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const resultsRootInput = option("--results-root");
const scheduleInput = option("--schedule");
const configurationInput = option("--config");
const analysisSourceInput = option("--analysis-source");
const pricingSnapshotInput = option("--pricing-snapshot");
const outputInput = option("--output");
if (
  resultsRootInput === undefined ||
  scheduleInput === undefined ||
  configurationInput === undefined ||
  analysisSourceInput === undefined ||
  outputInput === undefined
) {
  process.stderr.write(
    "Usage: agentix-benchmark-report --results-root=<immutable-root> --schedule=<json> --config=<json> --analysis-source=<canonical-source-manifest> [--pricing-snapshot=<json>] --output=<new-directory>\n",
  );
  process.exitCode = 2;
} else {
  const resultsRoot = resolve(resultsRootInput);
  const schedulePath = resolve(scheduleInput);
  const configurationPath = resolve(configurationInput);
  const analysisSourcePath = resolve(analysisSourceInput);
  const pricingSnapshotPath =
    pricingSnapshotInput === undefined ? null : resolve(pricingSnapshotInput);
  const outputDirectory = resolve(outputInput);
  const [scheduleBytes, configurationBytes, analysisSourceBytes, pricingSnapshotBytes] =
    await Promise.all([
      readFile(schedulePath),
      readFile(configurationPath),
      readFile(analysisSourcePath),
      pricingSnapshotPath === null ? Promise.resolve(null) : readFile(pricingSnapshotPath),
    ]);
  const schedule = parseScheduleDocument(
    JSON.parse(scheduleBytes.toString("utf8")) as unknown,
  );
  const configuration = parseAnalysisConfiguration(
    JSON.parse(configurationBytes.toString("utf8")) as unknown,
  );
  const verifiedAnalysisSource = await verifyExecutedAnalysisSourceManifest({
    text: analysisSourceBytes.toString("utf8"),
    runtimeDirectory: dirname(fileURLToPath(import.meta.url)),
  });
  const pricingSnapshot =
    pricingSnapshotBytes === null
      ? null
      : parsePricingSnapshot(
          JSON.parse(pricingSnapshotBytes.toString("utf8")) as unknown,
        );
  const records = await Promise.all(
    configuration.runIds.map((runId) =>
      readImmutableRunResult(resultsRoot, runId),
    ),
  );
  const report = analyzeExperiment({
    records,
    schedule,
    configuration,
    pricingSnapshot,
    evidence: { analysisSourceHash: verifiedAnalysisSource.manifestHash },
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdown(report);
  const publishedDirectory = join(outputDirectory, "published");
  const manifest: PublishedReportManifest = {
    schemaVersion: 1,
    analysisVersion: report.analysisVersion,
    inputs: {
      schedule: { path: schedulePath, sha256: sha256(scheduleBytes) },
      configuration: {
        path: configurationPath,
        sha256: sha256(configurationBytes),
      },
      analysisSource: {
        path: analysisSourcePath,
        sha256: verifiedAnalysisSource.manifestHash,
      },
      pricingSnapshot:
        pricingSnapshotPath === null || pricingSnapshotBytes === null
          ? null
          : {
              path: pricingSnapshotPath,
              sha256: sha256(pricingSnapshotBytes),
            },
      recordsRoot: resultsRoot,
      recordHashes: report.evidence.recordHashes,
    },
    outputs: {
      json: {
        path: join(publishedDirectory, "report.json"),
        sha256: sha256(json),
      },
      markdown: {
        path: join(publishedDirectory, "report.md"),
        sha256: sha256(markdown),
      },
    },
  };
  await publishReportDirectory({
    outputDirectory,
    json,
    markdown,
    manifest,
  });
}
