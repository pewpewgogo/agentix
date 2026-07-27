import { dirname, extname, resolve } from "node:path";

import * as ts from "typescript/unstable/ast";

import {
  compareStrings as compare,
  createSourceManifest,
  discoverSourceFiles,
  featureSegmentOf,
  repositoryPath,
} from "./files.js";
import { API, SymbolFlags, type Checker, type TypeScriptSymbol } from "./ts.js";
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
  type IndexedHttp,
  type IndexedOperation,
  type IndexedOperationError,
  type IndexedPort,
  type IndexedPortOperation,
  type IndexedTest,
  type SchemaExcerpt,
  type SourceLocation,
} from "./types.js";

const EXCERPT_LIMIT = 1024;

const PORT_OP_KINDS = ["read", "write", "time", "random", "external"] as const;
type PortOpKind = (typeof PORT_OP_KINDS)[number];

const testCalls = new Set([
  "associateOperationTest",
  "defineOperationTest",
  "testCommand",
  "testQuery",
]);

type DraftKind = "feature" | "port" | "store" | "event";

interface Draft {
  readonly kind: DraftKind;
  readonly call: ts.CallExpression;
  readonly declaration: ts.VariableDeclaration;
  readonly symbolName: string;
  readonly symbol?: TypeScriptSymbol;
  readonly source: SourceLocation;
  readonly sourceFile: ts.SourceFile;
}

interface PortOperationDraft extends IndexedPortOperation {
  readonly symbol?: TypeScriptSymbol;
}

interface UnboundOperationDraft {
  readonly kind: "command" | "query";
  readonly call: ts.CallExpression;
}

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
  if (ts.isNumericLiteral(name)) return name.text;
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

const boundedText = (text: string): string => {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > EXCERPT_LIMIT
    ? `${collapsed.slice(0, EXCERPT_LIMIT - 1)}…`
    : collapsed;
};

const expressionText = (expression: ts.Expression): string =>
  boundedText(expression.getText(expression.getSourceFile()));

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

interface CalleeDescription {
  readonly name: string;
  readonly namespace?: string;
}

/**
 * Canonical callee for a call expression: `feature(...)` -> {name: "feature"},
 * `port.store(...)` -> {name: "store", namespace: "port"}, resolving import
 * aliases and namespace imports (`ax.feature`, `ax.port.store`).
 */
