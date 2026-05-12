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
  buildPersonaReflectSuggestion,
  buildPersonaUpdateFromUserInput,
  evaluateSuggestionMatch,
  PersonaAttributeSpec,
  PersonaAttributeValue,
} from '../subconscious/SubconsciousHelper.js';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getConfiguredStateDir } from '../utils/runtimeStatePaths.js';

interface PersonaState extends ModuleState {
  pendingSuggestion: Suggestion | null;
  personaBase: string;
  personaAttributes: Record<string, PersonaAttributeValue>;
  currentProfileVersion?: string;
  currentProfilePath?: string;
  lastReflectPersonaChangeCount?: number;
}

interface PersonaProfileFile {
  personaBase: string;
  personaAttributes: Record<string, PersonaAttributeValue>;
}

interface PersonaHistoryEntry {
  at: string;
  personaBaseChanged: boolean;
  changedKeys: string[];
  patches: Record<
    string,
    {
      before: string;
      after: string;
    }
  >;
}

export class PersonaModule extends BaseModule {
  id = 'persona';
  dependencies = ['conversation'];
  private readonly stateDir = getConfiguredStateDir();
  private readonly personaDir = path.join(this.stateDir, 'persona');
  private readonly personaFilePath = path.join(this.personaDir, 'persona.json');
  private readonly personaHistoryFilePath = path.join(this.personaDir, 'persona.history.jsonl');
  private readonly defaultProfile: PersonaProfileFile = {
    personaBase: '你是一个稳健、清晰、务实的智能助手。',
    personaAttributes: {
      identity_scope: {
        constraint: '始终以专业工程助手身份回答，优先帮助用户完成工程目标。',
        fewshot: [
          '当需求不清晰时，先澄清目标再给方案，不直接假设业务前提。',
          '遇到实现细节时，先给可执行路径，再补充风险与取舍。',
        ],
      },
      tone_style: {
        constraint: '语气友好、克制、直接，避免夸张承诺和情绪化表述。',
        fewshot: [
          '可以这样做：先修改配置，再验证构建与测试结果。',
          '这个报错的根因是依赖顺序，修复后我会再跑一遍校验。',
        ],
      },
      answer_structure: {
        constraint: '先给结论，再给关键变更与验证结果，保持层次清晰。',
        fewshot: [
          '结论：已修复。变更点：A/B/C。验证：build 与 test 均通过。',
          '建议分三步执行：先定位、再改动、最后回归验证。',
        ],
      },
      safety_boundary: {
        constraint: '涉及高风险操作时先提醒影响并寻求确认，默认采取最小破坏方案。',
        fewshot: [
          '该操作可能覆盖现有改动，建议先备份后执行。',
          '我先给非破坏性方案；如果你确认，再执行高风险步骤。',
        ],
      },
      user_impression: {
        constraint: '目前对用户了解较少，认为用户是一个需要专业帮助的开发者。',
        fewshot: [],
      },
      short_term_goal: {
        constraint: '准确理解用户当前的具体需求，提供直接有效的解决方案或情感回应。',
        fewshot: [],
      },
      long_term_goal: {
        constraint: '建立互信的伙伴关系，在解决问题的同时让用户感受到温暖与支持。',
        fewshot: [],
      },
    },
  };
  private lifecycleTrace: string[] = [];
  private readonly attributeSpecs: PersonaAttributeSpec[] = [
    {
      key: 'identity_scope',
      purpose: '定义助手角色边界、价值观和自我定位。',
    },
    {
      key: 'tone_style',
      purpose: '约束语言语气、礼貌程度和表达风格。',
    },
    {
      key: 'answer_structure',
      purpose: '约束回答组织方式，包括先后顺序和信息颗粒度。',
    },
    {
      key: 'safety_boundary',
      purpose: '约束风险处理、免责声明和拒答策略。',
    },
    {
      key: 'user_impression',
      purpose: '记录AI对用户的印象、认知以及这些印象的来源（用户具体做了什么事）。',
    },
    {
      key: 'short_term_goal',
      purpose: '定义当前阶段对该用户的短期目标，例如让用户开心、帮助完成具体任务等。',
    },
    {
      key: 'long_term_goal',
      purpose: '定义与该用户相处的长期目标，例如帮助用户顺利工作、提供持续的情感支持等。',
    },
  ];

