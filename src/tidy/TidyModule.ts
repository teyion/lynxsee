import { BaseModule } from '../modules/BaseModule.js';
import { ContextModule } from '../core/ContextModule.js';
import { FetchResult, GateContext, GlobalSnapshot } from '../types/index.js';

export class TidyModule extends BaseModule {
  id = 'tidy';
  dependencies: string[] = [];

  constructor(sort = 90) {
    super(sort);
  }

  protected override state = {
    activeTopics: [],
    temporalFocus: 'latest',
    pendingSuggestion: null,
    totalTidyRuns: 0,
  };

  async activationGate(_ctx: GateContext): Promise<boolean> {
    return false;
  }

  async update(_userInput: string, _snapshot: GlobalSnapshot, _freshData: FetchResult[]): Promise<void> {
    // tidy 不参与在线更新。
  }

  async render(): Promise<string> {
    return '';
  }

  shouldTriggerTidy(turnCount: number): boolean {
    return turnCount > 0 && turnCount % 10 === 0;
  }

  async generateTidyPlan(modules: ContextModule[]): Promise<Map<string, string>> {
    const plan = new Map<string, string>();
    for (const mod of modules) {
      if (mod.id === 'tidy') {
        continue;
      }
      plan.set(mod.id, '清理主题并压缩状态');
    }
    return plan;
  }

  async runTidyCycle(modules: ContextModule[]): Promise<void> {
    const plan = await this.generateTidyPlan(modules);
    for (const [moduleId, query] of plan.entries()) {
      const module = modules.find((m) => m.id === moduleId);
      if (!module) {
        continue;
      }
      await module.receiveTidyRequest(query);
    }
    this.state.totalTidyRuns += 1;
  }
}
