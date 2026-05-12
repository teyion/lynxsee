import { contextBridge, ipcRenderer } from 'electron';

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
  actionData?: {
    id: string;
    videoPath: string;
    edgeSkipSeconds?: number;
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

type ProfileCatalogData = {
  activeRoleId: string;
  activeStyleId: string;
  activeRoleLabel: string;
  activeStyleLabel: string;
  selectedBackgroundName?: string;
  roles: Array<{
    id: string;
    label: string;
    styles: Array<{
      id: string;
      label: string;
      backgroundCount: number;
    }>;
  }>;
  backgrounds: Array<{
    id: string;
    name: string;
    filePath: string;
    url: string;
  }>;
};

type ActionItem = {
  id: string;
  name: string;
  description: string;
  triggerCondition: string;
  videoPath: string;
  isIdle?: boolean;
  edgeSkipSeconds?: number;
};

type RoleCreationProgressEvent = {
  percent: number;
  stage: string;
};

const api = {
  runTurn(userInput: string): Promise<TurnResult> {
    return ipcRenderer.invoke('agent:runTurn', userInput);
  },
  health(): Promise<{ app: string; engineReady: boolean; hint: string }> {
    return ipcRenderer.invoke('agent:health');
  },
  getPersonaPanel(): Promise<PersonaPanelData> {
    return ipcRenderer.invoke('agent:getPersonaPanel');
  },
  getMemoryPanel(): Promise<MemoryPanelData> {
    return ipcRenderer.invoke('agent:getMemoryPanel');
  },
  getMemoryMetrics(): Promise<MemoryMetricsData | null> {
    return ipcRenderer.invoke('agent:getMemoryMetrics');
  },
  getActions(): Promise<ActionItem[]> {
    return ipcRenderer.invoke('agent:getActions');
  },
  getLLMConfig(): Promise<{ provider: string; baseURL: string; apiKey: string; model: string }> {
    return ipcRenderer.invoke('agent:getLLMConfig');
  },
  saveLLMConfig(baseURL: string, apiKey: string, model: string): Promise<boolean> {
    return ipcRenderer.invoke('agent:saveLLMConfig', baseURL, apiKey, model);
  },
  getProfileCatalog(): Promise<ProfileCatalogData> {
    return ipcRenderer.invoke('agent:getProfileCatalog');
  },
  createRole(params: { name: string; setting: string; catchphrase: string; bgPath?: string }): Promise<string> {
    return ipcRenderer.invoke('agent:createRole', params);
  },
  deleteRole(roleId: string): Promise<boolean> {
    return ipcRenderer.invoke('agent:deleteRole', roleId);
  },
  setActiveProfile(roleId: string, styleId: string): Promise<ProfileCatalogData> {
    return ipcRenderer.invoke('agent:setActiveProfile', roleId, styleId);
  },
  setSelectedBackground(roleId: string, styleId: string, backgroundName?: string): Promise<ProfileCatalogData> {
    return ipcRenderer.invoke('agent:setSelectedBackground', roleId, styleId, backgroundName);
  },
  pickImage(): Promise<string | null> {
    return ipcRenderer.invoke('agent:pickImage');
  },
  startIdleVideoStream(): Promise<string | null> {
    return ipcRenderer.invoke('agent:startIdleVideoStream');
  },
  stopIdleVideoStream(): Promise<boolean> {
    return ipcRenderer.invoke('agent:stopIdleVideoStream');
  },
  startActionVideoStream(
    videoPath: string,
    edgeSkipSeconds?: number,
    actionId?: string
  ): Promise<{ queued?: boolean; url?: string; durationMs?: number } | null> {
    return ipcRenderer.invoke('agent:startActionVideoStream', videoPath, edgeSkipSeconds, actionId);
  },
  stopActionVideoStream(): Promise<boolean> {
    return ipcRenderer.invoke('agent:stopActionVideoStream');
  },
  pickMp4(): Promise<string | null> {
    return ipcRenderer.invoke('agent:pickMp4');
  },
  getVideoDataUrl(videoPath: string): Promise<string | null> {
    return ipcRenderer.invoke('agent:getVideoDataUrl', videoPath);
  },
  addAction(actionInfo: Omit<ActionItem, 'id' | 'videoPath'>, sourceVideoPath: string): Promise<ActionItem> {
    return ipcRenderer.invoke('agent:addAction', actionInfo, sourceVideoPath);
  },
  updateAction(id: string, actionInfo: Omit<ActionItem, 'id' | 'videoPath'>, sourceVideoPath?: string): Promise<ActionItem> {
    return ipcRenderer.invoke('agent:updateAction', id, actionInfo, sourceVideoPath);
  },
  deleteAction(id: string): Promise<boolean> {
    return ipcRenderer.invoke('agent:deleteAction', id);
  },
  onProgress(handler: (event: CdaProgressEvent) => void): () => void {
    const listener = (_: unknown, data: CdaProgressEvent) => {
      handler(data);
    };
    ipcRenderer.on('agent:progress', listener);
    return () => ipcRenderer.removeListener('agent:progress', listener);
  },
  onCreateRoleProgress(handler: (event: RoleCreationProgressEvent) => void): () => void {
    const listener = (_: unknown, data: RoleCreationProgressEvent) => {
      handler(data);
    };
    ipcRenderer.on('agent:createRoleProgress', listener);
    return () => ipcRenderer.removeListener('agent:createRoleProgress', listener);
  },
};

contextBridge.exposeInMainWorld('cdaClient', api);
