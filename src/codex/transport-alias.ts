import {
  type CodexAnalysisInput,
  createCodexAnalysisInput,
  transformCodexSourceReferences,
} from "./input.js";
import { z } from "zod";
import {
  CodexOutputSemanticValidationError,
  CodexTransportAliasError,
  type CodexOutputValidationIssue,
} from "./errors.js";
import { validateCodexElementOutputSchema } from "./element-output.js";
import { validateCodexAnalysisOutput } from "./output-validation.js";
import { type CodexElementOutput } from "./semantic-validation.js";
import { type CodexElementEvidence, type SchemaValidCodexElementOutput } from "./element-output.js";
import {
  isCodexSemanticCorrectionEligible,
  codexSemanticValidationIssueCodeSchema,
  type CodexSemanticValidationIssueCode,
} from "./semantic-validation-issues.js";
import { serializeCanonicalJson } from "../canonical-json/index.js";

const SOURCE_ALIAS_PREFIX = "codex_source:";
const RELATION_ALIAS_PREFIX = "rel:codex-";
const RELATION_REFERENCE_FIELDS = new Set([
  "relationCandidateIds",
  "nativeBlockedBy",
  "nativeBlocking",
  "nativeParent",
  "nativeSubIssues",
]);

/** Codex実行時のIDとcanonical IDを対応付けるcodec。 */
type CodexTransportAliasCodec = Readonly<{
  sourceAliasByCanonicalId: ReadonlyMap<string, string>;
  sourceCanonicalIdByAlias: ReadonlyMap<string, string>;
  relationAliasByCanonicalId: ReadonlyMap<string, string>;
  relationCanonicalIdByAlias: ReadonlyMap<string, string>;
}>;

/** alias化されたCodex入力とID復元用codec。 */
type CodexTransportInput = Readonly<{
  input: CodexAnalysisInput;
  codec: CodexTransportAliasCodec;
}>;

/** semantic generationの補正入力へ渡すissue要約。 */
export type CodexSemanticCorrectionIssue = Readonly<{
  path: string;
  code: CodexSemanticValidationIssueCode;
}>;

/** 通常項目AIのgenerationごとの実行context。 */
export type CodexSemanticGenerationContext =
  | Readonly<{
      generation: 1;
    }>
  | Readonly<{
      generation: 2 | 3;
      previousOutput: SchemaValidCodexElementOutput;
      issues: readonly CodexSemanticCorrectionIssue[];
    }>;

/** 通常項目AIのsemantic generation集計を受け取る同期observer。 */
export type CodexSemanticGenerationObserver = Readonly<{
  onGenerationStarted: (generation: number) => void;
  onCorrectionStarted: (generation: number) => void;
  onCorrectionSucceeded: (generation: number) => void;
  onCorrectionExhausted: (generation: number) => void;
  onProcessAttemptStarted: (generation: number, attempt: number) => void;
}>;

/** semantic generation loopの設定。 */
export type CodexSemanticGenerationOptions = Readonly<{
  maxSemanticGenerations: number;
  observer?: CodexSemanticGenerationObserver;
}>;

const semanticGenerationOptionsSchema = z.strictObject({
  maxSemanticGenerations: z.number().int().min(1).max(3),
});

const correctionIssueSchema = z.strictObject({
  path: z.string(),
  code: codexSemanticValidationIssueCodeSchema,
});

const correctionEnvelopeSchema = z
  .strictObject({
    analysisInput: z.unknown(),
    previousOutput: z.unknown(),
    generation: z.number().int().min(2).max(3),
    issues: z.array(correctionIssueSchema).min(1),
  })
  .superRefine((envelope, context) => {
    for (const [index, issue] of envelope.issues.entries()) {
      if (!isCodexSemanticCorrectionEligible(issue.code)) {
        context.addIssue({
          code: "custom",
          path: ["issues", index, "code"],
          message: "補正対象外のsemantic issue codeです",
        });
      }
    }
  });

