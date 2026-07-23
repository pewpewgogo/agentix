import { basename, dirname, extname, resolve } from "node:path";

import { API, SymbolFlags, type Checker, type Symbol as TypeScriptSymbol } from "typescript/unstable/sync";
import * as ts from "typescript/unstable/ast";

import { createSourceManifest, discoverSourceFiles, repositoryPath } from "./files.js";
import {
  COMPILER_VERSION,
  INDEX_SCHEMA_VERSION,
  type AgentIndex,
  type AnalyzeOptions,
  type CompilerDiagnostic,
  type GraphEdge,
  type IndexedEffect,
  type IndexedEvent,
  type IndexedFeature,
  type IndexedInvariant,
  type IndexedOperation,
  type IndexedPort,
  type IndexedPortOperation,
  type IndexedTest,
  type SourceLocation,
} from "./types.js";

const descriptorCalls = new Map([
  ["defineFeature", "feature"],
  ["defineCommand", "command"],
  ["defineQuery", "query"],
  ["definePort", "port"],
  ["defineEvent", "event"],
  ["defineInvariant", "invariant"],
] as const);

const testCalls = new Set([
  "associateOperationTest",
  "defineOperationTest",
  "testCommand",
  "testQuery",
]);

type DescriptorCallName = typeof descriptorCalls extends Map<infer K, unknown> ? K : never;
type DescriptorKind = "feature" | "command" | "query" | "port" | "event" | "invariant";

interface Draft {
  readonly kind: DescriptorKind;
  readonly call: ts.CallExpression;
  readonly object: ts.ObjectLiteralExpression;
  readonly declaration: ts.VariableDeclaration;
  readonly symbolName: string;
  readonly symbol?: TypeScriptSymbol;
  readonly source: SourceLocation;
  readonly sourceFile: ts.SourceFile;
}

interface PortOperationDraft extends IndexedPortOperation {
  readonly symbol?: TypeScriptSymbol;
  readonly qualifiedName: string;
}

interface ImportUse {
  readonly fromSegment: string;
  readonly toSegment: string;
  readonly source: SourceLocation;
  readonly publicContract: boolean;
}

const compare = (left: string, right: string): number => left.localeCompare(right);
const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isAssertionExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};

const propertyName = (name: ts.PropertyName | undefined): string | undefined => {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLikeNode(name)) return name.text;
  if (ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
};

const getProperty = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined =>
  object.properties.find(
    (property) => "name" in property && propertyName(property.name) === name,
  );

const initializerForProperty = (
  property: ts.ObjectLiteralElementLike,
): ts.Expression | undefined => {
  if (ts.isPropertyAssignment(property)) return unwrap(property.initializer);
  if (ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)) {
    return property.name;
  }
  return undefined;
};

const propertyExpression = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined => {
  const property = getProperty(object, name);
  if (property === undefined) return undefined;
  return initializerForProperty(property);
};

const objectExpression = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralExpression | undefined => {
  const expression = propertyExpression(object, name);
  return expression !== undefined && ts.isObjectLiteralExpression(expression)
    ? expression
    : undefined;
};

const arrayExpressions = (
  object: ts.ObjectLiteralExpression,
  name: string,
): readonly ts.Expression[] => {
  const expression = propertyExpression(object, name);
  return expression !== undefined && ts.isArrayLiteralExpression(expression)
    ? expression.elements.filter(ts.isExpression).map(unwrap)
    : [];
};

const stringLiteral = (expression: ts.Expression | undefined): string | undefined => {
  const unwrapped = expression === undefined ? undefined : unwrap(expression);
  return unwrapped !== undefined && ts.isStringLiteralLikeNode(unwrapped)
    ? unwrapped.text
    : undefined;
};

const numberLiteral = (expression: ts.Expression | undefined): number | undefined => {
  const unwrapped = expression === undefined ? undefined : unwrap(expression);
  return unwrapped !== undefined && ts.isNumericLiteral(unwrapped)
    ? Number(unwrapped.text)
    : undefined;
};

const expressionText = (expression: ts.Expression): string =>
  expression.getText(expression.getSourceFile()).replace(/\s+/gu, " ");

const featureSegment = (rootDir: string, file: string): string | undefined => {
  const match = /(?:^|\/)src\/features\/([^/]+)(?:\/|$)/u.exec(
    repositoryPath(rootDir, file),
  );
  return match?.[1];
};