const calledName = (
  call: ts.CallExpression,
  imports: ReadonlyMap<string, string>,
): CalleeDescription | undefined => {
  const expression = unwrap(call.expression);
  if (ts.isIdentifier(expression)) {
    return { name: imports.get(expression.text) ?? expression.text };
  }
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const base = unwrap(expression.expression);
  if (ts.isIdentifier(base)) {
    const canonical = imports.get(base.text) ?? base.text;
    if (canonical === "*") return { name: expression.name.text };
    return { name: expression.name.text, namespace: canonical };
  }
  if (
    ts.isPropertyAccessExpression(base) &&
    ts.isIdentifier(base.expression) &&
    (imports.get(base.expression.text) ?? base.expression.text) === "*"
  ) {
    return { name: expression.name.text, namespace: base.name.text };
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

const symbolDeclaration = (symbol: TypeScriptSymbol | undefined): ts.Node | undefined =>
  symbol?.declarations[0]?.resolve();

const symbolDeclarationKey = (symbol: TypeScriptSymbol | undefined): string | undefined => {
  const declaration = symbolDeclaration(symbol);
  if (declaration === undefined) return undefined;
  const sourceFile = declaration.getSourceFile();
  return `${resolve(sourceFile.fileName)}:${declaration.getStart(sourceFile)}`;
};

const exportedNames = (sourceFile: ts.SourceFile): string[] => {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const specifier of statement.exportClause.elements) {
        names.push(specifier.name.text);
      }
      continue;
    }
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

interface ArchitectureResult {
  readonly diagnostics: CompilerDiagnostic[];
  readonly unresolved: string[];
  /** Feature id -> feature ids it imports (feature-file imports only). */
  readonly dependencies: Map<string, Set<string>>;
}

const architectureDiagnostics = (
  rootDir: string,
  sourceFiles: readonly ts.SourceFile[],
  featureIds: ReadonlyMap<string, string>,
  featureFileBases: ReadonlySet<string>,
): ArchitectureResult => {
  const diagnostics: CompilerDiagnostic[] = [];
  const unresolved: string[] = [];
  const dependencies = new Map<string, Set<string>>();
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
    const relativeFile = repositoryPath(rootDir, sourceFile.fileName);
    const fromSegment = featureSegmentOf(relativeFile);
    if (fromSegment === undefined) continue;
    const isDomain = !/\.(?:agent-test|test|spec)\.[cm]?tsx?$/u.test(relativeFile);

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
      const targetBase = repositoryPath(rootDir, target);
      const targetSegment = featureSegmentOf(targetBase);
      if (targetSegment === undefined || targetSegment === fromSegment) return;
      const isFeatureFile = featureFileBases.has(targetBase);
      if (isFeatureFile) {
        const fromId = featureIds.get(fromSegment);
        const toId = featureIds.get(targetSegment);
        if (fromId !== undefined && toId !== undefined) {
          const set = dependencies.get(fromId) ?? new Set<string>();
          set.add(toId);
          dependencies.set(fromId, set);
        }
      } else {
        add(
          sourceFile,
          node,
          "architecture.private-cross-feature-import",
          "error",
          `Feature '${featureIds.get(fromSegment) ?? fromSegment}' imports private source from feature '${featureIds.get(targetSegment) ?? targetSegment}'. Import its feature file (the public contract) instead.`,
        );
      }
      if (dynamic && !isFeatureFile) {
        const location = sourceLocation(rootDir, sourceFile, node);
        unresolved.push(`${location.file}:${location.line}: dynamic private cross-feature import '${specifier}'`);
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

  return { diagnostics: sortDiagnostics(diagnostics), unresolved: uniqueSorted(unresolved), dependencies };
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
  const unboundOperations = new Map<string, UnboundOperationDraft>();

  const diagnostic = (
    sourceFile: ts.SourceFile,
    node: ts.Node,
    code: string,
    message: string,
    severity: "error" | "warning" = "error",
  ): void => {
    diagnostics.push({ code, message, severity, source: sourceLocation(rootDir, sourceFile, node) });
  };

  const segmentOf = (sourceFile: ts.SourceFile): string | undefined =>
    featureSegmentOf(repositoryPath(rootDir, sourceFile.fileName));

  /* ------------------------------------------------------------------ */
  /* Pass 1: collect descriptor drafts (feature/port/port.store/event)  */
  /* and standalone command()/query() variable declarations.            */
  /* ------------------------------------------------------------------ */

  for (const sourceFile of sourceFiles) {
    if (segmentOf(sourceFile) === undefined) continue;
    const imports = canonicalImports(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = calledName(node, imports);
        const kind: DraftKind | undefined =
          callee === undefined
            ? undefined
            : callee.namespace === undefined &&
                (callee.name === "feature" || callee.name === "port" || callee.name === "event")
              ? (callee.name as DraftKind)
              : callee.namespace === "port" && callee.name === "store"
                ? "store"
                : undefined;
        if (kind !== undefined) {
          const declaration = variableForCall(node);
          if (declaration === undefined || !ts.isIdentifier(declaration.name)) {
            diagnostic(sourceFile, node, "metadata.static-descriptor-required", `${kind === "store" ? "port.store" : kind} must initialize a named variable.`);
          } else {
            const checker = checkerFor(declaration.name);
            const symbol = unalias(checker, checker.getSymbolAtLocation(declaration.name));
            drafts.push({
              kind,
              call: node,
              declaration,
              symbolName: declaration.name.text,
              ...(symbol === undefined ? {} : { symbol }),
              source: sourceLocation(rootDir, sourceFile, declaration.name),
              sourceFile,
            });
          }
        } else if (
          callee !== undefined &&
          callee.namespace === undefined &&
          (callee.name === "command" || callee.name === "query")
        ) {
          const declaration = variableForCall(node);
          if (declaration !== undefined && ts.isIdentifier(declaration.name)) {
            const checker = checkerFor(declaration.name);
            const symbol = unalias(checker, checker.getSymbolAtLocation(declaration.name));
            const key = symbolDeclarationKey(symbol);
            if (key !== undefined) {
              unboundOperations.set(key, { kind: callee.name, call: node });
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }

  const draftBySymbol = new Map<TypeScriptSymbol, Draft>();
  const draftByDeclaration = new Map<string, Draft>();
  for (const draft of drafts) {
    if (draft.symbol !== undefined) {
      draftBySymbol.set(draft.symbol, draft);
      const key = symbolDeclarationKey(draft.symbol);
      if (key !== undefined) draftByDeclaration.set(key, draft);
    }
  }
  const resolveDraft = (expression: ts.Expression): Draft | undefined => {
    const symbol = expressionSymbol(checkerFor(expression), expression);
    if (symbol === undefined) return undefined;
    const declarationKey = symbolDeclarationKey(symbol);
    return draftBySymbol.get(symbol) ??
      (declarationKey === undefined ? undefined : draftByDeclaration.get(declarationKey));
  };

  /* ------------------------------------------------------------------ */
  /* Ids: literal arg 0 for feature/port/store/event; duplicates.       */
  /* ------------------------------------------------------------------ */

  const ids = new Map<Draft, string>();
  const seenIds = new Map<string, SourceLocation>();
  const registerId = (id: string, sourceFile: ts.SourceFile, node: ts.Node): void => {
    const source = sourceLocation(rootDir, sourceFile, node);
    const previous = seenIds.get(id);
    if (previous !== undefined) {
      diagnostic(sourceFile, node, "metadata.duplicate-id", `Stable id '${id}' is already declared at ${previous.file}:${previous.line}.`);
    } else {
      seenIds.set(id, source);
    }
  };
  for (const draft of drafts) {
    const label = draft.kind === "store" ? "port.store" : draft.kind;
    const id = stringLiteral(draft.call.arguments[0]);
    if (id === undefined) {
      diagnostic(draft.sourceFile, draft.call.arguments[0] ?? draft.call, "metadata.literal-id-required", `${label} '${draft.symbolName}' must declare a string-literal id.`);
      unresolved.push(`${draft.source.file}:${draft.source.line}: non-literal ${label} id`);
      continue;
    }
    registerId(id, draft.sourceFile, draft.declaration.name);
    ids.set(draft, id);
  }

  const featureDrafts = drafts.filter((draft) => draft.kind === "feature" && ids.has(draft));
  const featureIdsBySegment = new Map<string, string>();
  const featureFileBases = new Set<string>();
  const featureIdByFile = new Map<string, string>();
  for (const draft of featureDrafts) {
    const segment = segmentOf(draft.sourceFile);
    const id = ids.get(draft);
    if (id !== undefined) {
      // The feature file IS the public contract, so a file declares exactly
      // one feature(); a second declaration makes imports of the file
      // ambiguous and is an architecture error.
      const previous = featureIdByFile.get(draft.sourceFile.fileName);
      if (previous === undefined) {
        featureIdByFile.set(draft.sourceFile.fileName, id);
      } else {
        diagnostic(draft.sourceFile, draft.declaration.name, "architecture.one-feature-per-file", `Feature '${id}' is declared in a file that already declares feature '${previous}'. Each file must declare exactly one feature().`);
      }
    }
    if (segment !== undefined && id !== undefined) featureIdsBySegment.set(segment, id);
    featureFileBases.add(
      repositoryPath(rootDir, draft.sourceFile.fileName).replace(/\.[cm]?tsx?$/u, ""),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Ports: explicit port(id, {op: port.kind({...})}) and port.store.   */
  /* ------------------------------------------------------------------ */

  const portOperationBySymbol = new Map<TypeScriptSymbol, PortOperationDraft>();
  const portOperationByDeclaration = new Map<string, PortOperationDraft>();
  const portOperationByText = new Map<string, PortOperationDraft>();
  const portOperationsByDraft = new Map<Draft, Map<string, PortOperationDraft>>();
  const ports: IndexedPort[] = [];

  const registerPortOperation = (
    draft: Draft,
    operation: PortOperationDraft,
  ): void => {
    const byName = portOperationsByDraft.get(draft) ?? new Map<string, PortOperationDraft>();
    byName.set(operation.name, operation);
    portOperationsByDraft.set(draft, byName);
    if (operation.symbol !== undefined) {
      portOperationBySymbol.set(operation.symbol, operation);
      const key = symbolDeclarationKey(operation.symbol);
      if (key !== undefined) portOperationByDeclaration.set(key, operation);
    }
    portOperationByText.set(`${draft.symbolName}.${operation.name}`, operation);
    portOperationByText.set(`${draft.symbolName}.operations.${operation.name}`, operation);
  };

  for (const draft of drafts.filter((candidate) => candidate.kind === "port" && ids.has(candidate))) {
    const portId = ids.get(draft) as string;
    const imports = canonicalImports(draft.sourceFile);
    const definition = draft.call.arguments[1];
    const object = definition === undefined ? undefined : unwrap(definition);
    const operations: PortOperationDraft[] = [];
    if (object === undefined || !ts.isObjectLiteralExpression(object)) {
      diagnostic(draft.sourceFile, definition ?? draft.call, "metadata.static-object-required", `port '${draft.symbolName}' requires a static operations object literal.`);
      unresolved.push(`${draft.source.file}:${draft.source.line}: non-static port operations`);
    } else {
      for (const property of object.properties) {
        const name = "name" in property ? propertyName(property.name) : undefined;
        if (
          (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
          name === undefined
        ) {
          // Spread or computed members hide operations from static analysis;
          // diagnose and widen conservatively instead of dropping them.
          const location = sourceLocation(rootDir, draft.sourceFile, property);
          diagnostic(draft.sourceFile, property, "metadata.static-operation-required", `port '${draft.symbolName}' declares an operation through a spread or computed member; every port operation needs a static literal key.`);
          unresolved.push(`${location.file}:${location.line}: non-static port operation in '${portId}'`);
          continue;
        }
        const initializer = initializerForProperty(property);
        const callee =
          initializer !== undefined && ts.isCallExpression(initializer)
            ? calledName(initializer, imports)
            : undefined;
        const kind =
          callee?.namespace === "port" && (PORT_OP_KINDS as readonly string[]).includes(callee.name)
            ? (callee.name as PortOpKind)
            : undefined;
        if (kind === undefined) {
          diagnostic(draft.sourceFile, property, "metadata.invalid-port-operation", `Port operation '${draft.symbolName}.${name}' must be created with port.read/write/time/random/external.`);
          continue;
        }
        const checker = checkerFor(property.name);
        const symbol = unalias(checker, checker.getSymbolAtLocation(property.name));
        const operationId = `${portId}.${name}`;
        registerId(operationId, draft.sourceFile, property.name);
        const operation: PortOperationDraft = {
          name,
          id: operationId,
          kind,
          source: sourceLocation(rootDir, draft.sourceFile, property.name),
          signature: boundedText(property.getText(draft.sourceFile)),
          ...(symbol === undefined ? {} : { symbol }),
        };
        operations.push(operation);
        registerPortOperation(draft, operation);
      }
    }
    const segment = segmentOf(draft.sourceFile);
    ports.push({
      id: portId,
      symbol: draft.symbolName,
      ...(segment === undefined ? {} : { feature: featureIdsBySegment.get(segment) ?? segment }),
      source: draft.source,
      operations: operations
        .map(({ symbol: _symbol, ...operation }) => operation)
        .sort((left, right) => compare(left.id, right.id)),
    });
  }

  const STORE_OPERATIONS: readonly { name: string; kind: PortOpKind }[] = [
    { name: "get", kind: "read" },
    { name: "save", kind: "write" },
    { name: "delete", kind: "write" },
    { name: "list", kind: "read" },
  ];
  for (const draft of drafts.filter((candidate) => candidate.kind === "store" && ids.has(candidate))) {
    const portId = ids.get(draft) as string;
    const signature = boundedText(draft.call.getText(draft.sourceFile));
    const operations: PortOperationDraft[] = STORE_OPERATIONS.map(({ name, kind }) => ({
      name,
      id: `${portId}.${name}`,
      kind,
      source: draft.source,
      signature,
    }));
    for (const operation of operations) {
      registerId(operation.id, draft.sourceFile, draft.declaration.name);
      registerPortOperation(draft, operation);
    }
    const segment = segmentOf(draft.sourceFile);
    ports.push({
      id: portId,
      symbol: draft.symbolName,
      ...(segment === undefined ? {} : { feature: featureIdsBySegment.get(segment) ?? segment }),
      source: draft.source,
      operations: operations
        .map(({ symbol: _symbol, ...operation }) => operation)
        .sort((left, right) => compare(left.id, right.id)),
    });
  }

  const resolvePortOperation = (expression: ts.Expression): PortOperationDraft | undefined => {
    const unwrapped = unwrap(expression);
    const symbol = expressionSymbol(checkerFor(unwrapped), unwrapped);
    if (symbol !== undefined) {
      const direct = portOperationBySymbol.get(symbol);
      if (direct !== undefined) return direct;
      const key = symbolDeclarationKey(symbol);
      const byDeclaration = key === undefined ? undefined : portOperationByDeclaration.get(key);
      if (byDeclaration !== undefined) return byDeclaration;
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const name = unwrapped.name.text;
      let base = unwrap(unwrapped.expression);
      if (ts.isPropertyAccessExpression(base) && base.name.text === "operations") {
        base = unwrap(base.expression);
      }
      const draft = resolveDraft(base);
      if (draft !== undefined && (draft.kind === "port" || draft.kind === "store")) {
        const operation = portOperationsByDraft.get(draft)?.get(name);
        if (operation !== undefined) return operation;
      }
    }
    return portOperationByText.get(expressionText(unwrapped));
  };

  /* ------------------------------------------------------------------ */
  /* Events: event(id, version, payload) — positional.                  */
  /* ------------------------------------------------------------------ */

  const eventDrafts = drafts.filter((draft) => draft.kind === "event" && ids.has(draft));
  const events: IndexedEvent[] = eventDrafts
    .map((draft) => {
      const version = numberLiteral(draft.call.arguments[1]);
      const segment = segmentOf(draft.sourceFile);
      return {
        id: ids.get(draft) as string,
        symbol: draft.symbolName,
        ...(version === undefined ? {} : { version }),
        ...(segment === undefined ? {} : { feature: featureIdsBySegment.get(segment) ?? segment }),
        source: draft.source,
      };
    })
    .sort((left, right) => compare(left.id, right.id));

  /* ------------------------------------------------------------------ */
  /* Excerpts: bounded schema declaration text and execute signatures.  */
  /* ------------------------------------------------------------------ */

  const schemaExcerpt = (expression: ts.Expression): SchemaExcerpt => {
    const unwrapped = unwrap(expression);
    const text = expressionText(unwrapped);
    if (!ts.isIdentifier(unwrapped) && !ts.isPropertyAccessExpression(unwrapped)) {
      return { text };
    }
    const declaration = symbolDeclaration(expressionSymbol(checkerFor(unwrapped), unwrapped));
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return { text };
    const declarationFile = declaration.getSourceFile();
    const repoFile = repositoryPath(rootDir, declarationFile.fileName);
    if (repoFile.startsWith("..")) return { text };
    return {
      text,
      declaration: boundedText(declaration.getText(declarationFile)),
      source: sourceLocation(rootDir, declarationFile, declaration),
    };
  };

  const detailsText = (expression: ts.Expression): string => {
    const excerpt = schemaExcerpt(expression);
    return excerpt.declaration ?? excerpt.text;
  };

  const signatureBeforeBody = (
    node: ts.Node,
    body: ts.Node | undefined,
    sourceFile: ts.SourceFile,
  ): string => {
    const text = node.getText(sourceFile);
    const sliced = body === undefined
      ? text
      : text.slice(0, body.getStart(sourceFile) - node.getStart(sourceFile));
    return boundedText(sliced).replace(/\s*(?:=>|\{)?\s*$/u, "");
  };

  const executeSignature = (
    object: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
  ): string | undefined => {
    const property = getProperty(object, "execute");
    if (property === undefined) return undefined;
    if (ts.isMethodDeclaration(property)) {
      return signatureBeforeBody(property, property.body, sourceFile);
    }
    if (ts.isPropertyAssignment(property)) {
      const initializer = unwrap(property.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        return `execute: ${signatureBeforeBody(initializer, initializer.body, sourceFile)}`;
      }
    }
    return undefined;
  };

  /* ------------------------------------------------------------------ */
  /* Operations: iterate each feature's `operations` object literal.    */
  /* ------------------------------------------------------------------ */

  const operationBySymbol = new Map<TypeScriptSymbol, string>();
  const operationByDeclaration = new Map<string, string>();
  const operationByText = new Map<string, string>();
  const operationKeysByFeatureDraft = new Map<Draft, Map<string, string>>();
  const operationsMutable: IndexedOperation[] = [];
  const featureEventIds = new Map<Draft, string[]>();

  for (const draft of featureDrafts) {
    const featureId = ids.get(draft) as string;
    const imports = canonicalImports(draft.sourceFile);
    const definitionArgument = draft.call.arguments[1];
    const definition = definitionArgument === undefined ? undefined : unwrap(definitionArgument);
    if (definition === undefined || !ts.isObjectLiteralExpression(definition)) {
      diagnostic(draft.sourceFile, definitionArgument ?? draft.call, "metadata.static-object-required", `feature '${draft.symbolName}' requires a static definition object literal.`);
      unresolved.push(`${draft.source.file}:${draft.source.line}: non-static feature definition`);
      continue;
    }

    featureEventIds.set(
      draft,
      arrayExpressions(definition, "events").map((expression) => {
        const resolved = resolveDraft(expression);
        return (resolved !== undefined ? ids.get(resolved) : undefined) ?? expressionText(expression);
      }),
    );

    const operationsExpression = propertyExpression(definition, "operations");
    if (operationsExpression === undefined || !ts.isObjectLiteralExpression(operationsExpression)) {
      diagnostic(draft.sourceFile, operationsExpression ?? definition, "metadata.static-operation-required", `feature '${featureId}' requires a static operations object literal.`);
      unresolved.push(`${draft.source.file}:${draft.source.line}: non-static feature operations`);
      continue;
    }

    const keyMap = new Map<string, string>();
    operationKeysByFeatureDraft.set(draft, keyMap);

    for (const property of operationsExpression.properties) {
      const key = "name" in property ? propertyName(property.name) : undefined;
      if (
        (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
        key === undefined
      ) {
        // Spread or computed members serve operations at runtime that the
        // index cannot see; diagnose and widen instead of omitting silently.
        const location = sourceLocation(rootDir, draft.sourceFile, property);
        diagnostic(draft.sourceFile, property, "metadata.static-operation-required", `feature '${featureId}' declares an operation through a spread or computed member; every operation needs a static literal key with a command() or query() value.`);
        unresolved.push(`${location.file}:${location.line}: non-static operation member in feature '${featureId}'`);
        continue;
      }
      const operationId = `${featureId}.${key}`;
      const propertySource = sourceLocation(rootDir, draft.sourceFile, property.name);

      let initializer = initializerForProperty(property);
      let kind: "command" | "query" | undefined;
      let call: ts.CallExpression | undefined;
      if (initializer !== undefined && ts.isCallExpression(initializer)) {
        const callee = calledName(initializer, imports);
        if (callee?.namespace === undefined && (callee?.name === "command" || callee?.name === "query")) {
          kind = callee.name;
          call = initializer;
        }
      } else if (initializer !== undefined && ts.isIdentifier(initializer)) {
        const checker = checkerFor(initializer);
        const symbol = ts.isShorthandPropertyAssignment(property)
          ? unalias(checker, checker.getShorthandAssignmentValueSymbol(property))
          : expressionSymbol(checker, initializer);
        const declarationKey = symbolDeclarationKey(symbol);
        const standalone = declarationKey === undefined ? undefined : unboundOperations.get(declarationKey);
        if (standalone !== undefined) {
          kind = standalone.kind;
          call = standalone.call;
        }
      }
      const objectArgument = call?.arguments[0];
      const object = objectArgument === undefined ? undefined : unwrap(objectArgument);
      if (kind === undefined || call === undefined || object === undefined || !ts.isObjectLiteralExpression(object)) {
        diagnostic(draft.sourceFile, property, "metadata.static-operation-required", `Operation '${operationId}' must be a static command() or query() call.`);
        unresolved.push(`${propertySource.file}:${propertySource.line}: non-static operation '${operationId}'`);
        continue;
      }

      registerId(operationId, draft.sourceFile, property.name);
      keyMap.set(key, operationId);
      const checker = checkerFor(property.name);
      const propertySymbol = unalias(checker, checker.getSymbolAtLocation(property.name));
      if (propertySymbol !== undefined) {
        operationBySymbol.set(propertySymbol, operationId);
        const declarationKey = symbolDeclarationKey(propertySymbol);
        if (declarationKey !== undefined) operationByDeclaration.set(declarationKey, operationId);
      }
      if (initializer !== undefined && ts.isIdentifier(initializer)) {
        const standaloneSymbol = expressionSymbol(checkerFor(initializer), initializer);
        if (standaloneSymbol !== undefined) operationBySymbol.set(standaloneSymbol, operationId);
      }
      operationByText.set(`${draft.symbolName}.operations.${key}`, operationId);

      const operationFile = call.getSourceFile();

      // Effects: `{ alias: Port.opName }` property accesses.
      const effectsObject = objectExpression(object, "effects");
      const effects: IndexedEffect[] = [];
      if (effectsObject !== undefined) {
        for (const effectProperty of effectsObject.properties) {
          if (!ts.isPropertyAssignment(effectProperty) && !ts.isShorthandPropertyAssignment(effectProperty)) {
            // A spread hides operation-effect edges; record it as unresolved
            // so the owning feature's subgraph widens conservatively.
            diagnostic(draft.sourceFile, effectProperty, "metadata.static-effect-required", `Operation '${operationId}' declares effects through a spread or non-static member; the hidden effects widen verification to the owning feature.`, "warning");
            unresolved.push(`${propertySource.file}:${propertySource.line}: unresolved effects spread in operation '${operationId}'`);
            continue;
          }
          const effectName = propertyName(effectProperty.name);
          const expression = initializerForProperty(effectProperty);
          if (effectName === undefined || expression === undefined) {
            diagnostic(draft.sourceFile, effectProperty, "metadata.static-effect-required", `Operation '${operationId}' declares an effect with a computed key; every effect needs a static literal key.`, "warning");
            unresolved.push(`${propertySource.file}:${propertySource.line}: non-static effect in operation '${operationId}'`);
            continue;
          }
          const portOperation = resolvePortOperation(expression);
          effects.push({
            name: effectName,
            reference: expressionText(expression),
            ...(portOperation === undefined
              ? {}
              : { operationId: portOperation.id, kind: portOperation.kind }),
          });
          if (portOperation === undefined) {
            unresolved.push(`${propertySource.file}:${propertySource.line}: unresolved effect ${expressionText(expression)}`);
          }
        }
      }

      // Emits: `{ alias: EventDescriptor }`.
      const eventIds: string[] = [];
      const emits = objectExpression(object, "emits");
      if (emits !== undefined) {
        for (const emitProperty of emits.properties) {
          if (!ts.isPropertyAssignment(emitProperty) && !ts.isShorthandPropertyAssignment(emitProperty)) {
            diagnostic(draft.sourceFile, emitProperty, "metadata.static-emit-required", `Operation '${operationId}' declares emits through a spread or non-static member; the hidden events widen verification to the owning feature.`, "warning");
            unresolved.push(`${propertySource.file}:${propertySource.line}: unresolved emits spread in operation '${operationId}'`);
            continue;
          }
          const expression = initializerForProperty(emitProperty);
          if (expression === undefined) continue;
          const resolved = resolveDraft(expression);
          eventIds.push((resolved !== undefined ? ids.get(resolved) : undefined) ?? expressionText(expression));
        }
      }

      const ensuresObject = objectExpression(object, "ensures");
      const ensures = ensuresObject === undefined
        ? []
        : ensuresObject.properties
            .map((ensureProperty) => "name" in ensureProperty ? propertyName(ensureProperty.name) : undefined)
            .filter((name): name is string => name !== undefined);

      const permissions = arrayExpressions(object, "permissions").map((expression) => {
        const value = stringLiteral(expression);
        if (value === undefined) {
          diagnostic(draft.sourceFile, expression, "metadata.literal-permission-required", `Operation '${operationId}' has a non-literal permission.`);
          return expressionText(expression);
        }
        return value;
      });

      if (kind === "query") {
        for (const effect of effects.filter((candidate) => candidate.kind === "write")) {
          diagnostic(draft.sourceFile, effectsObject ?? object, "operation.query-write-effect", `Query '${operationId}' declares write effect '${effect.operationId ?? effect.reference}'.`);
        }
        if (eventIds.length > 0) {
          diagnostic(draft.sourceFile, emits ?? object, "operation.query-emits-event", `Query '${operationId}' must not emit domain events.`);
        }
      }

      // Unified errors: `{ CODE: { http?, details? } }` or bare schema.
      const errorsObject = objectExpression(object, "errors");
      const errors: IndexedOperationError[] = [];
      if (errorsObject !== undefined) {
        for (const errorProperty of errorsObject.properties) {
          if (!("name" in errorProperty)) continue;
          const code = propertyName(errorProperty.name);
          if (code === undefined) continue;
          const initializerExpression = initializerForProperty(errorProperty);
          if (initializerExpression === undefined) {
            errors.push({ code });
            continue;
          }
          const spec = unwrap(initializerExpression);
          if (
            ts.isObjectLiteralExpression(spec) &&
            (getProperty(spec, "http") !== undefined || getProperty(spec, "details") !== undefined)
          ) {
            const http = numberLiteral(propertyExpression(spec, "http"));
            const detailsExpression = propertyExpression(spec, "details");
            errors.push({
              code,
              ...(http === undefined ? {} : { http }),
              ...(detailsExpression === undefined ? {} : { details: detailsText(detailsExpression) }),
            });
          } else {
            errors.push({ code, details: detailsText(spec) });
          }
        }
      }
      errors.sort((left, right) => compare(left.code, right.code));

      // HTTP metadata with derived per-error statuses.
      let http: IndexedHttp | undefined;
      const httpObject = objectExpression(object, "http");
      if (httpObject !== undefined) {
        const method = stringLiteral(propertyExpression(httpObject, "method"));
        const path = stringLiteral(propertyExpression(httpObject, "path"));
        const status = numberLiteral(propertyExpression(httpObject, "status"));
        if (method === undefined || path === undefined) {
          diagnostic(draft.sourceFile, httpObject, "metadata.literal-http-required", `Operation '${operationId}' http metadata requires literal method and path.`);
        } else {
          const errorStatus: Record<string, number> = {};
          for (const error of errors) {
            if (error.http !== undefined) errorStatus[error.code] = error.http;
          }
          http = {
            method,
            path,
            ...(status === undefined ? {} : { status }),
            errorStatus,
          };
        }
      }

      const input = propertyExpression(object, "input");
      const output = propertyExpression(object, "output");
      const signature = executeSignature(object, operationFile);
      operationsMutable.push({
        id: operationId,
        key,
        symbol: `${draft.symbolName}.operations.${key}`,
        kind,
        feature: featureId,
        source: propertySource,
        ...(input === undefined ? {} : { input: schemaExcerpt(input) }),
        ...(output === undefined ? {} : { output: schemaExcerpt(output) }),
        errors,
        ...(http === undefined ? {} : { http }),
        permissions: uniqueSorted(permissions),
        effects: effects.sort((left, right) => compare(left.name, right.name)),
        events: uniqueSorted(eventIds),
        ensures: uniqueSorted(ensures),
        ...(signature === undefined ? {} : { executeSignature: signature }),
        tests: [],
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tests: markers first, then feature-segment fallback.               */
  /* ------------------------------------------------------------------ */

  const knownOperationIds = new Set(operationsMutable.map((operation) => operation.id));
  const resolveOperationReference = (expression: ts.Expression): string | undefined => {
    const unwrapped = unwrap(expression);
    const literal = stringLiteral(unwrapped);
    if (literal !== undefined) {
      return knownOperationIds.has(literal) ? literal : undefined;
    }
    const symbol = expressionSymbol(checkerFor(unwrapped), unwrapped);
    if (symbol !== undefined) {
      const direct = operationBySymbol.get(symbol);
      if (direct !== undefined) return direct;
      const declarationKey = symbolDeclarationKey(symbol);
      const byDeclaration = declarationKey === undefined ? undefined : operationByDeclaration.get(declarationKey);
      if (byDeclaration !== undefined) return byDeclaration;
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const key = unwrapped.name.text;
      let base = unwrap(unwrapped.expression);
      if (ts.isPropertyAccessExpression(base) && base.name.text === "operations") {
        base = unwrap(base.expression);
      }
      const draft = resolveDraft(base);
      if (draft !== undefined && draft.kind === "feature") {
        const resolved = operationKeysByFeatureDraft.get(draft)?.get(key);
        if (resolved !== undefined) return resolved;
      }
    }
    return operationByText.get(expressionText(unwrapped));
  };

  const testsMutable: IndexedTest[] = [];
  for (const sourceFile of sourceFiles.filter(
    (candidate) => /\.(?:agent-test|test|spec)\.[cm]?tsx?$/u.test(candidate.fileName),
  )) {
    const associated = new Set<string>();
    const imports = canonicalImports(sourceFile);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && testCalls.has(calledName(node, imports)?.name ?? "")) {
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
          const id = resolveOperationReference(expression);
          if (id !== undefined) associated.add(id);
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
    const segment = segmentOf(sourceFile);
    const feature = segment === undefined ? undefined : featureIdsBySegment.get(segment) ?? segment;
    if (associated.size === 0 && feature !== undefined) {
      for (const operation of operationsMutable.filter((candidate) => candidate.feature === feature)) {
        associated.add(operation.id);
      }
    }
    if (associated.size === 0 && feature === undefined) continue;
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

  /* ------------------------------------------------------------------ */
  /* Architecture: the feature file IS the public contract.             */
  /* ------------------------------------------------------------------ */

  const architecture = architectureDiagnostics(
    rootDir,
    sourceFiles,
    featureIdsBySegment,
    featureFileBases,
  );
  diagnostics.push(...architecture.diagnostics);
  unresolved.push(...architecture.unresolved);

  const consumerMap = new Map<string, Set<string>>();
  for (const [feature, dependencies] of architecture.dependencies) {
    for (const dependency of dependencies) {
      const consumers = consumerMap.get(dependency) ?? new Set<string>();
      consumers.add(feature);
      consumerMap.set(dependency, consumers);
    }
  }

  const features: IndexedFeature[] = featureDrafts
    .map((draft): IndexedFeature => {
      const id = ids.get(draft) as string;
      return {
        id,
        symbol: draft.symbolName,
        source: draft.source,
        exports: exportedNames(draft.sourceFile),
        dependencies: uniqueSorted(architecture.dependencies.get(id) ?? []),
        consumers: uniqueSorted(consumerMap.get(id) ?? []),
        operations: uniqueSorted(operations.filter((operation) => operation.feature === id).map((operation) => operation.id)),
        events: uniqueSorted(featureEventIds.get(draft) ?? []),
        tests: uniqueSorted(testsMutable.filter((test) => test.features.includes(id)).map((test) => test.id)),
      };
    })
    .sort((left, right) => compare(left.id, right.id));

  /* ------------------------------------------------------------------ */
  /* Graph edges.                                                       */
  /* ------------------------------------------------------------------ */

  const edges: GraphEdge[] = [];
  for (const feature of features) {
    for (const dependency of feature.dependencies) {
      edges.push({ from: feature.id, to: dependency, kind: "feature-dependency", reason: `${feature.id} imports the feature file of ${dependency}` });
    }
    for (const operation of feature.operations) {
      edges.push({ from: feature.id, to: operation, kind: "feature-operation", reason: `${feature.id} owns operation ${operation}` });
    }
  }
  for (const port of ports) {
    for (const operation of port.operations) {
      edges.push({ from: port.id, to: operation.id, kind: "port-operation", reason: `${port.id} declares operation ${operation.id}` });
    }
  }
  for (const operation of operations) {
    for (const effect of operation.effects) {
      const target = effect.operationId ?? effect.reference;
      edges.push({ from: operation.id, to: target, kind: "operation-effect", reason: `${operation.id} declares effect ${target}` });
    }
    for (const event of operation.events) {
      edges.push({ from: operation.id, to: event, kind: "operation-event", reason: `${operation.id} emits event ${event}` });
    }
    for (const test of operation.tests) {
      edges.push({ from: operation.id, to: test, kind: "operation-test", reason: `${operation.id} is associated with test ${test}` });
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
    tests: testsMutable.sort((left, right) => compare(left.id, right.id)),
    edges,
    diagnostics: sortDiagnostics(diagnostics),
    unresolved: uniqueSorted(unresolved),
  };
  snapshot.dispose();
  api.close();
  return index;
};
