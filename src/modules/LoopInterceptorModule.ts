import { BaseModule } from './BaseModule.js';
import { FetchResult, GateContext, GlobalSnapshot, LoopDirective, ModuleState, ReflectContext, Suggestion } from '../types/index.js';
import { buildSuggestion } from '../subconscious/SubconsciousHelper.js';

interface LoopInterceptorState extends ModuleState {
  pendingSuggestion: Suggestion | null;
  lastUserInput: string;
  evaluationPass: number;
  maxPasses: number;
  satisfied: boolean;
  continueLoop: boolean;
  reason: string;
  targetModuleIds: string[];
  missingIntents: string[];
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

export class LoopInterceptorModule extends BaseModule {
  id = 'loop';
  dependencies = ['tools'];

  protected override state: LoopInterceptorState = {
    activeTopics: [],
    temporalFocus: 'latest',
    pendingSuggestion: null,
    lastUserInput: '',
    evaluationPass: 0,
    maxPasses: 4,
    satisfied: true,
    continueLoop: false,
    reason: 'idle',
    targetModuleIds: ['task', 'tools'],
    missingIntents: [],
  };

  constructor(sort = 45) {
    super(sort);
    this.directives = {
      ...this.directives,
      maxTokens: 180,
      outputFormat: 'markdown',
      templateVersion: 'loop-v1',
    };
  }

  async activationGate(ctx: GateContext): Promise<boolean> {
    return ctx.userInput.trim().length > 0;
  }

  async update(userInput: string, snapshot: GlobalSnapshot, _freshData: FetchResult[]): Promise<void> {
    const sameTurn = this.state.lastUserInput === userInput;
    const evaluationPass = sameTurn ? this.state.evaluationPass + 1 : 1;
    const taskState = (snapshot.moduleSnapshots.task?.state ?? {}) as Record<string, any>;
    const toolsState = (snapshot.moduleSnapshots.tools?.state ?? {}) as Record<string, any>;
    const requiredIntents = asStringArray(taskState.currentTask?.requiredToolIntents);
    const missingIntents = asStringArray(toolsState.missingIntents);
    const taskReadyForFinal = Boolean(taskState.currentTask?.readyForFinal);
    const satisfied = requiredIntents.length === 0 || (taskReadyForFinal && missingIntents.length === 0);
    const continueLoop = !satisfied && requiredIntents.length > 0 && evaluationPass < this.state.maxPasses;
    const reason = satisfied
      ? 'task and tool state are sufficient for final synthesis'
      : missingIntents.length > 0
        ? `missing tool coverage: ${missingIntents.join(', ')}`
        : 'task is not ready for final synthesis';

    this.state.lastUserInput = userInput;
    this.state.evaluationPass = evaluationPass;
    this.state.satisfied = satisfied;
    this.state.continueLoop = continueLoop;
    this.state.reason = reason;
    this.state.targetModuleIds = ['task', 'tools'];
    this.state.missingIntents = missingIntents;
  }

  async render(): Promise<string> {
    const missing = this.state.missingIntents.length > 0 ? this.state.missingIntents.join(', ') : '(none)';
    return [
      '# Loop Interceptor',
      `status: ${this.state.satisfied ? 'settled' : this.state.continueLoop ? 'rerun-task-tools' : 'stop-with-gaps'}`,
      `evaluationPass: ${this.state.evaluationPass}/${this.state.maxPasses}`,
      `reason: ${this.state.reason}`,
      `missingIntents: ${missing}`,
    ].join('\n');
  }

  shouldRunLLM(): boolean {
    return false;
  }

  getLoopDirective(): LoopDirective | null {
    return {
      continueLoop: this.state.continueLoop,
      reason: this.state.reason,
      targetModuleIds: this.state.targetModuleIds,
      maxPasses: this.state.maxPasses,
    };
  }

  async subconsciousReflect(ctx: ReflectContext): Promise<void> {
    this.state.pendingSuggestion = await buildSuggestion(ctx.userInput, ctx.response, this.id);
  }
}
