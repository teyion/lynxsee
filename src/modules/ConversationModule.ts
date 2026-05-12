import { ContextModule } from '../core/ContextModule.js';
import {
  DataBinding,
  FetchResult,
  GateContext,
  GlobalSnapshot,
  ModuleState,
  ReflectContext,
  RenderDirectives,
  SubconsciousContext,
} from '../types/index.js';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getConfiguredStateDir } from '../utils/runtimeStatePaths.js';

interface ConversationRecord {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

interface ConversationFetchData {
  records: ConversationRecord[];
  total: number;
  referenceRecords: ConversationRecord[];
}

export class ConversationModule implements ContextModule {
  id = 'conversation';
  dependencies: string[] = [];
  private sort: number;
  private readonly stateDir = getConfiguredStateDir();
  private readonly sessionsDir = path.join(this.stateDir, 'conversation', 'sessions');
  private lifecycleTrace: string[] = [];

  private state: ModuleState = {
    activeTopics: [],
    temporalFocus: 'latest',
    lastUserMessage: '',
    historySummary: '',
    messages: [] as string[],
    historyRecords: [] as ConversationRecord[],
    referenceHistoryRecords: [] as ConversationRecord[],
    turnCount: 0,
    pendingSuggestion: null,
  };

  private directives: RenderDirectives = {
    maxTokens: 2000,
    outputFormat: 'openai-messages',
    templateVersion: 'v1',
    historyMessageCount: 50,
    referenceHistoryMessageCount: 8,
  };

  private bindings: DataBinding[] = [];

  constructor(sort = 0) {
    this.sort = sort;
    const sessionId = this.buildSessionId();
    const sessionFilePath = path.join(this.sessionsDir, `${sessionId}.jsonl`);
    this.directives.sessionId = sessionId;
    this.directives.sessionFilePath = sessionFilePath;
    this.bindings = [
      {
        type: 'markdown',
        locator: sessionFilePath,
        fetchDirectives: {},
        refreshPolicy: 'on_update',
      },
    ];
  }

  async activationGate(_ctx: GateContext): Promise<boolean> {
    this.lifecycleTrace = [];
    return true;
  }

  async subconsciousAdjust(ctx: SubconsciousContext): Promise<void> {
    const words = ctx.userInput.split(/\s+/).filter(Boolean);
    this.state.activeTopics = words.slice(0, 6);
    this.state.temporalFocus = 'latest';
    if (typeof this.directives.historyMessageCount !== 'number' || this.directives.historyMessageCount <= 0) {
      this.directives.historyMessageCount = 50;
    }
    this.trace(
      `subconsciousAdjust: session=${this.directives.sessionId} historyMessageCount=${this.directives.historyMessageCount}`
    );
  }

  async fetchData(): Promise<FetchResult[]> {
    await this.ensureSessionDir();
    const filePath = String(this.directives.sessionFilePath);
    const limit = Math.max(1, Number(this.directives.historyMessageCount ?? 6));
    const referenceLimit = Math.max(0, Number(this.directives.referenceHistoryMessageCount ?? 8));
    const records = await this.readSessionRecords(filePath);
    const selected = records.slice(-limit);
    const referenceRecords =
      referenceLimit > 0 ? await this.readRecentRecordsFromOtherSessions(filePath, referenceLimit) : [];
    this.trace(
      `fetchData: file=${filePath} total=${records.length} fetched=${selected.length} limit=${limit} referenceFetched=${referenceRecords.length} referenceLimit=${referenceLimit}`
    );
    return [
      {
        bindingIndex: 0,
        data: {
          records: selected,
          total: records.length,
          referenceRecords,
        },
      },
    ];
  }

