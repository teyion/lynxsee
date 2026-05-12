import { BaseModule } from './BaseModule.js';
import {
  FetchResult,
  GateContext,
  GlobalSnapshot,
  ModuleState,
  ReflectContext,
  SubconsciousContext,
  Suggestion,
} from '../types/index.js';
import {
  buildMemoryReflectPlan,
  MemoryLoadedFragmentBrief,
} from '../subconscious/SubconsciousHelper.js';
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';
import { getConfiguredStateDir } from '../utils/runtimeStatePaths.js';
interface MemoryFragment {
  filePath: string;
  timestamp: number;
  layer: string;
  keyword: string;
  summary: string;
  text: string;
  relevanceScore: number;
  relevanceReason: string;
  sourceType: 'time' | 'strategy';
  sourceStrategy: string;
  sourceDetail: string;
}

type MemoryLayer = 'short_term' | 'episodic' | 'semantic';
type MemoryWriteAction = 'ADD' | 'UPDATE';

interface MemoryFact {
  type: '事实' | '偏好' | '事件' | '目标' | '风险' | '其他';
  content: string;
  confidence: number;
}

interface MemoryRecallCandidate {
  filePath: string;
  keyword: string;
  strategy: string;
  detail: string;
  score: number;
  ttlTurns: number;
  createdAt: number;
}

interface MemoryRuntimeStatus {
  phase: 'idle' | 'adjust' | 'fetch_recent' | 'fetch_recall' | 'update' | 'render' | 'reflect' | 'done';
  message: string;
  active: boolean;
  updatedAt: number;
}

interface MemoryIndexEntry {
  filePath: string;
  layer: string;
  timestamp: number;
  summary: string;
}

interface MemoryState extends ModuleState {
  pendingSuggestion: Suggestion | null;
  loadedFragments: MemoryFragment[];
  recallInbox: MemoryRecallCandidate[];
  stickyTargetFiles: MemoryRecallCandidate[];
  keywordCursorState: Record<string, string>;
  lastScannedOldestByKeyword: Record<string, string>;
  lastConversationRender: string;
  lastReflectMemoryFragmentWriteCount?: number;
  runtimeStatus: MemoryRuntimeStatus;
}

interface MemoryMetrics {
  updatedAt: string;
  totals: {
    writes: number;
    addWrites: number;
    updateWrites: number;
    duplicateLikeWrites: number;
    recallTurns: number;
    recallCandidatesBeforeRecentFilter: number;
    recallCandidatesFilteredByRecentWindow: number;
  };
  aggregates: {
    totalFragmentChars: number;
  };
  ratios: {
    duplicateWriteRate: number;
    updateAddRatio: number;
    avgFragmentLength: number;
    recentDuplicateRecallRate: number;
  };
}

function nowTs(): number {
  return Date.now();
}