  constructor(sort = 10) {
    super(sort);
    this.bindings = [
      {
        type: 'database',
        locator: this.personaFilePath,
        fetchDirectives: {},
        refreshPolicy: 'on_update',
      },
    ];
    this.directives = {
      ...this.directives,
      attributeKeys: this.attributeSpecs.map((item) => item.key),
      includeFewshot: true,
      personaBaseUpdate: undefined,
      personaAttributeUpdates: {},
    };
  }

  protected override state: PersonaState = {
    activeTopics: [],
    temporalFocus: 'latest',
    pendingSuggestion: null as Suggestion | null,
    personaBase: this.defaultProfile.personaBase,
    personaAttributes: JSON.parse(JSON.stringify(this.defaultProfile.personaAttributes)),
    lastReflectPersonaChangeCount: 0,
  };

  shouldRunLLM(): boolean {
    return false;
  }
  async activationGate(_ctx: GateContext): Promise<boolean> {
    return true;
  }

  async subconsciousAdjust(ctx: SubconsciousContext): Promise<void> {
    this.lifecycleTrace = [];
    this.trace(`subconsciousAdjust: start userInput="${ctx.userInput}"`);
    let nextUpdates = {} as Record<string, Partial<PersonaAttributeValue>>;
    let nextPersonaBase: string | undefined;
    const suggestionUpdates = ctx.pendingSuggestion?.adjustedFetchDirectives?.personaAttributeUpdates as
      | Record<string, Partial<PersonaAttributeValue>>
      | undefined;
    const suggestionPersonaBase = ctx.pendingSuggestion?.adjustedFetchDirectives?.personaBaseUpdate as
      | string
      | undefined;

    if (ctx.pendingSuggestion && (suggestionUpdates || suggestionPersonaBase)) {
      this.trace(
        `subconsciousAdjust: pendingSuggestion reason="${ctx.pendingSuggestion.reason}" confidence=${ctx.pendingSuggestion.confidence.toFixed(2)} personaBase=${suggestionPersonaBase ?? '(none)'} updates=${JSON.stringify(suggestionUpdates)}`
      );
      const match = await evaluateSuggestionMatch(ctx.userInput, ctx.pendingSuggestion);
      const shouldAdopt = match >= 0.2;
      this.trace(
        `subconsciousAdjust: pendingSuggestion match=${match.toFixed(2)} adopt=${shouldAdopt}`
      );
      if (shouldAdopt) {
        nextUpdates = {
          ...nextUpdates,
          ...(suggestionUpdates ?? {}),
        };
        if (suggestionPersonaBase && this.isNaturalLanguage(suggestionPersonaBase)) {
          nextPersonaBase = suggestionPersonaBase.trim();
        }
        this.trace(
          `subconsciousAdjust: adopted suggestion keys=[${Object.keys(suggestionUpdates ?? {}).join(', ')}]`
        );
      } else {
        this.trace(
          `subconsciousAdjust: suggestion dropped reason="match below threshold(0.20)" userInput="${ctx.userInput}"`
        );
      }
    } else {
      this.trace('subconsciousAdjust: no pendingSuggestion');
    }

    const shouldAdjustPersona = /更活泼|更正式|语气|口吻|风格|叫|起名|实习生|身份|不要再说/.test(
      ctx.userInput
    );
    if (shouldAdjustPersona) {
      this.trace('subconsciousAdjust: run online persona update');
      const onlineResult = await buildPersonaUpdateFromUserInput({
        userInput: ctx.userInput,
        currentPersonaBase: this.state.personaBase,
        attributeSpecs: this.attributeSpecs,
        currentAttributes: this.state.personaAttributes,
        targetKeys: ['tone_style', 'identity_scope'],
      });
      nextUpdates = {
        ...nextUpdates,
        ...onlineResult.updates,
      };
      if (onlineResult.personaBase && this.isNaturalLanguage(onlineResult.personaBase)) {
        nextPersonaBase = onlineResult.personaBase.trim();
      }
      this.trace(
        `subconsciousAdjust: online update personaBase=${onlineResult.personaBase ?? '(none)'} keys=[${Object.keys(
          onlineResult.updates
        ).join(', ')}]`
      );
    }

    this.directives.personaAttributeUpdates = nextUpdates;
    this.directives.personaBaseUpdate = nextPersonaBase;
    this.directives.attributeKeys = this.attributeSpecs.map((item) => item.key);
    this.directives.includeFewshot = true;
    this.directives.personaProfilePath = this.personaFilePath;
    this.directives.personaProfileVersion = this.state.currentProfileVersion ?? 'v-latest';
    this.trace(
      `subconsciousAdjust: directives profilePath=${this.directives.personaProfilePath} profileVersion=${this.directives.personaProfileVersion}`
    );
    this.trace(
      `subconsciousAdjust: directives personaBaseUpdate=${nextPersonaBase ?? '(none)'} updates keys=[${Object.keys(
        nextUpdates
      ).join(', ') || '(none)'}]`
    );
    this.state.pendingSuggestion = null;
  }