const sourceLocation = (
  rootDir: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): SourceLocation => {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: repositoryPath(rootDir, sourceFile.fileName),
    line: position.line + 1,
    column: position.character + 1,
  };
};

const variableForCall = (call: ts.CallExpression): ts.VariableDeclaration | undefined => {
  let node: ts.Node = call;
  while (
    node.parent !== undefined &&
    (ts.isAsExpression(node.parent) ||
      ts.isSatisfiesExpression(node.parent) ||
      ts.isParenthesizedExpression(node.parent))
  ) {
    node = node.parent;
  }
  return node.parent !== undefined && ts.isVariableDeclaration(node.parent)
    ? node.parent
    : undefined;
};

const canonicalImports = (sourceFile: ts.SourceFile): Map<string, string> => {
  const names = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const clause = statement.importClause;
    if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const specifier of clause.namedBindings.elements) {
        names.set(specifier.name.text, specifier.propertyName?.text ?? specifier.name.text);
      }
    }
    if (clause.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)) {
      names.set(clause.namedBindings.name.text, "*");
    }
  }
  return names;
};

const calledName = (
  call: ts.CallExpression,
  imports: ReadonlyMap<string, string>,
): string | undefined => {
  const expression = unwrap(call.expression);
  if (ts.isIdentifier(expression)) {
    return imports.get(expression.text) ?? expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
};

const unalias = (checker: Checker, symbol: TypeScriptSymbol | undefined): TypeScriptSymbol | undefined => {
  if (symbol === undefined) return undefined;
  return (symbol.flags & SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
};

const expressionSymbol = (
  checker: Checker,
  expression: ts.Expression,
): TypeScriptSymbol | undefined => {
  const unwrapped = unwrap(expression);
  const target = ts.isPropertyAccessExpression(unwrapped) ? unwrapped.name : unwrapped;
  return unalias(checker, checker.getSymbolAtLocation(target));
};

const symbolSource = (symbol: TypeScriptSymbol | undefined): ts.SourceFile | undefined =>
  symbol?.declarations[0]?.resolve()?.getSourceFile();

const exportedNames = (sourceFile: ts.SourceFile): string[] => {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!/^export\b/u.test(statement.getText(sourceFile))) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return uniqueSorted(names);
};

const sortDiagnostics = (diagnostics: CompilerDiagnostic[]): CompilerDiagnostic[] =>
  diagnostics.sort(
    (left, right) =>
      compare(left.source.file, right.source.file) ||
      left.source.line - right.source.line ||
      left.source.column - right.source.column ||
      compare(left.code, right.code) ||
      compare(left.message, right.message),
  );

const architectureDiagnostics = (
  rootDir: string,
  sourceFiles: readonly ts.SourceFile[],
  featureIds: ReadonlyMap<string, string>,
  declaredDependencies: ReadonlyMap<string, ReadonlySet<string>>,
): { diagnostics: CompilerDiagnostic[]; unresolved: string[] } => {
  const diagnostics: CompilerDiagnostic[] = [];
  const unresolved: string[] = [];
  const importUses: ImportUse[] = [];
  const databaseImports = new Set([
    "@prisma/client",
    "better-sqlite3",
    "mongodb",
    "mysql",
    "mysql2",
    "node:sqlite",
    "pg",
    "sqlite3",
  ]);

  const add = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    code: string,
    severity: "error" | "warning",
    message: string,
  ): void => {
    diagnostics.push({ code, severity, message, source: sourceLocation(rootDir, sourceFile, node) });
  };

  for (const sourceFile of sourceFiles) {
    const fromSegment = featureSegment(rootDir, sourceFile.fileName);
    if (fromSegment === undefined) continue;
    const relativeFile = repositoryPath(rootDir, sourceFile.fileName);
    const isDomain =
      !/(?:^|\/)contract\.[cm]?tsx?$/u.test(relativeFile) &&
      !/\.(?:agent-test|test|spec)\.[cm]?tsx?$/u.test(relativeFile);

    const inspectImport = (
      specifier: string,
      node: ts.Node,
      dynamic: boolean,
    ): void => {
      if (isDomain && (specifier === "node:fs" || specifier === "node:fs/promises" || specifier === "fs" || specifier === "fs/promises")) {
        add(sourceFile, node, "architecture.ambient-filesystem", "error", `Domain source imports ambient filesystem module '${specifier}'.`);
      }
      if (isDomain && databaseImports.has(specifier)) {
        add(sourceFile, node, "architecture.ambient-database", "error", `Domain source imports ambient database module '${specifier}'.`);
      }
      if (!specifier.startsWith(".")) return;
      const extension = extname(specifier);
      const withoutExtension = extension === ".js" || extension === ".ts" || extension === ".mjs" || extension === ".mts" || extension === ".cjs" || extension === ".cts"
        ? specifier.slice(0, -extension.length)
        : specifier;
      const target = resolve(dirname(sourceFile.fileName), withoutExtension);
      const targetSegment = featureSegment(rootDir, target);
      if (targetSegment === undefined || targetSegment === fromSegment) return;
      const publicContract = basename(target) === "contract";
      importUses.push({
        fromSegment,
        toSegment: targetSegment,
        source: sourceLocation(rootDir, sourceFile, node),
        publicContract,
      });
      if (!publicContract) {
        add(
          sourceFile,
          node,
          "architecture.private-cross-feature-import",
          "error",
          `Feature '${featureIds.get(fromSegment) ?? fromSegment}' imports private source from feature '${featureIds.get(targetSegment) ?? targetSegment}'. Import its public contract instead.`,
        );
      }
      if (dynamic && !publicContract) {
        unresolved.push(`${relativeFile}: dynamic private cross-feature import '${specifier}'`);
      }
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLikeNode(node.moduleSpecifier)) {
        inspectImport(node.moduleSpecifier.text, node.moduleSpecifier, false);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const argument = node.arguments[0];
        if (argument === undefined || !ts.isStringLiteralLikeNode(argument)) {
          const location = sourceLocation(rootDir, sourceFile, node);
          unresolved.push(`${location.file}:${location.line}: unresolved dynamic import`);
          add(sourceFile, node, "architecture.unresolved-dynamic-import", "warning", "A non-literal dynamic import forces conservative verification.");
        } else {
          inspectImport(argument.text, argument, true);
        }
      }
      if (isDomain && ts.isCallExpression(node)) {
        const expression = unwrap(node.expression);
        if (ts.isIdentifier(expression) && expression.text === "fetch") {
          add(sourceFile, node, "architecture.ambient-fetch", "error", "Domain source calls ambient fetch; declare a port effect instead.");
        }
        if (
          ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          ((expression.expression.text === "Date" && expression.name.text === "now") ||
            (expression.expression.text === "Math" && expression.name.text === "random"))
        ) {
          const code = expression.expression.text === "Date" ? "architecture.ambient-time" : "architecture.ambient-randomness";
          add(sourceFile, node, code, "error", `Domain source calls ambient ${expression.expression.text}.${expression.name.text}; declare a port effect instead.`);
        }
      }
      if (
        isDomain &&
        ts.isNewExpression(node) &&
        ts.isIdentifier(unwrap(node.expression)) &&
        (unwrap(node.expression) as ts.Identifier).text === "Date"
      ) {
        add(sourceFile, node, "architecture.ambient-time", "error", "Domain source constructs ambient Date; declare a time port effect instead.");
      }
      if (
        isDomain &&
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "env" &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "process"
      ) {
        add(sourceFile, node, "architecture.ambient-environment", "error", "Domain source reads process.env; pass configuration through an explicit boundary.");
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }

  const used = new Map<string, Set<string>>();
  for (const use of importUses.filter((candidate) => candidate.publicContract)) {
    const fromId = featureIds.get(use.fromSegment) ?? use.fromSegment;
    const toId = featureIds.get(use.toSegment) ?? use.toSegment;
    const set = used.get(fromId) ?? new Set<string>();
    set.add(toId);
    used.set(fromId, set);
    if (!declaredDependencies.get(fromId)?.has(toId)) {
      diagnostics.push({
        code: "architecture.undeclared-feature-dependency",
        severity: "error",
        message: `Feature '${fromId}' imports public contract '${toId}' without declaring it as a dependency.`,
        source: use.source,
      });
    }
  }
  for (const [fromId, dependencies] of declaredDependencies) {
    for (const dependency of dependencies) {
      if (!used.get(fromId)?.has(dependency)) {
        const featureSource = sourceFiles.find(
          (sourceFile) => featureIds.get(featureSegment(rootDir, sourceFile.fileName) ?? "") === fromId,
        );
        if (featureSource !== undefined) {
          diagnostics.push({
            code: "architecture.unused-feature-dependency",
            severity: "warning",
            message: `Feature '${fromId}' declares unused dependency '${dependency}'.`,
            source: sourceLocation(rootDir, featureSource, featureSource),
          });
        }
      }
    }
  }
  return { diagnostics: sortDiagnostics(diagnostics), unresolved: uniqueSorted(unresolved) };
};

const likelyAffected = (
  features: readonly IndexedFeature[],
  operations: readonly IndexedOperation[],
  ports: readonly IndexedPort[],
  events: readonly IndexedEvent[],
  invariants: readonly IndexedInvariant[],
): AgentIndex["likelyAffected"] => {
  const entries: { target: string; operations: { id: string; reason: string }[] }[] = [];
  const consumers = new Map(features.map((feature) => [feature.id, feature.consumers]));
  const featureClosure = (id: string): Set<string> => {
    const selected = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const consumer of consumers.get(current) ?? []) {
        if (!selected.has(consumer)) {
          selected.add(consumer);
          queue.push(consumer);
        }
      }
    }
    return selected;
  };
  for (const feature of features) {
    const closure = featureClosure(feature.id);
    entries.push({
      target: feature.id,
      operations: operations
        .filter((operation) => operation.feature !== undefined && closure.has(operation.feature))
        .map((operation) => ({
          id: operation.id,
          reason: operation.feature === feature.id ? "owned by selected feature" : `owned by transitive consumer '${operation.feature}'`,
        })),
    });
  }
  for (const operation of operations) {
    entries.push({ target: operation.id, operations: [{ id: operation.id, reason: "selected operation" }] });
  }
  for (const port of ports) {
    for (const portOperation of port.operations) {
      entries.push({
        target: portOperation.id,
        operations: operations
          .filter((operation) => operation.effects.some((effect) => effect.operationId === portOperation.id))
          .map((operation) => ({ id: operation.id, reason: `declares effect '${portOperation.id}'` })),
      });
    }
  }
  for (const event of events) {
    entries.push({
      target: event.id,
      operations: operations
        .filter((operation) => operation.events.includes(event.id))
        .map((operation) => ({ id: operation.id, reason: `declares event '${event.id}'` })),
    });
  }
  for (const invariant of invariants) {
    entries.push({
      target: invariant.id,
      operations: invariant.preservers.map((id) => ({ id, reason: `preserves invariant '${invariant.id}'` })),
    });
  }
  return entries
    .map((entry) => ({
      target: entry.target,
      operations: entry.operations.sort((left, right) => compare(left.id, right.id)),
    }))
    .sort((left, right) => compare(left.target, right.target));
};

