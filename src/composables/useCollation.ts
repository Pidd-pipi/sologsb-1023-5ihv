import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Message } from '@arco-design/web-vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  ComparisonRules,
  LegacyCollationState,
  PairSession,
  PairSnapshot,
  PersistedWorkbench,
  TextUnit,
  VersionDocument
} from '../types';
import type { DifferenceStatus } from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v2';
const LEGACY_STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';
const MAX_HISTORY = 50;

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
  // 会话数据全是可 JSON 序列化的纯对象/数组；structuredClone 无法处理 Vue 的响应式代理。
  return JSON.parse(JSON.stringify(value)) as T;
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

/** 组合键带方向：同一底本对不同参校本、方向相反的组合各自独立。 */
export function pairKey(leftVersionId: string, rightVersionId: string) {
  return `${leftVersionId}::${rightVersionId}`;
}

function sessionUnresolved(session: PairSession): number {
  return session.rows.filter((row) => !row.accepted && row.status !== 'same').length;
}

export function useCollation() {
  const versions = ref<VersionDocument[]>([]);
  const sessions = ref<Record<string, PairSession>>({});
  const activePairKey = ref('');

  // 以下均为“当前组合”的工作视图，切换组合时整体换入/换出。
  const leftVersionId = ref('');
  const rightVersionId = ref('');
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<string[]>([]);

  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);

  /** 左侧“版本组合进度”列表所需的摘要。 */
  const pairSummaries = computed(() =>
    Object.values(sessions.value).map((session) => ({
      key: pairKey(session.leftVersionId, session.rightVersionId),
      leftName: versions.value.find((item) => item.id === session.leftVersionId)?.name ?? '未知版本',
      rightName: versions.value.find((item) => item.id === session.rightVersionId)?.name ?? '未知版本',
      unresolved: sessionUnresolved(session),
      updatedAt: session.updatedAt,
      active: pairKey(session.leftVersionId, session.rightVersionId) === activePairKey.value
    }))
  );

  /** 任意组合还有待办差异时都提醒，不只是当前组合。 */
  const totalUnresolvedCount = computed(() =>
    Object.values(sessions.value).reduce((sum, session) => sum + sessionUnresolved(session), 0)
  );

  function snapshot(): string {
    const data: PairSnapshot = {
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value,
      selectedRowIds: selectedRowIds.value
    };
    return JSON.stringify(data);
  }

  /** 把当前工作视图连同撤销栈写回所属组合。 */
  function flushActive() {
    if (!activePairKey.value) return;
    const session = sessions.value[activePairKey.value];
    if (!session) return;
    session.leftVersionId = leftVersionId.value;
    session.rightVersionId = rightVersionId.value;
    session.rows = rows.value;
    session.rules = rules.value;
    session.selectedRowId = selectedRowId.value;
    session.selectedRowIds = selectedRowIds.value;
    session.history = history.value;
    session.future = future.value;
    session.updatedAt = new Date().toISOString();
  }

  function persist() {
    flushActive();
    // 撤销/重做栈只在本次会话内有效，不写入 localStorage，避免长文本下迅速撑爆配额。
    const storedSessions = Object.fromEntries(
      Object.entries(sessions.value).map(([key, session]) => [
        key,
        { ...session, history: [], future: [] }
      ])
    );
    const data: PersistedWorkbench = {
      schema: 2,
      versions: versions.value,
      activePairKey: activePairKey.value,
      sessions: storedSessions
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('校勘数据写入本地失败', error);
      Message.warning('本地存储空间不足，本次进度可能无法保存，建议先导出 JSON 备份');
    }
  }

  let persistTimer = 0;
  function schedulePersist() {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => persist(), 300);
  }

  function applySnapshot(raw: string) {
    const parsed = JSON.parse(raw) as PairSnapshot;
    rows.value = parsed.rows;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
    selectedRowIds.value = parsed.selectedRowIds;
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > MAX_HISTORY) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    applySnapshot(previous);
    message.value = '已撤销上一步操作';
    persist();
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    applySnapshot(next);
    message.value = '已重做上一步操作';
    persist();
  }

  function loadSession(session: PairSession) {
    activePairKey.value = pairKey(session.leftVersionId, session.rightVersionId);
    leftVersionId.value = session.leftVersionId;
    rightVersionId.value = session.rightVersionId;
    rows.value = session.rows;
    rules.value = clone(session.rules);
    selectedRowId.value = session.selectedRowId;
    selectedRowIds.value = [...session.selectedRowIds];
    history.value = [...session.history];
    future.value = [...session.future];
  }

  function createSession(leftId: string, rightId: string, initialRules?: ComparisonRules): PairSession {
    const now = new Date().toISOString();
    const session: PairSession = {
      leftVersionId: leftId,
      rightVersionId: rightId,
      rows: [],
      rules: clone(initialRules ?? defaultRules()),
      selectedRowId: '',
      selectedRowIds: [],
      aligned: false,
      history: [],
      future: [],
      createdAt: now,
      updatedAt: now
    };
    sessions.value[pairKey(leftId, rightId)] = session;
    return session;
  }

  /**
   * 切换到另一组版本组合：先存好当前组合的全部进度，再换入目标组合；
   * 目标组合第一次进入（aligned=false）时自动执行分片对齐。
   */
  async function activatePair(leftId: string, rightId: string, beforeSwitch?: () => void) {
    if (!leftId || !rightId || leftId === rightId) return;
    if (processing.value) {
      Message.warning('正在自动对齐，请稍候再切换版本组合');
      return;
    }
    const key = pairKey(leftId, rightId);
    if (key === activePairKey.value) return;

    beforeSwitch?.();
    persist();

    let session = sessions.value[key];
    if (!session) {
      session = createSession(leftId, rightId, rules.value);
      message.value = '首次进入该版本组合，正在自动对齐…';
    } else {
      message.value = `已切回「${versions.value.find((item) => item.id === leftId)?.name ?? ''} ↔ ${
        versions.value.find((item) => item.id === rightId)?.name ?? ''
      }」，继续上次的校勘位置`;
    }
    loadSession(session);
    persist();

    if (!session.aligned) {
      await runAlignment(false);
    }
  }

  /** 底本下拉变化（含选中与当前参校本相同的回退保护）。 */
  async function changeLeftVersion(nextId: unknown) {
    const id = String(nextId ?? '');
    if (!id || id === leftVersionId.value) return;
    if (id === rightVersionId.value) {
      Message.warning('底本与参校本不能是同一个版本，已保持当前组合');
      leftVersionId.value = activeSessionLeft();
      return;
    }
    await activatePair(id, rightVersionId.value);
  }

  async function changeRightVersion(nextId: unknown) {
    const id = String(nextId ?? '');
    if (!id || id === rightVersionId.value) return;
    if (id === leftVersionId.value) {
      Message.warning('参校本与底本不能是同一个版本，已保持当前组合');
      rightVersionId.value = activeSessionRight();
      return;
    }
    await activatePair(leftVersionId.value, id);
  }

  function activeSessionLeft() {
    const current = activePairKey.value ? sessions.value[activePairKey.value] : undefined;
    return current?.leftVersionId ?? '';
  }

  function activeSessionRight() {
    const current = activePairKey.value ? sessions.value[activePairKey.value] : undefined;
    return current?.rightVersionId ?? '';
  }

  /** 左侧组合列表点击切换；beforeSwitch 用于先带走未保存的校记草稿。 */
  async function switchPairByKey(key: string, beforeSwitch?: () => void) {
    const session = sessions.value[key];
    if (!session) return;
    await activatePair(session.leftVersionId, session.rightVersionId, beforeSwitch);
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    try {
      const result = await alignUnits(leftVersion.value.units, rightVersion.value.units, rules.value, (value) => {
        progress.value = value;
      });
      if (commitHistory) {
        history.value.push(previous);
        if (history.value.length > MAX_HISTORY) history.value.shift();
        future.value = [];
      }
      rows.value = result;
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      const session = activePairKey.value ? sessions.value[activePairKey.value] : undefined;
      if (session) session.aligned = true;
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

  /** 规则勾选：v-model 已先改值，这里把旧规则与旧行状态记入撤销历史，再按新规则重算。 */
  function toggleRule(key: 'ignorePunctuation' | 'ignoreVariants') {
    const previousRules: ComparisonRules = { ...rules.value, [key]: !rules.value[key] };
    const previousRows = rows.value.map((row) => {
      if (!row.left || !row.right) return row;
      const score = Number(
        similarity(normalized(row.left.text, previousRules), normalized(row.right.text, previousRules)).toFixed(3)
      );
      return { ...row, similarity: score, status: statusFor(row.left, row.right, score) };
    });
    history.value.push(
      JSON.stringify({
        rows: previousRows,
        rules: previousRules,
        selectedRowId: selectedRowId.value,
        selectedRowIds: selectedRowIds.value
      } satisfies PairSnapshot)
    );
    if (history.value.length > MAX_HISTORY) history.value.shift();
    future.value = [];
    rows.value = rows.value.map((row) => {
      if (!row.left || !row.right) return row;
      const score = Number(
        similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
      );
      return { ...row, similarity: score, status: statusFor(row.left, row.right, score) };
    });
    selectedRowIds.value = [];
    message.value = '已按比较规则重算差异';
    persist();
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) Object.assign(row, patch, { manuallyAdjusted: true });
    });
  }

  /** 切组合前，把详情面板里尚未点“保存”的校勘说明先带走。 */
  function flushDraftNote(id: string, note: string, source: string) {
    const row = rows.value.find((item) => item.id === id);
    if (!row) return;
    const nextNote = note.trim();
    const nextSource = source.trim();
    if (row.note === nextNote && row.source === nextSource) return;
    history.value.push(snapshot());
    if (history.value.length > MAX_HISTORY) history.value.shift();
    future.value = [];
    row.note = nextNote;
    row.source = nextSource;
    row.manuallyAdjusted = true;
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

  function selectRow(id: string) {
    if (selectedRowId.value === id) return;
    selectedRowId.value = id;
    schedulePersist();
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
    persist();
    // 新导入的版本与当前底本构成的是全新组合，第一次进入会自动对齐。
    void activatePair(leftVersionId.value || versions.value[0]?.id || '', id);
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

  function migrateLegacy(raw: string): PersistedWorkbench | null {
    try {
      const legacy = JSON.parse(raw) as LegacyCollationState;
      if (!Array.isArray(legacy.versions) || !legacy.leftVersionId || !legacy.rightVersionId) return null;
      const now = new Date().toISOString();
      const key = pairKey(legacy.leftVersionId, legacy.rightVersionId);
      const session: PairSession = {
        leftVersionId: legacy.leftVersionId,
        rightVersionId: legacy.rightVersionId,
        rows: Array.isArray(legacy.rows) ? legacy.rows : [],
        rules: legacy.rules ?? defaultRules(),
        selectedRowId: legacy.selectedRowId ?? '',
        selectedRowIds: [],
        // 旧版本已有对齐结果，不重复自动对齐；撤销栈按新结构重新开始。
        aligned: Array.isArray(legacy.rows) && legacy.rows.length > 0,
        history: [],
        future: [],
        createdAt: now,
        updatedAt: now
      };
      return { schema: 2, versions: legacy.versions, activePairKey: key, sessions: { [key]: session } };
    } catch {
      return null;
    }
  }

  onMounted(() => {
    let workbench: PersistedWorkbench | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) workbench = JSON.parse(raw) as PersistedWorkbench;
    } catch (error) {
      console.error('v2 本地草稿读取失败', error);
    }

    if (!workbench) {
      const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyRaw) {
        workbench = migrateLegacy(legacyRaw);
        if (workbench) message.value = '已从旧版草稿迁移，各版本组合的进度将分别保存';
      }
    }

    if (!workbench) {
      versions.value = clone(sampleVersions);
      const leftId = sampleVersions[0].id;
      const rightId = sampleVersions[1].id;
      const session = createSession(leftId, rightId);
      loadSession(session);
      persist();
      message.value = '已载入示例版本，正在自动对齐…';
      void runAlignment(false);
      return;
    }

    versions.value = workbench.versions ?? clone(sampleVersions);
    sessions.value = workbench.sessions ?? {};
    const first = sessions.value[workbench.activePairKey]
      ? sessions.value[workbench.activePairKey]
      : Object.values(sessions.value)[0];

    if (!first) {
      const leftId = versions.value[0]?.id ?? '';
      const rightId = versions.value[1]?.id ?? '';
      const session = createSession(leftId, rightId);
      loadSession(session);
      persist();
      void runAlignment(false);
      return;
    }

    loadSession(first);
    if (!first.aligned) {
      message.value = '该版本组合尚未对齐，正在自动对齐…';
      void runAlignment(false);
    } else {
      message.value = workbench.schema === 2 ? '已恢复浏览器中的校勘草稿' : '已从旧版草稿迁移，各版本组合的进度将分别保存';
      persist();
    }
  });

  onBeforeUnmount(() => {
    window.clearTimeout(persistTimer);
  });

  return {
    versions,
    sessions,
    activePairKey,
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
    totalUnresolvedCount,
    pairSummaries,
    runAlignment,
    recalculate,
    toggleRule,
    updateRow,
    flushDraftNote,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    nextDifference,
    selectRow,
    addVersion,
    activatePair,
    switchPairByKey,
    changeLeftVersion,
    changeRightVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    commit,
    schedulePersist
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