  async fetchData(): Promise<FetchResult[]> {
    const targetPath = String(this.directives.personaProfilePath ?? this.personaFilePath);
    const fetchedProfile = await this.readPersonaProfile(targetPath);
    const profile = fetchedProfile.profile;
    const attrKeys = Array.isArray(this.directives.attributeKeys)
      ? this.directives.attributeKeys
      : this.attributeSpecs.map((item) => item.key);
    const selected: Record<string, PersonaAttributeValue> = {};
    for (const key of attrKeys) {
      // 核心修复：即使硬盘上的 JSON 文件里没有这个 key（比如我们刚加的 user_impression），
      // 在读取时也要把它默认补齐（或者依赖后面的 mergeAttributes），
      // 但最好在这里就先补齐，这样下一次写回的时候就能带上。
      if (profile.personaAttributes[key]) {
        selected[key] = profile.personaAttributes[key];
      } else if (this.defaultProfile.personaAttributes[key]) {
        // 如果文件里没有，但是 default 里有新加的字段，直接拉过来
        selected[key] = this.defaultProfile.personaAttributes[key];
      }
    }
    this.trace(
      `fetchData: file=${fetchedProfile.filePath} version=${fetchedProfile.version} selectedKeys=[${Object.keys(
        selected
      ).join(', ')}]`
    );

    return [
      {
        bindingIndex: 0,
        data: {
          profile,
          profileVersion: fetchedProfile.version,
          profilePath: fetchedProfile.filePath,
          selectedAttributes: selected,
        },
      },
    ];
  }

  async update(_userInput: string, _snapshot: GlobalSnapshot, freshData: FetchResult[]): Promise<void> {
    const fetched = freshData[0]?.data as
      | {
          profile?: PersonaProfileFile;
          profileVersion?: string;
          profilePath?: string;
          selectedAttributes?: Record<string, PersonaAttributeValue>;
        }
      | undefined;
    const fallback = await this.readPersonaProfile(String(this.directives.personaProfilePath ?? this.personaFilePath));
    const profile = fetched?.profile ?? fallback.profile;
    const selected = fetched?.selectedAttributes ?? profile.personaAttributes;
    const updates = (this.directives.personaAttributeUpdates ?? {}) as Record<
      string,
      Partial<PersonaAttributeValue>
    >;
    const personaBaseUpdate = this.directives.personaBaseUpdate as string | undefined;

    const beforeBase = this.state.personaBase;
    const beforeAttributes = JSON.parse(JSON.stringify(this.state.personaAttributes)) as Record<
      string,
      PersonaAttributeValue
    >;
    const beforeTone = beforeAttributes.tone_style?.constraint ?? '';
    this.trace(
      `update: beforeMerge personaBase="${beforeBase}" tone_style="${beforeTone}" updateKeys=[${Object.keys(
        updates
      ).join(', ') || '(none)'}]`
    );
    const merged = this.mergeAttributes(selected, updates);
    this.state.personaBase =
      personaBaseUpdate && this.isNaturalLanguage(personaBaseUpdate)
        ? personaBaseUpdate.trim()
        : profile.personaBase;
    this.state.personaAttributes = merged;
    this.state.currentProfileVersion = fetched?.profileVersion ?? fallback.version;
    this.state.currentProfilePath = fetched?.profilePath ?? fallback.filePath;

    // 持久化：persona 模块在自己的 state 子目录中维护人设 JSON。
    await this.writePersonaProfile(String(this.state.currentProfilePath ?? this.personaFilePath), {
      personaBase: this.state.personaBase,
      personaAttributes: merged,
    });
    const afterBase = this.state.personaBase;
    const afterTone = this.state.personaAttributes.tone_style?.constraint ?? '';
    const historyEntry = this.buildPersonaHistoryEntry({
      beforeBase,
      afterBase,
      beforeAttributes,
      afterAttributes: this.state.personaAttributes,
    });
    if (historyEntry) {
      await this.appendPersonaHistory(historyEntry);
      this.trace(
        `update: history appended keys=[${historyEntry.changedKeys.join(', ') || '(none)'}] baseChanged=${historyEntry.personaBaseChanged}`
      );
    }
    this.trace(
      `update: afterMerge personaBase="${afterBase}" tone_style="${afterTone}" persisted=${this.state.currentProfilePath} version=${this.state.currentProfileVersion}`
    );
  }

