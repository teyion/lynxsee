import {
  DataBinding,
  FetchResult,
  GateContext,
  GlobalSnapshot,
  LoopDirective,
  ModuleState,
  ReflectContext,
  RenderDirectives,
  SubconsciousContext,
} from '../types/index.js';

export interface ContextModule {
  readonly id: string;
  readonly dependencies: string[];

  activationGate(ctx: GateContext): Promise<boolean>;
  subconsciousAdjust(ctx: SubconsciousContext): Promise<void>;
  fetchData(): Promise<FetchResult[]>;
  update(userInput: string, snapshot: GlobalSnapshot, freshData: FetchResult[]): Promise<void>;
  render(): Promise<string>;
  subconsciousReflect(ctx: ReflectContext): Promise<void>;

  getState(): ModuleState;
  getDirectives(): RenderDirectives;
  getBindings(): DataBinding[];
  getSort(): number;
  shouldRunLLM(): boolean;
  getLoopDirective?(): LoopDirective | null;
  getLifecycleTrace?(): string[];

  receiveTidyRequest(tidyQuery: string): Promise<void>;
}
