import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  ComparisonRules,
  DifferenceStatus,
  PersistedCollationState,
  PersistedCollationStateV1,
  PersistedSession,
  TextUnit,
  VersionDocument
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v2';
const LEGACY_STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
const HISTORY_LIMIT = 50;

const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function statusFor(left: TextUnit | undefined, right: TextUnit | undefined, ratio: number): DifferenceStatus {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

async function alignUnits(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  onProgress: (value: number) => void
): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容'));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
      leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));
      const nextLeftRatio =
        leftUnits[leftIndex + 1] && right
          ? similarity(normalized(leftUnits[leftIndex + 1].text, rules), normalized(right.text, rules))
          : 0;
      const nextRightRatio =
        rightUnits[rightIndex + 1] && left
          ? similarity(normalized(left.text, rules), normalized(rightUnits[rightIndex + 1].text, rules))
          : 0;

      if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
        const score = Number(ratio.toFixed(3));
        rows.push({
          id: `row-${rows.length + 1}-${left.id}-${right.id}`,
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          source: '',
          accepted: score > 0.995,
          manuallyAdjusted: false
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入'));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失'));
        leftIndex += 1;
      }
    }

    if (rows.length % 24 === 0) {
      onProgress(Math.round(((leftIndex + rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100));
      await yieldToBrowser();
    }
  }
  onProgress(100);
  return rows;
}