  async render(): Promise<string> {
    const lines: string[] = [
      '# Persona', 
      this.state.personaBase, 
      '', 
      '## Attributes'
    ];
    const includeFewshot = this.directives.includeFewshot !== false;
    for (const spec of this.attributeSpecs) {
      const value = this.state.personaAttributes[spec.key];
      if (!value) {
        continue;
      }
      lines.push(`- ${spec.key}: ${value.constraint}`);
      if (includeFewshot && value.fewshot && value.fewshot.length > 0) {
        lines.push(`  示例: ${value.fewshot.join(' | ')}`);
      }
    }
    
    // Add explicit instructions to avoid hallucinations when context is missing
    lines.push('');
    lines.push('## Important Anti-Hallucination Constraints');
    lines.push('- 当作为开场或未加载到足够记忆时，**仅作简短的寒暄回应**，不要编造未发生的事件、虚假的往事或凭空捏造事实。');
    lines.push('- 严格基于当前提供的 Conversation 和 Memory 上下文进行回答。如果用户提及某事但上下文中没有相关信息，请坦诚表示“暂时不记得了”或询问细节，**绝对不要顺着用户的话自己编造细节**。');
    lines.push('- 你是一个虚拟助手，即使在角色扮演中，也必须保持事实的准确性。不能因为用户的引导就承认或编造一段实际上不存在的记忆或情节（例如“调试时改日志”、“一起吃宵夜”等）。');

    return lines.join('\n');
  }

  async subconsciousReflect(ctx: ReflectContext): Promise<void> {
    this.state.pendingSuggestion = await buildPersonaReflectSuggestion({
      userInput: ctx.userInput,
      response: ctx.response,
      myPromptSegment: ctx.myPromptSegment,
      currentPersonaBase: this.state.personaBase,
      attributeSpecs: this.attributeSpecs,
      currentAttributes: this.state.personaAttributes,
    });
    const updates =
      (this.state.pendingSuggestion.adjustedFetchDirectives?.personaAttributeUpdates as Record<
        string,
        unknown
      >) ?? {};
    const baseUpdate = this.state.pendingSuggestion.adjustedFetchDirectives?.personaBaseUpdate;
    const changedCount = Object.keys(updates).length + (baseUpdate ? 1 : 0);
    this.state.lastReflectPersonaChangeCount = changedCount;
    this.trace(
      `subconsciousReflect: generated pendingSuggestion confidence=${this.state.pendingSuggestion.confidence.toFixed(
        2
      )} keys=[${Object.keys(updates).join(', ') || '(none)'}]`
    );
    this.trace(`subconsciousReflect: persona changeCount=${changedCount}`);
    this.trace(
      `subconsciousReflect: suggestion reason="${this.state.pendingSuggestion.reason}" personaBaseUpdate=${baseUpdate ?? '(none)'} updates=${JSON.stringify(
        updates
      )}`
    );
  }

