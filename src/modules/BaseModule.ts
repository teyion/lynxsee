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
import { fetchDataSources } from '../utils/fetchDataSources.js';

export abstract class BaseModule implements ContextModule {
  abstract id: string;
  abstract dependencies: string[];

  protected sort = 100;
  protected state: ModuleState = { activeTopics: [], temporalFocus: 'latest', pendingSuggestion: null };
  protected directives: RenderDirectives = {
    maxTokens: 500,
    outputFormat: 'markdown',
    templateVersion: 'v1',
  };
  protected bindings: DataBinding[] = [];

  constructor(sort = 100) {
    this.sort = sort;
  }

  abstract activationGate(ctx: GateContext): Promise<boolean>;
  abstract update(userInput: string, snapshot: GlobalSnapshot, freshData: FetchResult[]): Promise<void>;
  abstract render(): Promise<string>;

  async subconsciousAdjust(ctx: SubconsciousContext): Promise<void> {
    if (ctx.pendingSuggestion) {
      this.state.fetchDirectives = {
        ...(this.state.fetchDirectives ?? {}),
        ...ctx.pendingSuggestion.adjustedFetchDirectives,
      };
    }
  }

  async fetchData(): Promise<FetchResult[]> {
    return fetchDataSources(this.bindings, this.state.fetchDirectives ?? {});
  }

  async subconsciousReflect(_ctx: ReflectContext): Promise<void> {
    // 默认不做事，子类按需覆盖。
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
    return true;
  }

  async receiveTidyRequest(tidyQuery: string): Promise<void> {
    if (tidyQuery.includes('清理主题')) {
      this.state.activeTopics = this.state.activeTopics.slice(0, 3);
    }
  }
}
