import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documentationRoot = resolve(repositoryRoot, "docs");
const outputRoot = resolve(repositoryRoot, ".agentix-tmp/pages-source");
const repositoryUrl = "https://github.com/pewpewgogo/agentix";

const isWithin = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

const encodeRepositoryPath = (path) =>
  path.split(sep).map(encodeURIComponent).join("/");

const markdownOutputPath = (sourcePath) => {
  const path = relative(documentationRoot, sourcePath);
  return path === "README.md" ? "index.md" : path;
};

const publishedDocumentPath = (sourcePath) => {
  const path = markdownOutputPath(sourcePath);
  return path.replace(/\.md$/u, ".html");
};

const pathKind = async (path) => {
  try {
    return (await stat(path)).isDirectory() ? "tree" : "blob";
  } catch {
    return "blob";
  }
};

const rewriteTarget = async (sourcePath, rawTarget) => {
  const wrapped = rawTarget.startsWith("<") && rawTarget.endsWith(">");
  const target = wrapped ? rawTarget.slice(1, -1) : rawTarget;
  if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(target)) return rawTarget;

  const hashIndex = target.indexOf("#");
  const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : target.slice(hashIndex);
  if (pathPart.length === 0) return rawTarget;

  const absolute = resolve(dirname(sourcePath), decodeURIComponent(pathPart));
  if (isWithin(documentationRoot, absolute)) {
    if (extname(absolute).toLowerCase() !== ".md") return rawTarget;
    const sourceOutput = markdownOutputPath(sourcePath);
    const targetOutput = publishedDocumentPath(absolute);
    const rewritten = relative(dirname(sourceOutput), targetOutput).split(sep).join("/");
    return `${rewritten.startsWith(".") ? rewritten : `./${rewritten}`}${hash}`;
  }

  if (!isWithin(repositoryRoot, absolute)) return rawTarget;
  const repositoryPath = encodeRepositoryPath(relative(repositoryRoot, absolute));
  return `${repositoryUrl}/${await pathKind(absolute)}/main/${repositoryPath}${hash}`;
};

const rewriteLinks = async (sourcePath, source) => {
  const matches = [...source.matchAll(/\[([^\]]*)\]\(([^)]+)\)/gu)];
  let cursor = 0;
  let output = "";
  for (const match of matches) {
    const index = match.index ?? 0;
    output += source.slice(cursor, index);
    output += `[${match[1]}](${await rewriteTarget(sourcePath, match[2].trim())})`;
    cursor = index + match[0].length;
  }
  return output + source.slice(cursor);
};

const titleFor = (source, fallback) =>
  /^#\s+(.+)$/mu.exec(source)?.[1]?.trim() ?? fallback;

const prepareMarkdown = async (sourcePath, destinationPath) => {
  const source = await readFile(sourcePath, "utf8");
  const title = titleFor(source, "Agentix Documentation");
  const rewritten = await rewriteLinks(sourcePath, source);
  const frontMatter = [
    "---",
    "layout: default",
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
  ].join("\n");
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, `${frontMatter}${rewritten}`, "utf8");
};

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const sourcePath of await walk(documentationRoot)) {
  const sourceRelativePath = relative(documentationRoot, sourcePath);
  if (extname(sourcePath).toLowerCase() === ".md") {
    const destination = resolve(outputRoot, markdownOutputPath(sourcePath));
    await prepareMarkdown(sourcePath, destination);
  } else {
    const destination = resolve(outputRoot, sourceRelativePath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourcePath, destination);
  }
}

console.log(`Prepared GitHub Pages source at ${relative(repositoryRoot, outputRoot)}`);
