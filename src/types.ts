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

/**
 * 一组（底本 + 参校本）组合各自保存的校勘进度：
 * 配对结果、比较规则、光标位置、勾选、撤销重做历史都按组合隔离。
 */
export interface PairSession {
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  selectedRowIds: string[];
  /** 是否已完成过首次自动对齐；新组合第一次进入时为 false，会自动对齐。 */
  aligned: boolean;
  history: string[];
  future: string[];
  createdAt: string;
  updatedAt: string;
}

/** 撤销/重做快照只保存当前组合的可编辑切片。 */
export interface PairSnapshot {
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
  selectedRowIds: string[];
}

export interface PersistedWorkbench {
  schema: 2;
  versions: VersionDocument[];
  activePairKey: string;
  sessions: Record<string, PairSession>;
}

/** v1 版本保存的是单一全局状态，用于首次启动时迁移。 */
export interface LegacyCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
}
