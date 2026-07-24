import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_GIT_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_GIT_BATCH_BYTES = 256 * 1024 * 1024;

const verifiedCommits = new Map<string, Promise<void>>();
const gitBlobs = new Map<string, Promise<Buffer>>();

const runGit = async (
  repositoryRoot: string,
  arguments_: readonly string[],
): Promise<Buffer> =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      ["--no-replace-objects", "-C", resolve(repositoryRoot), ...arguments_],
      { encoding: null, maxBuffer: MAX_GIT_BLOB_BYTES },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.toString("utf8").trim();
          rejectPromise(new Error(
            detail.length > 0 ? `Git object read failed: ${detail}` : "Git object read failed.",
            { cause: error },
          ));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });

const parseGitBlobBatch = (
  output: Buffer,
  repositoryPaths: readonly string[],
): readonly Buffer[] => {
  const blobs: Buffer[] = [];
  let offset = 0;

  for (const repositoryPath of repositoryPaths) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new Error(`Git batch response ended before ${repositoryPath}.`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    if (header.endsWith(" missing")) {
      throw new Error(`Git object read failed: ${repositoryPath} is missing.`);
    }
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/u.exec(header);
    if (match === null) {
      throw new Error(`Unexpected Git batch header for ${repositoryPath}: ${header}`);
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > MAX_GIT_BLOB_BYTES) {
      throw new Error(`Git blob ${repositoryPath} has an unsafe size: ${match[2]}.`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new Error(`Git batch response has invalid framing for ${repositoryPath}.`);
    }
    blobs.push(Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }

  if (offset !== output.length) {
    throw new Error("Git batch response contains unexpected trailing data.");
  }
  return blobs;
};

const runGitBlobBatch = async (
  repositoryRoot: string,
  commit: string,
  repositoryPaths: readonly string[],
): Promise<readonly Buffer[]> => {
  if (repositoryPaths.length === 0) return [];

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      "git",
      ["--no-replace-objects", "-C", resolve(repositoryRoot), "cat-file", "--batch"],
      { windowsHide: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const reject = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(error);
    };

    child.on("error", (error) => reject(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_BATCH_BYTES) {
        reject(new Error("Git batch response exceeded the maximum safe size."));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        rejectPromise(new Error(
          detail.length > 0 ? `Git object read failed: ${detail}` : "Git object read failed.",
        ));
        return;
      }
      try {
        resolvePromise(parseGitBlobBatch(Buffer.concat(stdout), repositoryPaths));
      } catch (error: unknown) {
        rejectPromise(error);
      }
    });

    child.stdin.end(
      `${repositoryPaths.map((path) => `${commit}:${path}`).join("\n")}\n`,
      "utf8",
    );
  });
};

const assertNormalizedGitPath = (repositoryPath: string): void => {
  if (
    repositoryPath.length === 0 ||
    repositoryPath.includes("\0") ||
    repositoryPath.includes("\n") ||
    repositoryPath.includes("\r") ||
    isAbsolute(repositoryPath) ||
    repositoryPath.startsWith("/") ||
    repositoryPath.includes("\\") ||
    posix.normalize(repositoryPath) !== repositoryPath ||
    repositoryPath === ".." ||
    repositoryPath.startsWith("../")
  ) {
    throw new TypeError(`Unsafe repository-relative Git path: ${repositoryPath}`);
  }
};

const assertGitCommit = async (
  repositoryRoot: string,
  commit: string,
): Promise<void> => {
  if (!GIT_COMMIT_PATTERN.test(commit)) {
    throw new TypeError(`Expected a full lowercase Git commit SHA, received ${commit}.`);
  }

  const key = `${resolve(repositoryRoot)}\0${commit}`;
  let verification = verifiedCommits.get(key);
  if (verification === undefined) {
    verification = (async () => {
      const objectType = (await runGit(repositoryRoot, ["cat-file", "-t", commit]))
        .toString("utf8")
        .trim();
      if (objectType !== "commit") {
        throw new TypeError(`Git object ${commit} is ${objectType}, not a commit.`);
      }
    })();
    verifiedCommits.set(key, verification);
  }

  try {
    await verification;
  } catch (error: unknown) {
    if (verifiedCommits.get(key) === verification) verifiedCommits.delete(key);
    throw error;
  }
};