function createSemanticGenerationContext(
  generation: number,
  previousOutput: SchemaValidCodexElementOutput | undefined,
  issues: readonly CodexSemanticCorrectionIssue[] | undefined,
): CodexSemanticGenerationContext {
  if (generation === 1) {
    if (previousOutput != null || issues != null) {
      throw new TypeError("Codex初回generationへsemantic補正contextを指定できません");
    }
    return Object.freeze({ generation: 1 });
  }
  if (generation !== 2 && generation !== 3) {
    throw new RangeError("Codex semantic generationは1から3にしてください");
  }
  if (previousOutput == null || issues == null) {
    throw new TypeError("Codex補正generationへ直前出力とsemantic issueが必要です");
  }
  return Object.freeze({
    generation,
    previousOutput,
    issues,
  });
}

/** semantic補正generationのstrict stdin envelopeをシリアライズする。 */
export function serializeCodexSemanticCorrectionEnvelope(
  analysisInput: CodexAnalysisInput,
  previousOutput: SchemaValidCodexElementOutput,
  generation: number,
  issues: readonly CodexSemanticCorrectionIssue[],
): string {
  const validatedAnalysisInput = createCodexAnalysisInput(analysisInput);
  const validatedPreviousOutput = validateCodexElementOutputSchema(
    previousOutput,
    validatedAnalysisInput.selectedElements,
  );
  const envelope = correctionEnvelopeSchema.parse({
    analysisInput: validatedAnalysisInput,
    previousOutput: validatedPreviousOutput,
    generation,
    issues,
  });
  return `${serializeCanonicalJson(envelope)}\n`;
}

