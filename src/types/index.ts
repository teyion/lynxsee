export interface DataBinding {
  type: 'markdown' | 'api' | 'database' | 'tool_result';
  locator: string;
  fetchDirectives: Record<string, any>;
  refreshPolicy: 'on_update' | 'on_render' | 'manual' | 'every_n_turns';
  lastFetchedAt?: number;
  lastFetchedHash?: string;
}

export interface Suggestion {
  adjustedFetchDirectives: Record<string, any>;
  reason: string;
  confidence: number;
}

export interface ModuleState {
  activeTopics: string[];
  temporalFocus: 'latest' | string;
  pendingSuggestion?: Suggestion | null;
  fetchDirectives?: Record<string, any>;
  [key: string]: any;
}

export interface RenderDirectives {
  maxTokens: number;
  outputFormat: string;
  templateVersion: string;
  [key: string]: any;
}

export interface GlobalSnapshot {
  conversationState: ModuleState;
  conversationRender: string;
  moduleSnapshots: Record<
    string,
    {
      state: ModuleState;
      lastRender: string;
    }
  >;
}

export interface GateContext {
  userInput: string;
  currentState: ModuleState;
  globalSnapshot: GlobalSnapshot;
}

export interface SubconsciousContext {
  userInput: string;
  state: ModuleState;
  pendingSuggestion: Suggestion | null;
}

export interface ReflectContext {
  userInput: string;
  response: string;
  myPromptSegment: string;
}

export interface FetchResult {
  bindingIndex: number;
  data: any;
}

export interface LoopDirective {
  continueLoop: boolean;
  reason: string;
  targetModuleIds: string[];
  maxPasses?: number;
}
