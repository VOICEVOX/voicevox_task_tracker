import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

import ts from "typescript";

const CHECKER_VERSION = 4;
const CACHE_PATH = "node_modules/.cache/voicevox-task-tracker/dependency-graph.json";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readProject(path) {
  const config = ts.readConfigFile(path, ts.sys.readFile);
  if (config.error != null) {
    throw new TypeError("依存検査のTypeScript設定を読み取れません", { cause: config.error });
  }
  const project = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(resolve(path)));
  if (project.errors.length !== 0) {
    throw new TypeError("依存検査のTypeScript設定が不正です", { cause: project.errors });
  }
  return project;
}

function sourcePath(path) {
  const normalized = relative(process.cwd(), path).replaceAll("\\", "/");
  return normalized.startsWith("src/") || normalized.startsWith("web/src/")
    ? normalized
    : undefined;
}

function staticDependencies(file, bytes, options, resolutionCache) {
  const source = ts.createSourceFile(file, bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
  const dependencies = new Set();
  function add(specifier) {
    if (
      specifier == null ||
      !ts.isStringLiteralLike(specifier) ||
      !specifier.text.startsWith(".")
    ) {
      return;
    }
    const resolved = ts.resolveModuleName(
      specifier.text,
      file,
      options,
      ts.sys,
      resolutionCache,
    ).resolvedModule;
    if (resolved == null) {
      throw new TypeError(`依存先を解決できません: ${sourcePath(file)} -> ${specifier.text}`);
    }
    const target = sourcePath(resolved.resolvedFileName);
    if (target != null) dependencies.add(target);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0]);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...dependencies].sort();
}

function circularDependencies(graph) {
  const indexByPath = new Map();
  const lowLinkByPath = new Map();
  const stack = [];
  const active = new Set();
  const cycles = [];
  let index = 0;
  function visit(path) {
    indexByPath.set(path, index);
    lowLinkByPath.set(path, index++);
    stack.push(path);
    active.add(path);
    for (const dependency of graph.get(path) ?? []) {
      if (!indexByPath.has(dependency)) {
        visit(dependency);
        lowLinkByPath.set(path, Math.min(lowLinkByPath.get(path), lowLinkByPath.get(dependency)));
      } else if (active.has(dependency)) {
        lowLinkByPath.set(path, Math.min(lowLinkByPath.get(path), indexByPath.get(dependency)));
      }
    }
    if (lowLinkByPath.get(path) !== indexByPath.get(path)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      component.push(member);
    } while (member !== path);
    if (component.length > 1 || graph.get(path)?.includes(path)) cycles.push(component.sort());
  }
  for (const path of [...graph.keys()].sort()) {
    if (!indexByPath.has(path)) visit(path);
  }
  return cycles;
}

function main() {
  const projects = ["tsconfig.json", "web/tsconfig.json"].map(readProject);
  const key = digest(
    JSON.stringify({
      checkerVersion: CHECKER_VERSION,
      typescriptVersion: ts.version,
      nodeVersion: process.version,
      sourceFiles: projects.map((project) =>
        project.fileNames
          .map(sourcePath)
          .filter((path) => path != null)
          .sort(),
      ),
      configurations: ["tsconfig.json", "web/tsconfig.json", "scripts/check-dependencies.mjs"].map(
        (path) => [path, digest(readFileSync(path))],
      ),
    }),
  );
  const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : undefined;
  const previous = cache?.key === key ? cache.entries : {};
  const next = {};
  const graph = new Map();
  for (const project of projects) {
    const resolutionCache = ts.createModuleResolutionCache(
      process.cwd(),
      (path) => path,
      project.options,
    );
    for (const file of project.fileNames) {
      const path = sourcePath(file);
      if (path == null || graph.has(path)) continue;
      const bytes = readFileSync(file);
      const sha256 = digest(bytes);
      const cached = previous[path];
      const dependencies =
        cached?.sha256 === sha256
          ? cached.dependencies
          : staticDependencies(file, bytes, project.options, resolutionCache);
      next[path] = { sha256, dependencies };
      graph.set(path, dependencies);
    }
  }
  const cycles = circularDependencies(graph);
  if (cycles.length !== 0) {
    throw new TypeError(
      cycles.map((paths) => `循環importがあります: ${paths.join(" -> ")}`).join("\n"),
    );
  }
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify({ key, entries: next })}\n`);
  process.stdout.write(`依存検査: ${graph.size.toString()} module、循環import 0件\n`);
}

main();