function makeRow(
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  source: string
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: score > 0.995,
    manuallyAdjusted: false
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

function pairKey(leftId: string, rightId: string) {
  return `${leftId}::${rightId}`;
}

function isPendingRow(row: AlignmentRow) {
  return !row.accepted && row.status !== 'same';
}

/** 单个版本组合的完整进度：对齐行、当前位置与独立的撤销/重做栈 */
interface SessionEntry extends PersistedSession {
  history: string[];
  future: string[];
}

export interface SessionSummary {
  key: string;
  leftVersionId: string;
  rightVersionId: string;
  leftName: string;
  rightName: string;
  rowCount: number;
  pending: number;
  active: boolean;
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  /** 非当前组合的进度都暂存在这里；当前组合由上面的 rows/history/future 承载 */
  const sessionStore = ref<Record<string, SessionEntry>>({});
  /** 当前载入工作区的组合键，用于识别“是否真的发生了切换” */
  const activeKey = ref(pairKey(leftVersionId.value, rightVersionId.value));

  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter(isPendingRow).length);
  /** 除当前组合外，其余组合尚未接受的差异总数 */
  const pendingElsewhere = computed(() =>
    Object.entries(sessionStore.value)
      .filter(([key]) => key !== activeKey.value)
      .reduce((total, [, entry]) => total + entry.rows.filter(isPendingRow).length, 0)
  );
  /** 任意一个组合仍有待办差异，用于离开页面前提醒 */
  const anyUnresolved = computed(() => unresolvedCount.value > 0 || pendingElsewhere.value > 0);

  const sessionSummaries = computed<SessionSummary[]>(() => {
    const nameOf = (id: string) => versions.value.find((item) => item.id === id)?.name ?? '未知版本';
    const summaries = new Map<string, SessionSummary>();
    const collect = (key: string, sessionRows: AlignmentRow[]) => {
      const [leftId = '', rightId = ''] = key.split('::');
      summaries.set(key, {
        key,
        leftVersionId: leftId,
        rightVersionId: rightId,
        leftName: nameOf(leftId),
        rightName: nameOf(rightId),
        rowCount: sessionRows.length,
        pending: sessionRows.filter(isPendingRow).length,
        active: key === activeKey.value
      });
    };
    for (const [key, entry] of Object.entries(sessionStore.value)) collect(key, entry.rows);
    // 当前组合用实时数据覆盖，保证首次进入尚未落库的组合也能出现
    collect(activeKey.value, rows.value);
    return [...summaries.values()].sort((a, b) => Number(b.active) - Number(a.active));
  });

  /** 当前组合的快照，撤销/重做只回滚本组合的对齐行与位置 */
  function snapshotSession(): string {
    const data: PersistedSession = { rows: rows.value, selectedRowId: selectedRowId.value };
    return JSON.stringify(data);
  }

  function applySessionSnapshot(raw: string) {
    const parsed = JSON.parse(raw) as PersistedSession;
    rows.value = parsed.rows;
    selectedRowId.value = parsed.selectedRowId;
    selectedRowIds.value = [];
  }

  function persist() {
    const sessions: Record<string, PersistedSession> = {};
    for (const [key, entry] of Object.entries(sessionStore.value)) {
      sessions[key] = { rows: entry.rows, selectedRowId: entry.selectedRowId };
    }
    sessions[activeKey.value] = { rows: rows.value, selectedRowId: selectedRowId.value };
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rules: rules.value,
      sessions
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshotSession());
    if (history.value.length > HISTORY_LIMIT) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshotSession());
    applySessionSnapshot(previous);
    message.value = '已撤销上一步操作';
    persist();
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshotSession());
    applySessionSnapshot(next);
    message.value = '已重做上一步操作';
    persist();
  }

  /** 把当前工作区的进度存回所属组合 */
  function stashActiveSession() {
    sessionStore.value[activeKey.value] = {
      rows: rows.value,
      selectedRowId: selectedRowId.value,
      history: history.value,
      future: future.value
    };
  }

  /** 载入指定组合；没有记录的组合首次进入时自动对齐 */
  function loadSession(key: string) {
    const entry = sessionStore.value[key];
    if (entry) {
      rows.value = entry.rows;
      selectedRowId.value = entry.selectedRowId;
      history.value = entry.history;
      future.value = entry.future;
      selectedRowIds.value = [];
      message.value = `已切回「${leftVersion.value?.name ?? '?'} × ${rightVersion.value?.name ?? '?'}」，继续上次校勘进度`;
      persist();
    } else {
      rows.value = [];
      selectedRowId.value = '';
      history.value = [];
      future.value = [];
      selectedRowIds.value = [];
      message.value = '首次进入该版本组合，正在自动对齐…';
      void runAlignment(false);
    }
  }

  async function runAlignment(commitHistory = true) {
    const left = leftVersion.value;
    const right = rightVersion.value;
    if (!left || !right || processing.value) return;
    const targetKey = pairKey(left.id, right.id);
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshotSession() : '';
    try {
      const result = await alignUnits(left.units, right.units, rules.value, (value) => {
        progress.value = value;
      });
      const firstDifference = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      if (targetKey === activeKey.value) {
        if (commitHistory) {
          history.value.push(previous);
          if (history.value.length > HISTORY_LIMIT) history.value.shift();
          future.value = [];
        }
        rows.value = result;
        selectedRowId.value = firstDifference;
        selectedRowIds.value = [];
        message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      } else {
        // 对齐期间用户切到了别的组合，把结果存回它原本所属的组合
        const existing = sessionStore.value[targetKey];
        sessionStore.value[targetKey] = {
          rows: result,
          selectedRowId: firstDifference,
          history: existing?.history ?? [],
          future: []
        };
      }
      persist();
    } finally {
      processing.value = false;
    }
  }

  function recalculate() {
    commit('已按比较规则重算差异', () => {
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) return row;
        const score = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        return { ...row, similarity: score, status: statusFor(row.left, row.right, score) };
      });
      selectedRowIds.value = [];
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) Object.assign(row, patch, { manuallyAdjusted: true });
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位' : '已向后调整错位', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const current = rows.value[index];
      const target = rows.value[targetIndex];
      const currentLeft = current.left;
      current.left = target.left;
      target.left = currentLeft;
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = Number(
            similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
          );
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
      }
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  function acceptRows(ids: string[]) {
    if (!ids.length) return;
    commit(`已接受 ${ids.length} 条校对建议`, () => {
      const selected = new Set(ids);
      rows.value.forEach((row) => {
        if (selected.has(row.id)) row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    commit('已批量接受全部差异建议', () => {
      rows.value.forEach((row) => {
        row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && !row.accepted) {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
  }

  function addVersion(name: string, source: string, text: string) {
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    versions.value.push(item);
    message.value = `已导入版本：${item.name}`;
    persist();
    // 切到与新版本的组合；若是新组合会自动对齐，已有组合则恢复进度
    rightVersionId.value = id;
  }

  function activateSession(key: string) {
    if (processing.value || key === activeKey.value) return;
    const [leftId, rightId] = key.split('::');
    if (!leftId || !rightId) return;
    leftVersionId.value = leftId;
    rightVersionId.value = rightId;
  }

  function exportMarkdown() {
    const changed = rows.value.filter((row) => row.status !== 'same' || row.note || row.source);
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 序 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|'
    ];
    changed.forEach((row, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${row.accepted ? '已接受' : '待处理'} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        rows: rows.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  function loadPersisted(): PersistedCollationState | null {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersistedCollationState;
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return null;
    const old = JSON.parse(legacy) as PersistedCollationStateV1;
    return {
      versions: old.versions,
      leftVersionId: old.leftVersionId,
      rightVersionId: old.rightVersionId,
      rules: old.rules,
      sessions: {
        [pairKey(old.leftVersionId, old.rightVersionId)]: { rows: old.rows, selectedRowId: old.selectedRowId }
      }
    };
  }

  onMounted(() => {
    try {
      const persisted = loadPersisted();
      if (persisted && persisted.versions.length) {
        versions.value = persisted.versions;
        rules.value = { ...defaultRules(), ...persisted.rules };
        sessionStore.value = Object.fromEntries(
          Object.entries(persisted.sessions ?? {}).map(([key, session]) => [
            key,
            { rows: session.rows, selectedRowId: session.selectedRowId, history: [], future: [] }
          ])
        );
        const ids = new Set(persisted.versions.map((item) => item.id));
        leftVersionId.value = ids.has(persisted.leftVersionId) ? persisted.leftVersionId : persisted.versions[0].id;
        rightVersionId.value = ids.has(persisted.rightVersionId)
          ? persisted.rightVersionId
          : (persisted.versions[1]?.id ?? persisted.versions[0].id);
        activeKey.value = pairKey(leftVersionId.value, rightVersionId.value);
        const entry = sessionStore.value[activeKey.value];
        if (entry) {
          rows.value = entry.rows;
          selectedRowId.value = entry.selectedRowId;
          message.value = '已恢复浏览器中的校勘草稿，各版本组合进度各自保留';
        } else {
          message.value = '已恢复版本与规则，正在对齐当前组合…';
          void runAlignment(false);
        }
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment(false);
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
  });

  // 底本/参校本任一变化都视为切换组合：先存回当前组合，再载入或新建目标组合
  watch([leftVersionId, rightVersionId], () => {
    const key = pairKey(leftVersionId.value, rightVersionId.value);
    if (key === activeKey.value) return;
    stashActiveSession();
    activeKey.value = key;
    loadSession(key);
  });

  watch([() => rules.value.ignorePunctuation, () => rules.value.ignoreVariants], () => {
    if (!processing.value) persist();
  });

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rows,
    rules,
    selectedRowId,
    selectedRowIds,
    processing,
    progress,
    message,
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    unresolvedCount,
    pendingElsewhere,
    anyUnresolved,
    sessionSummaries,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    nextDifference,
    addVersion,
    activateSession,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit
  };
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