function jsonPointerPath(parent: string, field: string): string {
  const escapedField = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${escapedField}`;
}

function createAliasMaps(
  canonicalIds: readonly string[],
  aliasPrefix: string,
  reservedIds: ReadonlySet<string>,
): Readonly<{
  aliasByCanonicalId: ReadonlyMap<string, string>;
  canonicalIdByAlias: ReadonlyMap<string, string>;
}> {
  const aliasByCanonicalId = new Map<string, string>();
  const canonicalIdByAlias = new Map<string, string>();
  for (const [index, canonicalId] of canonicalIds.entries()) {
    if (aliasByCanonicalId.has(canonicalId)) {
      throw new TypeError(
        `Codex transport aliasのcanonical IDが重複しています。対象: ${canonicalId}`,
      );
    }
    const alias = `${aliasPrefix}${index.toString()}`;
    if (reservedIds.has(alias) || canonicalIdByAlias.has(alias)) {
      throw new TypeError(`Codex transport aliasが既存のIDと衝突しています。対象: ${alias}`);
    }
    aliasByCanonicalId.set(canonicalId, alias);
    canonicalIdByAlias.set(alias, canonicalId);
  }
  return Object.freeze({
    aliasByCanonicalId,
    canonicalIdByAlias,
  });
}

function requireAlias(
  aliases: ReadonlyMap<string, string>,
  canonicalId: string,
  path: string,
): string {
  const alias = aliases.get(canonicalId);
  if (alias == null) {
    throw new TypeError(`Codex transport aliasに対応するIDがありません。対象: ${path}`);
  }
  return alias;
}

function requireCanonicalId(
  canonicalIds: ReadonlyMap<string, string>,
  alias: string,
  path: string,
): string {
  const canonicalId = canonicalIds.get(alias);
  if (canonicalId == null) {
    throw new TypeError(`Codex transport aliasに対応するcanonical IDがありません。対象: ${path}`);
  }
  return canonicalId;
}

function mapRelationReference(
  value: unknown,
  path: string,
  relationAliases: ReadonlyMap<string, string>,
): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `Codex入力のrelation candidate ID参照は文字列にしてください。対象: ${path}`,
    );
  }
  return requireAlias(relationAliases, value, path);
}

function isLockedRelationCandidateIdPath(path: string, field: string): boolean {
  return field === "candidateId" && /^\/lockedElements\/relations\/value\/\d+$/u.test(path);
}

function transformRelationReferences(
  value: unknown,
  path: string,
  relationAliases: ReadonlyMap<string, string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      transformRelationReferences(entry, jsonPointerPath(path, index.toString()), relationAliases),
    );
  }
  if (typeof value !== "object" || value == null) {
    return value;
  }

  const transformed: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(value)) {
    const entryPath = jsonPointerPath(path, field);
    let transformedEntry: unknown = entry;
    if (path === "/deterministicSignals" && RELATION_REFERENCE_FIELDS.has(field)) {
      if (!Array.isArray(entry)) {
        throw new TypeError(
          `Codex入力のrelation candidate ID参照は文字列配列にしてください。対象: ${entryPath}`,
        );
      }
      transformedEntry = entry.map((candidateId, index) =>
        mapRelationReference(
          candidateId,
          jsonPointerPath(entryPath, index.toString()),
          relationAliases,
        ),
      );
    } else if (isLockedRelationCandidateIdPath(path, field)) {
      transformedEntry = mapRelationReference(entry, entryPath, relationAliases);
    }
    transformed[field] = transformRelationReferences(transformedEntry, entryPath, relationAliases);
  }
  return transformed;
}

function createCodexTransportAliasCodec(input: CodexAnalysisInput): CodexTransportAliasCodec {
  const sourceIds = input.sources.map((source) => source.id);
  const relationIds = input.candidates.relations.map((candidate) => candidate.id);
  const reservedIds = new Set([...sourceIds, ...relationIds]);
  const sourceMaps = createAliasMaps(sourceIds, SOURCE_ALIAS_PREFIX, reservedIds);
  const relationMaps = createAliasMaps(relationIds, RELATION_ALIAS_PREFIX, reservedIds);
  const aliases = new Set([
    ...sourceMaps.canonicalIdByAlias.keys(),
    ...relationMaps.canonicalIdByAlias.keys(),
  ]);
  if (aliases.size !== sourceIds.length + relationIds.length) {
    throw new TypeError("Codex transport aliasが重複しています");
  }
  return Object.freeze({
    sourceAliasByCanonicalId: sourceMaps.aliasByCanonicalId,
    sourceCanonicalIdByAlias: sourceMaps.canonicalIdByAlias,
    relationAliasByCanonicalId: relationMaps.aliasByCanonicalId,
    relationCanonicalIdByAlias: relationMaps.canonicalIdByAlias,
  });
}

function createCodexTransportInput(input: CodexAnalysisInput): CodexTransportInput {
  const canonicalInput = createCodexAnalysisInput(input);
  const codec = createCodexTransportAliasCodec(canonicalInput);
  const aliasedInput = {
    ...canonicalInput,
    candidates: {
      ...canonicalInput.candidates,
      relations: canonicalInput.candidates.relations.map((candidate, index) => ({
        ...candidate,
        id: requireAlias(
          codec.relationAliasByCanonicalId,
          candidate.id,
          `/candidates/relations/${index.toString()}/id`,
        ),
      })),
    },
    sources: canonicalInput.sources.map((source, index) => ({
      ...source,
      id: requireAlias(
        codec.sourceAliasByCanonicalId,
        source.id,
        `/sources/${index.toString()}/id`,
      ),
    })),
  };
  const sourceAliasedInput = transformCodexSourceReferences(
    aliasedInput,
    codec.sourceAliasByCanonicalId,
    "",
  );
  const transportInput = createCodexAnalysisInput(
    transformRelationReferences(sourceAliasedInput, "", codec.relationAliasByCanonicalId),
  );
  return Object.freeze({
    input: transportInput,
    codec,
  });
}

function restoreSourceId(value: string, path: string, codec: CodexTransportAliasCodec): string {
  return requireCanonicalId(codec.sourceCanonicalIdByAlias, value, path);
}

function restoreElementResultEvidence(
  value: Readonly<{
    evidence: readonly CodexElementEvidence[];
  }>,
  path: string,
  codec: CodexTransportAliasCodec,
): Record<string, unknown> {
  return {
    ...value,
    evidence: value.evidence.map((evidence, index) => ({
      ...evidence,
      sourceId: restoreSourceId(
        evidence.sourceId,
        `${path}/evidence/${index.toString()}/sourceId`,
        codec,
      ),
    })),
  };
}

function restoreCodexOutput(
  value: SchemaValidCodexElementOutput,
  codec: CodexTransportAliasCodec,
): unknown {
  const restored: Record<string, unknown> = {
    schemaVersion: value.schemaVersion,
    item: value.item,
  };
  if (value.status != null) {
    restored["status"] = restoreElementResultEvidence(value.status, "/status", codec);
  }
  if (value.waitingOn != null) {
    const restoredWaitingOn = restoreElementResultEvidence(value.waitingOn, "/waitingOn", codec);
    restoredWaitingOn["value"] = value.waitingOn.value.map((waitingOn, index) => ({
      ...waitingOn,
      sourceIds: waitingOn.sourceIds.map((sourceId, sourceIndex) =>
        restoreSourceId(
          sourceId,
          `/waitingOn/value/${index.toString()}/sourceIds/${sourceIndex.toString()}`,
          codec,
        ),
      ),
    }));
    restored["waitingOn"] = restoredWaitingOn;
  }
  if (value.nextAction != null) {
    restored["nextAction"] = restoreElementResultEvidence(value.nextAction, "/nextAction", codec);
  }
  if (value.relations != null) {
    const restoredRelations = restoreElementResultEvidence(value.relations, "/relations", codec);
    restoredRelations["value"] = value.relations.value.map((relation, index) => ({
      ...relation,
      candidateId: requireCanonicalId(
        codec.relationCanonicalIdByAlias,
        relation.candidateId,
        `/relations/value/${index.toString()}/candidateId`,
      ),
      sourceIds: relation.sourceIds.map((sourceId, sourceIndex) =>
        restoreSourceId(
          sourceId,
          `/relations/value/${index.toString()}/sourceIds/${sourceIndex.toString()}`,
          codec,
        ),
      ),
    }));
    restored["relations"] = restoredRelations;
  }
  if (value.progress != null) {
    const restoredProgress = restoreElementResultEvidence(value.progress, "/progress", codec);
    restoredProgress["value"] = {
      ...value.progress.value,
      latestMeaningfulSourceId:
        value.progress.value.latestMeaningfulSourceId == null
          ? null
          : restoreSourceId(
              value.progress.value.latestMeaningfulSourceId,
              "/progress/value/latestMeaningfulSourceId",
              codec,
            ),
    };
    restored["progress"] = restoredProgress;
  }
  if (value.importance != null) {
    restored["importance"] = restoreElementResultEvidence(value.importance, "/importance", codec);
  }
  if (value.deadline != null) {
    restored["deadline"] = restoreElementResultEvidence(value.deadline, "/deadline", codec);
  }
  if (value.notification != null) {
    restored["notification"] = restoreElementResultEvidence(
      value.notification,
      "/notification",
      codec,
    );
  }
  if (value.selfCommitment != null) {
    const restoredSelfCommitment = restoreElementResultEvidence(
      value.selfCommitment,
      "/selfCommitment",
      codec,
    );
    restoredSelfCommitment["value"] = value.selfCommitment.value.map((commitment, index) => ({
      ...commitment,
      sourceId: restoreSourceId(
        commitment.sourceId,
        `/selfCommitment/value/${index.toString()}/sourceId`,
        codec,
      ),
    }));
    restored["selfCommitment"] = restoredSelfCommitment;
  }
  return restored;
}

/** Codexをtransport aliasで実行し、canonical IDへ戻した要素別出力を返す。 */
export async function executeCodexAnalysisWithTransportAliases(
  input: CodexAnalysisInput,
  execute: (input: CodexAnalysisInput, context: CodexSemanticGenerationContext) => Promise<unknown>,
  options: CodexSemanticGenerationOptions,
): Promise<CodexElementOutput> {
  const maxSemanticGenerations = semanticGenerationOptionsSchema.parse({
    maxSemanticGenerations: options.maxSemanticGenerations,
  }).maxSemanticGenerations;
  const observer = options.observer;
  let transport: CodexTransportInput;
  try {
    transport = createCodexTransportInput(input);
  } catch (error: unknown) {
    throw new CodexTransportAliasError("input", { cause: error });
  }
  let previousOutput: SchemaValidCodexElementOutput | undefined;
  let previousIssues: readonly CodexSemanticCorrectionIssue[] | undefined;
  for (let generation = 1; generation <= maxSemanticGenerations; generation += 1) {
    observer?.onGenerationStarted(generation);
    const context = createSemanticGenerationContext(generation, previousOutput, previousIssues);
    const rawOutput = await execute(transport.input, context);
    let validatedOutput: SchemaValidCodexElementOutput;
    try {
      validatedOutput = validateCodexAnalysisOutput(rawOutput, transport.input);
    } catch (error: unknown) {
      if (!(error instanceof CodexOutputSemanticValidationError)) {
        throw error;
      }
      const schemaValidOutput = validateCodexElementOutputSchema(
        rawOutput,
        transport.input.selectedElements,
      );
      const issues = semanticCorrectionIssues(error.issues);
      if (issues == null || !allSemanticIssuesAreCorrectable(issues)) {
        throw error;
      }
      if (generation === maxSemanticGenerations) {
        if (previousOutput != null) {
          observer?.onCorrectionExhausted(generation);
        }
        throw error;
      }
      const correctionStarted = previousOutput == null;
      previousOutput = schemaValidOutput;
      previousIssues = issues;
      if (correctionStarted) {
        observer?.onCorrectionStarted(generation + 1);
      }
      continue;
    }
    const canonicalOutput = restoreAndValidateCanonicalOutput(
      validatedOutput,
      transport.codec,
      input,
    );
    if (generation > 1) {
      observer?.onCorrectionSucceeded(generation);
    }
    return canonicalOutput;
  }
  throw new TypeError("Codex semantic generation loopが終了条件なしに終了しました");
}

function semanticCorrectionIssues(
  issues: readonly CodexOutputValidationIssue[],
): readonly CodexSemanticCorrectionIssue[] | undefined {
  const correctionIssues: CodexSemanticCorrectionIssue[] = [];
  for (const issue of issues) {
    const code = codexSemanticValidationIssueCodeSchema.safeParse(issue.code);
    if (!code.success) {
      return undefined;
    }
    correctionIssues.push(
      Object.freeze({
        path: issue.path,
        code: code.data,
      }),
    );
  }
  return Object.freeze(correctionIssues);
}

function allSemanticIssuesAreCorrectable(issues: readonly CodexSemanticCorrectionIssue[]): boolean {
  return (
    issues.length > 0 && issues.every((issue) => isCodexSemanticCorrectionEligible(issue.code))
  );
}

function restoreAndValidateCanonicalOutput(
  output: SchemaValidCodexElementOutput,
  codec: CodexTransportAliasCodec,
  input: CodexAnalysisInput,
): CodexElementOutput {
  let restoredOutput: unknown;
  try {
    restoredOutput = restoreCodexOutput(output, codec);
  } catch (error: unknown) {
    throw new CodexTransportAliasError("restore", { cause: error });
  }
  try {
    return validateCodexAnalysisOutput(restoredOutput, input);
  } catch (error: unknown) {
    throw new CodexTransportAliasError("canonical_validation", { cause: error });
  }
}
