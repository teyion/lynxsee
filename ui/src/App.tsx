import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  instant?: boolean;
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

type ActiveActionVideo = {
  id: number;
  videoPath: string;
  url: string;
  mode: 'action' | 'idle';
  edgeSkipSeconds: number;
};

function TypewriterText({ content, instant, isScrolling }: { content: string, instant?: boolean, isScrolling?: boolean }) {
  const [displayedLength, setDisplayedLength] = useState(instant ? content.length : 0);

  useEffect(() => {
    if (instant || isScrolling) {
      setDisplayedLength(content.length);
      return;
    }
    if (displayedLength < content.length) {
      const backlog = content.length - displayedLength;
      const speed = backlog > 100 ? 10 : backlog > 30 ? 25 : 50;
      const timer = setTimeout(() => {
        setDisplayedLength(prev => prev + 1);
      }, speed);
      return () => clearTimeout(timer);
    }
  }, [content, displayedLength, instant, isScrolling]);

  return (
    <>
      {content.substring(0, displayedLength)}
      {displayedLength < content.length && <span className="typewriter-cursor"></span>}
    </>
  );
}

type ModuleStatus = {
  moduleId: string;
  status: 'idle' | 'running' | 'done';
  layer?: number;
  detail?: string;
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

type BackgroundAsset = {
  id: string;
  name: string;
  filePath: string;
  url: string;
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
  backgrounds: BackgroundAsset[];
};

const PERSONA_LABELS: Record<string, string> = {
  identity_scope: '角色定位',
  tone_style: '语气风格',
  answer_structure: '回答结构',
  safety_boundary: '安全边界',
  user_impression: '用户印象',
  short_term_goal: '短期目标',
  long_term_goal: '长期目标',
  personaBase: '基础人设',
};

const MODULE_ORDER = ['conversation', 'persona', 'memory', 'task', 'tools'];
const MODULE_LABELS: Record<string, string> = {
  conversation: '理解对话',
  persona: '匹配人设',
  memory: '检索记忆',
  task: '规划任务',
  tools: '工具执行',
};

function getFriendlyProgressText(evt: any): string {
  if (!evt || !evt.phase) return '处理中...';
  if (evt.phase === 'module' && evt.moduleId) {
    const label = MODULE_LABELS[evt.moduleId] ?? '处理流程';
    const match = typeof evt.message === 'string' ? evt.message.match(/stage=([a-z_]+)/) : null;
    if (evt.moduleId === 'memory' && match) {
      const stage = match[1];
      if (stage === 'gate') return '正在唤起记忆模块...';
      if (stage === 'adjust') return '正在规划最近记忆与慢回忆...';
      if (stage === 'fetch') return '正在读取记忆数据...';
      if (stage === 'update') return '正在挂载记忆结果...';
      if (stage === 'render') return '正在整理记忆上下文...';
    }
    if (typeof evt.message === 'string' && evt.message.startsWith('start')) {
      return `正在${label}...`;
    }
    if (typeof evt.message === 'string' && evt.message.startsWith('done')) {
      return `${label}完成`;
    }
    return `正在${label}...`;
  }
  if (evt.phase === 'llm') {
    return '正在组织回复内容...';
  }
  if (evt.phase === 'usage') {
    return '正在统计本轮消耗...';
  }
  if (evt.phase === 'reflect') {
    if (evt.moduleId === 'memory' && typeof evt.message === 'string' && evt.message.startsWith('reflect start')) {
      return '正在离线回顾并补慢回忆...';
    }
    return '正在同步记忆与人设...';
  }
  if (evt.phase === 'runner') {
    return '正在准备回复...';
  }
  return '处理中...';
}

const RIGHT_ACTIONS = [
  { id: 'persona', icon: '👤', label: '人物' },
  { id: 'memory', icon: '◎', label: '记忆' },
  { id: 'heartbeat', icon: '∿', label: '心跳值', value: '86', isHeartbeat: true },
  { id: 'settings', icon: '⚙', label: '设置' },
];

const INITIAL_MESSAGES: Message[] = [
  { id: 'init1', role: 'assistant', content: '今天过得怎么样？', at: 1, instant: false },
  { id: 'init2', role: 'assistant', content: '有遇到什么开心的事吗？', at: 2, instant: false },
];

function formatTime(ts: number): { time: string; ampm: string; date: string; weekday: string } {
  const d = new Date(ts);
  let hours = d.getHours();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const mins = String(d.getMinutes()).padStart(2, '0');
  
  const month = d.getMonth() + 1;
  const date = d.getDate();
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const weekday = weekdays[d.getDay()];

  return {
    time: `${hours}:${mins}`,
    ampm,
    date: `${month}月${date}日`,
    weekday
  };
}

export interface ActionOption {
  id: string;
  label: string;
}

export function CustomSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: ActionOption[];
  disabled?: boolean;
  onChange: (val: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((o) => o.id === value) || options[0];

  return (
    <div className={`custom-select-container ${disabled ? 'disabled' : ''}`}>
      <div
        className="custom-select-trigger action-input"
        onClick={() => !disabled && setOpen(!open)}
      >
        <span>{selectedOption?.label ?? 'Select...'}</span>
        <svg
          className={`custom-select-arrow ${open ? 'open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>
      {open && !disabled && (
        <div className="custom-select-dropdown glass">
          {options.map((opt) => (
            <div
              key={opt.id}
              className={`custom-select-option ${opt.id === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(opt.id);
                setOpen(false);
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const ENABLE_IDLE_LIVE_STREAM = true;
  const HLS_STABLE_CONFIG = {
    enableWorker: true,
    lowLatencyMode: false,
    maxBufferLength: 1.2,
    backBufferLength: 1,
    liveSyncDuration: 0.6,
    liveMaxLatencyDuration: 1.4,
    maxLiveSyncPlaybackRate: 1,
  } as const;
  const [readyHint, setReadyHint] = useState('检查中...');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [lastEvent, setLastEvent] = useState<string>('等待输入');
  const [usage, setUsage] = useState({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
  const [reflect, setReflect] = useState({ personaChanges: 0, memoryFragmentChanges: 0, scope: 'last' });
  const [moduleStatus, setModuleStatus] = useState<Record<string, ModuleStatus>>({});
  const [showPersonaPanel, setShowPersonaPanel] = useState(false);
  const [personaPanel, setPersonaPanel] = useState<PersonaPanelData | null>(null);
  const [personaPanelLoading, setPersonaPanelLoading] = useState(false);
  const [personaPanelError, setPersonaPanelError] = useState('');
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [llmBaseURL, setLlmBaseURL] = useState('');
  const [llmAPIKey, setLlmAPIKey] = useState('');
  const [llmModel, setLlmModel] = useState('deepseek-v4-flash');
  const [llmConfigBusy, setLlmConfigBusy] = useState(false);
  const [llmConfigMessage, setLlmConfigMessage] = useState('');
  const [memoryPanel, setMemoryPanel] = useState<MemoryPanelData | null>(null);
  const [memoryPanelLoading, setMemoryPanelLoading] = useState(false);
  const [memoryPanelError, setMemoryPanelError] = useState('');
  const [memoryMetrics, setMemoryMetrics] = useState<MemoryMetricsData | null>(null);
  const [profileCatalog, setProfileCatalog] = useState<ProfileCatalogData | null>(null);
  const [profileError, setProfileError] = useState('');
  const [profileSwitchBusy, setProfileSwitchBusy] = useState(false);
  const [bgSaving, setBgSaving] = useState(false);

  const [personaTab, setPersonaTab] = useState<'info' | 'background' | 'actions'>('info');
  const [bgIndex, setBgIndex] = useState(0);

  const [isCreatingRole, setIsCreatingRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleSetting, setNewRoleSetting] = useState('');
  const [newRoleCatchphrase, setNewRoleCatchphrase] = useState('');
  const [newRoleBgPath, setNewRoleBgPath] = useState('');
  const [isGeneratingRole, setIsGeneratingRole] = useState(false);
  const [roleGenerationProgress, setRoleGenerationProgress] = useState<{
    percent: number;
    stage: string;
  }>({
    percent: 0,
    stage: '准备开始',
  });

  const [deleteRoleModal, setDeleteRoleModal] = useState<{ isOpen: boolean; roleId: string; roleName: string }>({ isOpen: false, roleId: '', roleName: '' });
  const [deleteRoleInput, setDeleteRoleInput] = useState('');
  const [deleteRoleBusy, setDeleteRoleBusy] = useState(false);

  const [actions, setActions] = useState<ActionItem[]>([]);
  const [currentActionVideo, setCurrentActionVideo] = useState<ActiveActionVideo | null>(null);
  const [nextActionVideo, setNextActionVideo] = useState<ActiveActionVideo | null>(null);
  const [useNextAsActiveLayer, setUseNextAsActiveLayer] = useState(false);
  const [actionName, setActionName] = useState('');
  const [actionDesc, setActionDesc] = useState('');
  const [actionTrigger, setActionTrigger] = useState('');
  const [actionIsIdle, setActionIsIdle] = useState(false);
  const [actionEdgeSkip, setActionEdgeSkip] = useState('0.2');
  const [actionFilePath, setActionFilePath] = useState('');
  const [actionFormError, setActionFormError] = useState('');
  const [actionFormBusy, setActionFormBusy] = useState(false);
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [editActionName, setEditActionName] = useState('');
  const [editActionDesc, setEditActionDesc] = useState('');
  const [editActionTrigger, setEditActionTrigger] = useState('');
  const [editActionIsIdle, setEditActionIsIdle] = useState(false);
  const [editActionEdgeSkip, setEditActionEdgeSkip] = useState('0.2');
  const [editActionFilePath, setEditActionFilePath] = useState('');
  const [editActionError, setEditActionError] = useState('');
  const [editActionBusy, setEditActionBusy] = useState(false);
  const [actionPreviewOpenId, setActionPreviewOpenId] = useState<string | null>(null);
  const [actionPreviewBusyId, setActionPreviewBusyId] = useState<string | null>(null);
  const [actionPreviewUrls, setActionPreviewUrls] = useState<Record<string, string>>({});
  const [actionPreviewError, setActionPreviewError] = useState('');
  const [idleStreamUrl, setIdleStreamUrl] = useState<string | null>(null);
  const [actionStreamUrl, setActionStreamUrl] = useState<string | null>(null);
  const [idleStreamFailed, setIdleStreamFailed] = useState(false);
  const actionVideoStoppedRef = useRef(false);
  const actionVideoPlayingRef = useRef(false);
  const actionVideoLoadSeqRef = useRef(0);
  const actionVideoIdSeqRef = useRef(0);
  const actionCurrentVideoRef = useRef<HTMLVideoElement | null>(null);
  const actionNextVideoRef = useRef<HTMLVideoElement | null>(null);
  const suppressStopDuringSwitchRef = useRef(false);
  const idlePreparingNextRef = useRef(false);
  const stagedLayerRef = useRef<'current' | 'next' | null>(null);
  const stagedVideoReadyRef = useRef(false);
  const videoLayerSwitchingRef = useRef(false);
  const idlePlayTimerRef = useRef<number | null>(null);
  const idleActionsRef = useRef<ActionItem[]>([]);
  const idleQueueRef = useRef<ActionItem[]>([]);
  const idleLastActionIdRef = useRef<string | null>(null);
  const idlePrefetchRef = useRef<{ videoPath: string; dataUrl: string } | null>(null);
  const idlePrefetchSeqRef = useRef(0);
  const idleStreamVideoRef = useRef<HTMLVideoElement | null>(null);
  const idleStreamHlsRef = useRef<Hls | null>(null);
  const idleStreamRetryTimerRef = useRef<number | null>(null);
  const idleStreamRetryCountRef = useRef(0);
  const actionStreamVideoRef = useRef<HTMLVideoElement | null>(null);
  const actionStreamHlsRef = useRef<Hls | null>(null);
  const actionStreamStopTimerRef = useRef<number | null>(null);
  const migratedBgStorageKeysRef = useRef(new Set<string>());
  const DEFAULT_EDGE_SKIP_SECONDS = 0.2;
  const IDLE_PREPARE_NEXT_SECONDS = 1.6;
  const IDLE_SWITCH_AHEAD_SECONDS = 0.5;
  const currentBackgroundOptions = useMemo(() => profileCatalog?.backgrounds ?? [], [profileCatalog]);
  const activeRoleStyles = useMemo(
    () => profileCatalog?.roles.find((item) => item.id === profileCatalog.activeRoleId)?.styles ?? [],
    [profileCatalog]
  );
  const currentBg = currentBackgroundOptions[bgIndex]?.url || currentBackgroundOptions[0]?.url || '';

  useEffect(() => {
    if (currentBackgroundOptions.length <= 0) {
      setBgIndex(0);
      return;
    }
    const selectedIdx = currentBackgroundOptions.findIndex(
      (item) => item.name === profileCatalog?.selectedBackgroundName
    );
    if (selectedIdx >= 0) {
      setBgIndex(selectedIdx);
      return;
    }
    setBgIndex(0);
  }, [currentBackgroundOptions, profileCatalog?.selectedBackgroundName]);

  useEffect(() => {
    if (!profileCatalog || currentBackgroundOptions.length <= 0 || profileCatalog.selectedBackgroundName) {
      return;
    }
    const storageKey = `cda_bg_index:${profileCatalog.activeRoleId}:${profileCatalog.activeStyleId}`;
    if (migratedBgStorageKeysRef.current.has(storageKey)) {
      return;
    }
    migratedBgStorageKeysRef.current.add(storageKey);
    const saved = localStorage.getItem(storageKey);
    if (saved === null) {
      return;
    }
    const idx = Number.parseInt(saved, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= currentBackgroundOptions.length) {
      localStorage.removeItem(storageKey);
      return;
    }
    const target = currentBackgroundOptions[idx];
    localStorage.removeItem(storageKey);
    void handleSelectBackground(target.name, idx);
  }, [currentBackgroundOptions, profileCatalog]);

  const getActionEdgeSkipSeconds = (action?: { edgeSkipSeconds?: number }) => {
    const value = Number(action?.edgeSkipSeconds ?? DEFAULT_EDGE_SKIP_SECONDS);
    if (!Number.isFinite(value)) {
      return DEFAULT_EDGE_SKIP_SECONDS;
    }
    return Math.max(0, value);
  };

  const clearIdlePlayTimer = () => {
    if (idlePlayTimerRef.current !== null) {
      window.clearTimeout(idlePlayTimerRef.current);
      idlePlayTimerRef.current = null;
    }
  };

  const clearActionStreamStopTimer = () => {
    if (actionStreamStopTimerRef.current !== null) {
      window.clearTimeout(actionStreamStopTimerRef.current);
      actionStreamStopTimerRef.current = null;
    }
  };

  const clearIdleStreamRetryTimer = () => {
    if (idleStreamRetryTimerRef.current !== null) {
      window.clearTimeout(idleStreamRetryTimerRef.current);
      idleStreamRetryTimerRef.current = null;
    }
  };

  const scheduleIdleStreamRetry = (reason: string) => {
    if (!ENABLE_IDLE_LIVE_STREAM) return;
    if (idleActionsRef.current.length === 0) return;
    if (idleStreamRetryTimerRef.current !== null) return;
    const retryCount = idleStreamRetryCountRef.current;
    const delayMs = Math.min(8000, 500 * Math.pow(2, Math.min(5, retryCount)));
    console.warn(`[idle-stream] live stream retry scheduled reason=${reason} retryCount=${retryCount} delayMs=${delayMs}`);
    idleStreamRetryTimerRef.current = window.setTimeout(() => {
      idleStreamRetryTimerRef.current = null;
      idleStreamRetryCountRef.current += 1;
      // @ts-ignore
      void window.cdaClient.startIdleVideoStream().then((url: string | null) => {
        if (url) {
          setIdleStreamUrl(url);
          setIdleStreamFailed(false);
          idleStreamRetryCountRef.current = 0;
          console.info(`[idle-stream] live stream active: ${url}`);
          return;
        }
        setIdleStreamFailed(true);
        scheduleIdleStreamRetry('start-returned-null');
      }).catch((err: unknown) => {
        console.error('[idle-stream] live stream retry failed', err);
        setIdleStreamFailed(true);
        scheduleIdleStreamRetry('start-threw');
      });
    }, delayMs);
  };

  const stopActionStreamPlayback = () => {
    clearActionStreamStopTimer();
    if (actionStreamHlsRef.current) {
      actionStreamHlsRef.current.destroy();
      actionStreamHlsRef.current = null;
    }
    const video = actionStreamVideoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    setActionStreamUrl(null);
    // @ts-ignore
    void window.cdaClient.stopActionVideoStream();
  };

  const shuffleActions = (list: ActionItem[]): ActionItem[] => {
    const arr = [...list];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };

  const refillIdleQueue = () => {
    const shuffled = shuffleActions(idleActionsRef.current);
    if (shuffled.length > 1 && idleLastActionIdRef.current) {
      const first = shuffled[0];
      if (first.id === idleLastActionIdRef.current) {
        const moved = shuffled.shift();
        if (moved) {
          shuffled.push(moved);
        }
      }
    }
    idleQueueRef.current = shuffled;
  };

  const getNextIdleAction = (): ActionItem | null => {
    if (idleQueueRef.current.length === 0) {
      refillIdleQueue();
    }
    const next = idleQueueRef.current.shift() ?? null;
    if (next) {
      idleLastActionIdRef.current = next.id;
    }
    return next;
  };

  const prefetchNextIdleVideo = async () => {
    if (idleActionsRef.current.length === 0) {
      idlePrefetchRef.current = null;
      return;
    }
    if (idleQueueRef.current.length === 0) {
      refillIdleQueue();
    }
    const next = idleQueueRef.current[0];
    if (!next) {
      return;
    }
    if (idlePrefetchRef.current?.videoPath === next.videoPath) {
      return;
    }
    const seq = ++idlePrefetchSeqRef.current;
    try {
      // @ts-ignore
      const dataUrl = await window.cdaClient.getVideoDataUrl(next.videoPath);
      if (seq !== idlePrefetchSeqRef.current) {
        return;
      }
      if (!dataUrl) {
        return;
      }
      idlePrefetchRef.current = { videoPath: next.videoPath, dataUrl };
    } catch {
      // ignore prefetch failures, fallback to normal load
    }
  };

  const playNextIdleVideo = async () => {
    if (actionVideoPlayingRef.current) {
      return;
    }
    const nextIdle = getNextIdleAction();
    if (!nextIdle) {
      return;
    }
    let preloadedDataUrl: string | undefined;
    if (idlePrefetchRef.current?.videoPath === nextIdle.videoPath) {
      preloadedDataUrl = idlePrefetchRef.current.dataUrl;
      idlePrefetchRef.current = null;
    }
    await playActionVideo(nextIdle.videoPath, 'idle', preloadedDataUrl, getActionEdgeSkipSeconds(nextIdle));
  };

  const scheduleIdlePlay = (delayMs = 0) => {
    if (ENABLE_IDLE_LIVE_STREAM && idleStreamUrl && !idleStreamFailed) {
      return;
    }
    if (ENABLE_IDLE_LIVE_STREAM && (idleStreamFailed || !idleStreamUrl)) {
      // live-stream mode does not fallback to local idle playback.
      return;
    }
    clearIdlePlayTimer();
    if (actionVideoPlayingRef.current) {
      return;
    }
    if (idleActionsRef.current.length === 0) {
      return;
    }
    idlePlayTimerRef.current = window.setTimeout(() => {
      void playNextIdleVideo();
    }, delayMs);
  };

  const stopActionVideo = () => {
    if (suppressStopDuringSwitchRef.current) {
      return;
    }
    if (actionVideoStoppedRef.current) {
      return;
    }
    actionVideoStoppedRef.current = true;
    actionVideoLoadSeqRef.current += 1;
    actionVideoPlayingRef.current = false;
    setCurrentActionVideo(null);
    setNextActionVideo(null);
    setUseNextAsActiveLayer(false);
    stagedLayerRef.current = null;
    stagedVideoReadyRef.current = false;
    videoLayerSwitchingRef.current = false;
    idlePreparingNextRef.current = false;
    suppressStopDuringSwitchRef.current = false;
    scheduleIdlePlay(0);
  };

  const handleCurrentActionVideoLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const edgeSkip = currentActionVideo?.edgeSkipSeconds ?? DEFAULT_EDGE_SKIP_SECONDS;
    const video = e.currentTarget;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > edgeSkip * 2) {
      video.currentTime = edgeSkip;
    }
    if (stagedLayerRef.current === 'current') {
      video.pause();
      stagedVideoReadyRef.current = true;
    }
  };

  const switchToStagedIdleVideoLayer = () => {
    if (!stagedLayerRef.current || !stagedVideoReadyRef.current || videoLayerSwitchingRef.current) {
      return;
    }
    const stagedLayer = stagedLayerRef.current;
    const stagedVideo = stagedLayer === 'next' ? nextActionVideo : currentActionVideo;
    if (!stagedVideo) {
      return;
    }
    const stagedEl = stagedLayer === 'next' ? actionNextVideoRef.current : actionCurrentVideoRef.current;
    if (!stagedEl) {
      return;
    }
    videoLayerSwitchingRef.current = true;
    suppressStopDuringSwitchRef.current = true;
    setUseNextAsActiveLayer(stagedLayer === 'next');
    const edgeSkip = stagedVideo.edgeSkipSeconds ?? DEFAULT_EDGE_SKIP_SECONDS;
    if (stagedEl.currentTime < edgeSkip) {
      stagedEl.currentTime = edgeSkip;
    }
    void stagedEl.play().catch(() => {});
    actionVideoPlayingRef.current = true;
    const oldLayer = stagedLayer === 'next' ? 'current' : 'next';
    window.setTimeout(() => {
      if (oldLayer === 'current') {
        setCurrentActionVideo(null);
      } else {
        setNextActionVideo(null);
      }
      stagedLayerRef.current = null;
      stagedVideoReadyRef.current = false;
      videoLayerSwitchingRef.current = false;
      idlePreparingNextRef.current = false;
      suppressStopDuringSwitchRef.current = false;
      if (stagedVideo.mode === 'idle') {
        void prefetchNextIdleVideo();
      }
    }, 140);
  };

  const handleActionVideoTimeUpdate = (layer: 'current' | 'next', e: React.SyntheticEvent<HTMLVideoElement>) => {
    const isActiveLayer = layer === 'next' ? useNextAsActiveLayer : !useNextAsActiveLayer;
    if (!isActiveLayer) {
      return;
    }
    const video = e.currentTarget;
    const activeVideo = layer === 'next' ? nextActionVideo : currentActionVideo;
    if (!activeVideo) {
      return;
    }
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration <= 0) {
      return;
    }
    const remaining = duration - video.currentTime;

    if (activeVideo.mode === 'idle') {
      if (remaining <= IDLE_PREPARE_NEXT_SECONDS && !stagedLayerRef.current && !idlePreparingNextRef.current) {
        idlePreparingNextRef.current = true;
        void prepareNextIdleVideoLayer();
      }
      if (remaining <= IDLE_SWITCH_AHEAD_SECONDS && stagedVideoReadyRef.current) {
        switchToStagedIdleVideoLayer();
        return;
      }
    }

    const edgeSkip = activeVideo.edgeSkipSeconds ?? DEFAULT_EDGE_SKIP_SECONDS;
    if (video.currentTime >= duration - edgeSkip && !videoLayerSwitchingRef.current) {
      stopActionVideo();
    }
  };

  const handleNextActionVideoLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const edgeSkip = nextActionVideo?.edgeSkipSeconds ?? DEFAULT_EDGE_SKIP_SECONDS;
    const video = e.currentTarget;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > edgeSkip * 2) {
      video.currentTime = edgeSkip;
    }
    if (stagedLayerRef.current === 'next') {
      video.pause();
      stagedVideoReadyRef.current = true;
    }
  };

  const prepareNextIdleVideoLayer = async () => {
    try {
      const nextIdle = getNextIdleAction();
      if (!nextIdle) {
        idlePreparingNextRef.current = false;
        return;
      }
      let preloadedDataUrl: string | undefined;
      if (idlePrefetchRef.current?.videoPath === nextIdle.videoPath) {
        preloadedDataUrl = idlePrefetchRef.current.dataUrl;
        idlePrefetchRef.current = null;
      }
      const dataUrl = preloadedDataUrl
        ? preloadedDataUrl
        : // @ts-ignore
          await window.cdaClient.getVideoDataUrl(nextIdle.videoPath);
      if (!dataUrl) {
        idlePreparingNextRef.current = false;
        return;
      }
      const stagedVideo: ActiveActionVideo = {
        id: ++actionVideoIdSeqRef.current,
        videoPath: nextIdle.videoPath,
        url: dataUrl,
        mode: 'idle',
        edgeSkipSeconds: getActionEdgeSkipSeconds(nextIdle),
      };
      const targetLayer: 'current' | 'next' = useNextAsActiveLayer ? 'current' : 'next';
      stagedLayerRef.current = targetLayer;
      stagedVideoReadyRef.current = false;
      if (targetLayer === 'next') {
        setNextActionVideo(stagedVideo);
      } else {
        setCurrentActionVideo(stagedVideo);
      }
      void prefetchNextIdleVideo();
    } catch {
      idlePreparingNextRef.current = false;
    }
  };

  const playActionVideo = async (
    videoPath: string,
    mode: 'action' | 'idle' = 'action',
    preloadedDataUrl?: string,
    edgeSkipSeconds?: number
  ) => {
    try {
      clearIdlePlayTimer();
      actionVideoStoppedRef.current = false;
      const loadSeq = ++actionVideoLoadSeqRef.current;
      actionVideoPlayingRef.current = false;
      const dataUrl = preloadedDataUrl
        ? preloadedDataUrl
        : // @ts-ignore
          await window.cdaClient.getVideoDataUrl(videoPath);
      if (loadSeq !== actionVideoLoadSeqRef.current) {
        return;
      }
      if (!dataUrl) {
        if (mode === 'idle') {
          scheduleIdlePlay(0);
        }
        return;
      }
      const newVideo: ActiveActionVideo = {
        id: ++actionVideoIdSeqRef.current,
        videoPath,
        url: dataUrl,
        mode,
        edgeSkipSeconds: Math.max(0, Number(edgeSkipSeconds ?? DEFAULT_EDGE_SKIP_SECONDS)),
      };
      setNextActionVideo(null);
      setUseNextAsActiveLayer(false);
      stagedLayerRef.current = null;
      stagedVideoReadyRef.current = false;
      videoLayerSwitchingRef.current = false;
      idlePreparingNextRef.current = false;
      suppressStopDuringSwitchRef.current = false;
      actionVideoPlayingRef.current = true;
      setCurrentActionVideo(newVideo);
      if (mode === 'idle') {
        void prefetchNextIdleVideo();
      }
    } catch {
      if (mode === 'idle') {
        scheduleIdlePlay(0);
      }
      setCurrentActionVideo(null);
    }
  };

  useEffect(() => {
    // @ts-ignore
    window.cdaClient
      .health()
      .then((res: any) => {
        setReadyHint(res.engineReady ? '已连接引擎' : res.hint);
      })
      .catch((err: any) => {
        setReadyHint(`检查失败: ${String(err)}`);
      });
  }, []);

  useEffect(() => {
    // @ts-ignore
    return window.cdaClient.onProgress((evt: any) => {
      setLastEvent(getFriendlyProgressText(evt));
      if (evt.phase === 'action' && evt.actionData) {
        const actionEvtAt = performance.now();
        console.info(
          `[latency][frontend] action_event actionId=${evt.actionData.id ?? '(none)'} at=${Date.now()}`
        );
        if (ENABLE_IDLE_LIVE_STREAM) {
          // @ts-ignore
          void window.cdaClient
            .startActionVideoStream(evt.actionData.videoPath, evt.actionData.edgeSkipSeconds, evt.actionData.id)
            .then((result: { queued?: boolean; url?: string; durationMs?: number } | null) => {
              const ipcMs = Math.max(0, Math.round(performance.now() - actionEvtAt));
              console.info(
                `[latency][frontend] action_ipc_done actionId=${evt.actionData.id ?? '(none)'} ipcMs=${ipcMs} queued=${Boolean(
                  result?.queued
                )}`
              );
              if (result?.queued) {
                console.info('[action-stream] queued into single idle live stream');
                return;
              }
              if (result?.url) {
                clearActionStreamStopTimer();
                setActionStreamUrl(result.url);
                actionStreamStopTimerRef.current = window.setTimeout(() => {
                  stopActionStreamPlayback();
                }, Math.max(300, (result.durationMs ?? 0) + 120));
                return;
              }
              void playActionVideo(evt.actionData.videoPath, 'action', undefined, evt.actionData.edgeSkipSeconds);
            })
            .catch(() => {
              void playActionVideo(evt.actionData.videoPath, 'action', undefined, evt.actionData.edgeSkipSeconds);
            });
        } else {
          void playActionVideo(evt.actionData.videoPath, 'action', undefined, evt.actionData.edgeSkipSeconds);
        }
      }
      if (evt.phase === 'module' && evt.moduleId) {
        const running = evt.message.startsWith('start');
        const done = evt.message.startsWith('done');
        const detailText = getFriendlyProgressText(evt);
        setModuleStatus((prev) => ({
          ...prev,
          [evt.moduleId!]: {
            moduleId: evt.moduleId!,
            layer: evt.layer,
            status: running ? 'running' : done ? 'done' : prev[evt.moduleId!]?.status ?? 'idle',
            detail: detailText,
          },
        }));
        if (evt.moduleId === 'memory' && done && showMemoryPanel) {
          void loadMemoryPanel();
        }
      }
      if (evt.phase === 'reflect' && evt.moduleId === 'memory' && showMemoryPanel) {
        void loadMemoryPanel();
      }
      // Handle actual LLM token streaming
      if (evt.phase === 'llm') {
        let chunk = '';
        if (evt.llmChunk) {
           chunk = evt.llmChunk;
        } else if (evt.message && evt.message.startsWith('chunk:')) {
           chunk = evt.message.replace('chunk:', '');
        }
        if (chunk) {
           setMessages(prev => {
             if (prev.length === 0) return prev;
             const newMsgs = [...prev];
             const lastMsg = { ...newMsgs[newMsgs.length - 1] };
             if (lastMsg.role === 'assistant') {
               if (lastMsg.content === '...') lastMsg.content = '';
               lastMsg.content += chunk;
               newMsgs[newMsgs.length - 1] = lastMsg;
             }
             return newMsgs;
           });
        }
      }
      if (evt.phase === 'usage' && evt.usageEvent?.normalized) {
        setUsage((prev) => ({
          inputTokens: prev.inputTokens + evt.usageEvent!.normalized.inputTokens,
          cachedTokens: prev.cachedTokens + evt.usageEvent!.normalized.cachedTokens,
          outputTokens: prev.outputTokens + evt.usageEvent!.normalized.outputTokens,
        }));
      }
      if (evt.phase === 'reflect' && evt.reflectCounters) {
        setReflect({
          personaChanges: evt.reflectCounters.personaChanges ?? 0,
          memoryFragmentChanges: evt.reflectCounters.memoryFragmentChanges ?? 0,
          scope: evt.reflectCounters.scope ?? 'last',
        });
      }
    });
  }, [showMemoryPanel]);

  useEffect(() => {
    return () => {
      clearIdlePlayTimer();
      clearActionStreamStopTimer();
      stopActionStreamPlayback();
      // @ts-ignore
      void window.cdaClient.stopIdleVideoStream();
    };
  }, []);

  const moduleCards = useMemo(() => {
    return MODULE_ORDER.map((id) => {
      const item = moduleStatus[id] ?? { moduleId: id, status: 'idle' as const };
      return item;
    });
  }, [moduleStatus]);

  const moduleProgress = useMemo(() => {
    const total = moduleCards.length || 1;
    const doneCount = moduleCards.filter((m) => m.status === 'done').length;
    const running = moduleCards.find((m) => m.status === 'running');
    const idleCount = moduleCards.filter((m) => m.status === 'idle').length;
    const progressRaw = doneCount + (running ? 0.5 : 0);
    const percent = Math.min(100, Math.round((progressRaw / total) * 100));
    let statusText = '等待开始';
    if (running) {
      statusText = `正在${MODULE_LABELS[running.moduleId] ?? running.moduleId}`;
    } else if (doneCount === total && total > 0) {
      statusText = '已完成本轮回复';
    } else if (doneCount > 0 || idleCount < total) {
      statusText = '处理中';
    }
    return { percent, statusText };
  }, [moduleCards]);

  const memoryStatus = useMemo(() => {
    const memoryModuleState = moduleStatus.memory?.status ?? 'idle';
    const memoryDetail = moduleStatus.memory?.detail;
    const active = memoryPanelLoading || memoryModuleState === 'running';
    if (memoryPanelError) {
      return {
        icon: '!',
        title: '记忆读取失败',
        sub: 'ERROR',
        active: false,
        tone: 'error' as const,
      };
    }
    if (active) {
      return {
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ),
        title: memoryDetail || memoryPanel?.runtimeStatus?.message || '记忆回溯中...',
        sub: 'MEMORY',
        active: true,
        tone: 'active' as const,
      };
    }
    if (memoryModuleState === 'done' || memoryPanel) {
      return {
        icon: '✓',
        title: memoryPanel?.runtimeStatus?.message || '记忆已同步',
        sub: 'READY',
        active: false,
        tone: 'ready' as const,
      };
    }
    return {
      icon: '○',
      title: '记忆待命中',
      sub: 'STANDBY',
      active: false,
      tone: 'idle' as const,
    };
  }, [memoryPanel, memoryPanelError, memoryPanelLoading, moduleStatus.memory?.detail, moduleStatus.memory?.status]);

  const usageSummary = useMemo(() => {
    const total = usage.inputTokens + usage.cachedTokens + usage.outputTokens;
    return {
      total,
      input: usage.inputTokens,
      cache: usage.cachedTokens,
      output: usage.outputTokens,
    };
  }, [usage]);

  const agentUpdateSummary = useMemo(() => {
    const updates = reflect.personaChanges + reflect.memoryFragmentChanges;
    let scopeText = '本轮对话';
    if (reflect.scope === 'session') {
      scopeText = '本次会话';
    } else if (reflect.scope === 'global') {
      scopeText = '长期记忆';
    }
    return {
      updates,
      scopeText,
      persona: reflect.personaChanges,
      memory: reflect.memoryFragmentChanges,
    };
  }, [reflect]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const content = input.trim();
    if (!content || busy) {
      return;
    }
    setBusy(true);
    setInput('');
    setLastEvent('正在理解你的输入...');
    setUsage({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
    setModuleStatus({});
    
    const userMsgId = Date.now().toString();
    const assistantMsgId = (Date.now() + 1).toString();
    
    setMessages((prev) => [
      ...prev, 
      { id: userMsgId, role: 'user', content, at: Date.now(), instant: true },
      { id: assistantMsgId, role: 'assistant', content: '...', at: Date.now() + 1, instant: false }
    ]);
    
    try {
      // 开启流式响应，并在完成后将完整结果保存为最终消息
      // @ts-ignore
      const result = await window.cdaClient.runTurn(content);
      setMessages(prev => {
        const newMsgs = [...prev];
        const lastMsg = { ...newMsgs[newMsgs.length - 1] };
        if (lastMsg.role === 'assistant' && lastMsg.id === assistantMsgId) {
          lastMsg.content = result.response;
          newMsgs[newMsgs.length - 1] = lastMsg;
        }
        return newMsgs;
      });
      setLastEvent('回复完成');
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), role: 'assistant', content: `请求失败: ${String(err)}`, at: Date.now(), instant: true },
      ]);
      setLastEvent('回复失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  const [msgHeights, setMsgHeights] = useState<Record<string, number>>({});
  const observer = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      setMsgHeights(prev => {
        let changed = false;
        const next = { ...prev };
        for (let entry of entries) {
          const id = entry.target.getAttribute('data-msg-id');
          if (id) {
            const h = (entry.target as HTMLElement).offsetHeight;
            if (Math.abs((next[id] || 0) - h) > 2) {
              next[id] = h;
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
    });
    return () => observer.current?.disconnect();
  }, []);

  const measureRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) {
      el.setAttribute('data-msg-id', id);
      observer.current?.observe(el);
    }
  };

  const [scrollOffset, setScrollOffset] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimer = useRef<number | null>(null);

  useEffect(() => {
    setScrollOffset(0);
  }, [messages.length]);

  const maxScroll = useMemo(() => {
    const total = messages.reduce((acc, msg) => acc + (msgHeights[msg.id] || 50) + 24, 0);
    return Math.max(0, total - 400); 
  }, [messages, msgHeights]);

  const handleWheel = (e: React.WheelEvent) => {
    // Mark as scrolling to disable transitions
    setIsScrolling(true);
    if (scrollTimer.current) window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => setIsScrolling(false), 150);

    // Calculate new scroll offset
    setScrollOffset(prev => {
      const next = prev - e.deltaY;
      const bounded = Math.max(0, Math.min(maxScroll, next));
      
      // If we are scrolling up into history (offset > 0), force all messages to be instant
      if (bounded > 0) {
        setMessages(msgs => msgs.map(m => m.instant ? m : { ...m, instant: true }));
      }
      
      return bounded;
    });
  };

  const layouts = useMemo(() => {
    const reversed = [...messages].reverse();
    let currentBottom = 0;
    const FADE_START = 350;
    const FADE_END = 600;
    const BOTTOM_FADE_START = 0;
    const BOTTOM_FADE_END = -50;

    return reversed.map((msg) => {
      const h = msgHeights[msg.id] || 50; 
      const rawBottom = currentBottom;
      currentBottom += h + 24; 
      
      const bottom = rawBottom - scrollOffset;
      
      let opacity = 1;
      
      if (bottom > FADE_START) {
        opacity = Math.max(0, 1 - (bottom - FADE_START) / (FADE_END - FADE_START));
      } else if (bottom < BOTTOM_FADE_START) {
        opacity = Math.max(0, (bottom - BOTTOM_FADE_END) / (BOTTOM_FADE_START - BOTTOM_FADE_END));
      }
      
      // 3D Layout calculations
      const centerBottom = 200; // The focal point (closest to the viewer)
      const dist = bottom - centerBottom;
      
      // Curve in depth (push back as it goes away from center)
      const translateZ = -Math.pow(dist, 2) * 0.002;
      
      // Curve horizontally (moves right at the top/bottom, left in the center)
      const translateX = Math.pow(dist, 2) * 0.001 - 30;
      
      // Tilt up/down to face the center
      const rotateX = dist * 0.06;
      
      // Fixed rotation to angle the messages slightly
      const rotateY = 20;

      return { 
        ...msg, 
        bottom, 
        opacity, 
        transform: `translate3d(${translateX}px, 0, ${translateZ}px) rotateY(${rotateY}deg) rotateX(${rotateX}deg)`, 
        visible: opacity > 0 
      };
    });
  }, [messages, msgHeights, scrollOffset]);

  const [showStatus, setShowStatus] = useState(false);

  const resetRoleScopedUiState = () => {
    setMessages(INITIAL_MESSAGES);
    setPersonaPanel(null);
    setPersonaPanelError('');
    setMemoryPanel(null);
    setMemoryPanelError('');
    setMemoryMetrics(null);
    setActions([]);
    setActionPreviewOpenId(null);
    setActionPreviewBusyId(null);
    setActionPreviewUrls({});
    setActionPreviewError('');
    cancelEditAction();
    stopActionStreamPlayback();
    setIdleStreamUrl(null);
    setIdleStreamFailed(false);
    clearIdleStreamRetryTimer();
    idleStreamRetryCountRef.current = 0;
    // @ts-ignore
    void window.cdaClient.stopIdleVideoStream();
  };

  async function loadProfileCatalog() {
    try {
      setProfileError('');
      // @ts-ignore
      const data = await window.cdaClient.getProfileCatalog();
      setProfileCatalog(data);
    } catch (err) {
      setProfileError(`读取角色配置失败: ${String(err)}`);
    }
  }

  async function switchProfile(roleId: string, styleId: string) {
    try {
      setProfileSwitchBusy(true);
      setProfileError('');
      resetRoleScopedUiState();
      // @ts-ignore
      const data = await window.cdaClient.setActiveProfile(roleId, styleId);
      setProfileCatalog(data);
      await Promise.all([loadActions(), loadPersonaPanel(), loadMemoryPanel(), loadMemoryMetrics()]);
    } catch (err) {
      setProfileError(`切换角色/风格失败: ${String(err)}`);
    } finally {
      setProfileSwitchBusy(false);
    }
  }

  async function handleSelectBackground(backgroundName: string, idx: number) {
    if (!profileCatalog || bgSaving) {
      return;
    }
    if (idx === bgIndex && backgroundName === profileCatalog.selectedBackgroundName) {
      return;
    }
    try {
      setBgSaving(true);
      setProfileError('');
      setBgIndex(idx);
      // @ts-ignore
      const data = await window.cdaClient.setSelectedBackground(
        profileCatalog.activeRoleId,
        profileCatalog.activeStyleId,
        backgroundName
      );
      setProfileCatalog(data);
    } catch (err) {
      setProfileError(`保存背景选择失败: ${String(err)}`);
      await loadProfileCatalog();
    } finally {
      setBgSaving(false);
    }
  }

  const deleteRoleNameMatches = deleteRoleInput.trim() === deleteRoleModal.roleName.trim();

  const handleConfirmDeleteRole = async () => {
    if (!deleteRoleModal.roleId || !deleteRoleNameMatches) {
      return;
    }
    try {
      setDeleteRoleBusy(true);
      setProfileError('');
      await window.cdaClient.deleteRole(deleteRoleModal.roleId);
      await switchProfile('default', 'default');
      setDeleteRoleModal({ isOpen: false, roleId: '', roleName: '' });
      setDeleteRoleInput('');
      setIsCreatingRole(false);
      await loadProfileCatalog();
    } catch (err) {
      setProfileError(`删除角色失败: ${String(err)}`);
    } finally {
      setDeleteRoleBusy(false);
    }
  };

  async function loadMemoryMetrics() {
    try {
      // @ts-ignore
      const data = await window.cdaClient.getMemoryMetrics();
      setMemoryMetrics(data);
    } catch {
      setMemoryMetrics(null);
    }
  }

  useEffect(() => {
    if (showStatus) {
      void loadMemoryMetrics();
    }
  }, [showStatus]);

  const memoryQualitySummary = useMemo(() => {
    if (!memoryMetrics) {
      return {
        duplicateWriteRate: '--',
        updateShare: '--',
        avgFragmentLength: '--',
        recentFilterRate: '--',
        totalWrites: 0,
      };
    }
    const duplicateWriteRate = `${(memoryMetrics.ratios.duplicateWriteRate * 100).toFixed(1)}%`;
    const updateShare = `${(memoryMetrics.totals.updateWrites / Math.max(1, memoryMetrics.totals.writes) * 100).toFixed(1)}%`;
    const avgFragmentLength = `${memoryMetrics.ratios.avgFragmentLength.toFixed(0)} 字`;
    const recentFilterRate = `${(memoryMetrics.ratios.recentDuplicateRecallRate * 100).toFixed(1)}%`;
    return {
      duplicateWriteRate,
      updateShare,
      avgFragmentLength,
      recentFilterRate,
      totalWrites: memoryMetrics.totals.writes,
    };
  }, [memoryMetrics]);

  async function loadPersonaPanel() {
    try {
      setPersonaPanelLoading(true);
      setPersonaPanelError('');
      // @ts-ignore
      const data = await window.cdaClient.getPersonaPanel();
      setPersonaPanel(data);
    } catch (err) {
      setPersonaPanelError(`读取人设失败: ${String(err)}`);
    } finally {
      setPersonaPanelLoading(false);
    }
  }

  async function loadMemoryPanel() {
    try {
      setMemoryPanelLoading(true);
      setMemoryPanelError('');
      // @ts-ignore
      const data = await window.cdaClient.getMemoryPanel();
      setMemoryPanel(data);
    } catch (err) {
      setMemoryPanelError(`读取记忆面板失败: ${String(err)}`);
    } finally {
      setMemoryPanelLoading(false);
    }
  }

  const loadActions = async () => {
    try {
      // @ts-ignore
      const data = await window.cdaClient.getActions();
      setActions(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    void loadProfileCatalog();
  }, []);

  useEffect(() => {
    void loadActions();
  }, []);

  useEffect(() => {
    return window.cdaClient.onCreateRoleProgress((event) => {
      setRoleGenerationProgress(event);
    });
  }, []);

  useEffect(() => {
    idleActionsRef.current = actions.filter((action) => Boolean(action.isIdle));
    idleQueueRef.current = [];
    idlePrefetchRef.current = null;
    idlePrefetchSeqRef.current += 1;
    if (ENABLE_IDLE_LIVE_STREAM) {
      const hasIdle = idleActionsRef.current.length > 0;
      if (!hasIdle) {
        clearIdleStreamRetryTimer();
        idleStreamRetryCountRef.current = 0;
        setIdleStreamUrl(null);
        setIdleStreamFailed(false);
        // @ts-ignore
        void window.cdaClient.stopIdleVideoStream();
        return;
      }
      // @ts-ignore
      void window.cdaClient.startIdleVideoStream().then((url: string | null) => {
        setIdleStreamUrl(url);
        const failed = !url;
        setIdleStreamFailed(failed);
        if (failed) {
          scheduleIdleStreamRetry('startup-null');
        } else {
          clearIdleStreamRetryTimer();
          idleStreamRetryCountRef.current = 0;
          console.info(`[idle-stream] live stream active: ${url}`);
        }
      }).catch((err: unknown) => {
        console.error('[idle-stream] live stream startup failed', err);
        setIdleStreamFailed(true);
        scheduleIdleStreamRetry('startup-threw');
      });
      return;
    }
    if (!actionVideoPlayingRef.current) {
      scheduleIdlePlay(0);
    } else {
      void prefetchNextIdleVideo();
    }
  }, [actions]);

  useEffect(() => {
    const video = idleStreamVideoRef.current;
    if (!video) {
      return;
    }
    if (idleStreamHlsRef.current) {
      idleStreamHlsRef.current.destroy();
      idleStreamHlsRef.current = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (!idleStreamUrl) {
      return;
    }
    console.info('[idle-stream] attaching stream to background video element');
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = idleStreamUrl;
      void video.play().catch(() => {});
      return;
    }
    if (Hls.isSupported()) {
      const hls = new Hls(HLS_STABLE_CONFIG);
      idleStreamHlsRef.current = hls;
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(idleStreamUrl);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.info('[idle-stream] manifest parsed, start playback');
        void video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
          console.error('[idle-stream] hls fatal error, retry live stream', data);
          if (idleStreamHlsRef.current) {
            idleStreamHlsRef.current.destroy();
            idleStreamHlsRef.current = null;
          }
          setIdleStreamFailed(true);
          setIdleStreamUrl(null);
          scheduleIdleStreamRetry(`hls-${String(data?.details ?? data?.type ?? 'fatal')}`);
        }
      });
    }
    return () => {
      if (idleStreamHlsRef.current) {
        idleStreamHlsRef.current.destroy();
        idleStreamHlsRef.current = null;
      }
    };
  }, [idleStreamUrl]);

  useEffect(() => {
    const video = actionStreamVideoRef.current;
    if (!video) {
      return;
    }
    if (actionStreamHlsRef.current) {
      actionStreamHlsRef.current.destroy();
      actionStreamHlsRef.current = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (!actionStreamUrl) {
      return;
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = actionStreamUrl;
      void video.play().catch(() => {});
      return;
    }
    if (Hls.isSupported()) {
      const hls = new Hls(HLS_STABLE_CONFIG);
      actionStreamHlsRef.current = hls;
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(actionStreamUrl);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        void video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
          console.error('[action-stream] hls fatal error, fallback local action', data);
          stopActionStreamPlayback();
        }
      });
    }
    return () => {
      if (actionStreamHlsRef.current) {
        actionStreamHlsRef.current.destroy();
        actionStreamHlsRef.current = null;
      }
    };
  }, [actionStreamUrl]);

  useEffect(() => {
    if (!ENABLE_IDLE_LIVE_STREAM) {
      return;
    }
    if ((!idleStreamUrl || idleStreamFailed) && idleActionsRef.current.length > 0) {
      scheduleIdleStreamRetry('watchdog');
    }
  }, [idleStreamUrl, idleStreamFailed]);

  useEffect(() => () => {
    clearIdleStreamRetryTimer();
  }, []);

  const handlePickActionVideo = async () => {
    try {
      // @ts-ignore
      const fp = await window.cdaClient.pickMp4();
      if (!fp) {
        return;
      }
      setActionFormError('');
      setActionFilePath(fp);
    } catch (err) {
      setActionFormError(`选择文件失败: ${String(err)}`);
    }
  };

  const handleAddAction = async () => {
    if (!actionName.trim() || !actionDesc.trim() || !actionFilePath.trim()) {
      setActionFormError('请填写动作名称、动作描述，并选择一个 MP4 文件。');
      return;
    }
    if (!actionIsIdle && !actionTrigger.trim()) {
      setActionFormError('普通动作必须填写触发条件。');
      return;
    }
    try {
      setActionFormBusy(true);
      setActionFormError('');
      // @ts-ignore
      await window.cdaClient.addAction(
        {
          name: actionName.trim(),
          description: actionDesc.trim(),
          triggerCondition: actionIsIdle ? '' : actionTrigger.trim(),
          isIdle: actionIsIdle,
          edgeSkipSeconds: Math.max(0, Number(actionEdgeSkip) || DEFAULT_EDGE_SKIP_SECONDS),
        },
        actionFilePath.trim()
      );
      await loadActions();
      setActionName('');
      setActionDesc('');
      setActionTrigger('');
      setActionIsIdle(false);
      setActionEdgeSkip('0.2');
      setActionFilePath('');
    } catch (err) {
      setActionFormError(`添加失败: ${String(err)}`);
    } finally {
      setActionFormBusy(false);
    }
  };

  const handleDeleteAction = async (id: string) => {
    try {
      // @ts-ignore
      await window.cdaClient.deleteAction(id);
      if (editingActionId === id) {
        setEditingActionId(null);
      }
      if (actionPreviewOpenId === id) {
        setActionPreviewOpenId(null);
      }
      setActionPreviewUrls((prev) => {
        if (!prev[id]) {
          return prev;
        }
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await loadActions();
    } catch (err) {
      setActionFormError(`删除失败: ${String(err)}`);
    }
  };

  const handleOpenActionPreview = async (action: ActionItem) => {
    setActionPreviewError('');
    setActionPreviewOpenId(action.id);
    if (actionPreviewUrls[action.id]) {
      return;
    }
    try {
      setActionPreviewBusyId(action.id);
      // @ts-ignore
      const dataUrl = await window.cdaClient.getVideoDataUrl(action.videoPath);
      if (!dataUrl) {
        setActionPreviewError('视频读取失败，请检查文件是否存在。');
        return;
      }
      setActionPreviewUrls((prev) => ({ ...prev, [action.id]: dataUrl }));
    } catch (err) {
      setActionPreviewError(`视频加载失败: ${String(err)}`);
    } finally {
      setActionPreviewBusyId(null);
    }
  };

  const startEditAction = (action: ActionItem) => {
    setEditingActionId(action.id);
    setEditActionName(action.name);
    setEditActionDesc(action.description);
    setEditActionTrigger(action.triggerCondition);
    setEditActionIsIdle(Boolean(action.isIdle));
    setEditActionEdgeSkip(String(getActionEdgeSkipSeconds(action)));
    setEditActionFilePath('');
    setEditActionError('');
  };

  const cancelEditAction = () => {
    setEditingActionId(null);
    setEditActionName('');
    setEditActionDesc('');
    setEditActionTrigger('');
    setEditActionIsIdle(false);
    setEditActionEdgeSkip('0.2');
    setEditActionFilePath('');
    setEditActionError('');
  };

  const handlePickEditActionVideo = async () => {
    try {
      // @ts-ignore
      const fp = await window.cdaClient.pickMp4();
      if (!fp) {
        return;
      }
      setEditActionError('');
      setEditActionFilePath(fp);
    } catch (err) {
      setEditActionError(`选择文件失败: ${String(err)}`);
    }
  };

  const handleSaveActionEdit = async () => {
    if (!editingActionId) {
      return;
    }
    if (!editActionName.trim() || !editActionDesc.trim()) {
      setEditActionError('请填写动作名称和动作描述。');
      return;
    }
    if (!editActionIsIdle && !editActionTrigger.trim()) {
      setEditActionError('普通动作必须填写触发条件。');
      return;
    }
    try {
      setEditActionBusy(true);
      setEditActionError('');
      // @ts-ignore
      await window.cdaClient.updateAction(
        editingActionId,
        {
          name: editActionName.trim(),
          description: editActionDesc.trim(),
          triggerCondition: editActionIsIdle ? '' : editActionTrigger.trim(),
          isIdle: editActionIsIdle,
          edgeSkipSeconds: Math.max(0, Number(editActionEdgeSkip) || DEFAULT_EDGE_SKIP_SECONDS),
        },
        editActionFilePath.trim() || undefined
      );
      await loadActions();
      cancelEditAction();
    } catch (err) {
      setEditActionError(`保存失败: ${String(err)}`);
    } finally {
      setEditActionBusy(false);
    }
  };

  const onClickAction = async (actionId: string) => {
    if (actionId === 'persona') {
      const next = !showPersonaPanel;
      setShowPersonaPanel(next);
      setShowMemoryPanel(false);
      setShowSettingsPanel(false);
      if (next) {
        await loadPersonaPanel();
      }
    } else if (actionId === 'memory') {
      const next = !showMemoryPanel;
      setShowMemoryPanel(next);
      setShowPersonaPanel(false);
      setShowSettingsPanel(false);
      if (next) {
        await loadMemoryPanel();
      }
    } else if (actionId === 'settings') {
      const next = !showSettingsPanel;
      setShowSettingsPanel(next);
      setShowPersonaPanel(false);
      setShowMemoryPanel(false);
      if (next) {
        setLlmConfigMessage('');
        try {
          const config = await window.cdaClient.getLLMConfig();
          setLlmBaseURL(config.baseURL || 'https://api.deepseek.com/beta');
          setLlmAPIKey(config.apiKey || '');
          setLlmModel(config.model || 'deepseek-v4-flash');
        } catch (e: any) {
          setLlmConfigMessage('读取配置失败');
        }
      }
    }
  };

  const toPersonaLabel = (key: string) => PERSONA_LABELS[key] ?? key;

  return (
    <div className="screen" style={currentBg ? { backgroundImage: `url("${currentBg}")` } : undefined}>
      <div className="bg-media-layer">
        {idleStreamUrl && (
          <video
            ref={idleStreamVideoRef}
            className="action-video"
            muted
            playsInline
            autoPlay
            preload="auto"
          />
        )}
        {actionStreamUrl && (
          <video
            ref={actionStreamVideoRef}
            className="action-video"
            muted
            playsInline
            autoPlay
            preload="auto"
            onEnded={stopActionStreamPlayback}
            onError={stopActionStreamPlayback}
          />
        )}
        {currentActionVideo && (
          <video
            key={`current-${currentActionVideo.id}`}
            ref={actionCurrentVideoRef}
            src={currentActionVideo.url}
            className="action-video"
            autoPlay
            muted
            playsInline
            preload="auto"
            style={{ opacity: useNextAsActiveLayer ? 0 : 1, transition: 'opacity 140ms linear' }}
            onLoadedMetadata={handleCurrentActionVideoLoadedMetadata}
            onTimeUpdate={(e) => handleActionVideoTimeUpdate('current', e)}
            onEnded={stopActionVideo}
            onError={stopActionVideo}
          />
        )}
        {nextActionVideo && (
          <video
            key={`next-${nextActionVideo.id}`}
            ref={actionNextVideoRef}
            src={nextActionVideo.url}
            className="action-video"
            autoPlay={false}
            muted
            playsInline
            preload="auto"
            style={{ opacity: useNextAsActiveLayer ? 1 : 0, transition: 'opacity 140ms linear' }}
            onLoadedMetadata={handleNextActionVideoLoadedMetadata}
            onTimeUpdate={(e) => handleActionVideoTimeUpdate('next', e)}
            onEnded={stopActionVideo}
            onError={stopActionVideo}
          />
        )}
      </div>
      <div className="screen-vignette" />

      {/* Top Left Area */}
      <div className="top-left-area">
        <div className="logo-wrap">
          <div className="logo-icon">✧</div>
          <div className="logo-text-group">
            <div className="logo-text">灵觉空间</div>
            <div className="logo-sub">LynxSee</div>
          </div>
        </div>
        <div className="memory-loading">
          <span className={`memory-icon ${memoryStatus.active ? 'spinning' : ''} ${memoryStatus.tone}`}>{memoryStatus.icon}</span>
          <div className="memory-text-group">
            <div className="memory-title">{memoryStatus.title}</div>
            <div className="memory-sub">{memoryStatus.sub}</div>
          </div>
        </div>
      </div>

      {/* Top Right Area */}
      <div className="top-right-area">
        <div className="time-date">
          <div className="clock-large">{formatTime(Date.now()).time}</div>
          <div className="date-info">
            <div>{formatTime(Date.now()).ampm}</div>
            <div className="date-text">{formatTime(Date.now()).date}<br/>{formatTime(Date.now()).weekday}</div>
          </div>
        </div>
        <div className="weather-info">
          <span>☼</span> 26°C
        </div>
      </div>

      {/* Character Name Center */}
      <div className="character-title-center">
        <div className="char-line"></div>
        <div className="char-text-group">
          <div className="char-name">{profileCatalog?.activeRoleLabel ?? '默认角色'}</div>
          <div className="char-sub">{(profileCatalog?.activeStyleLabel ?? 'default').toUpperCase()}</div>
        </div>
      </div>

      {/* Right Action Menu */}
      <aside className="right-action-menu">
        {RIGHT_ACTIONS.map((item) => (
          <button
            className={`action-orb ${item.isHeartbeat ? 'heartbeat' : ''} ${(
              (item.id === 'persona' && showPersonaPanel) ||
              (item.id === 'memory' && showMemoryPanel) ||
              (item.id === 'settings' && showSettingsPanel)
            ) ? 'active' : ''}`}
            key={item.label}
            type="button"
            onClick={() => void onClickAction(item.id)}
          >
            <span className="orb-icon">{item.icon}</span>
            {item.value && <span className="hb-value">{item.value}</span>}
            <span>{item.label}</span>
          </button>
        ))}
      </aside>
      {showPersonaPanel && (
        <aside className="persona-panel glass">
          <div className="persona-panel-head">
            <div className="persona-title">人物设定</div>
            <button className="persona-close-btn" type="button" onClick={() => setShowPersonaPanel(false)}>
              ×
            </button>
          </div>

          <div className="persona-panel-body" style={{ paddingBottom: 0 }}>
            <div className="persona-section">
              <div className="persona-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>角色与风格</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {profileCatalog?.activeRoleId !== 'default' && !isCreatingRole && (
                    <button
                      className="persona-refresh-btn danger"
                      style={{ margin: 0, borderColor: 'rgba(255, 100, 100, 0.4)', color: '#ff9c9c' }}
                      onClick={() => {
                        setDeleteRoleModal({
                          isOpen: true,
                          roleId: profileCatalog!.activeRoleId,
                          roleName: profileCatalog!.activeRoleLabel,
                        });
                        setDeleteRoleInput('');
                      }}
                    >
                      删除角色
                    </button>
                  )}
                  <button
                    className="persona-refresh-btn"
                    style={{ margin: 0 }}
                    onClick={() => setIsCreatingRole(!isCreatingRole)}
                  >
                    {isCreatingRole ? '返回' : '创建新角色'}
                  </button>
                </div>
              </div>

              {isCreatingRole ? (
                <div className="action-form" style={{ marginTop: '12px' }}>
                  <input
                    className="action-input"
                    placeholder="角色名 (如: 米娅)"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    disabled={isGeneratingRole}
                  />
                  <textarea
                    className="action-input"
                    placeholder="角色设定 (如: 傲娇的吸血鬼，喜欢捉弄人)"
                    value={newRoleSetting}
                    onChange={(e) => setNewRoleSetting(e.target.value)}
                    disabled={isGeneratingRole}
                    style={{ minHeight: '60px', resize: 'vertical' }}
                  />
                  <input
                    className="action-input"
                    placeholder="口头禅 (如: 哼，愚蠢的人类)"
                    value={newRoleCatchphrase}
                    onChange={(e) => setNewRoleCatchphrase(e.target.value)}
                    disabled={isGeneratingRole}
                  />
                  <div className="action-file-row">
                    <button
                      type="button"
                      className="menu-btn"
                      style={{ width: 'auto', height: '28px', fontSize: '11px', borderRadius: '6px', padding: '0 8px' }}
                      disabled={isGeneratingRole}
                      onClick={async () => {
                        const bgPath = await window.cdaClient.pickImage();
                        if (bgPath) {
                          setNewRoleBgPath(bgPath);
                        }
                      }}
                    >
                      选择背景图 (16:9)
                    </button>
                    <div className="action-file-path" title={newRoleBgPath || '未选择'}>
                      {newRoleBgPath ? newRoleBgPath.split(/[/\\]/).pop() : '未选择'}
                    </div>
                  </div>
                  <button
                    className="menu-btn"
                    style={{
                      width: 'auto',
                      borderRadius: '8px',
                      height: '32px',
                      fontSize: '13px',
                      marginTop: '4px',
                    }}
                    disabled={!newRoleName || !newRoleSetting || isGeneratingRole}
                    onClick={async () => {
                      try {
                        setIsGeneratingRole(true);
                        setRoleGenerationProgress({ percent: 0, stage: '准备开始' });
                        const newRoleId = await window.cdaClient.createRole({
                          name: newRoleName,
                          setting: newRoleSetting,
                          catchphrase: newRoleCatchphrase,
                          bgPath: newRoleBgPath || undefined,
                        });
                        setNewRoleName('');
                        setNewRoleSetting('');
                        setNewRoleCatchphrase('');
                        setNewRoleBgPath('');
                        await loadProfileCatalog();
                        await switchProfile(newRoleId, 'default');
                        setIsCreatingRole(false);
                      } catch (err: any) {
                        alert('创建角色失败: ' + err.message);
                      } finally {
                        setIsGeneratingRole(false);
                      }
                    }}
                  >
                    {isGeneratingRole ? `正在生成 ${roleGenerationProgress.percent}%` : '生成并创建角色'}
                  </button>
                  {isGeneratingRole && (
                    <div className="persona-attr-val" style={{ marginTop: '4px' }}>
                      当前阶段: {roleGenerationProgress.stage}
                    </div>
                  )}
                </div>
              ) : (
                <div className="action-form">
                  <CustomSelect
                    value={profileCatalog?.activeRoleId ?? 'default'}
                    disabled={profileSwitchBusy}
                    options={(profileCatalog?.roles ?? []).map((r) => ({ id: r.id, label: r.label }))}
                    onChange={(nextRoleId) => {
                      const nextStyles = profileCatalog?.roles.find((item) => item.id === nextRoleId)?.styles ?? [];
                      const nextStyleId = nextStyles[0]?.id ?? 'default';
                      void switchProfile(nextRoleId, nextStyleId);
                    }}
                  />
                  <CustomSelect
                    value={profileCatalog?.activeStyleId ?? 'default'}
                    disabled={profileSwitchBusy}
                    options={activeRoleStyles.map((s) => ({ id: s.id, label: s.label }))}
                    onChange={(nextStyleId) => {
                      void switchProfile(profileCatalog?.activeRoleId ?? 'default', nextStyleId);
                    }}
                  />
                  {profileSwitchBusy && <div className="persona-attr-val">切换中...</div>}
                  {profileError && <div className="action-form-error">{profileError}</div>}
                </div>
              )}
            </div>
          </div>

          {!isCreatingRole && (
            <>
              <div className="settings-tabs" style={{ marginTop: '12px' }}>
                <button className={`settings-tab ${personaTab === 'info' ? 'active' : ''}`} onClick={() => setPersonaTab('info')}>人设信息</button>
                <button className={`settings-tab ${personaTab === 'background' ? 'active' : ''}`} onClick={() => setPersonaTab('background')}>视觉表现</button>
                <button className={`settings-tab ${personaTab === 'actions' ? 'active' : ''}`} onClick={() => setPersonaTab('actions')}>动作库</button>
              </div>

          <div className="persona-panel-body">
            {personaTab === 'info' && (
              <>
                <button className="persona-refresh-btn" type="button" onClick={() => void loadPersonaPanel()}>
                  刷新人设
                </button>
                {personaPanelLoading && <div className="persona-empty">加载中...</div>}
                {!personaPanelLoading && personaPanelError && <div className="persona-empty">{personaPanelError}</div>}
                {!personaPanelLoading && !personaPanelError && personaPanel && (
                  <>
                    <div className="persona-section">
                      <div className="persona-section-title">当前人设</div>
                      <div className="persona-base">{personaPanel.personaBase || '(空)'}</div>
                      <div className="persona-attr-list">
                        {Object.entries(personaPanel.personaAttributes).map(([key, value]) => (
                          <div className="persona-attr-item" key={key}>
                            <div className="persona-attr-key">{toPersonaLabel(key)}</div>
                            <div className="persona-attr-val">{value.constraint || '(空)'}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="persona-section">
                      <div className="persona-section-title">变更历史</div>
                      <div className="persona-history-list">
                        {personaPanel.history.length === 0 && <div className="persona-empty">暂无变更记录</div>}
                        {personaPanel.history.map((item, idx) => (
                          <div className="persona-history-item" key={`${item.at}-${idx}`}>
                            <div className="persona-history-time">{new Date(item.at).toLocaleString()}</div>
                            <div className="persona-history-keys">
                              {item.personaBaseChanged ? toPersonaLabel('personaBase') : ''}
                              {item.personaBaseChanged && item.changedKeys.length > 0 ? '、' : ''}
                              {(item.changedKeys.map((k) => toPersonaLabel(k)).join('、')) || '(无字段变更)'}
                            </div>
                            {Object.entries(item.patches).slice(0, 3).map(([patchKey, patch]) => (
                              <div className="persona-history-patch" key={patchKey}>
                                <span className="patch-key">{toPersonaLabel(patchKey)}</span>
                                <span className="patch-arrow">→</span>
                                <span className="patch-text">{patch.after}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
            {personaTab === 'background' && (
              <div className="persona-section">
                <div className="persona-section-title">选择背景</div>
                <div className="persona-attr-val" style={{ marginBottom: '8px' }}>
                  当前角色：{profileCatalog?.activeRoleLabel ?? '默认角色'} · 当前风格：{profileCatalog?.activeStyleLabel ?? 'default'}
                </div>
                {currentBackgroundOptions.length > 0 ? (
                  <div className="bg-picker-grid">
                    {currentBackgroundOptions.map((bg, idx) => (
                      <div
                        key={bg.id}
                        className={`bg-picker-item ${idx === bgIndex ? 'active' : ''}`}
                        onClick={() => void handleSelectBackground(bg.name, idx)}
                        style={{ backgroundImage: `url("${bg.url}")`, opacity: bgSaving && idx === bgIndex ? 0.7 : 1 }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="persona-attr-val">当前角色/风格目录下暂无背景图</div>
                )}
              </div>
            )}
            {personaTab === 'actions' && (
              <div className="persona-section">
                <div className="persona-section-title">添加动作</div>
                <div className="persona-attr-val" style={{ marginBottom: '8px' }}>
                  当前风格动作库：{profileCatalog?.activeRoleLabel ?? '默认角色'} / {profileCatalog?.activeStyleLabel ?? 'default'}
                </div>
                <div className="action-form">
                  <input
                    className="action-input"
                    placeholder="动作名称（例如：开心挥手）"
                    value={actionName}
                    onChange={(e) => setActionName(e.target.value)}
                  />
                  <input
                    className="action-input"
                    placeholder="动作描述（告诉 AI 这个动作表达什么）"
                    value={actionDesc}
                    onChange={(e) => setActionDesc(e.target.value)}
                  />
                  <input
                    className="action-input"
                    placeholder={actionIsIdle ? 'Idle 动作无需触发条件' : '触发条件（例如：当用户说“想你了”）'}
                    value={actionTrigger}
                    onChange={(e) => setActionTrigger(e.target.value)}
                    disabled={actionIsIdle}
                  />
                  <label className="persona-attr-val" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      checked={actionIsIdle}
                      onChange={(e) => setActionIsIdle(e.target.checked)}
                    />
                    设为 Idle 循环动作（不参与触发条件判断）
                  </label>
                  <input
                    className="action-input"
                    type="number"
                    min="0"
                    step="0.05"
                    placeholder="首尾跳过秒数（默认 0.2）"
                    value={actionEdgeSkip}
                    onChange={(e) => setActionEdgeSkip(e.target.value)}
                  />
                  <div className="action-file-row">
                    <button type="button" onClick={handlePickActionVideo} className="persona-refresh-btn" style={{ margin: 0 }}>
                      选择 MP4
                    </button>
                    <span className="action-file-path">{actionFilePath ? actionFilePath.split('/').pop() : '未选择文件'}</span>
                    <button type="button" onClick={() => void handleAddAction()} className="persona-refresh-btn" style={{ margin: 0 }} disabled={actionFormBusy}>
                      {actionFormBusy ? '添加中...' : '提交动作'}
                    </button>
                  </div>
                  {actionFormError && <div className="action-form-error">{actionFormError}</div>}
                </div>
                <div className="persona-section-title" style={{ marginTop: '10px' }}>已配置动作</div>
                <div className="persona-attr-list">
                  {actions.length === 0 && <div className="persona-empty">暂无动作</div>}
                  {actions.map((action) => (
                    <div className="persona-attr-item" key={action.id}>
                      {editingActionId === action.id ? (
                        <div className="action-form">
                          <input
                            className="action-input"
                            value={editActionName}
                            onChange={(e) => setEditActionName(e.target.value)}
                            placeholder="动作名称"
                          />
                          <input
                            className="action-input"
                            value={editActionDesc}
                            onChange={(e) => setEditActionDesc(e.target.value)}
                            placeholder="动作描述"
                          />
                          <input
                            className="action-input"
                            value={editActionTrigger}
                            onChange={(e) => setEditActionTrigger(e.target.value)}
                            placeholder={editActionIsIdle ? 'Idle 动作无需触发条件' : '触发条件'}
                            disabled={editActionIsIdle}
                          />
                          <label className="persona-attr-val" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <input
                              type="checkbox"
                              checked={editActionIsIdle}
                              onChange={(e) => setEditActionIsIdle(e.target.checked)}
                            />
                            设为 Idle 循环动作（不参与触发条件判断）
                          </label>
                          <input
                            className="action-input"
                            type="number"
                            min="0"
                            step="0.05"
                            placeholder="首尾跳过秒数（默认 0.2）"
                            value={editActionEdgeSkip}
                            onChange={(e) => setEditActionEdgeSkip(e.target.value)}
                          />
                          <div className="action-file-row">
                            <button type="button" onClick={handlePickEditActionVideo} className="persona-refresh-btn" style={{ margin: 0 }}>
                              替换 MP4
                            </button>
                            <span className="action-file-path">
                              {editActionFilePath ? `新文件: ${editActionFilePath.split('/').pop()}` : `当前文件: ${action.videoPath.split('/').pop()}`}
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button type="button" onClick={() => void handleSaveActionEdit()} className="persona-refresh-btn" style={{ margin: 0 }} disabled={editActionBusy}>
                              {editActionBusy ? '保存中...' : '保存'}
                            </button>
                            <button type="button" onClick={cancelEditAction} className="persona-refresh-btn" style={{ margin: 0 }}>
                              取消
                            </button>
                            <button type="button" onClick={() => void handleDeleteAction(action.id)} style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer', marginLeft: 'auto' }}>
                              删除
                            </button>
                          </div>
                          {editActionError && <div className="action-form-error">{editActionError}</div>}
                        </div>
                      ) : (
                        <>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div className="persona-attr-key">
                              {action.name}
                              {action.isIdle ? '（Idle）' : ''}
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              <button onClick={() => void handleOpenActionPreview(action)} style={{ background: 'none', border: 'none', color: '#c8f1ff', cursor: 'pointer' }}>
                                {actionPreviewOpenId === action.id ? '重新播放' : '查看MP4'}
                              </button>
                              <button onClick={() => startEditAction(action)} style={{ background: 'none', border: 'none', color: '#8fd6ff', cursor: 'pointer' }}>编辑</button>
                              <button onClick={() => handleDeleteAction(action.id)} style={{ background: 'none', border: 'none', color: '#ff6b6b', cursor: 'pointer' }}>删除</button>
                            </div>
                          </div>
                          <div className="persona-attr-val" style={{ marginTop: '4px' }}>描述: {action.description}</div>
                          <div className="persona-attr-val" style={{ marginTop: '4px' }}>
                            {action.isIdle ? '类型: Idle 循环动作' : `触发条件: ${action.triggerCondition}`}
                          </div>
                          <div className="persona-attr-val" style={{ marginTop: '4px' }}>
                            首尾跳过: {getActionEdgeSkipSeconds(action).toFixed(2)}s
                          </div>
                          {actionPreviewOpenId === action.id && (
                            <div style={{ marginTop: '8px' }}>
                              {actionPreviewBusyId === action.id && (
                                <div className="persona-attr-val">视频加载中...</div>
                              )}
                              {actionPreviewUrls[action.id] && (
                                <video
                                  src={actionPreviewUrls[action.id]}
                                  controls
                                  autoPlay
                                  muted
                                  playsInline
                                  preload="metadata"
                                  style={{ width: '100%', borderRadius: '8px', border: '1px solid rgba(173, 216, 255, 0.2)', background: 'rgba(5, 10, 20, 0.5)' }}
                                />
                              )}
                              {actionPreviewError && <div className="action-form-error">{actionPreviewError}</div>}
                              <div style={{ marginTop: '6px' }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActionPreviewOpenId(null);
                                    setActionPreviewError('');
                                  }}
                                  style={{ background: 'none', border: 'none', color: '#9ad9ff', cursor: 'pointer', padding: 0 }}
                                >
                                  收起预览
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          </>
          )}
        </aside>
      )}
      {deleteRoleModal.isOpen && (
        <div className="confirm-modal-backdrop">
          <div className="confirm-modal glass">
            <div className="persona-title">确认删除角色</div>
            <div className="persona-attr-val" style={{ marginTop: '10px' }}>
              此操作会永久删除角色 <span style={{ color: '#ffb3b3' }}>【{deleteRoleModal.roleName}】</span> 及其相关目录内容。
            </div>
            <div className="persona-attr-val" style={{ marginTop: '8px' }}>
              请输入删除【{deleteRoleModal.roleName}】进行二次确认。
            </div>
            <input
              className="action-input"
              style={{ marginTop: '12px' }}
              value={deleteRoleInput}
              onChange={(e) => setDeleteRoleInput(e.target.value)}
              placeholder={`删除【${deleteRoleModal.roleName}】`}
              disabled={deleteRoleBusy}
            />
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="persona-refresh-btn"
                style={{ margin: 0 }}
                onClick={() => {
                  if (deleteRoleBusy) {
                    return;
                  }
                  setDeleteRoleModal({ isOpen: false, roleId: '', roleName: '' });
                  setDeleteRoleInput('');
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="persona-refresh-btn danger"
                style={{ margin: 0, borderColor: 'rgba(255, 100, 100, 0.4)', color: '#ff9c9c' }}
                onClick={() => void handleConfirmDeleteRole()}
                disabled={!deleteRoleNameMatches || deleteRoleBusy}
              >
                {deleteRoleBusy ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
      {showMemoryPanel && (
        <aside className="persona-panel glass">
          <div className="persona-panel-head">
            <div className="persona-title">记忆面板</div>
            <button className="persona-close-btn" type="button" onClick={() => setShowMemoryPanel(false)}>
              ×
            </button>
          </div>
          <button className="persona-refresh-btn" type="button" onClick={() => void loadMemoryPanel()}>
            刷新
          </button>
          {memoryPanelLoading && <div className="persona-empty">加载中...</div>}
          {!memoryPanelLoading && memoryPanelError && <div className="persona-empty">{memoryPanelError}</div>}
          {!memoryPanelLoading && !memoryPanelError && memoryPanel && (
            <div className="persona-panel-body">
              <div className="persona-section">
                <div className="persona-section-title">当前加载碎片</div>
                <div className="memory-panel-meta">
                  本轮加载 {memoryPanel.loadedFragments.length} 条 · 慢回忆候选 {memoryPanel.recallInboxCount} 条 · 更新时间 {new Date(memoryPanel.loadedAt).toLocaleTimeString()}
                </div>
                {memoryPanel.runtimeStatus && (
                  <div className="memory-panel-meta">
                    当前状态: {memoryPanel.runtimeStatus.message || memoryPanel.runtimeStatus.phase} ·
                    {memoryPanel.runtimeStatus.updatedAt
                      ? ` ${new Date(memoryPanel.runtimeStatus.updatedAt).toLocaleTimeString()}`
                      : ' -'}
                  </div>
                )}
                {memoryPanel.loadedFragments.length === 0 && (
                  <div className="persona-empty">当前轮尚未加载记忆碎片</div>
                )}
                <div className="memory-fragment-list">
                  {memoryPanel.loadedFragments.map((frag) => (
                    <div className="memory-fragment-item" key={frag.filePath}>
                      <div className="memory-fragment-title">{frag.summary || '(无摘要)'}</div>
                      <div className="memory-fragment-line">
                        层级: {frag.layer || '-'} · 关键词: {frag.keyword || '-'}
                      </div>
                      <div className="memory-fragment-line">
                        分数: {Number.isFinite(frag.relevanceScore) ? frag.relevanceScore.toFixed(2) : '--'} · 挂载来源: {frag.sourceType === 'time' ? '时间' : '策略'}
                      </div>
                      <div className="memory-fragment-line">
                        策略: {frag.sourceStrategy || '-'} · 说明: {frag.sourceDetail || frag.relevanceReason || '-'}
                      </div>
                      <div className="memory-fragment-line">
                        时间: {frag.timestamp ? new Date(frag.timestamp).toLocaleString() : '-'}
                      </div>
                      <div className="memory-fragment-path">{frag.filePath}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </aside>
      )}

{showSettingsPanel && (
        <aside className="persona-panel glass">
          <div className="persona-panel-head">
            <div className="persona-title">设置</div>
            <button className="persona-close-btn" type="button" onClick={() => setShowSettingsPanel(false)}>
              ×
            </button>
          </div>
          <div className="persona-panel-body">
            <div className="persona-section">
              <div className="persona-section-title">DeepSeek 配置</div>
              <div className="persona-attr-val" style={{ marginBottom: '12px' }}>
                开发模式默认读取项目根目录下的 `.env`；打包版本默认读取 `~/.cda_env`。点击“保存配置”后才会立即生效，并写回对应配置文件。
              </div>
              <div className="persona-attr-val" style={{ marginBottom: '12px', opacity: 0.82 }}>
                当前仅支持 DeepSeek。前缀续写能力依赖 DeepSeek Beta 接口，推荐使用
                `https://api.deepseek.com/beta`。
              </div>
              <div className="action-form">
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  <button type="button" className="settings-tab active" onClick={() => { setLlmBaseURL('https://api.deepseek.com/beta'); setLlmConfigMessage('已填入 DeepSeek Beta 地址'); }}>DeepSeek</button>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                  <button type="button" className={`settings-tab ${llmModel === 'deepseek-v4-flash' ? 'active' : ''}`} onClick={() => { setLlmModel('deepseek-v4-flash'); setLlmConfigMessage('已选择 deepseek-v4-flash，保存后生效'); }}>V4 Flash</button>
                  <button type="button" className={`settings-tab ${llmModel === 'deepseek-v4-pro' ? 'active' : ''}`} onClick={() => { setLlmModel('deepseek-v4-pro'); setLlmConfigMessage('已选择 deepseek-v4-pro，保存后生效'); }}>V4 Pro</button>
                </div>
                <input
                  className="action-input"
                  placeholder="Base URL（例如 https://api.deepseek.com/beta）"
                  value={llmBaseURL}
                  onChange={(e) => setLlmBaseURL(e.target.value)}
                />
                <input
                  className="action-input"
                  placeholder="模型名（例如 deepseek-v4-flash）"
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                />
                <input
                  className="action-input"
                  type="password"
                  placeholder="API Key（开发模式默认读项目 .env，打包版默认读 ~/.cda_env）"
                  value={llmAPIKey}
                  onChange={(e) => setLlmAPIKey(e.target.value)}
                />
                <button
                  type="button"
                  className="persona-refresh-btn"
                  style={{ marginTop: '10px' }}
                  disabled={llmConfigBusy}
                  onClick={async () => {
                    setLlmConfigBusy(true);
                    setLlmConfigMessage('保存中...');
                    try {
                      await window.cdaClient.saveLLMConfig(llmBaseURL, llmAPIKey, llmModel);
                      setLlmConfigMessage('保存成功，配置已生效');
                    } catch (e: any) {
                      setLlmConfigMessage('保存失败: ' + (e.message || e.toString()));
                    } finally {
                      setLlmConfigBusy(false);
                    }
                  }}
                >
                  {llmConfigBusy ? '保存中...' : '保存配置'}
                </button>
                {llmConfigMessage && <div className="persona-attr-val" style={{ marginTop: '8px', color: llmConfigMessage.includes('失败') ? '#ff6b6b' : '#8bffd3' }}>{llmConfigMessage}</div>}
              </div>
            </div>
          </div>
        </aside>
      )}
      {/* Dialogue Area */}
      <main className="game-stage">
        <div 
          className={`game-dialogue-container ${isScrolling ? 'is-scrolling' : ''}`}
          onWheel={handleWheel}
        >
          {layouts.map((layout, idx) => {
            if (!layout.visible) return null;
            return (
              <div
                key={layout.id}
                className={`game-bubble-wrap ${layout.role}`}
                style={{
                  bottom: `${layout.bottom}px`,
                  opacity: layout.opacity,
                  transform: layout.transform,
                  transformOrigin: 'center center',
                  zIndex: 1000 - idx,
                  pointerEvents: layout.visible ? 'auto' : 'none',
                }}
              >
                <div
                  className="float-anim-inner"
                  style={{
                    animationDelay: `-${(idx * 0.7) % 3}s`,
                  }}
                >
                  <div className="chat-bubble" ref={measureRef(layout.id)}>
                    {layout.role === 'assistant' ? (
                      <TypewriterText content={layout.content} instant={layout.instant} isScrolling={isScrolling} />
                    ) : (
                      layout.content
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="stage-event">{lastEvent}</div>
      </main>

      {/* Bottom Area */}
      <div className="bottom-area">
        <div 
          className="bottom-left-menu"
          onMouseEnter={() => setShowStatus(true)}
          onMouseLeave={() => setShowStatus(false)}
        >
          <button className="menu-btn">≡</button>
          
          {/* Status Hover Popover */}
          {showStatus && (
            <div className="status-popover glass">
              <div className="panel-head">
                <div className="panel-title">引擎状态</div>
                <div className="panel-value">{readyHint}</div>
              </div>
              <div className="panel-section">
                <div className="section-title">响应拓扑</div>
                <div className="progress-head">
                  <span>{moduleProgress.statusText}</span>
                </div>
                <div className="topology-track">
                  {moduleCards.map((m) => (
                    <div 
                      key={m.moduleId} 
                      className={`topology-segment ${m.status}`}
                      title={MODULE_LABELS[m.moduleId] ?? m.moduleId}
                    />
                  ))}
                </div>
              </div>
              <div className="panel-section">
                <div className="section-title">本轮消耗</div>
                <div className="usage-total">Total {usageSummary.total.toLocaleString()}</div>
                <div className="usage-grid">
                  <div className="usage-stat">
                    <span className="stat-label">理解输入</span>
                    <span className="stat-val">{usageSummary.input.toLocaleString()}</span>
                  </div>
                  <div className="usage-stat">
                    <span className="stat-label">命中缓存</span>
                    <span className="stat-val">{usageSummary.cache.toLocaleString()}</span>
                  </div>
                  <div className="usage-stat">
                    <span className="stat-label">生成回复</span>
                    <span className="stat-val">{usageSummary.output.toLocaleString()}</span>
                  </div>
                </div>
              </div>
              <div className="panel-section">
                <div className="section-title">系统更新</div>
                <div className="agent-desc">{agentUpdateSummary.scopeText}发生 {agentUpdateSummary.updates} 次自我更新</div>
                <div className="agent-updates">
                  <div className="agent-item">
                    <span className="agent-dot persona" />
                    <span>人设调整 {agentUpdateSummary.persona}</span>
                  </div>
                  <div className="agent-item">
                    <span className="agent-dot memory" />
                    <span>记忆更新 {agentUpdateSummary.memory}</span>
                  </div>
                </div>
              </div>
              <div className="panel-section">
                <div className="section-title">记忆质量</div>
                <div className="memory-metrics-desc">累计写入 {memoryQualitySummary.totalWrites} 条记忆</div>
                <div className="memory-metrics-grid">
                  <div className="memory-metric-item">
                    <span className="memory-metric-label">重复写入率</span>
                    <span className="memory-metric-value">{memoryQualitySummary.duplicateWriteRate}</span>
                  </div>
                  <div className="memory-metric-item">
                    <span className="memory-metric-label">合并更新占比</span>
                    <span className="memory-metric-value">{memoryQualitySummary.updateShare}</span>
                  </div>
                  <div className="memory-metric-item">
                    <span className="memory-metric-label">平均记忆长度</span>
                    <span className="memory-metric-value">{memoryQualitySummary.avgFragmentLength}</span>
                  </div>
                  <div className="memory-metric-item">
                    <span className="memory-metric-label">近时窗过滤率</span>
                    <span className="memory-metric-value">{memoryQualitySummary.recentFilterRate}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <form className="floating-composer glass" onSubmit={onSubmit}>
          <span className="voice-waves">ılı.</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入想说的话..."
            disabled={busy}
          />
          <button type="button" className="icon-btn">🎙</button>
          <button type="button" className="icon-btn">＋</button>
          {/* Invisible submit button to allow Enter to send */}
          <button type="submit" style={{ display: 'none' }} disabled={busy || !input.trim()}></button>
        </form>

        <div className="bottom-right-menu">
          <button className="gift-btn">🎁</button>
        </div>
      </div>
    </div>
  );
}
