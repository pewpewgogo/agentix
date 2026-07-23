import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sha256 } from "@agentix/benchmark-harness";

import {
  publishReportDirectory,
  readPublishedReportManifest,
  ReportPublicationError,
} from "./publication.js";
import type { PublishedReportManifest } from "./types.js";

const REPORT_JSON = "{\"verdict\":\"INCONCLUSIVE\"}\n";
const REPORT_MARKDOWN = "# Report\n";

const manifest = (output: string): PublishedReportManifest => ({
  schemaVersion: 1,
  analysisVersion: "analysis-v1",
  inputs: {
    schedule: { path: "/evidence/schedule.json", sha256: "a".repeat(64) },
    configuration: { path: "/evidence/config.json", sha256: "b".repeat(64) },
    analysisSource: { path: "/evidence/source.json", sha256: "c".repeat(64) },
    pricingSnapshot: null,
    recordsRoot: "/evidence/results",
    recordHashes: { "run-1": "d".repeat(64) },
  },
  outputs: {
    json: {
      path: join(output, "published", "report.json"),
      sha256: sha256(REPORT_JSON),
    },
    markdown: {
      path: join(output, "published", "report.md"),
      sha256: sha256(REPORT_MARKDOWN),
    },
  },
});

describe("atomic report publication", () => {
  it("publishes through a completion marker and never overwrites a reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentix-report-publish-"));
    const output = join(root, "report-001");
    await publishReportDirectory({
      outputDirectory: output,
      json: REPORT_JSON,
      markdown: REPORT_MARKDOWN,
      manifest: manifest(output),
    });
    await expect(readPublishedReportManifest(output)).resolves.toEqual(
      manifest(output),
    );
    await expect(
      publishReportDirectory({
        outputDirectory: output,
        json: REPORT_JSON,
        markdown: REPORT_MARKDOWN,
        manifest: manifest(output),
      }),
    ).rejects.toBeInstanceOf(ReportPublicationError);
  });

  it("rejects partial publication and manifest tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentix-report-partial-"));
    const partial = join(root, "partial");
    await mkdir(join(partial, ".staging"), { recursive: true });
    await writeFile(join(partial, ".staging", "report.json"), "{}");
    await expect(readPublishedReportManifest(partial)).rejects.toThrow(
      /incomplete/u,
    );

    const published = join(root, "published");
    await publishReportDirectory({
      outputDirectory: published,
      json: REPORT_JSON,
      markdown: REPORT_MARKDOWN,
      manifest: manifest(published),
    });
    await writeFile(
      join(published, "published", "manifest.json"),
      "{\"tampered\":true}\n",
    );
    await expect(readPublishedReportManifest(published)).rejects.toThrow(
      /integrity/u,
    );
  });
});