  private isNaturalLanguage(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (/^[\d\s.,:+\-_/]+$/.test(trimmed)) {
      return false;
    }
    return /[\p{L}]/u.test(trimmed);
  }

  private mergeAttributes(
    base: Record<string, PersonaAttributeValue>,
    updates: Record<string, Partial<PersonaAttributeValue>>
  ): Record<string, PersonaAttributeValue> {
    const next: Record<string, PersonaAttributeValue> = {};
    for (const spec of this.attributeSpecs) {
      // 核心修复：如果 base 里没有这个 key（比如用户手动编辑的 json 里没有），
      // 但 this.defaultProfile 里有，应该 fallback 到 defaultProfile 里的默认值，
      // 否则如果连 defaultProfile 里也没有（旧代码遗留），就需要提供一个空对象的保底。
      const fallbackAttr = this.defaultProfile.personaAttributes[spec.key] ?? { constraint: '', fewshot: [] };
      const current = base[spec.key] ?? fallbackAttr;
      
      const update = updates[spec.key];
      const nextConstraint =
        typeof update?.constraint === 'string' && this.isNaturalLanguage(update.constraint)
          ? update.constraint.trim()
          : current.constraint;
      const nextFewshot =
        Array.isArray(update?.fewshot) && update?.fewshot.length > 0
          ? update.fewshot.filter((item): item is string => this.isNaturalLanguage(item)).slice(0, 3)
          : (current.fewshot || []);

      next[spec.key] = {
        constraint: nextConstraint,
        fewshot: nextFewshot.length > 0 ? nextFewshot : (current.fewshot || []),
      };
    }
    return next;
  }

  getLifecycleTrace(): string[] {
    return [...this.lifecycleTrace];
  }

  private trace(message: string): void {
    this.lifecycleTrace.push(message);
  }

  private async readPersonaProfile(
    filePath: string
  ): Promise<{ profile: PersonaProfileFile; version: string; filePath: string }> {
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      const raw = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersonaProfileFile;
      if (!parsed?.personaBase || !parsed?.personaAttributes) {
        throw new Error('invalid profile');
      }
      return {
        profile: parsed,
        version: this.buildProfileVersion(raw),
        filePath,
      };
    } catch {
      await this.writePersonaProfile(filePath, this.defaultProfile);
      return {
        profile: JSON.parse(JSON.stringify(this.defaultProfile)) as PersonaProfileFile,
        version: this.buildProfileVersion(JSON.stringify(this.defaultProfile)),
        filePath,
      };
    }
  }

  private async writePersonaProfile(filePath: string, profile: PersonaProfileFile): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(profile, null, 2), 'utf-8');
  }

  private buildPersonaHistoryEntry(input: {
    beforeBase: string;
    afterBase: string;
    beforeAttributes: Record<string, PersonaAttributeValue>;
    afterAttributes: Record<string, PersonaAttributeValue>;
  }): PersonaHistoryEntry | null {
    const changedKeys: string[] = [];
    const patches: PersonaHistoryEntry['patches'] = {};
    for (const spec of this.attributeSpecs) {
      const key = spec.key;
      const beforeConstraint = input.beforeAttributes[key]?.constraint ?? '';
      const afterConstraint = input.afterAttributes[key]?.constraint ?? '';
      if (beforeConstraint !== afterConstraint) {
        changedKeys.push(key);
        patches[key] = {
          before: beforeConstraint,
          after: afterConstraint,
        };
      }
    }
    const personaBaseChanged = input.beforeBase !== input.afterBase;
    if (!personaBaseChanged && changedKeys.length === 0) {
      return null;
    }
    return {
      at: new Date().toISOString(),
      personaBaseChanged,
      changedKeys,
      patches,
    };
  }

  private async appendPersonaHistory(entry: PersonaHistoryEntry): Promise<void> {
    await mkdir(path.dirname(this.personaHistoryFilePath), { recursive: true });
    await appendFile(this.personaHistoryFilePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  private buildProfileVersion(raw: string): string {
    return `sha1:${createHash('sha1').update(raw).digest('hex').slice(0, 12)}`;
  }
}
