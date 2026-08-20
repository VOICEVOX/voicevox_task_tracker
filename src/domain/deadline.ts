/** AIが判定した期限の切迫度。 */
export type DeadlineLevel = "none" | "low" | "medium" | "high";

/** 自然言語から判定した期限の切迫度。 */
export type NaturalLanguageDeadlineAssessment = Readonly<{
  level: DeadlineLevel;
  rationale: string;
}>;

/** 自然言語による期限の切迫度判定を利用できるかを表す。 */
export type NaturalLanguageDeadlineAssessmentState =
  | Readonly<{
      status: "not_available";
    }>
  | Readonly<{
      status: "available";
      value: NaturalLanguageDeadlineAssessment;
    }>;
