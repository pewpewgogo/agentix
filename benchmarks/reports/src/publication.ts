import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { canonicalJson, sha256 } from "@agentixdev/benchmark-harness";

import type { PublishedReportManifest } from "./types.js";

export class ReportPublicationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReportPublicationError";
  }
}

export const publishReportDirectory = async (input: {
  readonly outputDirectory: string;
  readonly json: string;
  readonly markdown: string;
  readonly manifest: PublishedReportManifest;
}): Promise<void> => {
  const outputDirectory = resolve(input.outputDirectory);
  const expectedJsonPath = join(outputDirectory, "published", "report.json");
  const expectedMarkdownPath = join(outputDirectory, "published", "report.md");
  if (
    resolve(input.manifest.outputs.json.path) !== expectedJsonPath ||
    resolve(input.manifest.outputs.markdown.path) !== expectedMarkdownPath ||
    input.manifest.outputs.json.sha256 !== sha256(input.json) ||
    input.manifest.outputs.markdown.sha256 !== sha256(input.markdown)
  ) {
    throw new ReportPublicationError(
      "Report manifest output paths or hashes do not match the publication payload.",
    );
  }
  await mkdir(dirname(outputDirectory), { recursive: true });
  try {
    await mkdir(outputDirectory, { recursive: false });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new ReportPublicationError(
        `Report directory already exists and will not be overwritten: ${outputDirectory}`,
      );
    }
    throw error;
  }
  const staging = join(outputDirectory, ".staging");
  const published = join(outputDirectory, "published");
  await mkdir(staging, { recursive: false });
  const manifestText = `${JSON.stringify(input.manifest, null, 2)}\n`;
  await Promise.all([
    writeFile(join(staging, "report.json"), input.json, { encoding: "utf8", flag: "wx" }),
    writeFile(join(staging, "report.md"), input.markdown, { encoding: "utf8", flag: "wx" }),
    writeFile(join(staging, "manifest.json"), manifestText, { encoding: "utf8", flag: "wx" }),
  ]);
  await writeFile(
    join(staging, "complete.json"),
    `${canonicalJson({
      schemaVersion: 1,
      manifestSha256: sha256(manifestText),
      reportJsonSha256: sha256(input.json),
      reportMarkdownSha256: sha256(input.markdown),
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await rename(staging, published);
  await writeFile(
    join(outputDirectory, "COMPLETE"),
    `${canonicalJson({
      schemaVersion: 1,
      publishedDirectory: "published",
      manifestSha256: sha256(manifestText),
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
};

const parseObject = (text: string, label: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ReportPublicationError(`${label} is malformed or truncated.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReportPublicationError(`${label} is not an object.`);
  }
  return value as Record<string, unknown>;
};

export const readPublishedReportManifest = async (
  outputDirectoryInput: string,
): Promise<PublishedReportManifest> => {
  const outputDirectory = resolve(outputDirectoryInput);
  let markerText: string;
  let manifestText: string;
  let completeText: string;
  let reportJson: string;
  let reportMarkdown: string;
  try {
    [markerText, manifestText, completeText, reportJson, reportMarkdown] = await Promise.all([
      readFile(join(outputDirectory, "COMPLETE"), "utf8"),
      readFile(join(outputDirectory, "published", "manifest.json"), "utf8"),
      readFile(join(outputDirectory, "published", "complete.json"), "utf8"),
      readFile(join(outputDirectory, "published", "report.json"), "utf8"),
      readFile(join(outputDirectory, "published", "report.md"), "utf8"),
    ]);
  } catch {
    throw new ReportPublicationError(
      "Report directory is incomplete and must not be consumed.",
    );
  }
  const marker = parseObject(markerText, "Publication marker");
  const complete = parseObject(completeText, "Published completion marker");
  const manifest = parseObject(manifestText, "Report manifest");
  const manifestHash = sha256(manifestText);
  if (
    marker["publishedDirectory"] !== "published" ||
    marker["manifestSha256"] !== manifestHash ||
    complete["manifestSha256"] !== manifestHash ||
    complete["reportJsonSha256"] !== sha256(reportJson) ||
    complete["reportMarkdownSha256"] !== sha256(reportMarkdown)
  ) {
    throw new ReportPublicationError("Published report manifest integrity check failed.");
  }
  const outputs =
    typeof manifest["outputs"] === "object" &&
    manifest["outputs"] !== null &&
    !Array.isArray(manifest["outputs"])
      ? (manifest["outputs"] as Record<string, unknown>)
      : null;
  const jsonMetadata =
    outputs !== null &&
    typeof outputs["json"] === "object" &&
    outputs["json"] !== null &&
    !Array.isArray(outputs["json"])
      ? (outputs["json"] as Record<string, unknown>)
      : null;
  const markdownMetadata =
    outputs !== null &&
    typeof outputs["markdown"] === "object" &&
    outputs["markdown"] !== null &&
    !Array.isArray(outputs["markdown"])
      ? (outputs["markdown"] as Record<string, unknown>)
      : null;
  if (
    manifest["schemaVersion"] !== 1 ||
    typeof manifest["analysisVersion"] !== "string" ||
    jsonMetadata?.["sha256"] !== sha256(reportJson) ||
    markdownMetadata?.["sha256"] !== sha256(reportMarkdown)
  ) {
    throw new ReportPublicationError("Published output hashes do not match the manifest.");
  }
  return manifest as unknown as PublishedReportManifest;
};