  async update(userInput: string, _snapshot: GlobalSnapshot, freshData: FetchResult[]): Promise<void> {
    this.state.lastUserMessage = userInput;
    this.state.turnCount = (this.state.turnCount ?? 0) + 1;
    const data = (freshData[0]?.data as ConversationFetchData | undefined) ?? {
      records: [],
      total: 0,
      referenceRecords: [],
    };
    const records = (data.records ?? []).slice();
    const referenceRecords = (data.referenceRecords ?? []).slice();
    const textMessages = records.map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`);
    this.state.messages = textMessages;
    this.state.historySummary = textMessages.slice(-3).join(' | ');
    this.state.historyRecords = records;
    this.state.referenceHistoryRecords = referenceRecords;
    await this.appendSessionRecord(String(this.directives.sessionFilePath), {
      role: 'user',
      content: userInput,
      ts: Date.now(),
    });
    this.trace(
      `update: append user message file=${this.directives.sessionFilePath} fetchedBefore=${records.length}`
    );
  }

  async render(): Promise<string> {
    const history = ((this.state.historyRecords as ConversationRecord[] | undefined) ?? [])
      .slice()
      .sort((a, b) => a.ts - b.ts);
    const referenceHistory = ((this.state.referenceHistoryRecords as ConversationRecord[] | undefined) ?? [])
      .slice()
      .sort((a, b) => a.ts - b.ts);
    const lines = ['# Conversation'];

    if (history.length === 0) {
      lines.push('## History', '(empty)');
      lines.push('', '## Current User', `User: ${this.state.lastUserMessage || '(empty)'}`);
      return lines.join('\n');
    }

    lines.push('## History');
    for (const item of history) {
      const role = item.role === 'user' ? 'User' : 'Assistant';
      lines.push(`### ${role}`);
      lines.push(`${role}: ${item.content || '(empty)'}`);
      lines.push('');
    }
    lines.push('## Current User');
    lines.push(`User: ${this.state.lastUserMessage || '(empty)'}`);
    if (referenceHistory.length > 0) {
      lines.push('');
      lines.push('## Historical Reference (May Be Discontinuous)');
      lines.push('- 以下内容来自之前会话，仅供参考，不保证与当前轮连续。');
      for (const item of referenceHistory) {
        const role = item.role === 'user' ? 'User' : 'Assistant';
        const ts = new Date(item.ts).toISOString();
        lines.push(`### ${role} @ ${ts}`);
        lines.push(`${role}: ${item.content || '(empty)'}`);
        lines.push('');
      }
    }
    
    // Add anti-hallucination note at the bottom of the conversation block
    lines.push('');
    lines.push('---');
    lines.push('> 核心要求：基于以上对话进行回复。不要主动编造没有在历史记录中发生过的事情，特别是在对话初始阶段，只需要礼貌回应即可。');
    
    return lines.join('\n').trim();
  }

  async subconsciousReflect(_ctx: ReflectContext): Promise<void> {
    await this.appendSessionRecord(String(this.directives.sessionFilePath), {
      role: 'assistant',
      content: _ctx.response,
      ts: Date.now(),
    });
    this.trace(`subconsciousReflect: append assistant message file=${this.directives.sessionFilePath}`);
  }

  getState(): ModuleState {
    return this.state;
  }

  getDirectives(): RenderDirectives {
    return this.directives;
  }

  getBindings(): DataBinding[] {
    return this.bindings;
  }

  getSort(): number {
    return this.sort;
  }

  shouldRunLLM(): boolean {
    return false;
  }

  getLifecycleTrace(): string[] {
    return [...this.lifecycleTrace];
  }

  async receiveTidyRequest(tidyQuery: string): Promise<void> {
    if (tidyQuery.includes('压缩对话历史')) {
      const messages = (this.state.messages as string[]) ?? [];
      this.state.historySummary = messages.slice(-5).join(' | ');
      this.state.messages = messages.slice(-5);
    }
  }

  private trace(line: string): void {
    this.lifecycleTrace.push(line);
  }

  private buildSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private async ensureSessionDir(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
  }

  private async readSessionRecords(filePath: string): Promise<ConversationRecord[]> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const lines = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const records: ConversationRecord[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as ConversationRecord;
          if (!parsed || typeof parsed.content !== 'string' || (parsed.role !== 'user' && parsed.role !== 'assistant')) {
            continue;
          }
          records.push({
            role: parsed.role,
            content: parsed.content,
            ts: Number(parsed.ts ?? Date.now()),
          });
        } catch {
          continue;
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  private async appendSessionRecord(filePath: string, record: ConversationRecord): Promise<void> {
    await this.ensureSessionDir();
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  private async readRecentRecordsFromOtherSessions(currentFilePath: string, limit: number): Promise<ConversationRecord[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.sessionsDir);
    } catch {
      return [];
    }
    const currentBase = path.basename(currentFilePath);
    const others = names
      .filter((name) => name.endsWith('.jsonl') && name !== currentBase)
      .sort((a, b) => this.sessionNameTs(b) - this.sessionNameTs(a))
      .slice(0, 6);
    const merged: ConversationRecord[] = [];
    for (const name of others) {
      const filePath = path.join(this.sessionsDir, name);
      const records = await this.readSessionRecords(filePath);
      if (records.length === 0) continue;
      merged.push(...records.slice(-Math.max(1, limit)));
      if (merged.length >= limit * 2) break;
    }
    return merged
      .sort((a, b) => a.ts - b.ts)
      .slice(-limit);
  }

  private sessionNameTs(name: string): number {
    const match = name.match(/^(\d+)-/);
    return match ? Number(match[1]) : 0;
  }
}
