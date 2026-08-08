import { z } from "zod";

import {
  createEmptyTableFilters,
  waitingSubjectKey,
  type TableFilterKey,
  type TableFilterOption,
  type TableFilterOptions,
  type TableFilters,
  type TableSelectFilterKey,
  type TableSort,
  type OverviewSort,
} from "./model.js";

type TableFilterDefinition =
  | Readonly<{
      key: TableSelectFilterKey;
      parameterName: string;
      validation: "option";
    }>
  | Readonly<{
      key: "waitingOn";
      parameterName: string;
      validation: "substring";
    }>;

const TABLE_FILTER_DEFINITIONS = [
  {
    key: "repository",
    parameterName: "repo",
    validation: "option",
  },
  {
    key: "type",
    parameterName: "type",
    validation: "option",
  },
  {
    key: "status",
    parameterName: "status",
    validation: "option",
  },
  {
    key: "importance",
    parameterName: "importance",
    validation: "option",
  },
  {
    key: "waitingOn",
    parameterName: "waitingOn",
    validation: "substring",
  },
  {
    key: "stall",
    parameterName: "stall",
    validation: "option",
  },
  {
    key: "aiAnalysis",
    parameterName: "ai",
    validation: "option",
  },
] satisfies readonly TableFilterDefinition[];

const ITEMS_QUERY_PARAMETER_NAMES: readonly string[] = [
  "q",
  ...TABLE_FILTER_DEFINITIONS.map((definition) => definition.parameterName),
  "sort",
  "direction",
];
const PERSON_QUERY_PARAMETER_NAMES: readonly string[] = ["teams", "sort", "direction"];
const OVERVIEW_QUERY_PARAMETER_NAMES: readonly string[] = ["sort", "direction"];

const tableColumnKeySchema = z.enum([
  "repository",
  "type",
  "status",
  "importance",
  "waitingOn",
  "stall",
]);
const personTableColumnKeySchema = tableColumnKeySchema.exclude(["waitingOn"]);
const overviewSortKeySchema = z.union([z.literal("attention"), tableColumnKeySchema]);
const sortDirectionSchema = z.enum(["ascending", "descending"]);
const filterValueSchema = z
  .string()
  .max(200)
  .refine((value) => {
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (code <= 31 || code === 127) {
        return false;
      }
    }
    return true;
  });
