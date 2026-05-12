import { BaseModule } from './BaseModule.js';
import { FetchResult, GateContext, GlobalSnapshot, ModuleState, ReflectContext, Suggestion } from '../types/index.js';
import { buildSuggestion } from '../subconscious/SubconsciousHelper.js';

export interface RegistryToolSpec {
  name: string;
  description: string;
  available: boolean;
  covers: string[];
  constraints?: string[];
}

interface ToolRegistryState extends ModuleState {
  pendingSuggestion: Suggestion | null;
  registryVersion: number;
  availableTools: RegistryToolSpec[];
}

export class ToolRegistryModule extends BaseModule {
  id = 'tool_registry';
  dependencies = ['conversation'];

  constructor(sort = 5) {
    super(sort);
  }

  protected override state: ToolRegistryState = {
    activeTopics: [],
    temporalFocus: 'latest',
    pendingSuggestion: null,
    registryVersion: 1,
    availableTools: [
      {
        name: 'inspect_request',
        description: '对齐用户诉求、限制条件和交付目标',
        available: true,
        covers: ['understand_request'],
      },
      {
        name: 'inspect_context',
        description: '核对当前上下文、模块快照与已有状态',
        available: true,
        covers: ['context_check'],
      },
      {
        name: 'plan_execution',
        description: '整理执行方案、改动步骤与依赖关系',
        available: true,
        covers: ['execution_plan'],
      },
      {
        name: 'check_result',
        description: '做结果一致性与完成度检查',
        available: true,
        covers: ['result_check'],
        constraints: ['只做一致性与完成度判断，不直接修改状态'],
      },
    ],
  };

  async activationGate(_ctx: GateContext): Promise<boolean> {
    return true;
  }

  async update(_userInput: string, _snapshot: GlobalSnapshot, _freshData: FetchResult[]): Promise<void> {
    // Static registry for now; future versions can hydrate from external tool manifests.
  }

  async render(): Promise<string> {
    const lines = this.state.availableTools
      .filter((tool) => tool.available)
      .map((tool) => {
        const constraints = tool.constraints?.length ? ` constraints=[${tool.constraints.join(' | ')}]` : '';
        return `- ${tool.name}: ${tool.description} [covers: ${tool.covers.join(', ')}]${constraints}`;
      });
    return [
      '# Tool Registry',
      `registryVersion: ${this.state.registryVersion}`,
      ...lines,
    ].join('\n');
  }

  shouldRunLLM(): boolean {
    return false;
  }

  async subconsciousReflect(ctx: ReflectContext): Promise<void> {
    this.state.pendingSuggestion = await buildSuggestion(ctx.userInput, ctx.response, this.id);
  }
}
