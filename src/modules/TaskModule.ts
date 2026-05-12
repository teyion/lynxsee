import { BaseModule } from './BaseModule.js';
import { FetchResult, GateContext, GlobalSnapshot, ModuleState, ReflectContext, Suggestion } from '../types/index.js';
import { buildSuggestion } from '../subconscious/SubconsciousHelper.js';

interface TaskChecklistItem {
  intent: string;
  label: string;
  satisfied: boolean;
}

interface TaskPlan {
  objective: string;
  requestedOutcome: string;
  requiredToolIntents: string[];
  selectedTools: Array<{ intent: string; toolName: string }>;
  unavailableIntents: string[];
  acceptanceChecks: TaskChecklistItem[];
  nextAction: string;
  readyForFinal: boolean;
}

interface TaskState extends ModuleState {
  pendingSuggestion: Suggestion | null;
  currentTask: TaskPlan | null;
  taskHistory: string[];
  executionPass: number;
  lastUserInput: string;
}

const TOOL_INTENT_LABELS: Record<string, string> = {
  understand_request: '确认用户诉求边界',
  context_check: '核对当前上下文与现有状态',
  execution_plan: '形成可执行的方案或步骤',
  result_check: '补足验证或完成度检查',
};

function inferRequiredToolIntents(userInput: string): string[] {
  const intents = ['understand_request'];
  if (/[看查排查分析检查定位确认为什么咋回事问题|state|snapshot|上下文|目录|文件|路径]/.test(userInput)) {
    intents.push('context_check');
  }
  if (/[改|实现|增加|新增|接入|支持|设计|方案|重构|优化|迁移]/.test(userInput)) {
    intents.push('execution_plan');
  }
  if (/[验证|确认|check|test|build|通过|回归|生效]/i.test(userInput)) {
    intents.push('result_check');
  }
  return [...new Set(intents)];
}

function inferRequestedOutcome(userInput: string): string {
  if (/[改|实现|增加|新增|接入|支持|重构|迁移]/.test(userInput)) {
    return '需要给出并推进一套可执行改动。';
  }
  if (/[看查排查分析检查定位为什么咋回事]/.test(userInput)) {
    return '需要定位原因并给出清晰判断。';
  }
  return '需要给出贴合诉求的最终答复。';
}

function firstMissingIntent(checks: TaskChecklistItem[]): TaskChecklistItem | null {
  return checks.find((item) => !item.satisfied) ?? null;
}

export class TaskModule extends BaseModule {
  id = 'task';
  dependencies = ['conversation', 'memory', 'tool_registry'];

  constructor(sort = 30) {
    super(sort);
  }

  protected override state: TaskState = {
    activeTopics: [],
    temporalFocus: 'latest',
    pendingSuggestion: null as Suggestion | null,
    currentTask: null,
    taskHistory: [],
    executionPass: 0,
    lastUserInput: '',
  };

  async activationGate(ctx: GateContext): Promise<boolean> {
    return ctx.userInput.trim().length > 0;
  }

  async update(userInput: string, snapshot: GlobalSnapshot, _freshData: FetchResult[]): Promise<void> {
    const sameTurn = this.state.lastUserInput === userInput;
    const executionPass = sameTurn ? this.state.executionPass + 1 : 1;
    const registryState = (snapshot.moduleSnapshots.tool_registry?.state ?? {}) as Record<string, any>;
    const registryTools = Array.isArray(registryState.availableTools)
      ? registryState.availableTools.filter((tool: any) => tool?.available)
      : [];
    const inferredIntents =
      sameTurn && this.state.currentTask ? this.state.currentTask.requiredToolIntents : inferRequiredToolIntents(userInput);
    const selectedTools = inferredIntents
      .map((intent) => {
        const matched = registryTools.find((tool: any) => Array.isArray(tool.covers) && tool.covers.includes(intent));
        return matched ? { intent, toolName: String(matched.name) } : null;
      })
      .filter((item): item is { intent: string; toolName: string } => Boolean(item));
    const unavailableIntents = inferredIntents.filter(
      (intent) => !selectedTools.some((item) => item.intent === intent)
    );
    const requiredToolIntents = selectedTools.map((item) => item.intent);
    const toolsState = (snapshot.moduleSnapshots.tools?.state ?? {}) as Record<string, any>;
    const coveredIntents = new Set(
      Array.isArray(toolsState.coveredIntents)
        ? toolsState.coveredIntents.map((item: unknown) => String(item))
        : []
    );
    const acceptanceChecks = requiredToolIntents.map((intent) => ({
      intent,
      label: TOOL_INTENT_LABELS[intent] ?? intent,
      satisfied: coveredIntents.has(intent),
    }));
    const missingIntent = firstMissingIntent(acceptanceChecks);
    const nextAction = unavailableIntents.length > 0
      ? `当前工具集暂未覆盖：${unavailableIntents.join(', ')}，需要基于已有信息给出保守结论。`
      : missingIntent
        ? `继续推进 tools，以完成「${missingIntent.label}」。`
        : 'task 与 tools 已具备足够信息，可以进入最终整合。';

    this.state.lastUserInput = userInput;
    this.state.executionPass = executionPass;
    this.state.currentTask = {
      objective: userInput,
      requestedOutcome: inferRequestedOutcome(userInput),
      requiredToolIntents,
      selectedTools,
      unavailableIntents,
      acceptanceChecks,
      nextAction,
      readyForFinal: acceptanceChecks.every((item) => item.satisfied),
    };
    this.state.taskHistory = [...new Set([userInput, ...this.state.taskHistory])].slice(0, 8);
  }

  async render(): Promise<string> {
    if (!this.state.currentTask) {
      return '';
    }
    const checks = this.state.currentTask.acceptanceChecks
      .map((item, idx) => `${idx + 1}. ${item.satisfied ? '✅' : '⬜'} ${item.label}`)
      .join('\n');
    const selectedTools = this.state.currentTask.selectedTools.length > 0
      ? this.state.currentTask.selectedTools.map((item) => `- ${item.intent}: ${item.toolName}`).join('\n')
      : '(none)';
    const unavailable = this.state.currentTask.unavailableIntents.length > 0
      ? this.state.currentTask.unavailableIntents.join(', ')
      : '(none)';
    return [
      '# Task',
      `objective: ${this.state.currentTask.objective}`,
      `requestedOutcome: ${this.state.currentTask.requestedOutcome}`,
      `executionPass: ${this.state.executionPass}`,
      'selectedTools:',
      selectedTools,
      `unavailableIntents: ${unavailable}`,
      'acceptanceChecks:',
      checks,
      `nextAction: ${this.state.currentTask.nextAction}`,
    ].join('\n');
  }

  shouldRunLLM(): boolean {
    return false;
  }

  async subconsciousReflect(ctx: ReflectContext): Promise<void> {
    this.state.pendingSuggestion = await buildSuggestion(ctx.userInput, ctx.response, this.id);
  }
}
