export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

/** 单个版本组合（底本 × 参校本）的校勘进度 */
export interface PersistedSession {
  rows: AlignmentRow[];
  selectedRowId: string;
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rules: ComparisonRules;
  /** 键为 `${leftVersionId}::${rightVersionId}`，每组版本组合各存一份 */
  sessions: Record<string, PersistedSession>;
}

/** v1 本地草稿结构，仅用于迁移 */
export interface PersistedCollationStateV1 {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
}