function shortName(filePath: string): string {
  return path.basename(filePath);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeForCompare(text: string): string {
  return oneLine(text).replace(/[。！!,.，；;：:“”"'‘’（）()\[\]{}]/g, '').toLowerCase();
}

function extractRuleKeywords(text: string, limit: number): string[] {
  const tokens = text.match(/[\p{Script=Han}A-Za-z0-9_]{2,}/gu) ?? [];
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const k = t.trim();
    if (!k) continue;
    const lk = k.toLowerCase();
    if (seen.has(lk)) continue;
    seen.add(lk);
    uniq.push(k);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

export class MemoryModule extends BaseModule {
  id = 'memory';
  dependencies = ['persona'];
  private readonly stateDir = getConfiguredStateDir();
  private readonly memoryRoot = path.join(this.stateDir, 'memory', 'fragments');
  private readonly memoryMetricsPath = path.join(this.stateDir, 'memory', 'memory.metrics.json');
  private readonly layers: MemoryLayer[] = ['short_term', 'episodic', 'semantic'];
  private lifecycleTrace: string[] = [];
  private turnConversationRender = '';

  constructor(sort = 20) {
    super(sort);
    this.bindings = [
      {
        type: 'markdown',
        locator: this.memoryRoot,
        fetchDirectives: {},
        refreshPolicy: 'on_update',
      },
    ];
    this.directives = {
      ...this.directives,
      keywords: [],
      targetFiles: [],
      fragmentLimit: 6,
      historicalLaneLimit: 2,
      skipRecentMinutes: 10,
      maxCandidatesPerKeyword: 12,
      maxOnlineTopK: 6,
      keywordCursor: {},
      seekOlderKeywords: [],
      replacementStrategy: 'replace_lowest_score',
    };
  }

  protected override state: MemoryState = {
    activeTopics: [],
    temporalFocus: 'latest',
    pendingSuggestion: null as Suggestion | null,
    loadedFragments: [],
    recallInbox: [],
    stickyTargetFiles: [],
    keywordCursorState: {},
    lastScannedOldestByKeyword: {},
    lastConversationRender: '',
    lastReflectMemoryFragmentWriteCount: 0,
    runtimeStatus: {
      phase: 'idle',
      message: '记忆待命中',
      active: false,
      updatedAt: 0,
    },
  };

  async activationGate(ctx: GateContext): Promise<boolean> {
    this.turnConversationRender = ctx.globalSnapshot.conversationRender;
    const indexPath = path.join(this.memoryRoot, 'memory.index.md');
    this.trace(
      `activationGate: stateDir=${this.stateDir} memoryRoot=${this.memoryRoot} indexPath=${indexPath} indexExists=${fs.existsSync(
        indexPath
      )}`
    );
    console.log(
      `[MemoryModule] activationGate stateDir=${this.stateDir} memoryRoot=${this.memoryRoot} indexPath=${indexPath} indexExists=${fs.existsSync(
        indexPath
      )}`
    );
    return true;
  }

  async subconsciousAdjust(ctx: SubconsciousContext): Promise<void> {
    this.lifecycleTrace = [];
    this.setRuntimeStatus('adjust', '正在规划最近记忆与慢回忆候选...', true);
    this.trace(`subconsciousAdjust: start userInput="${ctx.userInput}"`);
    const previousCursor = this.state.keywordCursorState ?? {};
    let keywordCursor: Record<string, string> = { ...previousCursor };
    const indexPath = path.join(this.memoryRoot, 'memory.index.md');
    let indexTail = '';
    let indexLineCount = 0;
    try {
      if (fs.existsSync(indexPath)) {
        const raw = await readFile(indexPath, 'utf-8');
        const lines = raw.split('\n').filter((line) => line.trim().length > 0);
        indexLineCount = lines.length;
        indexTail = lines.slice(-3).join(' || ');
      }
    } catch (err) {
      this.trace(`subconsciousAdjust: indexReadError=${String(err)}`);
    }
    this.trace(
      `subconsciousAdjust: indexDiagnostic exists=${fs.existsSync(indexPath)} lineCount=${indexLineCount} tail="${indexTail}"`
    );
    console.log(
      `[MemoryModule] subconsciousAdjust indexDiagnostic path=${indexPath} exists=${fs.existsSync(
        indexPath
      )} lineCount=${indexLineCount} tail="${indexTail}"`
    );

    // A: 使用规则化策略，去掉每轮 adjust-plan LLM 调用。
    const suggestion = ctx.pendingSuggestion?.adjustedFetchDirectives ?? {};
    const suggestedKeywords = Array.isArray(suggestion.keywords)
      ? suggestion.keywords.map((x: any) => String(x).trim()).filter(Boolean)
      : [];
    const suggestedTargetFiles = Array.isArray(suggestion.targetFiles)
      ? suggestion.targetFiles.map((x: any) => String(x).trim()).filter(Boolean)
      : [];
    const suggestedSeekOlder = Array.isArray(suggestion.seekOlderKeywords)
      ? suggestion.seekOlderKeywords.map((x: any) => String(x).trim()).filter(Boolean)
      : [];
    const suggestedFragmentLimit = Number(suggestion.fragmentLimit);
    const recallTargets = this.consumeRecallCandidates(this.state.recallInbox, 4);
    const stickyTargets = this.consumeRecallCandidates(this.state.stickyTargetFiles, 4);
    const baseKeywords = extractRuleKeywords(ctx.userInput, 8);
    const adoptSuggestion =
      suggestedKeywords.length > 0 ||
      suggestedTargetFiles.length > 0 ||
      suggestedSeekOlder.length > 0 ||
      Number.isFinite(suggestedFragmentLimit);
    this.trace(
      `subconsciousAdjust: decisionInput suggestedKeywords=[${suggestedKeywords.join(
        ', '
      )}] suggestedTargetFiles=[${suggestedTargetFiles.join(', ')}] suggestedSeekOlder=[${suggestedSeekOlder.join(
        ', '
      )}] suggestedFragmentLimit=${Number.isFinite(suggestedFragmentLimit) ? suggestedFragmentLimit : 'N/A'}`
    );

    let keywords = (suggestedKeywords.length > 0 ? suggestedKeywords : baseKeywords).slice(0, 8);
    const recallKeywords = [...new Set(recallTargets.map((item) => item.keyword).filter(Boolean))].slice(0, 4);
    if (keywords.length < 8) {
      keywords = [...new Set([...keywords, ...recallKeywords])].slice(0, 8);
    }
    if (keywords.length === 0) {
      keywords = this.state.activeTopics.slice(0, 6);
    }
    if (keywords.length === 0) {
      keywords = ['当前对话'];
    }
    const seekOlderKeywords = new Set<string>(suggestedSeekOlder);
    const fragmentLimit = Math.max(
      1,
      Number.isFinite(suggestedFragmentLimit)
        ? Math.floor(suggestedFragmentLimit)
        : Number(this.directives.fragmentLimit ?? 6)
    );

    for (const keyword of keywords) {
      if (!keywordCursor[keyword]) {
        keywordCursor[keyword] = String(nowTs());
      }
      if (seekOlderKeywords.has(keyword)) {
        const oldest = Number(this.state.lastScannedOldestByKeyword[keyword] ?? keywordCursor[keyword]);
        keywordCursor[keyword] = String(Math.max(0, oldest - 1));
      }
    }

    const mergedTargetFiles = [...new Set([
      ...suggestedTargetFiles,
      ...recallTargets.map((item) => item.filePath),
      ...stickyTargets.map((item) => item.filePath),
    ])];

    this.directives.keywords = keywords;
    this.directives.targetFiles = mergedTargetFiles;
    this.directives.fragmentLimit = fragmentLimit;
    this.directives.keywordCursor = keywordCursor;
    this.directives.seekOlderKeywords = [...seekOlderKeywords];
    this.directives.maxCandidatesPerKeyword = Number(this.directives.maxCandidatesPerKeyword ?? 30);
    this.directives.maxOnlineTopK = Number(this.directives.maxOnlineTopK ?? 6);
    this.directives.historicalLaneLimit = Math.max(1, Number(this.directives.historicalLaneLimit ?? 2));
    this.directives.memoryRoot = this.memoryRoot;

    this.state.activeTopics = keywords;
    this.state.temporalFocus = 'latest';
    this.trace(
      `subconsciousAdjust: rulePlan adoptSuggestion=${adoptSuggestion} keywords=[${keywords.join(
        ', '
      )}] targetFiles=[${mergedTargetFiles.join(', ')}] seekOlder=[${[...seekOlderKeywords].join(
        ', '
      )}] fragmentLimit=${fragmentLimit} cursor=${JSON.stringify(keywordCursor)}`
    );
    console.log(
      `[MemoryModule] subconsciousAdjust decision adoptSuggestion=${adoptSuggestion} keywords=[${keywords.join(
        ', '
      )}] targetFiles=[${mergedTargetFiles.join(', ')}] seekOlder=[${[...seekOlderKeywords].join(
        ', '
      )}] fragmentLimit=${fragmentLimit}`
    );
    this.trace(
      `subconsciousAdjust: recallTargets=${recallTargets.length} stickyTargets=${stickyTargets.length} recallKeywords=[${recallKeywords.join(
        ', '
      )}]`
    );
    this.state.pendingSuggestion = null;
    this.setRuntimeStatus(
      'adjust',
      `已规划最近记忆 + 历史回忆候选 ${Math.min(
        Number(this.directives.historicalLaneLimit ?? 2),
        mergedTargetFiles.length
      )} 条`,
      true
    );
  }

  async fetchData(): Promise<FetchResult[]> {
    await this.ensureMemoryDirs();
    this.setRuntimeStatus('fetch_recent', '正在加载最近记忆 TopK...', true);
    const maxOnlineTopK = Math.max(1, Number(this.directives.maxOnlineTopK ?? 6));
    const fragmentLimit = Math.max(1, Number(this.directives.fragmentLimit ?? 6));
    const historicalLaneLimit = Math.max(1, Number(this.directives.historicalLaneLimit ?? 2));
    const targetFiles = (this.directives.targetFiles as string[]) ?? [];
    this.trace(
      `fetchData: start mode=offline_first_then_time_topk fragmentLimit=${fragmentLimit} maxOnlineTopK=${maxOnlineTopK} targetFiles=${targetFiles.length}`
    );
    console.log(
      `[MemoryModule] fetchData start mode=offline_first_then_time_topk fragmentLimit=${fragmentLimit} maxOnlineTopK=${maxOnlineTopK} targetFiles=${targetFiles.length}`
    );

    const scannedOldestByKeyword: Record<string, string> = {};
    const candidates = await this.listAllFragmentCandidates();
    const beforeRecentFilter = candidates.length;
    await this.recordRecallMetrics({
      candidatesBeforeRecentFilter: beforeRecentFilter,
      filteredByRecentWindow: 0,
    });
    candidates.sort((a, b) => b.timestamp - a.timestamp);
    this.trace(`fetchData: totalFragments=${candidates.length}`);
    if (candidates.length > 0) {
      this.trace(
        `fetchData: latestOrder=[${candidates
          .slice(0, 20)
          .map((c) => shortName(c.filePath))
          .join(', ')}]`
      );
    }

    // 主路永远保留最近记忆，慢回忆只作为补位，不替换 recent topK。
    const candidateMap = new Map(candidates.map((item) => [item.filePath, item]));
    const strategyCandidateMap = this.buildStrategyCandidateMap();
    const recentCandidates: Array<{ keyword: string; filePath: string; layer: string; timestamp: number }> = [];
    const selectedPaths = new Set<string>();
    for (const item of candidates) {
      if (selectedPaths.has(item.filePath)) continue;
      recentCandidates.push(item);
      selectedPaths.add(item.filePath);
      if (recentCandidates.length >= maxOnlineTopK) break;
    }
    this.setRuntimeStatus('fetch_recall', '正在补挂慢回忆候选...', true);
    const historicalCandidates: Array<{ keyword: string; filePath: string; layer: string; timestamp: number }> = [];
    for (const filePath of targetFiles) {
      const hit = candidateMap.get(filePath);
      if (!hit) continue;
      if (selectedPaths.has(hit.filePath)) continue;
      const strategyHit = strategyCandidateMap.get(hit.filePath);
      historicalCandidates.push({
        ...hit,
        keyword: strategyHit?.keyword || hit.keyword,
      });
      selectedPaths.add(hit.filePath);
      if (historicalCandidates.length >= historicalLaneLimit) break;
    }
    const finalCandidates = [...recentCandidates, ...historicalCandidates];
    this.trace(
      `fetchData: selected recent=${recentCandidates.length} historical=${historicalCandidates.length} files=[${finalCandidates
        .map((c) => shortName(c.filePath))
        .join(', ')}]`
    );
    const loaded = await Promise.all(
      finalCandidates.map(async (item, idx) => {
        try {
          const text = await readFile(item.filePath, 'utf-8');
          const recencyScore = Math.max(0.4, 1 - idx / Math.max(1, recentCandidates.length));
          const fromOfflineStrategy = targetFiles.includes(item.filePath);
          return {
            ...item,
            text,
            relevanceScore: fromOfflineStrategy ? 0.95 : recencyScore,
            relevanceReason: fromOfflineStrategy ? '离线策略指定碎片' : '在线按时间最新TopK补齐',
            sourceType: fromOfflineStrategy ? ('strategy' as const) : ('time' as const),
            sourceStrategy: fromOfflineStrategy
              ? this.describeTargetFileStrategy(item.filePath)
              : 'recent_time_topk',
            sourceDetail: fromOfflineStrategy
              ? this.describeTargetFileDetail(item.filePath)
              : '按时间倒序保留最近记忆',
          };
        } catch (error: any) {
          if (error?.code === 'ENOENT') {
            this.trace(`fetchData: skip missing fragment file=${shortName(item.filePath)}`);
          } else {
            this.trace(`fetchData: read fragment failed file=${shortName(item.filePath)} error=${String(error)}`);
          }
          return null;
        }
      })
    );
    const selected = loaded.filter((x): x is NonNullable<typeof x> => Boolean(x));
    const effectiveLimit = Math.max(fragmentLimit, recentCandidates.length + historicalCandidates.length);
    const finalSelected = selected.slice(0, effectiveLimit);
    const fragments: MemoryFragment[] = finalSelected.map((item) => ({
      filePath: item.filePath,
      timestamp: item.timestamp,
      layer: item.layer,
      keyword: item.keyword,
      summary: this.extractFragmentSummary(item.text),
      text: item.text,
      relevanceScore: item.relevanceScore,
      relevanceReason: item.relevanceReason,
      sourceType: item.sourceType,
      sourceStrategy: item.sourceStrategy,
      sourceDetail: item.sourceDetail,
    }));

    this.trace(
      `fetchData: finalSelected=${fragments.length} fragmentLimit=${fragmentLimit} files=[${fragments
        .map((f) => path.basename(f.filePath))
        .join(', ')}]`
    );
    if (fragments.length > 0) {
      this.trace(
        `fetchData: selectedDetail=[${fragments
          .map(
            (f) =>
              `${shortName(f.filePath)} keyword=${f.keyword} score=${f.relevanceScore.toFixed(2)} source=${f.sourceType}/${f.sourceStrategy}`
          )
          .join(' | ')}]`
      );
    }
    this.setRuntimeStatus(
      'fetch_recall',
      `已挂载最近 ${recentCandidates.length} 条 + 历史 ${historicalCandidates.length} 条`,
      true
    );
    return [
      {
        bindingIndex: 0,
        data: {
          fragments,
          scannedOldestByKeyword,
        },
      },
    ];
  }

  private async listAllFragmentCandidates(): Promise<
    Array<{ keyword: string; filePath: string; layer: string; timestamp: number }>
  > {
    const out: Array<{ keyword: string; filePath: string; layer: string; timestamp: number }> = [];
    const dirs = this.layers.map((layer) => ({ layer, dir: path.join(this.memoryRoot, layer) }));
    for (const { layer, dir } of dirs) {
      let names: string[] = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        const filePath = path.join(dir, name);
        const match = name.match(/^(\d+)__/);
        const timestamp = match ? Number(match[1]) : 0;
        out.push({
          keyword: 'time_topk',
          filePath,
          layer,
          timestamp,
        });
      }
    }
    return out;
  }

  async update(_userInput: string, snapshot: GlobalSnapshot, freshData: FetchResult[]): Promise<void> {
    this.setRuntimeStatus('update', '正在写入记忆挂载结果...', true);
    const data = (freshData[0]?.data as
      | {
          fragments?: MemoryFragment[];
          scannedOldestByKeyword?: Record<string, string>;
        }
      | undefined) ?? { fragments: [], scannedOldestByKeyword: {} };

    this.state.loadedFragments = data.fragments ?? [];
    this.state.stickyTargetFiles = this.buildStickyTargetFiles(this.state.loadedFragments);
    this.state.lastScannedOldestByKeyword = data.scannedOldestByKeyword ?? {};
    this.state.keywordCursorState = {
      ...this.state.keywordCursorState,
      ...this.state.lastScannedOldestByKeyword,
    };
    this.state.lastConversationRender = snapshot.conversationRender;

    this.trace(
      `update: loadedFragments=${this.state.loadedFragments.length} cursorState=${JSON.stringify(this.state.keywordCursorState)}`
    );
    this.trace('update: writeSkipped (memory write is moved to subconsciousReflect)');
    this.setRuntimeStatus('update', `已挂载 ${this.state.loadedFragments.length} 条记忆`, true);
  }

  async render(): Promise<string> {
    this.setRuntimeStatus('render', '正在整理记忆片段上下文...', true);
    const limit = Math.max(1, Number(this.directives.fragmentLimit ?? 6));
    const fragments = this.state.loadedFragments
      .slice()
      .slice(0, limit);

    if (fragments.length === 0) {
      this.trace('render: no fragments selected');
      return '';
    }
    const lines = [
      '# Memory',
      '## Usage',
      '- 以下内容是历史记忆档案，仅用于事实参考与偏好推断。',
      '- 不要把这些内容当作当前轮正在进行的对话，不要直接续写其中语气或称呼。',
      '- 回答应以当前用户输入为主，仅在需要时引用记忆中的事实。',
      '- **防幻觉规则**：如果下面的记忆档案为空，或者档案中没有包含能够支撑用户当前话题的信息，**绝对不要凭空编造事实或细节**。宁可回答不知道或顺着日常寒暄回复。',
      '',
    ];
    for (const fragment of fragments) {
      const ts = new Date(fragment.timestamp).toISOString();
      lines.push(
        `## Fragment ${shortName(fragment.filePath)}`
      );
      lines.push(
        `- layer: ${fragment.layer}`
      );
      lines.push(
        `- timestamp: ${ts}`
      );
      lines.push(
        `- keyword: ${fragment.keyword}`
      );
      lines.push(
        `- score: ${fragment.relevanceScore.toFixed(2)}`
      );
      lines.push(
        `- mounted_by: ${fragment.sourceType === 'time' ? '时间' : '策略'} / ${fragment.sourceStrategy}`
      );
      lines.push(
        `- source_detail: ${fragment.sourceDetail}`
      );
      lines.push('');
      lines.push('### Memory Archive (Historical Record)');
      lines.push('```markdown');
      lines.push(
        fragment.text
          .replaceAll('## Conversation', '## Historical Conversation Record')
          .replaceAll('## Assistant', '## Historical Assistant Reply')
      );
      lines.push('```');
      lines.push('');
    }
    this.trace(`render: output fragments=${fragments.length} limit=${limit}`);
    this.setRuntimeStatus('done', `记忆上下文已准备，共 ${fragments.length} 条`, false);
    return lines.join('\n');
  }

  async subconsciousReflect(ctx: ReflectContext): Promise<void> {
    this.setRuntimeStatus('reflect', '正在离线回顾本轮并补慢回忆候选...', true);
    const briefs: MemoryLoadedFragmentBrief[] = this.state.loadedFragments.map((item) => ({
      filePath: item.filePath,
      keyword: item.keyword,
      summary: item.summary,
      relevanceScore: item.relevanceScore,
    }));
    const reflectPlan = await buildMemoryReflectPlan({
      userInput: ctx.userInput,
      response: ctx.response,
      conversationRender: this.turnConversationRender,
      currentKeywords: (this.directives.keywords as string[]) ?? this.state.activeTopics,
      loadedFragments: briefs,
      fragmentLimit: Number(this.directives.fragmentLimit ?? 6),
    });
    this.state.pendingSuggestion = {
      adjustedFetchDirectives: reflectPlan.adjustedFetchDirectives ?? {},
      reason: reflectPlan.reason,
      confidence: reflectPlan.confidence,
    };
    const recallCandidates = await this.buildOfflineRecallCandidates({
      userInput: ctx.userInput,
      response: ctx.response,
      currentKeywords: (this.directives.keywords as string[]) ?? this.state.activeTopics,
      loadedFragments: briefs,
      suggestedTargetFiles: Array.isArray(reflectPlan.adjustedFetchDirectives?.targetFiles)
        ? reflectPlan.adjustedFetchDirectives.targetFiles.map((item: any) => String(item).trim()).filter(Boolean)
        : [],
    });
    this.state.recallInbox = recallCandidates;
    this.state.pendingSuggestion.adjustedFetchDirectives = {
      ...(this.state.pendingSuggestion.adjustedFetchDirectives ?? {}),
      targetFiles: [
        ...new Set([
          ...(((this.state.pendingSuggestion.adjustedFetchDirectives ?? {}).targetFiles as string[] | undefined) ?? []),
          ...recallCandidates.map((item) => item.filePath),
        ]),
      ],
      keywords: [
        ...new Set([
          ...((((this.state.pendingSuggestion.adjustedFetchDirectives ?? {}).keywords as string[] | undefined) ?? []) || []),
          ...recallCandidates.map((item) => item.keyword).filter(Boolean),
        ]),
      ].slice(0, 8),
    };
    this.trace(
      `subconsciousReflect: llmPlan confidence=${reflectPlan.confidence.toFixed(2)} reason="${reflectPlan.reason}" adjusted=${JSON.stringify(
        reflectPlan.adjustedFetchDirectives ?? {}
      )}`
    );
    if (reflectPlan.writePlan.shouldWrite) {
      const filePath = await this.writeMemoryFragment({
        action: reflectPlan.writePlan.action,
        targetFilePath: reflectPlan.writePlan.targetFilePath,
        layer: reflectPlan.writePlan.layer,
        keywords: reflectPlan.writePlan.keywords,
        summary: reflectPlan.writePlan.summary,
        facts: reflectPlan.writePlan.facts,
        conversationText: this.turnConversationRender || `User: ${ctx.userInput}`,
        response: ctx.response,
      });
      this.state.lastReflectMemoryFragmentWriteCount = 1;
      this.trace(
        `subconsciousReflect: write fragment file=${filePath} action=${reflectPlan.writePlan.action} layer=${reflectPlan.writePlan.layer}`
      );
    } else {
      this.state.lastReflectMemoryFragmentWriteCount = 0;
      this.trace('subconsciousReflect: write skipped by llm plan');
    }
    this.trace(
      `subconsciousReflect: confidence=${this.state.pendingSuggestion.confidence.toFixed(
        2
      )} reason="${this.state.pendingSuggestion.reason}"`
    );
    this.trace(
      `subconsciousReflect: recallInbox=${recallCandidates.length} files=[${recallCandidates
        .map((item) => shortName(item.filePath))
        .join(', ')}]`
    );
    this.setRuntimeStatus('done', `离线回顾完成，补充 ${recallCandidates.length} 条慢回忆候选`, false);
  }

  getLifecycleTrace(): string[] {
    return [...this.lifecycleTrace];
  }

  private trace(message: string): void {
    this.lifecycleTrace.push(message);
  }

  private setRuntimeStatus(
    phase: MemoryRuntimeStatus['phase'],
    message: string,
    active: boolean
  ): void {
    this.state.runtimeStatus = {
      phase,
      message,
      active,
      updatedAt: nowTs(),
    };
    this.trace(`runtimeStatus: phase=${phase} active=${active} message="${message}"`);
  }

  private consumeRecallCandidates(candidates: MemoryRecallCandidate[], limit: number): MemoryRecallCandidate[] {
    const next: MemoryRecallCandidate[] = [];
    const selected: MemoryRecallCandidate[] = [];
    for (const item of candidates) {
      const ttlTurns = Math.max(0, Number(item.ttlTurns ?? 0));
      if (ttlTurns <= 0) {
        continue;
      }
      if (selected.length < limit) {
        selected.push({
          ...item,
          ttlTurns: ttlTurns - 1,
        });
      }
      if (ttlTurns - 1 > 0) {
        next.push({
          ...item,
          ttlTurns: ttlTurns - 1,
        });
      }
    }
    if (candidates === this.state.recallInbox) {
      this.state.recallInbox = next;
    } else if (candidates === this.state.stickyTargetFiles) {
      this.state.stickyTargetFiles = next;
    }
    return selected;
  }

  private buildStickyTargetFiles(fragments: MemoryFragment[]): MemoryRecallCandidate[] {
    return fragments
      .filter((fragment) => fragment.sourceType === 'strategy')
      .slice(0, 3)
      .map((fragment) => ({
        filePath: fragment.filePath,
        keyword: fragment.keyword,
        strategy: fragment.sourceStrategy,
        detail: fragment.sourceDetail,
        score: fragment.relevanceScore,
        ttlTurns: 2,
        createdAt: nowTs(),
      }));
  }

  private buildStrategyCandidateMap(): Map<string, MemoryRecallCandidate> {
    const merged = [...this.state.recallInbox, ...this.state.stickyTargetFiles];
    const map = new Map<string, MemoryRecallCandidate>();
    for (const item of merged) {
      const existed = map.get(item.filePath);
      if (!existed || item.score > existed.score || item.createdAt > existed.createdAt) {
        map.set(item.filePath, item);
      }
    }
    return map;
  }

  private describeTargetFileStrategy(filePath: string): string {
    const hit = this.buildStrategyCandidateMap().get(filePath);
    if (hit) {
      return hit.strategy;
    }
    return 'offline_target_files';
  }

  private describeTargetFileDetail(filePath: string): string {
    const hit = this.buildStrategyCandidateMap().get(filePath);
    if (hit) {
      return hit.detail;
    }
    return '由离线策略补挂到当前轮';
  }

  private collectRecallAnchors(input: {
    userInput: string;
    response: string;
    currentKeywords: string[];
    loadedFragments: MemoryLoadedFragmentBrief[];
  }): string[] {
    const anchorPool = [
      ...extractRuleKeywords(input.userInput, 10),
      ...extractRuleKeywords(input.response, 8),
      ...input.currentKeywords,
      ...input.loadedFragments.flatMap((fragment) =>
        [fragment.keyword, ...extractRuleKeywords(fragment.summary, 4)].filter(Boolean)
      ),
    ];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of anchorPool) {
      const anchor = String(raw).trim();
      if (!anchor) continue;
      const normalized = anchor.toLowerCase();
      if (seen.has(normalized)) continue;
      if (anchor.length < 2) continue;
      seen.add(normalized);
      out.push(anchor);
      if (out.length >= 16) break;
    }
    return out;
  }

  private async readMemoryIndexEntries(): Promise<MemoryIndexEntry[]> {
    const indexPath = path.join(this.memoryRoot, 'memory.index.md');
    try {
      const raw = await readFile(indexPath, 'utf-8');
      const entries: MemoryIndexEntry[] = [];
      for (const line of raw.split('\n')) {
        const match = line.match(/^- \[(\d+)\] \[([^\]]+)\] (.+?) : (.+)$/);
        if (!match) continue;
        const filePath = String(match[3]).trim();
        if (!this.isSafeMemoryPath(filePath) || !fs.existsSync(filePath)) {
          continue;
        }
        entries.push({
          timestamp: Number(match[1]) || 0,
          layer: String(match[2]).trim(),
          filePath,
          summary: String(match[4]).trim(),
        });
      }
      return entries;
    } catch {
      return [];
    }
  }

  private async buildOfflineRecallCandidates(input: {
    userInput: string;
    response: string;
    currentKeywords: string[];
    loadedFragments: MemoryLoadedFragmentBrief[];
    suggestedTargetFiles: string[];
  }): Promise<MemoryRecallCandidate[]> {
    const entries = await this.readMemoryIndexEntries();
    const loadedSet = new Set(input.loadedFragments.map((fragment) => fragment.filePath));
    const explicitTargets = new Set(
      input.suggestedTargetFiles.map((filePath) => String(filePath).trim()).filter((filePath) => this.isSafeMemoryPath(filePath))
    );
    const anchors = this.collectRecallAnchors(input);
    const scored: MemoryRecallCandidate[] = [];
    for (const entry of entries) {
      if (loadedSet.has(entry.filePath)) {
        continue;
      }
      const haystack = `${shortName(entry.filePath)} ${entry.summary}`.toLowerCase();
      const matchedAnchors = anchors.filter((anchor) => haystack.includes(anchor.toLowerCase()));
      if (matchedAnchors.length === 0 && !explicitTargets.has(entry.filePath)) {
        continue;
      }
      const ageDays = entry.timestamp > 0 ? Math.max(0, (nowTs() - entry.timestamp) / (24 * 60 * 60 * 1000)) : 999;
      const recencyBoost = Math.max(0, 0.4 - Math.min(0.35, ageDays * 0.01));
      const explicitBoost = explicitTargets.has(entry.filePath) ? 1.2 : 0;
      const score = matchedAnchors.length * 0.7 + recencyBoost + explicitBoost;
      const primaryAnchor = matchedAnchors[0] ?? input.currentKeywords[0] ?? 'historical_recall';
      scored.push({
        filePath: entry.filePath,
        keyword: primaryAnchor,
        strategy: explicitTargets.has(entry.filePath) ? 'offline_reflect_target' : 'historical_anchor_recall',
        detail:
          explicitTargets.has(entry.filePath)
            ? `离线反思明确指定，锚点=${matchedAnchors.slice(0, 3).join('、') || primaryAnchor}`
            : `慢回忆锚点命中：${matchedAnchors.slice(0, 3).join('、')}`,
        score,
        ttlTurns: 2,
        createdAt: nowTs(),
      });
    }
    return scored
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.createdAt - a.createdAt;
      })
      .slice(0, 4);
  }

  private async ensureMemoryDirs(): Promise<void> {
    for (const layer of this.layers) {
      await mkdir(path.join(this.memoryRoot, layer), { recursive: true });
    }
  }

  private extractFragmentSummary(text: string): string {
    const match = text.match(/## Summary\s+([\s\S]*?)(?:\n## |\s*$)/);
    if (match?.[1]) {
      return oneLine(match[1]).slice(0, 120);
    }
    return text.split('\n')[0].replace(/^#\s*/, '').slice(0, 80);
  }

  private async writeMemoryFragment(input: {
    action: MemoryWriteAction;
    targetFilePath?: string;
    layer: MemoryLayer;
    keywords: string[];
    summary: string;
    facts: MemoryFact[];
    conversationText: string;
    response: string;
  }): Promise<string> {
    await this.ensureMemoryDirs();
    const ts = nowTs();
    const contextSnapshot = oneLine(input.conversationText).slice(0, 240);
    const responseSnapshot = oneLine(input.response).slice(0, 200);
    const dedupFacts = this.dedupFacts(input.facts);
    const summary = oneLine(input.summary).slice(0, 220) || responseSnapshot || contextSnapshot || 'memory updated';

    if (input.action === 'UPDATE' && input.targetFilePath && this.isSafeMemoryPath(input.targetFilePath)) {
      try {
        const current = await readFile(input.targetFilePath, 'utf-8');
        const mergedFacts = this.mergeFactsFromExisting(current, dedupFacts);
        const targetLayer = this.layerFromPath(input.targetFilePath) ?? input.layer;
        const md = this.buildStructuredMemoryMarkdown({
          ts,
          layer: targetLayer,
          keywords: input.keywords,
          summary,
          facts: mergedFacts,
          contextSnapshot,
          responseSnapshot,
        });
        await writeFile(input.targetFilePath, md, 'utf-8');
        await this.upsertMemoryIndexLine({
          filePath: input.targetFilePath,
          layer: targetLayer,
          timestamp: ts,
          summary,
        });
        await this.recordWriteMetrics({
          action: 'UPDATE',
          summary,
          fragmentChars: md.length,
          duplicateLike: true,
        });
        return input.targetFilePath;
      } catch {
        this.trace(`writeMemoryFragment: UPDATE failed fallback to ADD target=${input.targetFilePath}`);
      }
    }

    const rawSlug = input.keywords[0] ?? 'memory';
    const normalizedSlug = rawSlug
      .split('')
      .filter((ch) => ch !== '/' && ch !== '\\' && ch !== ':' && ch !== '*')
      .join('')
      .slice(0, 20);
    const filePath = path.join(this.memoryRoot, input.layer, `${ts}__${normalizedSlug || 'memory'}.md`);
    const md = this.buildStructuredMemoryMarkdown({
      ts,
      layer: input.layer,
      keywords: input.keywords,
      summary,
      facts: dedupFacts,
      contextSnapshot,
      responseSnapshot,
    });
    await writeFile(filePath, md, 'utf-8');
    await this.upsertMemoryIndexLine({
      filePath,
      layer: input.layer,
      timestamp: ts,
      summary,
    });
    const duplicateLike = await this.isDuplicateLikeSummary(summary);
    await this.recordWriteMetrics({
      action: 'ADD',
      summary,
      fragmentChars: md.length,
      duplicateLike,
    });
    return filePath;
  }

  private buildStructuredMemoryMarkdown(input: {
    ts: number;
    layer: MemoryLayer;
    keywords: string[];
    summary: string;
    facts: MemoryFact[];
    contextSnapshot: string;
    responseSnapshot: string;
  }): string {
    const factLines =
      input.facts.length > 0
        ? input.facts.map((fact) => `- [${fact.type}] ${fact.content} (置信度=${fact.confidence.toFixed(2)})`)
        : ['- [其他] 本轮未提取到稳定事实'];
    return [
      `# ${new Date(input.ts).toISOString()} ${input.layer}`,
      '',
      '## Summary',
      input.summary,
      '',
      '## Metadata',
      `- layer: ${input.layer}`,
      `- timestamp: ${new Date(input.ts).toISOString()}`,
      `- keywords: ${input.keywords.join('、') || 'current_turn'}`,
      '',
      '## Fact Cards',
      ...factLines,
      '',
      '## Context Snapshot',
      `- conversation: ${input.contextSnapshot || '(none)'}`,
      `- response: ${input.responseSnapshot || '(none)'}`,
      '',
    ].join('\n');
  }

  private dedupFacts(facts: MemoryFact[]): MemoryFact[] {
    const seen = new Set<string>();
    const out: MemoryFact[] = [];
    for (const item of facts) {
      const content = oneLine(item.content).slice(0, 180);
      if (!content) continue;
      const key = normalizeForCompare(content);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        type: item.type,
        content,
        confidence: Math.max(0, Math.min(1, item.confidence)),
      });
    }
    return out.slice(0, 10);
  }

  private mergeFactsFromExisting(current: string, facts: MemoryFact[]): MemoryFact[] {
    const existingFacts: MemoryFact[] = [];
    for (const line of current.split('\n')) {
      const m = line.match(/^- \[(事实|偏好|事件|目标|风险|其他)\]\s+(.+?)\s+\(置信度=(\d+(?:\.\d+)?)\)\s*$/);
      if (!m) continue;
      existingFacts.push({
        type: m[1] as MemoryFact['type'],
        content: m[2],
        confidence: Number(m[3]),
      });
    }
    return this.dedupFacts([...existingFacts, ...facts]);
  }

  private isSafeMemoryPath(filePath: string): boolean {
    const normalizedRoot = path.resolve(this.memoryRoot) + path.sep;
    const normalizedTarget = path.resolve(filePath);
    return normalizedTarget.startsWith(normalizedRoot) && normalizedTarget.endsWith('.md');
  }

  private layerFromPath(filePath: string): MemoryLayer | null {
    const match = filePath.match(/fragments[\\/](short_term|episodic|semantic)[\\/]/);
    if (!match) return null;
    return match[1] as MemoryLayer;
  }

  private async upsertMemoryIndexLine(input: {
    filePath: string;
    layer: MemoryLayer;
    timestamp: number;
    summary: string;
  }): Promise<void> {
    const indexPath = path.join(this.memoryRoot, 'memory.index.md');
    const nextLine = `- [${input.timestamp}] [${input.layer}] ${input.filePath} : ${oneLine(input.summary)}`
      .slice(0, 600);
    try {
      const raw = await readFile(indexPath, 'utf-8');
      const lines = raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .filter((line) => !line.includes(input.filePath));
      lines.push(nextLine);
      await writeFile(indexPath, `${lines.join('\n')}\n`, 'utf-8');
    } catch {
      await appendFile(indexPath, `${nextLine}\n`, 'utf-8');
    }
  }

  private defaultMetrics(): MemoryMetrics {
    return {
      updatedAt: new Date().toISOString(),
      totals: {
        writes: 0,
        addWrites: 0,
        updateWrites: 0,
        duplicateLikeWrites: 0,
        recallTurns: 0,
        recallCandidatesBeforeRecentFilter: 0,
        recallCandidatesFilteredByRecentWindow: 0,
      },
      aggregates: {
        totalFragmentChars: 0,
      },
      ratios: {
        duplicateWriteRate: 0,
        updateAddRatio: 0,
        avgFragmentLength: 0,
        recentDuplicateRecallRate: 0,
      },
    };
  }

  private recalcMetrics(metrics: MemoryMetrics): MemoryMetrics {
    const writes = metrics.totals.writes;
    const adds = metrics.totals.addWrites;
    const updates = metrics.totals.updateWrites;
    const recallCandidates = metrics.totals.recallCandidatesBeforeRecentFilter;
    metrics.ratios.duplicateWriteRate = writes > 0 ? metrics.totals.duplicateLikeWrites / writes : 0;
    metrics.ratios.updateAddRatio = adds > 0 ? updates / adds : updates > 0 ? 1 : 0;
    metrics.ratios.avgFragmentLength = writes > 0 ? metrics.aggregates.totalFragmentChars / writes : 0;
    metrics.ratios.recentDuplicateRecallRate =
      recallCandidates > 0 ? metrics.totals.recallCandidatesFilteredByRecentWindow / recallCandidates : 0;
    metrics.updatedAt = new Date().toISOString();
    return metrics;
  }

  private async readMetrics(): Promise<MemoryMetrics> {
    try {
      const raw = await readFile(this.memoryMetricsPath, 'utf-8');
      const parsed = JSON.parse(raw) as MemoryMetrics;
      return this.recalcMetrics({
        ...this.defaultMetrics(),
        ...parsed,
        totals: { ...this.defaultMetrics().totals, ...(parsed?.totals ?? {}) },
        aggregates: { ...this.defaultMetrics().aggregates, ...(parsed?.aggregates ?? {}) },
        ratios: { ...this.defaultMetrics().ratios, ...(parsed?.ratios ?? {}) },
      });
    } catch {
      return this.defaultMetrics();
    }
  }

  private async writeMetrics(metrics: MemoryMetrics): Promise<void> {
    await mkdir(path.dirname(this.memoryMetricsPath), { recursive: true });
    await writeFile(this.memoryMetricsPath, JSON.stringify(this.recalcMetrics(metrics), null, 2), 'utf-8');
  }

  private async recordRecallMetrics(input: {
    candidatesBeforeRecentFilter: number;
    filteredByRecentWindow: number;
  }): Promise<void> {
    const metrics = await this.readMetrics();
    metrics.totals.recallTurns += 1;
    metrics.totals.recallCandidatesBeforeRecentFilter += Math.max(0, input.candidatesBeforeRecentFilter);
    metrics.totals.recallCandidatesFilteredByRecentWindow += Math.max(0, input.filteredByRecentWindow);
    await this.writeMetrics(metrics);
  }

  private async recordWriteMetrics(input: {
    action: MemoryWriteAction;
    summary: string;
    fragmentChars: number;
    duplicateLike: boolean;
  }): Promise<void> {
    const metrics = await this.readMetrics();
    metrics.totals.writes += 1;
    if (input.action === 'UPDATE') {
      metrics.totals.updateWrites += 1;
    } else {
      metrics.totals.addWrites += 1;
    }
    if (input.duplicateLike) {
      metrics.totals.duplicateLikeWrites += 1;
    }
    metrics.aggregates.totalFragmentChars += Math.max(0, input.fragmentChars);
    await this.writeMetrics(metrics);
    this.trace(
      `metrics: writes=${metrics.totals.writes} add=${metrics.totals.addWrites} update=${metrics.totals.updateWrites} duplicateRate=${(
        metrics.ratios.duplicateWriteRate * 100
      ).toFixed(1)}% avgLen=${metrics.ratios.avgFragmentLength.toFixed(1)}`
    );
  }

  private async isDuplicateLikeSummary(summary: string): Promise<boolean> {
    const indexPath = path.join(this.memoryRoot, 'memory.index.md');
    const normalized = normalizeForCompare(summary);
    if (!normalized) return false;
    try {
      const raw = await readFile(indexPath, 'utf-8');
      const lines = raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .slice(-120);
      for (const line of lines) {
        const idx = line.indexOf(' : ');
        if (idx < 0) continue;
        const oldSummary = normalizeForCompare(line.slice(idx + 3));
        if (!oldSummary) continue;
        if (oldSummary === normalized || oldSummary.includes(normalized) || normalized.includes(oldSummary)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }
}
