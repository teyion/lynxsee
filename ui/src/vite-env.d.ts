/// <reference types="vite/client" />

type CdaProgressEvent = {
  at: number;
  phase: 'turn' | 'layer' | 'module' | 'llm' | 'reflect' | 'usage';
  message: string;
  moduleId?: string;
  layer?: number;
  llmChunk?: string;
  usageEvent?: {
    source: string;
    normalized: {
      inputTokens: number;
      cachedTokens: number;
      outputTokens: number;
    };
  };
  reflectCounters?: {
    personaChanges?: number;
    memoryFragmentChanges?: number;
    scope?: 'last' | 'module' | 'turn';
  };
};

type TurnResult = {
  response: string;
  usage: {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
  };
};

type HealthResult = {
  app: string;
  engineReady: boolean;
  hint: string;
};

type PersonaPanelData = {
  personaBase: string;
  personaAttributes: Record<string, { constraint: string; fewshot: string[] }>;
  history: Array<{
    at: string;
    personaBaseChanged: boolean;
    changedKeys: string[];
    patches: Record<string, { before: string; after: string }>;
  }>;
};

type MemoryMetricsData = {
  updatedAt: string;
  totals: {
    writes: number;
    addWrites: number;
    updateWrites: number;
    duplicateLikeWrites: number;
    recallTurns: number;
    recallCandidatesBeforeRecentFilter: number;
    recallCandidatesFilteredByRecentWindow: number;
  };
  ratios: {
    duplicateWriteRate: number;
    updateAddRatio: number;
    avgFragmentLength: number;
    recentDuplicateRecallRate: number;
  };
};

type MemoryPanelData = {
  loadedAt: string;
  recallInboxCount: number;
  runtimeStatus: {
    phase: string;
    message: string;
    active: boolean;
    updatedAt: number;
  } | null;
  loadedFragments: Array<{
    filePath: string;
    layer: string;
    keyword: string;
    summary: string;
    timestamp: number;
    relevanceScore: number;
    relevanceReason: string;
    sourceType: 'time' | 'strategy';
    sourceStrategy: string;
    sourceDetail: string;
  }>;
};

export interface ActionItem {
  id: string;
  name: string;
  description: string;
  triggerCondition: string;
  videoPath: string;
  isIdle?: boolean;
  edgeSkipSeconds?: number;
}

type LLMConfigData = {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
};

type RoleCreationProgressEvent = {
  percent: number;
  stage: string;
};

declare global {
  interface Window {
    cdaClient: {
      getProfileCatalog(): Promise<ProfileCatalogData>;
      createRole(params: { name: string; setting: string; catchphrase: string; bgPath?: string }): Promise<string>;
      deleteRole(roleId: string): Promise<boolean>;
      setActiveProfile(roleId: string, styleId: string): Promise<ProfileCatalogData>;
      setSelectedBackground(roleId: string, styleId: string, backgroundName?: string): Promise<ProfileCatalogData>;
      pickImage(): Promise<string | null>;
      runTurn(userInput: string): Promise<TurnResult>;
      health(): Promise<HealthResult>;
      getPersonaPanel(): Promise<PersonaPanelData>;
      getMemoryPanel(): Promise<MemoryPanelData>;
      getMemoryMetrics(): Promise<MemoryMetricsData | null>;
      getLLMConfig(): Promise<LLMConfigData>;
      saveLLMConfig(baseURL: string, apiKey: string, model: string): Promise<boolean>;
      getActions(): Promise<ActionItem[]>;
      startIdleVideoStream(): Promise<string | null>;
      stopIdleVideoStream(): Promise<boolean>;
      startActionVideoStream(
        videoPath: string,
        edgeSkipSeconds?: number,
        actionId?: string
      ): Promise<{ queued?: boolean; url?: string; durationMs?: number } | null>;
      stopActionVideoStream(): Promise<boolean>;
      pickMp4(): Promise<string | null>;
      getVideoDataUrl(videoPath: string): Promise<string | null>;
      addAction(actionInfo: Omit<ActionItem, 'id' | 'videoPath'>, sourceVideoPath: string): Promise<ActionItem>;
      updateAction(id: string, actionInfo: Omit<ActionItem, 'id' | 'videoPath'>, sourceVideoPath?: string): Promise<ActionItem>;
      deleteAction(id: string): Promise<boolean>;
      onProgress(handler: (event: CdaProgressEvent) => void): () => void;
      onCreateRoleProgress(handler: (event: RoleCreationProgressEvent) => void): () => void;
    };
  }
}

export {};