const basePathSchema = z.string().regex(/^\/(?:[^?#]*\/)?$/u);
const itemNumberSchema = z.number().int().positive();
const githubLoginSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u);

/** 項目詳細pathから選択する公開項目。 */
export type ItemRouteTarget = Readonly<{
  nodeId: string;
  repositoryName: string;
  number: number;
}>;

/** pathnameで表す表示ページ。 */
export type WebRoute =
  | Readonly<{
      page: "overview";
    }>
  | Readonly<{
      page: "items";
    }>
  | Readonly<{
      page: "item-details";
      target: ItemRouteTarget;
    }>
  | Readonly<{
      page: "people";
    }>
  | Readonly<{
      page: "person";
      login: string;
      teamIds: readonly string[];
    }>;

/** URLの検証に使う公開DTO由来の選択肢。 */
export type ValidWebRouteTargets = Readonly<{
  items: readonly ItemRouteTarget[];
  tableFilterOptions: TableFilterOptions;
  teamIds: readonly string[];
}>;

/** ブラウザから読み取るURL。 */
export type WebLocation = Readonly<{
  pathname: string;
  search: string;
  hash: string;
}>;

/** URLで共有するrouteと一覧の表示状態。 */
export type WebViewState = Readonly<{
  overviewSort: OverviewSort;
  route: WebRoute;
  searchQuery: string;
  tableFilters: TableFilters;
  tableSort: TableSort;
}>;

/** URL状態を検証した結果。 */
export type ParsedWebViewState =
  | Readonly<{
      status: "valid";
      state: WebViewState;
    }>
  | Readonly<{
      status: "canonicalized";
      state: WebViewState;
    }>
  | Readonly<{
      status: "sanitized";
      state: WebViewState;
    }>;

type ParsedParameter<Value> =
  | Readonly<{
      status: "absent";
    }>
  | Readonly<{
      status: "valid";
      value: Value;
    }>
  | Readonly<{
      status: "invalid";
    }>;

type ParsedRoute = Readonly<{
  route: WebRoute;
  status: "valid" | "canonicalized" | "sanitized";
}>;

/** 指定routeの既定画面状態を作る。 */
export function createWebViewState(route: WebRoute): WebViewState {
  return {
    overviewSort: {
      key: "attention",
      direction: "descending",
    },
    route,
    searchQuery: "",
    tableFilters: createEmptyTableFilters(),
    tableSort: {
      key: "stall",
      direction: "descending",
    },
  };
}

/** 公開項目からpathname検証用の項目一覧を作る。 */
export function createItemRouteTargets(
  items: readonly Readonly<{
    displayReference: string;
    nodeId: string;
    number: number;
  }>[],
): readonly ItemRouteTarget[] {
  const targets = items.map((item) => {
    const expectedSuffix = `#${item.number.toString()}`;
    if (!item.displayReference.endsWith(expectedSuffix)) {
      throw new TypeError(`項目 ${item.nodeId} のdisplayReferenceと番号が一致しません`);
    }
    const repositoryReference = item.displayReference.slice(0, -expectedSuffix.length);
    const separatorIndex = repositoryReference.lastIndexOf("/");
    if (separatorIndex <= 0 || separatorIndex === repositoryReference.length - 1) {
      throw new TypeError(`項目 ${item.nodeId} のdisplayReferenceからリポジトリ名を取得できません`);
    }
    return {
      nodeId: item.nodeId,
      repositoryName: repositoryReference.slice(separatorIndex + 1),
      number: item.number,
    };
  });
  const pathKeys = new Set<string>();
  const nodeIds = new Set<string>();
  for (const target of targets) {
    const pathKey = `${target.repositoryName}\u0000${target.number.toString()}`;
    if (pathKeys.has(pathKey)) {
      throw new TypeError(
        `項目詳細pathが重複しています: ${target.repositoryName}#${target.number.toString()}`,
      );
    }
    if (nodeIds.has(target.nodeId)) {
      throw new TypeError(`項目node IDが重複しています: ${target.nodeId}`);
    }
    pathKeys.add(pathKey);
    nodeIds.add(target.nodeId);
  }
  return targets;
}

function parseParameter<Value>(
  parameters: URLSearchParams,
  name: string,
  schema: z.ZodType<Value>,
): ParsedParameter<Value> {
  const values = parameters.getAll(name);
  if (values.length === 0) {
    return {
      status: "absent",
    };
  }
  if (values.length !== 1) {
    return {
      status: "invalid",
    };
  }
  const result = schema.safeParse(values[0]);
  if (!result.success) {
    return {
      status: "invalid",
    };
  }
  return {
    status: "valid",
    value: result.data,
  };
}

function parseOptionParameter(
  parameters: URLSearchParams,
  name: string,
  options: readonly TableFilterOption[],
): ParsedParameter<string> {
  const parameter = parseParameter(parameters, name, filterValueSchema);
  if (parameter.status !== "valid") {
    return parameter;
  }
  if (!options.some((option) => option.value === parameter.value)) {
    return {
      status: "invalid",
    };
  }
  return parameter;
}

function parameterValueOr<Value>(
  parameter: ParsedParameter<Value>,
  fallback: Value,
): Readonly<{
  invalid: boolean;
  value: Value;
}> {
  switch (parameter.status) {
    case "absent":
      return {
        invalid: false,
        value: fallback,
      };
    case "valid":
      return {
        invalid: false,
        value: parameter.value,
      };
    case "invalid":
      return {
        invalid: true,
        value: fallback,
      };
  }
}

function decodePathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function parseItemRoute(
  segments: readonly string[],
  validItems: readonly ItemRouteTarget[],
): ParsedRoute {
  const fallback: ParsedRoute = {
    route: {
      page: "items",
    },
    status: "sanitized",
  };
  if (segments.length !== 3) {
    return fallback;
  }
  const repositoryName = decodePathSegment(segments[1] ?? "");
  const numberText = decodePathSegment(segments[2] ?? "");
  if (repositoryName == null || numberText == null || !/^[1-9]\d*$/u.test(numberText)) {
    return fallback;
  }
  const parsedNumber = itemNumberSchema.safeParse(Number(numberText));
  if (!parsedNumber.success) {
    return fallback;
  }
  const target = validItems.find(
    (item) => item.repositoryName === repositoryName && item.number === parsedNumber.data,
  );
  if (target == null) {
    return fallback;
  }
  return {
    route: {
      page: "item-details",
      target,
    },
    status: "valid",
  };
}

function parsePersonRoute(segments: readonly string[]): ParsedRoute {
  const fallback: ParsedRoute = {
    route: {
      page: "people",
    },
    status: "sanitized",
  };
  if (segments.length !== 2) {
    return fallback;
  }
  const decodedLogin = decodePathSegment(segments[1] ?? "");
  const parsedLogin = githubLoginSchema.safeParse(decodedLogin);
  if (!parsedLogin.success) {
    return fallback;
  }
  return {
    route: {
      page: "person",
      login: parsedLogin.data,
      teamIds: [],
    },
    status: segments[1] === encodeURIComponent(parsedLogin.data) ? "valid" : "canonicalized",
  };
}

function parseRelativeRoute(relativePath: string, targets: ValidWebRouteTargets): ParsedRoute {
  const segments = relativePath.split("/");
  switch (segments[0]) {
    case "items":
      if (segments.length === 1) {
        return {
          route: {
            page: "items",
          },
          status: "valid",
        };
      }
      return parseItemRoute(segments, targets.items);
    case "people":
      if (segments.length === 1) {
        return {
          route: {
            page: "people",
          },
          status: "valid",
        };
      }
      return parsePersonRoute(segments);
    default:
      return {
        route: {
          page: "overview",
        },
        status: "sanitized",
      };
  }
}

function parseRoute(
  pathname: string,
  basePath: string,
  targets: ValidWebRouteTargets,
): ParsedRoute {
  const parsedBasePath = basePathSchema.parse(basePath);
  if (!pathname.startsWith(parsedBasePath)) {
    return {
      route: {
        page: "overview",
      },
      status: "sanitized",
    };
  }
  const relativePath = pathname.slice(parsedBasePath.length);
  if (relativePath.length === 0) {
    return {
      route: {
        page: "overview",
      },
      status: "valid",
    };
  }
  const hasTrailingSlash = relativePath.endsWith("/");
  const normalizedRelativePath = hasTrailingSlash ? relativePath.slice(0, -1) : relativePath;
  const parsedRoute = parseRelativeRoute(normalizedRelativePath, targets);
  if (hasTrailingSlash && parsedRoute.status === "valid") {
    return {
      ...parsedRoute,
      status: "canonicalized",
    };
  }
  return parsedRoute;
}

function parseOverviewQuery(
  search: string,
  route: Extract<WebRoute, Readonly<{ page: "overview" }>>,
): Readonly<{
  sanitized: boolean;
  state: WebViewState;
}> {
  const parameters = new URLSearchParams(search);
  const defaults = createWebViewState(route);
  const allowedNames = new Set<string>(OVERVIEW_QUERY_PARAMETER_NAMES);
  let sanitized = [...parameters.keys()].some((name) => !allowedNames.has(name));
  const sortKey = parameterValueOr(
    parseParameter(parameters, "sort", overviewSortKeySchema),
    defaults.overviewSort.key,
  );
  const sortDirection = parameterValueOr(
    parseParameter(parameters, "direction", sortDirectionSchema),
    defaults.overviewSort.direction,
  );
  sanitized ||= sortKey.invalid || sortDirection.invalid;

  return {
    sanitized,
    state: {
      ...defaults,
      overviewSort: {
        key: sortKey.value,
        direction: sortDirection.value,
      },
    },
  };
}

function parsePersonQuery(
  search: string,
  route: Extract<WebRoute, Readonly<{ page: "person" }>>,
  validTeamIds: readonly string[],
): Readonly<{
  sanitized: boolean;
  state: WebViewState;
}> {
  const parameters = new URLSearchParams(search);
  const defaults = createWebViewState(route);
  const allowedNames = new Set<string>(PERSON_QUERY_PARAMETER_NAMES);
  let sanitized = [...parameters.keys()].some((name) => !allowedNames.has(name));
  const parsedTeams = parseParameter(parameters, "teams", filterValueSchema);
  const teamIds: string[] = [];
  const teamKeys = new Set<string>();
  const validTeamKeys = new Set(
    validTeamIds.map((teamId) => waitingSubjectKey({ kind: "team", teamId })),
  );

  switch (parsedTeams.status) {
    case "absent":
      break;
    case "invalid":
      sanitized = true;
      break;
    case "valid":
      for (const teamId of parsedTeams.value.split(",")) {
        if (teamId.length === 0) {
          sanitized = true;
          continue;
        }
        const teamKey = waitingSubjectKey({ kind: "team", teamId });
        if (teamKeys.has(teamKey) || !validTeamKeys.has(teamKey)) {
          sanitized = true;
          continue;
        }
        teamKeys.add(teamKey);
        teamIds.push(teamId);
      }
      break;
  }

  const sortKey = parameterValueOr(
    parseParameter(parameters, "sort", personTableColumnKeySchema),
    defaults.tableSort.key,
  );
  const sortDirection = parameterValueOr(
    parseParameter(parameters, "direction", sortDirectionSchema),
    defaults.tableSort.direction,
  );
  sanitized ||= sortKey.invalid || sortDirection.invalid;

  return {
    sanitized,
    state: {
      ...createWebViewState({
        ...route,
        teamIds,
      }),
      tableSort: {
        key: sortKey.value,
        direction: sortDirection.value,
      },
    },
  };
}

function parseItemsQuery(
  search: string,
  route: Extract<WebRoute, Readonly<{ page: "items" }>>,
  filterOptions: TableFilterOptions,
): Readonly<{
  sanitized: boolean;
  state: WebViewState;
}> {
  const parameters = new URLSearchParams(search);
  const defaults = createWebViewState(route);
  const allowedNames = new Set<string>(ITEMS_QUERY_PARAMETER_NAMES);
  let sanitized = [...parameters.keys()].some((name) => !allowedNames.has(name));

  const searchQuery = parameterValueOr(
    parseParameter(parameters, "q", filterValueSchema),
    defaults.searchQuery,
  );
  sanitized ||= searchQuery.invalid;

  const parsedTableFilters: Record<TableFilterKey, string> = {
    ...defaults.tableFilters,
  };
  for (const definition of TABLE_FILTER_DEFINITIONS) {
    const parameter =
      definition.validation === "option"
        ? parseOptionParameter(parameters, definition.parameterName, filterOptions[definition.key])
        : parseParameter(parameters, definition.parameterName, filterValueSchema);
    const filter = parameterValueOr(parameter, defaults.tableFilters[definition.key]);
    sanitized ||= filter.invalid;
    parsedTableFilters[definition.key] = filter.value;
  }

  const sortKey = parameterValueOr(
    parseParameter(parameters, "sort", tableColumnKeySchema),
    defaults.tableSort.key,
  );
  const sortDirection = parameterValueOr(
    parseParameter(parameters, "direction", sortDirectionSchema),
    defaults.tableSort.direction,
  );
  sanitized ||= sortKey.invalid || sortDirection.invalid;

  return {
    sanitized,
    state: {
      overviewSort: defaults.overviewSort,
      route,
      searchQuery: searchQuery.value,
      tableFilters: parsedTableFilters,
      tableSort: {
        key: sortKey.value,
        direction: sortDirection.value,
      },
    },
  };
}

/** pathnameとqueryを検証し、不正な値だけを該当ページの既定状態へ戻す。 */
export function parseWebViewState(
  location: WebLocation,
  basePath: string,
  targets: ValidWebRouteTargets,
): ParsedWebViewState {
  const parsedRoute = parseRoute(location.pathname, basePath, targets);
  let queryResult: Readonly<{
    sanitized: boolean;
    state: WebViewState;
  }>;
  switch (parsedRoute.route.page) {
    case "overview":
      queryResult = parseOverviewQuery(location.search, parsedRoute.route);
      break;
    case "items":
      queryResult = parseItemsQuery(location.search, parsedRoute.route, targets.tableFilterOptions);
      break;
    case "person":
      queryResult = parsePersonQuery(location.search, parsedRoute.route, targets.teamIds);
      break;
    default:
      queryResult = {
        sanitized: location.search.length > 0,
        state: createWebViewState(parsedRoute.route),
      };
      break;
  }
  if (parsedRoute.status === "sanitized" || queryResult.sanitized) {
    return {
      status: "sanitized",
      state: queryResult.state,
    };
  }
  return {
    status: parsedRoute.status,
    state: queryResult.state,
  };
}

function appendNonEmptyParameter(parameters: URLSearchParams, name: string, value: string): void {
  if (value.length > 0) {
    parameters.set(name, value);
  }
}

function appendSortParameters<Key extends string>(
  parameters: URLSearchParams,
  sort: Readonly<{
    key: Key;
    direction: TableSort["direction"];
  }>,
  defaultSort: Readonly<{
    key: Key;
    direction: TableSort["direction"];
  }>,
): void {
  if (sort.key !== defaultSort.key) {
    parameters.set("sort", sort.key);
  }
  if (sort.direction !== defaultSort.direction) {
    parameters.set("direction", sort.direction);
  }
}

function createRoutePath(basePath: string, route: WebRoute): string {
  const parsedBasePath = basePathSchema.parse(basePath);
  const pathPrefix = parsedBasePath === "/" ? "" : parsedBasePath.slice(0, -1);
  switch (route.page) {
    case "overview":
      return parsedBasePath;
    case "items":
      return `${pathPrefix}/items`;
    case "item-details":
      return `${pathPrefix}/items/${encodeURIComponent(route.target.repositoryName)}/${route.target.number.toString()}`;
    case "people":
      return `${pathPrefix}/people`;
    case "person":
      return `${pathPrefix}/people/${encodeURIComponent(route.login)}`;
  }
}

/** 検証済み画面状態をbasePath配下のdeep linkへ変換する。 */
export function createWebViewHref(basePath: string, state: WebViewState): string {
  const pathname = createRoutePath(basePath, state.route);
  if (state.route.page === "overview") {
    const parameters = new URLSearchParams();
    appendSortParameters(
      parameters,
      state.overviewSort,
      createWebViewState(state.route).overviewSort,
    );
    const query = parameters.toString();
    return `${pathname}${query.length === 0 ? "" : `?${query}`}`;
  }
  if (state.route.page === "person") {
    const parameters = new URLSearchParams();
    if (state.route.teamIds.length > 0) {
      parameters.set("teams", state.route.teamIds.join(","));
    }
    appendSortParameters(parameters, state.tableSort, createWebViewState(state.route).tableSort);
    const query = parameters.toString();
    return `${pathname}${query.length === 0 ? "" : `?${query}`}`;
  }
  if (state.route.page !== "items") {
    return pathname;
  }
  const parameters = new URLSearchParams();
  appendNonEmptyParameter(parameters, "q", state.searchQuery);
  for (const definition of TABLE_FILTER_DEFINITIONS) {
    appendNonEmptyParameter(
      parameters,
      definition.parameterName,
      state.tableFilters[definition.key],
    );
  }
  appendSortParameters(parameters, state.tableSort, createWebViewState(state.route).tableSort);
  const query = parameters.toString();
  return `${pathname}${query.length === 0 ? "" : `?${query}`}`;
}