export const analyzeProject = (options: AnalyzeOptions): AgentIndex => {
  const rootDir = resolve(options.rootDir);
  const files = discoverSourceFiles(rootDir, options.files);
  const api = new API({ cwd: rootDir });
  const snapshot = api.updateSnapshot({ openFiles: files });
  const checkerByFile = new Map<string, Checker>();
  const sourceFiles = files
    .map((file) => {
      const project = snapshot.getDefaultProjectForFile(file) ??
        snapshot.getProjects().find((candidate) => candidate.program.getSourceFile(file) !== undefined);
      if (project === undefined) return undefined;
      const sourceFile = project.program.getSourceFile(file);
      if (sourceFile !== undefined) checkerByFile.set(sourceFile.fileName, project.checker);
      return sourceFile;
    })
    .filter((sourceFile): sourceFile is ts.SourceFile => sourceFile !== undefined)
    .sort((left, right) => compare(repositoryPath(rootDir, left.fileName), repositoryPath(rootDir, right.fileName)));
  const checkerFor = (node: ts.Node): Checker => {
    const checker = checkerByFile.get(node.getSourceFile().fileName);
    if (checker === undefined) throw new Error(`No TypeScript checker for ${node.getSourceFile().fileName}`);
    return checker;
  };
  const diagnostics: CompilerDiagnostic[] = [];
  const unresolved: string[] = [];
  const drafts: Draft[] = [];

  const diagnostic = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    code: string,
    message: string,
    severity: "error" | "warning" = "error",
  ): void => {
    diagnostics.push({ code, message, severity, source: sourceLocation(rootDir, sourceFile, node) });
  };

  for (const sourceFile of sourceFiles) {
    if (featureSegment(rootDir, sourceFile.fileName) === undefined) continue;
    const imports = canonicalImports(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = calledName(node, imports) as DescriptorCallName | undefined;
        const kind = name === undefined ? undefined : descriptorCalls.get(name);
        if (kind !== undefined) {
          const declaration = variableForCall(node);
          const argument = node.arguments[0];
          const object = argument === undefined ? undefined : unwrap(argument);
          if (declaration === undefined || object === undefined || !ts.isObjectLiteralExpression(object) || !ts.isIdentifier(declaration.name)) {
            diagnostic(sourceFile, node, "metadata.static-object-required", `${name} must initialize a named variable from a static object literal.`);
          } else {
            const checker = checkerFor(declaration.name);
            const symbol = unalias(checker, checker.getSymbolAtLocation(declaration.name));
            drafts.push({
              kind,
              call: node,
              object,
              declaration,
              symbolName: declaration.name.text,
              ...(symbol === undefined ? {} : { symbol }),
              source: sourceLocation(rootDir, sourceFile, declaration.name),
              sourceFile,
            });
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }

  const draftBySymbol = new Map<TypeScriptSymbol, Draft>();
  for (const draft of drafts) {
    if (draft.symbol !== undefined) draftBySymbol.set(draft.symbol, draft);
  }
  const resolveDraft = (expression: ts.Expression): Draft | undefined => {
    const symbol = expressionSymbol(checkerFor(expression), expression);
    return symbol === undefined ? undefined : draftBySymbol.get(symbol);
  };

  const idFor = (draft: Draft): string | undefined => {
    const idExpression = propertyExpression(draft.object, "id");
    const id = stringLiteral(idExpression);
    if (id === undefined) {
      diagnostic(draft.sourceFile, idExpression ?? draft.call, "metadata.literal-id-required", `${draft.kind} '${draft.symbolName}' must declare a string-literal id.`);
      unresolved.push(`${draft.source.file}:${draft.source.line}: non-literal ${draft.kind} id`);
    }
    return id;
  };
  const ids = new Map<Draft, string>();
  const seenIds = new Map<string, Draft>();
  for (const draft of drafts) {
    const id = idFor(draft);
    if (id === undefined) continue;
    const previous = seenIds.get(id);
    if (previous !== undefined) {
      diagnostic(draft.sourceFile, draft.declaration.name, "metadata.duplicate-id", `Stable id '${id}' is already declared at ${previous.source.file}:${previous.source.line}.`);
    } else {
      seenIds.set(id, draft);
    }
    ids.set(draft, id);
  }

  const featureDrafts = drafts.filter((draft) => draft.kind === "feature" && ids.has(draft));
  const featureIdsBySegment = new Map<string, string>();
  for (const draft of featureDrafts) {
    const segment = featureSegment(rootDir, draft.sourceFile.fileName);
    const id = ids.get(draft);
    if (segment !== undefined && id !== undefined) featureIdsBySegment.set(segment, id);
  }
  const featureForExpression = (expression: ts.Expression): string | undefined => {
    const resolved = resolveDraft(expression);
    if (resolved?.kind === "feature") return ids.get(resolved);
    const source = symbolSource(expressionSymbol(checkerFor(expression), expression));
    const segment = source === undefined ? undefined : featureSegment(rootDir, source.fileName);
    return segment === undefined ? undefined : featureIdsBySegment.get(segment) ?? segment;
  };

  const portOperationBySymbol = new Map<TypeScriptSymbol, PortOperationDraft>();
  const portOperationByText = new Map<string, PortOperationDraft>();
  const ports: IndexedPort[] = [];
  for (const draft of drafts.filter((candidate) => candidate.kind === "port" && ids.has(candidate))) {
    const operationsObject = objectExpression(draft.object, "operations");
    const operations: PortOperationDraft[] = [];
    if (operationsObject !== undefined) {
      for (const property of operationsObject.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        const initializer = initializerForProperty(property);
        if (name === undefined || initializer === undefined || !ts.isCallExpression(initializer)) continue;
        const argument = initializer.arguments[0];
        const object = argument === undefined ? undefined : unwrap(argument);
        if (object === undefined || !ts.isObjectLiteralExpression(object)) continue;
        const operationId = stringLiteral(propertyExpression(object, "id"));
        const kind = stringLiteral(propertyExpression(object, "kind"));
        if (operationId === undefined || !["read", "write", "time", "random", "external"].includes(kind ?? "")) {
          diagnostic(draft.sourceFile, property, "metadata.invalid-port-operation", `Port operation '${draft.symbolName}.${name}' requires literal id and kind.`);
          continue;
        }
        const checker = checkerFor(property.name);
        const symbol = unalias(checker, checker.getSymbolAtLocation(property.name));
        const operation: PortOperationDraft = {
          name,
          id: operationId,
          kind: kind as PortOperationDraft["kind"],
          source: sourceLocation(rootDir, draft.sourceFile, property.name),
          qualifiedName: `${draft.symbolName}.operations.${name}`,
          ...(symbol === undefined ? {} : { symbol }),
        };
        operations.push(operation);
        if (symbol !== undefined) portOperationBySymbol.set(symbol, operation);
        portOperationByText.set(operation.qualifiedName, operation);
        // Retain the pre-Phase-3 shorthand for diagnostics/older source fixtures,
        // while indexing the real core API shape above.
        portOperationByText.set(`${draft.symbolName}.${name}`, operation);
      }
    }
    ports.push({
      id: ids.get(draft) as string,
      symbol: draft.symbolName,
      source: draft.source,
      operations: operations
        .map(({ symbol: _symbol, qualifiedName: _qualifiedName, ...operation }) => operation)
        .sort((left, right) => compare(left.id, right.id)),
    });
  }

  const events: IndexedEvent[] = drafts
    .filter((draft) => draft.kind === "event" && ids.has(draft))
    .map((draft) => {
      const version = numberLiteral(propertyExpression(draft.object, "version"));
      return {
        id: ids.get(draft) as string,
        symbol: draft.symbolName,
        source: draft.source,
        ...(version === undefined ? {} : { version }),
      };
    })
    .sort((left, right) => compare(left.id, right.id));

  const operationDrafts = drafts.filter(
    (draft): draft is Draft & { kind: "command" | "query" } =>
      (draft.kind === "command" || draft.kind === "query") && ids.has(draft),
  );
  const operationsMutable: IndexedOperation[] = [];
  for (const draft of operationDrafts) {
    const effectsObject = objectExpression(draft.object, "effects");
    const effects: IndexedEffect[] = [];
    if (effectsObject !== undefined) {
      for (const property of effectsObject.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        const expression = initializerForProperty(property);
        if (name === undefined || expression === undefined) continue;
        const symbol = expressionSymbol(checkerFor(expression), expression);
        const resolved = symbol === undefined ? undefined : portOperationBySymbol.get(symbol);
        const fallback = portOperationByText.get(expressionText(expression));
        const portOperation = resolved ?? fallback;
        effects.push({
          name,
          reference: expressionText(expression),
          ...(portOperation === undefined
            ? {}
            : { operationId: portOperation.id, kind: portOperation.kind }),
        });
        if (portOperation === undefined) {
          unresolved.push(`${draft.source.file}:${draft.source.line}: unresolved effect ${expressionText(expression)}`);
        }
      }
    }
    const eventIds = arrayExpressions(draft.object, "events").map((expression) => ids.get(resolveDraft(expression) as Draft) ?? expressionText(expression));
    const emits = objectExpression(draft.object, "emits");
    if (emits !== undefined) {
      for (const property of emits.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const expression = initializerForProperty(property);
        if (expression === undefined) continue;
        eventIds.push(ids.get(resolveDraft(expression) as Draft) ?? expressionText(expression));
      }
    }
    const invariantIds = arrayExpressions(draft.object, "invariants").map((expression) => ids.get(resolveDraft(expression) as Draft) ?? expressionText(expression));
    const permissions = arrayExpressions(draft.object, "permissions").map((expression) => {
      const value = stringLiteral(expression);
      if (value === undefined) {
        diagnostic(draft.sourceFile, expression, "metadata.literal-permission-required", `Operation '${ids.get(draft)}' has a non-literal permission.`);
        return expressionText(expression);
      }
      return value;
    });
    if (draft.kind === "query") {
      for (const effect of effects.filter((candidate) => candidate.kind === "write")) {
        diagnostic(draft.sourceFile, effectsObject ?? draft.object, "operation.query-write-effect", `Query '${ids.get(draft)}' declares write effect '${effect.operationId ?? effect.reference}'.`);
      }
      if (eventIds.length > 0) {
        diagnostic(draft.sourceFile, emits ?? draft.object, "operation.query-emits-event", `Query '${ids.get(draft)}' must not emit domain events.`);
      }
    }
    const errorsObject = objectExpression(draft.object, "errors");
    const errors = errorsObject === undefined
      ? []
      : errorsObject.properties
          .map((property) => "name" in property ? propertyName(property.name) : undefined)
          .filter((name): name is string => name !== undefined);
    const segment = featureSegment(rootDir, draft.sourceFile.fileName);
    const input = propertyExpression(draft.object, "input");
    const output = propertyExpression(draft.object, "output");
    operationsMutable.push({
      id: ids.get(draft) as string,
      symbol: draft.symbolName,
      kind: draft.kind,
      ...(segment === undefined ? {} : { feature: featureIdsBySegment.get(segment) ?? segment }),
      source: draft.source,
      ...(input === undefined ? {} : { input: expressionText(input) }),
      ...(output === undefined ? {} : { output: expressionText(output) }),
      errors: uniqueSorted(errors),
      permissions: uniqueSorted(permissions),
      effects: effects.sort((left, right) => compare(left.name, right.name)),
      events: uniqueSorted(eventIds),
      invariants: uniqueSorted(invariantIds),
      tests: [],
    });
  }

  const invariantDrafts = drafts.filter((draft) => draft.kind === "invariant" && ids.has(draft));
  const invariantsMutable: IndexedInvariant[] = invariantDrafts.map((draft) => {
    const segment = featureSegment(rootDir, draft.sourceFile.fileName);
    const dependencies = arrayExpressions(draft.object, "dependsOn")
      .map(featureForExpression)
      .filter((id): id is string => id !== undefined);
    return {
      id: ids.get(draft) as string,
      symbol: draft.symbolName,
      ...(segment === undefined ? {} : { feature: featureIdsBySegment.get(segment) ?? segment }),
      source: draft.source,
      dependencies: uniqueSorted(dependencies),
      preservers: [],
      tests: [],
    };
  });
  const invariantById = new Map(invariantsMutable.map((invariant) => [invariant.id, invariant]));
  for (const operation of operationsMutable) {
    for (const invariantId of operation.invariants) {
      const invariant = invariantById.get(invariantId);
      if (invariant !== undefined) {
        (invariant.preservers as string[]).push(operation.id);
      }
    }
  }

  const testsMutable: IndexedTest[] = [];
  for (const sourceFile of sourceFiles.filter(
    (candidate) =>
      /\.(?:agent-test|test|spec)\.[cm]?tsx?$/u.test(candidate.fileName) &&
      featureSegment(rootDir, candidate.fileName) !== undefined,
  )) {
    const associated = new Set<string>();
    const imports = canonicalImports(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && testCalls.has(calledName(node, imports) ?? "")) {
        const expressions: ts.Expression[] = [];
        for (const argument of node.arguments) {
          const unwrapped = unwrap(argument);
          if (ts.isObjectLiteralExpression(unwrapped)) {
            for (const key of ["operation", "command", "query"]) {
              const expression = propertyExpression(unwrapped, key);
              if (expression !== undefined) expressions.push(expression);
            }
          } else {
            expressions.push(unwrapped);
          }
        }
        for (const expression of expressions) {
          const draft = resolveDraft(expression);
          if (draft !== undefined && (draft.kind === "command" || draft.kind === "query")) {
            const id = ids.get(draft);
            if (id !== undefined) associated.add(id);
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
    const segment = featureSegment(rootDir, sourceFile.fileName);
    const feature = segment === undefined ? undefined : featureIdsBySegment.get(segment) ?? segment;
    if (associated.size === 0 && feature !== undefined) {
      for (const operation of operationsMutable.filter((candidate) => candidate.feature === feature)) {
        associated.add(operation.id);
      }
    }
    const id = repositoryPath(rootDir, sourceFile.fileName);
    testsMutable.push({
      id,
      source: sourceLocation(rootDir, sourceFile, sourceFile),
      operations: uniqueSorted(associated),
      features: feature === undefined ? [] : [feature],
    });
  }
  const testByOperation = new Map<string, string[]>();
  for (const test of testsMutable) {
    for (const operation of test.operations) {
      const values = testByOperation.get(operation) ?? [];
      values.push(test.id);
      testByOperation.set(operation, values);
    }
  }
  const operations = operationsMutable
    .map((operation) => ({ ...operation, tests: uniqueSorted(testByOperation.get(operation.id) ?? []) }))
    .sort((left, right) => compare(left.id, right.id));
  const invariants = invariantsMutable
    .map((invariant) => ({
      ...invariant,
      preservers: uniqueSorted(invariant.preservers),
      tests: uniqueSorted(invariant.preservers.flatMap((operation) => testByOperation.get(operation) ?? [])),
    }))
    .sort((left, right) => compare(left.id, right.id));

  const dependencyMap = new Map<string, Set<string>>();
  for (const draft of featureDrafts) {
    const id = ids.get(draft) as string;
    dependencyMap.set(
      id,
      new Set(
        arrayExpressions(draft.object, "dependencies")
          .map(featureForExpression)
          .filter((dependency): dependency is string => dependency !== undefined),
      ),
    );
  }
  const consumerMap = new Map<string, Set<string>>();
  for (const [feature, dependencies] of dependencyMap) {
    for (const dependency of dependencies) {
      const consumers = consumerMap.get(dependency) ?? new Set<string>();
      consumers.add(feature);
      consumerMap.set(dependency, consumers);
    }
  }
  const features: IndexedFeature[] = featureDrafts
    .map((draft): IndexedFeature => {
      const id = ids.get(draft) as string;
      const contractExpression = propertyExpression(draft.object, "contract");
      const contractSourceFile = contractExpression === undefined
        ? undefined
        : symbolSource(expressionSymbol(checkerFor(contractExpression), contractExpression));
      const contract: IndexedFeature["contract"] = contractSourceFile === undefined
        ? {
            expression: contractExpression === undefined ? "" : expressionText(contractExpression),
            exports: [],
          }
        : {
            expression: contractExpression === undefined ? "" : expressionText(contractExpression),
            source: sourceLocation(
              rootDir,
              contractSourceFile,
              expressionSymbol(checkerFor(contractExpression as ts.Expression), contractExpression as ts.Expression)?.declarations[0]?.resolve() ?? contractSourceFile,
            ),
            exports: exportedNames(contractSourceFile),
          };
      return {
        id,
        symbol: draft.symbolName,
        source: draft.source,
        contract,
        dependencies: uniqueSorted(dependencyMap.get(id) ?? []),
        consumers: uniqueSorted(consumerMap.get(id) ?? []),
        operations: uniqueSorted(operations.filter((operation) => operation.feature === id).map((operation) => operation.id)),
        invariants: uniqueSorted(invariants.filter((invariant) => invariant.feature === id).map((invariant) => invariant.id)),
        tests: uniqueSorted(testsMutable.filter((test) => test.features.includes(id)).map((test) => test.id)),
      };
    })
    .sort((left, right) => compare(left.id, right.id));

  const architecture = architectureDiagnostics(rootDir, sourceFiles, featureIdsBySegment, dependencyMap);
  diagnostics.push(...architecture.diagnostics);
  unresolved.push(...architecture.unresolved);

  const edges: GraphEdge[] = [];
  for (const feature of features) {
    for (const dependency of feature.dependencies) {
      edges.push({ from: feature.id, to: dependency, kind: "feature-dependency", reason: `${feature.id} depends on public contract ${dependency}` });
    }
    for (const operation of feature.operations) {
      edges.push({ from: feature.id, to: operation, kind: "feature-operation", reason: `${feature.id} owns operation ${operation}` });
    }
  }
  for (const operation of operations) {
    for (const effect of operation.effects) {
      const target = effect.operationId ?? effect.reference;
      edges.push({ from: operation.id, to: target, kind: "operation-effect", reason: `${operation.id} declares effect ${target}` });
    }
    for (const event of operation.events) {
      edges.push({ from: operation.id, to: event, kind: "operation-event", reason: `${operation.id} declares event ${event}` });
    }
    for (const invariant of operation.invariants) {
      edges.push({ from: operation.id, to: invariant, kind: "operation-invariant", reason: `${operation.id} preserves invariant ${invariant}` });
    }
    for (const test of operation.tests) {
      edges.push({ from: operation.id, to: test, kind: "operation-test", reason: `${operation.id} is associated with test ${test}` });
    }
  }
  for (const invariant of invariants) {
    for (const dependency of invariant.dependencies) {
      edges.push({ from: invariant.id, to: dependency, kind: "invariant-dependency", reason: `${invariant.id} depends on public contract ${dependency}` });
    }
  }
  edges.sort((left, right) => compare(left.from, right.from) || compare(left.to, right.to) || compare(left.kind, right.kind));

  const index: AgentIndex = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    sourceManifest: createSourceManifest(rootDir, files),
    features,
    operations,
    ports: ports.sort((left, right) => compare(left.id, right.id)),
    events,
    invariants,
    tests: testsMutable.sort((left, right) => compare(left.id, right.id)),
    edges,
    likelyAffected: likelyAffected(features, operations, ports, events, invariants),
    diagnostics: sortDiagnostics(diagnostics),
    unresolved: uniqueSorted(unresolved),
  };
  snapshot.dispose();
  api.close();
  return index;
};
