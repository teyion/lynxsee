import { BaseModule } from './BaseModule.js';
import { FetchResult, GateContext, GlobalSnapshot, ModuleState, ReflectContext, Suggestion } from '../types/index.js';
import { buildSuggestion } from '../subconscious/SubconsciousHelper.js';

interface ToolSpec {
  name: string;
  description: string;
  available: boolean;
  covers: string[];
}

interface ToolPassResult {
  pass: number;
  intent: string;
  toolName: string;
  summary: string;
}

interface ToolsState extends ModuleState {
  pendingSuggestion: Suggestion | null;
  knownTools: ToolSpec[];
  recentResults: ToolPassResult[];
  coveredIntents: string[];
  missingIntents: string[];
  executionPass: number;
  lastUserInput: string;
  requestMorePass: boolean;
}

export class ToolsModule extends BaseModule {
  id = 'tools';
  dependencies = ['task', 'tool_registry'];

  constructor(sort = 40) {
    super(sort);
  }

  protected override state: ToolsState = {
    activeTopics: [],
    temporalFocus: 'latest',
    pendingSuggestion: null as Suggestion | null,
    knownTools: [],
    recentResults: [],
    coveredIntents: [],
    missingIntents: [],
    executionPass: 0,
    lastUserInput: '',
    requestMorePass: false,
  };

  async activationGate(ctx: GateContext): Promise<boolean> {
    return ctx.userInput.trim().length > 0;
  }

  async update(userInput: string, snapshot: GlobalSnapshot, _freshData: FetchResult[]): Promise<void> {
    const sameTurn = this.state.lastUserInput === userInput;
    const executionPass = sameTurn ? this.state.executionPass + 1 : 1;
    const taskState = (snapshot.moduleSnapshots.task?.state ?? {}) as Record<string, any>;
    const registryState = (snapshot.moduleSnapshots.tool_registry?.state ?? {}) as Record<string, any>;
    const knownTools = Array.isArray(registryState.availableTools)
      ? registryState.availableTools
          .filter((tool: any) => tool?.available)
          .map((tool: any) => ({
            name: String(tool.name),
            description: String(tool.description),
            available: Boolean(tool.available),
            covers: Array.isArray(tool.covers) ? tool.covers.map((item: unknown) => String(item)) : [],
          }))
      : [];
    const requiredIntents = Array.isArray(taskState.currentTask?.requiredToolIntents)
      ? taskState.currentTask.requiredToolIntents.map((item: unknown) => String(item))
      : [];
    const coveredIntents = sameTurn ? [...this.state.coveredIntents] : [];
    const recentResults = sameTurn ? [...this.state.recentResults] : [];
    const missingBefore = requiredIntents.filter((intent: string) => !coveredIntents.includes(intent));
    const nextIntent = missingBefore[0];
    if (nextIntent) {
      const matchedTool =
        knownTools.find((tool) => tool.available && tool.covers.includes(nextIntent)) ??
        knownTools[0];
      if (matchedTool) {
        coveredIntents.push(nextIntent);
        recentResults.push({
          pass: executionPass,
          intent: nextIntent,
          toolName: matchedTool.name,
          summary: `pass ${executionPass}: ${matchedTool.name} 已覆盖 ${nextIntent}`,
        });
      }
    }
    const dedupCovered = [...new Set(coveredIntents)];
    const missingIntents = requiredIntents.filter((intent: string) => !dedupCovered.includes(intent));
    this.state.lastUserInput = userInput;
    this.state.executionPass = executionPass;
    this.state.knownTools = knownTools;
    this.state.coveredIntents = dedupCovered;
    this.state.missingIntents = missingIntents;
    this.state.recentResults = recentResults.slice(-8);
    this.state.requestMorePass = missingIntents.length > 0;
  }

  async render(): Promise<string> {
    const tools = (this.state.knownTools as ToolSpec[])
      .filter((t) => t.available)
      .map((t) => `- ${t.name}: ${t.description} [covers: ${t.covers.join(', ')}]`)
      .join('\n');

    if (!tools) {
      return '';
    }

    const recent = this.state.recentResults
      .map((item) => `- pass ${item.pass}: ${item.toolName} -> ${item.intent}`)
      .join('\n');
    const missing = this.state.missingIntents.length > 0 ? this.state.missingIntents.join(', ') : '(none)';
    return [
      '# Tools',
      tools,
      `executionPass: ${this.state.executionPass}`,
      `coveredIntents: ${this.state.coveredIntents.join(', ') || '(none)'}`,
      `missingIntents: ${missing}`,
      recent ? `recentResults:\n${recent}` : 'recentResults:\n(none)',
    ].join('\n');
  }

  shouldRunLLM(): boolean {
    return false;
  }

  async subconsciousReflect(ctx: ReflectContext): Promise<void> {
    this.state.pendingSuggestion = await buildSuggestion(ctx.userInput, ctx.response, this.id);
  }
}