export const sha256 = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

export const resolveInside = (
  repositoryRoot: string,
  repositoryPath: string,
): string => {
  const root = resolve(repositoryRoot);
  const candidate = resolve(root, repositoryPath);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !fromRoot.startsWith(sep))
  ) {
    return candidate;
  }
  throw new TypeError(`Path escapes repository root: ${repositoryPath}`);
};

export const digestFile = async (absolutePath: string): Promise<string> =>
  sha256(await readFile(absolutePath));

export const assertFileDigest = async (
  absolutePath: string,
  expected: string,
): Promise<void> => {
  const actual = await digestFile(absolutePath);
  if (actual !== expected) {
    throw new Error(
      `Integrity mismatch for ${absolutePath}: expected ${expected}, received ${actual}.`,
    );
  }
};

export const readVerifiedGitBlob = async (
  repositoryRoot: string,
  commit: string,
  repositoryPath: string,
  expectedSha256: string,
): Promise<Buffer> => {
  const blobs = await readVerifiedGitBlobs(repositoryRoot, commit, [{
    repositoryPath,
    expectedSha256,
  }]);
  const content = blobs.get(repositoryPath);
  if (content === undefined) {
    throw new Error(`Git batch response omitted ${repositoryPath}.`);
  }
  return content;
};

export const readVerifiedGitBlobs = async (
  repositoryRoot: string,
  commit: string,
  requests: readonly {
    readonly repositoryPath: string;
    readonly expectedSha256: string;
  }[],
): Promise<ReadonlyMap<string, Buffer>> => {
  const expectedByPath = new Map<string, string>();
  for (const { repositoryPath, expectedSha256 } of requests) {
    assertNormalizedGitPath(repositoryPath);
    if (!SHA256_PATTERN.test(expectedSha256)) {
      throw new TypeError(`Expected a lowercase SHA-256 digest for ${repositoryPath}.`);
    }
    const previous = expectedByPath.get(repositoryPath);
    if (previous !== undefined && previous !== expectedSha256) {
      throw new Error(`Conflicting SHA-256 digests for Git blob ${repositoryPath}.`);
    }
    expectedByPath.set(repositoryPath, expectedSha256);
  }
  await assertGitCommit(repositoryRoot, commit);

  const root = resolve(repositoryRoot);
  const missing = [...expectedByPath.keys()].filter(
    (repositoryPath) => !gitBlobs.has(`${root}\0${commit}\0${repositoryPath}`),
  );
  if (missing.length > 0) {
    const contents = await runGitBlobBatch(repositoryRoot, commit, missing);
    for (const [index, repositoryPath] of missing.entries()) {
      const content = contents[index];
      if (content === undefined) {
        throw new Error(`Git batch response omitted ${repositoryPath}.`);
      }
      gitBlobs.set(
        `${root}\0${commit}\0${repositoryPath}`,
        Promise.resolve(content),
      );
    }
  }

  const verified = new Map<string, Buffer>();
  for (const [repositoryPath, expectedSha256] of expectedByPath) {
    const key = `${root}\0${commit}\0${repositoryPath}`;
    const read = gitBlobs.get(key);
    if (read === undefined) {
      throw new Error(`Git blob cache omitted ${repositoryPath}.`);
    }
    let content: Buffer;
    try {
      content = await read;
    } catch (error: unknown) {
      if (gitBlobs.get(key) === read) gitBlobs.delete(key);
      throw error;
    }
    const actual = sha256(content);
    if (actual !== expectedSha256) {
      throw new Error(
        `Integrity mismatch for Git blob ${commit}:${repositoryPath}: expected ${expectedSha256}, received ${actual}.`,
      );
    }
    verified.set(repositoryPath, Buffer.from(content));
  }
  return verified;
};
