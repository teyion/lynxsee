import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron';
import { config as loadDotEnv } from 'dotenv';
import fs from 'node:fs';
import http from 'node:http';
import { execFile, ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createDefaultEngine } from '../../src/createDefaultEngine.js';
import {
  ActiveProfileContext,
  discoverRoles,
  readActiveSelection,
  resolveActiveContext,
  saveSelectedBackgroundName,
  toCatalogResponse,
  writeActiveSelection,
} from './profileCatalog.js';

interface PersonaPanelData {
  personaBase: string;
  personaAttributes: Record<string, { constraint: string; fewshot: string[] }>;
  history: Array<{
    at: string;
    personaBaseChanged: boolean;
    changedKeys: string[];
    patches: Record<string, { before: string; after: string }>;
  }>;
}

interface MemoryMetricsData {
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
}

interface MemoryPanelFragment {
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
}

interface MemoryPanelRuntimeStatus {
  phase: string;
  message: string;
  active: boolean;
  updatedAt: number;
}

interface MemoryPanelData {
  loadedAt: string;
  loadedFragments: MemoryPanelFragment[];
  recallInboxCount: number;
  runtimeStatus: MemoryPanelRuntimeStatus | null;
}

export interface ActionItem {
  id: string;
  name: string;
  description: string;
  triggerCondition: string;
  videoPath: string; // absolute path to video
  isIdle?: boolean;
  edgeSkipSeconds?: number;
}

type Engine = ReturnType<typeof createDefaultEngine>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Determine ROOT_DIR based on whether we are running in development or packaged mode
let ROOT_DIR = path.resolve(__dirname, '../..');
let envPath = path.join(ROOT_DIR, '.env');

if (app.isPackaged) {
  // In production, use user's home directory for state
  ROOT_DIR = path.join(app.getPath('home'), '.cda_framework');
  if (!fs.existsSync(ROOT_DIR)) {
    fs.mkdirSync(ROOT_DIR, { recursive: true });
  }
  
  // The env file should be .cda_env in the home directory
  envPath = path.join(app.getPath('home'), '.cda_env');
  
  // If .cda_env doesn't exist, but we have access to the original project .env (e.g., local testing), copy it over
  if (!fs.existsSync(envPath)) {
    const devEnvPath = path.resolve(app.getAppPath(), '../../../.env');
    try {
      if (fs.existsSync(devEnvPath)) {
        fs.copyFileSync(devEnvPath, envPath);
      }
    } catch (e) {
      // ignore
    }
  }
}

process.env.CDA_STATE_ROOT = ROOT_DIR;
loadDotEnv({ path: envPath });

let mainWindow: BrowserWindow | null = null;
let enginePromise: Promise<Engine> | null = null;
const execFileAsync = promisify(execFile);
let ffmpegAvailablePromise: Promise<boolean> | null = null;
let idleStreamServer: http.Server | null = null;
let idleStreamServerPort = 0;
let actionStreamProcess: ChildProcess | null = null;
const profileSelectionPath = path.join(ROOT_DIR, 'runtime', 'active-profile.json');
let activeProfileContext: ActiveProfileContext | null = null;
const actionVodCache = new Map<string, { videoPath: string; edgeSkipSeconds: number; durationMs: number }>();
const IDLE_LIVE_WINDOW_SEGMENTS_MAX = 12;
const IDLE_QUEUE_BUFFER_TARGET_NORMAL = 5;
const IDLE_QUEUE_BUFFER_TARGET_DURING_ACTION = 5;
const ACTION_INSERT_LEAD_MS = 0;
const IDLE_APPEND_CHUNK_TARGET_MS = 400;
const ACTION_HLS_SEGMENT_SECONDS = 0.4;
const ACTION_HLS_KEYINT_FRAMES = 12;
const LIVE_PUBLISH_TARGET_MS = 400;
const LIVE_PUBLISH_REFILL_AT_MS = 120;
const LIVE_PENDING_SEGMENT_QUEUE_TARGET_MS = 1200;
const LIVE_WINDOW_RETENTION_MS = 2000;
let idleLiveReadyPromise: Promise<boolean> | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cda-resource',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

function getStateDir(): string {
  return activeProfileContext?.stateDir ?? path.join(ROOT_DIR, 'state');
}

function getActionDir(): string {
  return activeProfileContext?.actionDir ?? path.join(getStateDir(), 'action');
}

function getIdleStreamDir(): string {
  return path.join(getActionDir(), 'stream_hls', 'idle');
}

function getActionStreamDir(): string {
  return path.join(getActionDir(), 'stream_hls', 'action');
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const relative = path.relative(parentDir, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isAllowedBackgroundAssetPath(filePath: string): boolean {
  if (!path.isAbsolute(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }
  if (!/\.(png|jpe?g|webp|gif)$/i.test(filePath)) {
    return false;
  }
  const roles = discoverRoles(ROOT_DIR);
  return roles.some((role) =>
    role.styles.some((style) => style.backgroundsDir && isPathInside(style.backgroundsDir, filePath))
  );
}

function registerAssetProtocol(): void {
  protocol.handle('cda-resource', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'background') {
      return new Response('Not Found', { status: 404 });
    }
    const requestedPath = url.searchParams.get('path');
    if (!requestedPath) {
      return new Response('Bad Request', { status: 400 });
    }
    const normalizedPath = path.normalize(requestedPath);
    if (!isAllowedBackgroundAssetPath(normalizedPath)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(`file://${normalizedPath}`);
  });
}

function getIdleLiveM3u8Path(): string {
  return path.join(getIdleStreamDir(), 'live.m3u8');
}

function applyActiveProfileEnv(context: ActiveProfileContext): void {
  activeProfileContext = context;
  process.env.CDA_STATE_ROOT = ROOT_DIR;
  process.env.CDA_STATE_DIR = context.stateDir;
  process.env.CDA_ACTION_DIR = context.actionDir;
  process.env.CDA_ROLE_ID = context.roleId;
  process.env.CDA_STYLE_ID = context.styleId;
}

async function ensureActiveProfileContext(
  requested?: { roleId?: string; styleId?: string } | null
): Promise<ActiveProfileContext> {
  const roles = discoverRoles(ROOT_DIR);
  if (roles.length === 0) {
    throw new Error('未发现角色配置，请先创建 roles/roles.json');
  }
  const stored = requested ? null : await readActiveSelection(profileSelectionPath);
  const resolved = resolveActiveContext(roles, requested ?? stored);
  if (!resolved) {
    throw new Error('无法解析当前角色/风格');
  }
  applyActiveProfileEnv(resolved);
  await writeActiveSelection(profileSelectionPath, { roleId: resolved.roleId, styleId: resolved.styleId });
  return resolved;
}

async function resetRuntimeForProfileSwitch(): Promise<void> {
  await stopIdleVideoStream();
  await stopActionVideoStream();
  actionVodCache.clear();
  enginePromise = null;
}

type StreamQueueItem = {
  actionId?: string;
  videoPath: string;
  edgeSkipSeconds?: number;
  source: 'idle' | 'action';
  enqueueAtMs: number;
  notBeforeMs?: number;
};

type LiveWindowSegment = {
  seq: number;
  duration: number;
  fileName: string;
};

type PendingLiveSegment = {
  source: 'idle' | 'action';
  actionId?: string;
  duration: number;
  srcFilePath: string;
};

const liveQueueState: {
  running: boolean;
  busy: boolean;
  nextSeq: number;
  queue: StreamQueueItem[];
  segmentQueue: PendingLiveSegment[];
  window: LiveWindowSegment[];
  timer: NodeJS.Timeout | null;
  idleSegmentCursor: Map<string, number>;
  playoutBufferedUntilMs: number;
} = {
  running: false,
  busy: false,
  nextSeq: 0,
  queue: [],
  segmentQueue: [],
  window: [],
  timer: null,
  idleSegmentCursor: new Map(),
  playoutBufferedUntilMs: 0,
};

type VideoProbeInfo = {
  codec_name?: string;
  pix_fmt?: string;
};

const DEFAULT_EDGE_SKIP_SECONDS = 0.2;
const require = createRequire(import.meta.url);
const ffmpegCommand = (() => {
  try {
    const p = require('ffmpeg-static');
    return typeof p === 'string' && p.trim().length > 0 ? p : 'ffmpeg';
  } catch {
    return 'ffmpeg';
  }
})();
const ffprobeCommand = (() => {
  try {
    const mod = require('ffprobe-static') as { path?: string };
    return typeof mod?.path === 'string' && mod.path.trim().length > 0 ? mod.path : 'ffprobe';
  } catch {
    return 'ffprobe';
  }
})();

async function hasFfmpeg(): Promise<boolean> {
  if (!ffmpegAvailablePromise) {
    ffmpegAvailablePromise = (async () => {
      try {
        await execFileAsync(ffmpegCommand, ['-version']);
        console.info(`[ffmpeg] ready ffmpeg=${ffmpegCommand} ffprobe=${ffprobeCommand}`);
        return true;
      } catch {
        console.warn(`[ffmpeg] unavailable ffmpeg=${ffmpegCommand} ffprobe=${ffprobeCommand}`);
        return false;
      }
    })();
  }
  return ffmpegAvailablePromise;
}

async function probeVideoInfo(videoPath: string): Promise<VideoProbeInfo | null> {
  try {
    const { stdout } = await execFileAsync(ffprobeCommand, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,pix_fmt',
      '-of',
      'json',
      videoPath,
    ]);
    const parsed = JSON.parse(stdout || '{}') as { streams?: Array<VideoProbeInfo> };
    return parsed.streams?.[0] ?? null;
  } catch {
    return null;
  }
}

async function probeVideoResolution(videoPath: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(ffprobeCommand, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      videoPath,
    ]);
    const parsed = JSON.parse(stdout || '{}') as { streams?: Array<{ width?: number; height?: number }> };
    const w = Number(parsed.streams?.[0]?.width ?? 0);
    const h = Number(parsed.streams?.[0]?.height ?? 0);
    if (w > 0 && h > 0) {
      return { width: w, height: h };
    }
    return null;
  } catch {
    return null;
  }
}

async function probeVideoDuration(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(ffprobeCommand, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nokey=1:noprint_wrappers=1',
      videoPath,
    ]);
    const val = Number((stdout ?? '').trim());
    if (Number.isFinite(val) && val > 0) {
      return val;
    }
    return null;
  } catch {
    return null;
  }
}

function shuffleArray<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

async function clearActionVodCacheById(actionId: string) {
  const actionStreamDir = getActionStreamDir();
  await mkdir(actionStreamDir, { recursive: true });
  const files = fs.readdirSync(actionStreamDir);
  for (const name of files) {
    if (name.startsWith(`action_${actionId}`) && (name.endsWith('.m3u8') || name.endsWith('.ts'))) {
      try {
        fs.unlinkSync(path.join(actionStreamDir, name));
      } catch {}
    }
  }
  actionVodCache.delete(actionId);
}

function stopActionStreamProcess() {
  if (actionStreamProcess && !actionStreamProcess.killed) {
    try {
      actionStreamProcess.kill('SIGTERM');
    } catch {}
  }
  actionStreamProcess = null;
}

async function ensureIdleStreamServer(): Promise<void> {
  if (idleStreamServer && idleStreamServerPort > 0) {
    return;
  }
  await mkdir(getIdleStreamDir(), { recursive: true });
  await mkdir(getActionStreamDir(), { recursive: true });
  idleStreamServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const rawPath = (req.url ?? '/').split('?')[0];
    const streamDir = rawPath.startsWith('/action/') ? getActionStreamDir() : getIdleStreamDir();
    const fileName = path.basename(rawPath);
    if (!fileName || fileName.includes('..')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const filePath = path.join(streamDir, fileName);
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (fileName.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else if (fileName.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise<void>((resolve) => {
    idleStreamServer!.listen(0, '127.0.0.1', () => {
      const addr = idleStreamServer!.address();
      if (addr && typeof addr === 'object') {
        idleStreamServerPort = addr.port;
      }
      resolve();
    });
  });
}

async function waitForFile(filePath: string, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

async function clearIdleLiveArtifacts(): Promise<void> {
  const idleStreamDir = getIdleStreamDir();
  await mkdir(idleStreamDir, { recursive: true });
  const files = fs.readdirSync(idleStreamDir);
  for (const name of files) {
    if (name === 'live.m3u8' || name.startsWith('live_')) {
      try {
        fs.unlinkSync(path.join(idleStreamDir, name));
      } catch {}
    }
  }
}

async function clearLegacyIdleArtifacts(): Promise<void> {
  const idleStreamDir = getIdleStreamDir();
  await mkdir(idleStreamDir, { recursive: true });
  const files = fs.readdirSync(idleStreamDir);
  for (const name of files) {
    if (name === 'idle.m3u8' || name === 'idle_playlist.txt' || name.startsWith('idle_')) {
      try {
        fs.unlinkSync(path.join(idleStreamDir, name));
      } catch {}
    }
  }
}

async function stopLegacyIdleConcatProcesses(): Promise<void> {
  try {
    const idleStreamDir = getIdleStreamDir();
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,command=']);
    const lines = (stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.includes('ffmpeg')) continue;
      if (!line.includes('idle_playlist.txt')) continue;
      if (!line.includes(idleStreamDir)) continue;
      const match = line.match(/^(\d+)\s+/);
      const pid = Number(match?.[1] ?? 0);
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGTERM');
        console.info(`[idle-stream] stopped legacy concat ffmpeg pid=${pid}`);
      } catch {}
    }
  } catch {}
}

function hasActionCacheArtifacts(actionId: string): boolean {
  const actionStreamDir = getActionStreamDir();
  const playlistPath = path.join(actionStreamDir, `action_${actionId}.m3u8`);
  if (!fs.existsSync(playlistPath)) {
    return false;
  }
  const files = fs.readdirSync(actionStreamDir);
  return files.some((name) => name.startsWith(`action_${actionId}_`) && name.endsWith('.ts'));
}

async function parseVodSegments(playlistPath: string): Promise<Array<{ duration: number; fileName: string }>> {
  const raw = await readFile(playlistPath, 'utf-8');
  const lines = raw.split('\n').map((x) => x.trim()).filter(Boolean);
  const out: Array<{ duration: number; fileName: string }> = [];
  let pendingDuration = 1;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const durationRaw = line.slice('#EXTINF:'.length).replace(',', '');
      const duration = Number(durationRaw);
      pendingDuration = Number.isFinite(duration) && duration > 0 ? duration : 1;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!line.endsWith('.ts')) continue;
    out.push({ duration: pendingDuration, fileName: line });
  }
  return out;
}

async function writeIdleLivePlaylist(): Promise<void> {
  const idleLiveM3u8Path = getIdleLiveM3u8Path();
  const window = liveQueueState.window.slice();
  const firstSeq = window.length > 0 ? window[0].seq : 0;
  const targetDuration = Math.max(1, Math.ceil(Math.max(1, ...window.map((x) => x.duration))));
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${firstSeq}`,
  ];
  for (const seg of window) {
    lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
    lines.push(seg.fileName);
  }
  const nextContent = `${lines.join('\n')}\n`;
  const tmpPath = `${idleLiveM3u8Path}.tmp`;
  await writeFile(tmpPath, nextContent, 'utf-8');
  // 原子替换，避免播放器读到半写入的 m3u8（缺失 #EXTM3U）。
  fs.renameSync(tmpPath, idleLiveM3u8Path);
}

function getPendingSegmentQueueMs(): number {
  return Math.max(
    0,
    Math.round(liveQueueState.segmentQueue.reduce((sum, seg) => sum + Math.max(0, seg.duration), 0) * 1000)
  );
}

function getPublishedBufferMs(now = Date.now()): number {
  return Math.max(0, liveQueueState.playoutBufferedUntilMs - now);
}

function getLiveWindowDurationMs(): number {
  return Math.max(0, Math.round(liveQueueState.window.reduce((sum, seg) => sum + Math.max(0, seg.duration), 0) * 1000));
}

function discardPendingIdleSegments(): number {
  const before = liveQueueState.segmentQueue.length;
  liveQueueState.segmentQueue = liveQueueState.segmentQueue.filter((seg) => seg.source !== 'idle');
  return Math.max(0, before - liveQueueState.segmentQueue.length);
}

function trimPublishedWindow(): void {
  const idleStreamDir = getIdleStreamDir();
  while (liveQueueState.window.length > IDLE_LIVE_WINDOW_SEGMENTS_MAX) {
    const dropped = liveQueueState.window.shift();
    if (!dropped) break;
    try {
      fs.unlinkSync(path.join(idleStreamDir, dropped.fileName));
    } catch {}
  }
  while (liveQueueState.window.length > 2) {
    const totalMs = getLiveWindowDurationMs();
    const first = liveQueueState.window[0];
    if (!first) break;
    const firstMs = Math.max(0, Math.round(first.duration * 1000));
    if (totalMs - firstMs < LIVE_WINDOW_RETENTION_MS) {
      break;
    }
    const dropped = liveQueueState.window.shift();
    if (!dropped) break;
    try {
      fs.unlinkSync(path.join(idleStreamDir, dropped.fileName));
    } catch {}
  }
}

async function buildClipSegments(item: StreamQueueItem): Promise<PendingLiveSegment[]> {
  const actionStreamDir = getActionStreamDir();
  const buildStartAt = Date.now();
  const built = await startActionVideoStream(item.videoPath, item.edgeSkipSeconds, item.actionId);
  if (!built || !item.actionId) {
    return [];
  }
  const buildDoneAt = Date.now();
  const vodPlaylist = path.join(actionStreamDir, `action_${item.actionId}.m3u8`);
  if (!fs.existsSync(vodPlaylist)) {
    return [];
  }
  const allSegments = await parseVodSegments(vodPlaylist);
  if (allSegments.length === 0) {
    return [];
  }
  let segments = allSegments;
  if (item.source === 'idle') {
    const cursorKey = item.actionId ?? item.videoPath;
    const startIdx = liveQueueState.idleSegmentCursor.get(cursorKey) ?? 0;
    const selected: Array<{ duration: number; fileName: string }> = [];
    let accMs = 0;
    for (let i = 0; i < allSegments.length; i += 1) {
      const idx = (startIdx + i) % allSegments.length;
      const seg = allSegments[idx];
      selected.push(seg);
      accMs += Math.max(0, Math.round(seg.duration * 1000));
      if (accMs >= IDLE_APPEND_CHUNK_TARGET_MS) {
        const nextIdx = (idx + 1) % allSegments.length;
        liveQueueState.idleSegmentCursor.set(cursorKey, nextIdx);
        break;
      }
      if (i === allSegments.length - 1) {
        liveQueueState.idleSegmentCursor.set(cursorKey, 0);
      }
    }
    if (selected.length > 0) {
      segments = selected;
    }
  }
  const prepared: PendingLiveSegment[] = [];
  for (const seg of segments) {
    const src = path.join(actionStreamDir, seg.fileName);
    if (!fs.existsSync(src)) continue;
    prepared.push({
      source: item.source,
      actionId: item.actionId,
      duration: seg.duration,
      srcFilePath: src,
    });
  }
  if (prepared.length < segments.length) {
    console.warn(
      `[idle-stream] partial prepare source=${item.source} actionId=${item.actionId ?? '(none)'} prepared=${prepared.length}/${
        segments.length
      }`
    );
  }
  const queuedDurationMs = Math.max(
    0,
    Math.round(prepared.reduce((sum, seg) => sum + Math.max(0, seg.duration), 0) * 1000)
  );
  const queueWaitMs = Math.max(0, buildStartAt - item.enqueueAtMs);
  const buildMs = Math.max(0, buildDoneAt - buildStartAt);
  const prepareMs = Math.max(0, Date.now() - buildDoneAt);
  console.info(
    `[latency][backend] source=${item.source} actionId=${item.actionId ?? '(none)'} queueWaitMs=${queueWaitMs} buildMs=${buildMs} prepareMs=${prepareMs} playlistSegs=${segments.length} queuedSegs=${prepared.length} queuedMs=${queuedDurationMs}`
  );
  return prepared;
}

async function ensureSegmentQueueFilled(): Promise<void> {
  while (getPendingSegmentQueueMs() < LIVE_PENDING_SEGMENT_QUEUE_TARGET_MS) {
    const next = await dequeueNextIdleOrAction();
    if (!next) {
      return;
    }
    const prepared = await buildClipSegments(next);
    if (prepared.length === 0) {
      continue;
    }
    if (next.source === 'action') {
      const droppedIdleSegs = discardPendingIdleSegments();
      if (droppedIdleSegs > 0) {
        console.info(
          `[idle-stream] drop pending idle fragments for action actionId=${next.actionId ?? '(none)'} droppedSegs=${droppedIdleSegs}`
        );
      }
    }
    liveQueueState.segmentQueue.push(...prepared);
    console.info(
      `[idle-stream] segment queue source=${next.source} actionId=${next.actionId ?? '(none)'} segmentQueueSegs=${liveQueueState.segmentQueue.length} segmentQueueMs=${getPendingSegmentQueueMs()}`
    );
    if (next.source === 'action') {
      return;
    }
  }
}

async function replenishIdleQueueBuffer(): Promise<void> {
  const hasPendingAction =
    liveQueueState.queue.some((item) => item.source === 'action') ||
    liveQueueState.segmentQueue.some((seg) => seg.source === 'action');
  const target = hasPendingAction ? IDLE_QUEUE_BUFFER_TARGET_DURING_ACTION : IDLE_QUEUE_BUFFER_TARGET_NORMAL;
  if (target <= 0) return;
  const idleIdxDesc = liveQueueState.queue
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.source === 'idle')
    .map(({ idx }) => idx)
    .sort((a, b) => b - a);
  const idleQueuedBefore = idleIdxDesc.length;
  if (idleQueuedBefore > target) {
    const overflow = idleQueuedBefore - target;
    for (let i = 0; i < overflow; i += 1) {
      const idx = idleIdxDesc[i];
      if (typeof idx === 'number') {
        liveQueueState.queue.splice(idx, 1);
      }
    }
  }
  const idleQueued = liveQueueState.queue.filter((item) => item.source === 'idle').length;
  if (idleQueued >= target) return;
  const actions = await readActions();
  const idleActions = actions.filter((a) => Boolean(a.isIdle) && a.videoPath && fs.existsSync(a.videoPath));
  if (idleActions.length === 0) return;
  const need = target - idleQueued;
  for (let i = 0; i < need; i += 1) {
    const selected = shuffleArray(idleActions)[0];
    liveQueueState.queue.push({
      actionId: selected.id,
      videoPath: selected.videoPath,
      edgeSkipSeconds: selected.edgeSkipSeconds,
      source: 'idle',
      enqueueAtMs: Date.now(),
    });
  }
}

async function dequeueNextIdleOrAction(): Promise<StreamQueueItem | null> {
  await replenishIdleQueueBuffer();
  if (liveQueueState.queue.length > 0) {
    const now = Date.now();
    const actionIdx = liveQueueState.queue.findIndex(
      (item) => item.source === 'action' && now >= (item.notBeforeMs ?? item.enqueueAtMs)
    );
    if (actionIdx >= 0) {
      return liveQueueState.queue.splice(actionIdx, 1)[0] ?? null;
    }
    const idleIdx = liveQueueState.queue.findIndex((item) => item.source === 'idle');
    if (idleIdx >= 0) {
      return liveQueueState.queue.splice(idleIdx, 1)[0] ?? null;
    }
    const nextActionAt = liveQueueState.queue
      .filter((item) => item.source === 'action')
      .map((item) => item.notBeforeMs ?? item.enqueueAtMs)
      .sort((a, b) => a - b)[0];
    if (typeof nextActionAt === 'number') {
      scheduleIdleLivePump(Math.max(0, nextActionAt - now));
    }
    return null;
  }
  await replenishIdleQueueBuffer();
  return liveQueueState.queue.shift() ?? null;
}

async function publishPendingSegments(): Promise<number> {
  const idleStreamDir = getIdleStreamDir();
  if (liveQueueState.segmentQueue.length === 0) {
    return 0;
  }
  const publishStartedAt = Date.now();
  const refillDeadlineMs = Date.now() + LIVE_PUBLISH_TARGET_MS;
  let bufferedUntil = Math.max(publishStartedAt, liveQueueState.playoutBufferedUntilMs);
  let publishedMs = 0;
  let copiedCount = 0;
  let firstSource: 'idle' | 'action' | null = null;
  let firstActionId: string | undefined;
  while (liveQueueState.segmentQueue.length > 0 && bufferedUntil < refillDeadlineMs) {
    const seg = liveQueueState.segmentQueue.shift();
    if (!seg) break;
    if (!fs.existsSync(seg.srcFilePath)) {
      continue;
    }
    if (!firstSource) {
      firstSource = seg.source;
      firstActionId = seg.actionId;
    }
    const seq = liveQueueState.nextSeq;
    liveQueueState.nextSeq += 1;
    const dstFileName = `live_${String(seq).padStart(6, '0')}.ts`;
    const dst = path.join(idleStreamDir, dstFileName);
    await copyFile(seg.srcFilePath, dst);
    liveQueueState.window.push({ seq, duration: seg.duration, fileName: dstFileName });
    const durationMs = Math.max(0, Math.round(seg.duration * 1000));
    bufferedUntil += durationMs;
    publishedMs += durationMs;
    copiedCount += 1;
  }
  if (copiedCount <= 0) {
    return 0;
  }
  liveQueueState.playoutBufferedUntilMs = bufferedUntil;
  trimPublishedWindow();
  await writeIdleLivePlaylist();
  const copyMs = Math.max(0, Date.now() - publishStartedAt);
  console.info(
    `[idle-stream] publish source=${firstSource ?? 'idle'} actionId=${firstActionId ?? '(none)'} copiedSegs=${copiedCount} publishedMs=${publishedMs} copyMs=${copyMs} publishedBufferMs=${getPublishedBufferMs()} segmentQueueMs=${getPendingSegmentQueueMs()}`
  );
  return publishedMs;
}

function scheduleIdleLivePump(delayMs: number): void {
  if (liveQueueState.timer) {
    clearTimeout(liveQueueState.timer);
    liveQueueState.timer = null;
  }
  liveQueueState.timer = setTimeout(() => {
    liveQueueState.timer = null;
    void pumpIdleLiveOnce();
  }, Math.max(0, delayMs));
}

async function waitForIdleLiveReady(timeoutMs = 20000): Promise<boolean> {
  const idleLiveM3u8Path = getIdleLiveM3u8Path();
  if (fs.existsSync(idleLiveM3u8Path)) {
    return true;
  }
  if (!idleLiveReadyPromise) {
    idleLiveReadyPromise = waitForFile(idleLiveM3u8Path, timeoutMs).finally(() => {
      idleLiveReadyPromise = null;
    });
  }
  return idleLiveReadyPromise;
}

async function pumpIdleLiveOnce(): Promise<void> {
  if (!liveQueueState.running || liveQueueState.busy) return;
  liveQueueState.busy = true;
  try {
    await replenishIdleQueueBuffer();
    await ensureSegmentQueueFilled();
    if (getPublishedBufferMs() <= LIVE_PUBLISH_REFILL_AT_MS) {
      const publishedMs = await publishPendingSegments();
      if (publishedMs <= 0) {
        await ensureSegmentQueueFilled();
        await publishPendingSegments();
      }
    }
    await replenishIdleQueueBuffer();
    await ensureSegmentQueueFilled();
    const publishedBufferMs = getPublishedBufferMs();
    const nextDelay = Math.max(40, publishedBufferMs - LIVE_PUBLISH_REFILL_AT_MS);
    console.info(
      `[idle-stream] buffer publishedBufferMs=${publishedBufferMs} nextDelay=${nextDelay} queueSize=${liveQueueState.queue.length} segmentQueueMs=${getPendingSegmentQueueMs()} windowSize=${liveQueueState.window.length}`
    );
    scheduleIdleLivePump(nextDelay);
  } catch (err) {
    console.error('[idle-stream] pump failed', err);
    scheduleIdleLivePump(800);
  } finally {
    liveQueueState.busy = false;
  }
}

async function startIdleVideoStream(): Promise<string | null> {
  const ffmpegReady = await hasFfmpeg();
  if (!ffmpegReady) {
    console.warn('[idle-stream] ffmpeg unavailable, skip live stream');
    return null;
  }
  const actions = await readActions();
  const idleActions = actions.filter((a) => Boolean(a.isIdle) && a.videoPath && fs.existsSync(a.videoPath));
  if (idleActions.length === 0) {
    console.info('[idle-stream] no idle actions found, stop live stream');
    return null;
  }
  await stopLegacyIdleConcatProcesses();
  await clearLegacyIdleArtifacts();
  await ensureIdleStreamServer();
  if (!liveQueueState.running) {
    await clearIdleLiveArtifacts();
    liveQueueState.running = true;
    liveQueueState.busy = false;
    liveQueueState.nextSeq = 0;
    liveQueueState.queue = [];
    liveQueueState.segmentQueue = [];
    liveQueueState.window = [];
    liveQueueState.timer = null;
    liveQueueState.idleSegmentCursor = new Map();
    liveQueueState.playoutBufferedUntilMs = 0;
    await replenishIdleQueueBuffer();
    scheduleIdleLivePump(0);
  }
  const ready = await waitForIdleLiveReady(20000);
  if (!ready) {
    console.error('[idle-stream] startup timeout: live.m3u8 not ready');
    return null;
  }
  const streamUrl = `http://127.0.0.1:${idleStreamServerPort}/idle/live.m3u8`;
  console.info(`[idle-stream] live stream active (single-url): ${streamUrl}`);
  return streamUrl;
}

async function stopIdleVideoStream(): Promise<void> {
  liveQueueState.running = false;
  liveQueueState.busy = false;
  liveQueueState.queue = [];
  liveQueueState.segmentQueue = [];
  liveQueueState.window = [];
  liveQueueState.idleSegmentCursor = new Map();
  liveQueueState.playoutBufferedUntilMs = 0;
  if (liveQueueState.timer) {
    clearTimeout(liveQueueState.timer);
    liveQueueState.timer = null;
  }
  idleLiveReadyPromise = null;
  await clearIdleLiveArtifacts();
}

async function enqueueActionIntoIdleLive(
  videoPath: string,
  edgeSkipSeconds?: number,
  actionId?: string
): Promise<{ queued: boolean }> {
  if (!liveQueueState.running) {
    await startIdleVideoStream();
  }
  if (!liveQueueState.running) {
    return { queued: false };
  }
  const queuedIdleBefore = liveQueueState.queue.filter((item) => item.source === 'idle').length;
  liveQueueState.queue = liveQueueState.queue.filter((item) => item.source === 'action');
  const droppedIdleSegs = discardPendingIdleSegments();
  liveQueueState.queue.unshift({
    actionId,
    videoPath,
    edgeSkipSeconds,
    source: 'action',
    enqueueAtMs: Date.now(),
    notBeforeMs: Date.now() + ACTION_INSERT_LEAD_MS,
  });
  console.info(
    `[idle-stream] queue push action actionId=${actionId ?? '(none)'} leadMs=${ACTION_INSERT_LEAD_MS} droppedIdleClips=${queuedIdleBefore} droppedIdleSegs=${droppedIdleSegs} queueSize=${liveQueueState.queue.length} segmentQueueMs=${getPendingSegmentQueueMs()} windowSize=${liveQueueState.window.length}`
  );
  scheduleIdleLivePump(0);
  return { queued: true };
}

async function startActionVideoStream(
  videoPath: string,
  edgeSkipSeconds?: number,
  actionId?: string
): Promise<{ url: string; durationMs: number } | null> {
  const actionStreamDir = getActionStreamDir();
  const ffmpegReady = await hasFfmpeg();
  if (!ffmpegReady || !videoPath || !fs.existsSync(videoPath)) {
    return null;
  }
  await ensureIdleStreamServer();
  const actions = await readActions();
  const matched =
    (actionId ? actions.find((a) => a.id === actionId) : undefined) ??
    actions.find((a) => a.videoPath === videoPath);
  const resolvedId = matched?.id ?? crypto.createHash('md5').update(videoPath).digest('hex');
  const resolvedVideoPath = matched?.videoPath ?? videoPath;
  const skip = Math.max(0, Number(edgeSkipSeconds ?? matched?.edgeSkipSeconds ?? DEFAULT_EDGE_SKIP_SECONDS));
  const cached = actionVodCache.get(resolvedId);
  const playlistPath = path.join(actionStreamDir, `action_${resolvedId}.m3u8`);
  const duration = (await probeVideoDuration(resolvedVideoPath)) ?? 2;
  const playDuration = Math.max(0.2, duration - skip * 2);
  const durationMs = Math.round(playDuration * 1000);
  if (
    cached &&
    cached.videoPath === resolvedVideoPath &&
    cached.edgeSkipSeconds === skip &&
    fs.existsSync(playlistPath)
  ) {
    const url = `http://127.0.0.1:${idleStreamServerPort}/action/action_${resolvedId}.m3u8?ts=${Date.now()}`;
    return { url, durationMs: cached.durationMs };
  }
  if (hasActionCacheArtifacts(resolvedId)) {
    actionVodCache.set(resolvedId, {
      videoPath: resolvedVideoPath,
      edgeSkipSeconds: skip,
      durationMs,
    });
    const url = `http://127.0.0.1:${idleStreamServerPort}/action/action_${resolvedId}.m3u8?ts=${Date.now()}`;
    console.info(`[action-stream] reuse cached hls: ${url}`);
    return { url, durationMs };
  }
  await clearActionVodCacheById(resolvedId);
  const startAt = Math.min(skip, Math.max(0, duration - 0.2));
  try {
    await execFileAsync(ffmpegCommand, [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-ss',
      startAt.toFixed(3),
      '-i',
      resolvedVideoPath,
      '-t',
      playDuration.toFixed(3),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-g',
      String(ACTION_HLS_KEYINT_FRAMES),
      '-keyint_min',
      String(ACTION_HLS_KEYINT_FRAMES),
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${ACTION_HLS_SEGMENT_SECONDS})`,
      '-hls_time',
      String(ACTION_HLS_SEGMENT_SECONDS),
      '-hls_list_size',
      '0',
      '-hls_flags',
      'independent_segments+temp_file',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_filename',
      path.join(actionStreamDir, `action_${resolvedId}_%05d.ts`),
      playlistPath,
    ]);
  } catch {
    return null;
  }
  if (!fs.existsSync(playlistPath)) {
    return null;
  }
  actionVodCache.set(resolvedId, {
    videoPath: resolvedVideoPath,
    edgeSkipSeconds: skip,
    durationMs,
  });
  const url = `http://127.0.0.1:${idleStreamServerPort}/action/action_${resolvedId}.m3u8?ts=${Date.now()}`;
  console.info(`[action-stream] ready: ${url}`);
  return { url, durationMs };
}

async function stopActionVideoStream(): Promise<void> {
  stopActionStreamProcess();
}

async function prewarmActionVideoStreams(): Promise<void> {
  try {
    const actions = await readActions();
    const normalActions = actions.filter((a) => !a.isIdle && a.videoPath && fs.existsSync(a.videoPath));
    for (const action of normalActions) {
      await startActionVideoStream(action.videoPath, action.edgeSkipSeconds, action.id).catch(() => null);
    }
  } catch {
    // ignore prewarm errors
  }
}

async function transcodeActionVideoToMp4(sourcePath: string, destPath: string): Promise<void> {
  const ffmpegReady = await hasFfmpeg();
  if (!ffmpegReady) {
    await copyFile(sourcePath, destPath);
    return;
  }
  const probe = await probeVideoInfo(sourcePath);
  const alreadyCompatible = probe?.codec_name === 'h264' && probe?.pix_fmt === 'yuv420p';
  if (alreadyCompatible) {
    await copyFile(sourcePath, destPath);
    return;
  }
  try {
    await execFileAsync(ffmpegCommand, [
      '-y',
      '-i',
      sourcePath,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'slow',
      '-crf',
      '16',
      '-profile:v',
      'high',
      '-level',
      '4.1',
      '-movflags',
      '+faststart',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      destPath,
    ]);
  } catch {
    // Fallback to direct copy if transcoding fails for any reason.
    await copyFile(sourcePath, destPath);
  }
}

async function readPersonaPanelData(): Promise<PersonaPanelData> {
  const personaPath = path.join(getStateDir(), 'persona', 'persona.json');
  const historyPath = path.join(getStateDir(), 'persona', 'persona.history.jsonl');
  let personaBase = '';
  let personaAttributes: Record<string, { constraint: string; fewshot: string[] }> = {};
  try {
    const raw = await readFile(personaPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      personaBase?: string;
      personaAttributes?: Record<string, { constraint?: string; fewshot?: string[] }>;
    };
    personaBase = parsed.personaBase ?? '';
    personaAttributes = Object.fromEntries(
      Object.entries(parsed.personaAttributes ?? {}).map(([k, v]) => [
        k,
        {
          constraint: v?.constraint ?? '',
          fewshot: Array.isArray(v?.fewshot) ? v!.fewshot : [],
        },
      ])
    );
  } catch {
    personaBase = '(未加载到人设)';
    personaAttributes = {};
  }

  let history: PersonaPanelData['history'] = [];
  try {
    if (fs.existsSync(historyPath)) {
      const raw = await readFile(historyPath, 'utf-8');
      history = raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .slice(-120)
        .map((line) => {
          try {
            return JSON.parse(line) as PersonaPanelData['history'][number];
          } catch {
            return null;
          }
        })
        .filter((x): x is PersonaPanelData['history'][number] => Boolean(x))
        .reverse();
    }
  } catch {
    history = [];
  }

  return {
    personaBase,
    personaAttributes,
    history,
  };
}

function resolveRendererEntry(): { devUrl?: string; indexHtml: string } {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const indexHtml = path.join(__dirname, '../dist/index.html');
  return { devUrl, indexHtml };
}

async function getProfileCatalog() {
  const active = await ensureActiveProfileContext();
  const roles = discoverRoles(ROOT_DIR);
  return toCatalogResponse(roles, active);
}

async function getEngine(): Promise<Engine> {
  await ensureActiveProfileContext();
  if (enginePromise) {
    return enginePromise;
  }
  enginePromise = Promise.resolve(createDefaultEngine());
  return enginePromise;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    title: '灵觉空间',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const { devUrl, indexHtml } = resolveRendererEntry();
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(indexHtml);
  }
}

import { generateRole, deleteRole } from './roleGenerator.js';

ipcMain.handle('agent:createRole', async (event: any, params: { name: string; setting: string; catchphrase: string; bgPath?: string }) => {
  const sendProgress = (percent: number, stage: string) => {
    event.sender.send('agent:createRoleProgress', {
      percent,
      stage,
    });
  };
  sendProgress(0, '准备开始');
  const newRoleId = await generateRole(params, ROOT_DIR, ({ percent, stage }) => {
    sendProgress(percent, stage);
  });
  return newRoleId;
});

ipcMain.handle('agent:deleteRole', async (_event: any, roleId: string) => {
  if (roleId === 'default') {
    throw new Error('不能删除默认角色');
  }
  const success = await deleteRole(roleId, ROOT_DIR);
  if (!success) {
    throw new Error('角色删除失败，可能角色不存在或文件被占用');
  }
  return true;
});

ipcMain.handle('agent:getProfileCatalog', async () => {
  return getProfileCatalog();
});

ipcMain.handle('agent:setActiveProfile', async (_event: any, roleId: string, styleId: string) => {
  await resetRuntimeForProfileSwitch();
  const active = await ensureActiveProfileContext({ roleId, styleId });
  const roles = discoverRoles(ROOT_DIR);
  return toCatalogResponse(roles, active);
});

ipcMain.handle(
  'agent:setSelectedBackground',
  async (_event: any, roleId: string, styleId: string, backgroundName?: string) => {
    await saveSelectedBackgroundName(ROOT_DIR, roleId, styleId, backgroundName);
    const active = await ensureActiveProfileContext({ roleId, styleId });
    const roles = discoverRoles(ROOT_DIR);
    return toCatalogResponse(roles, active);
  }
);

ipcMain.handle('agent:runTurn', async (event: any, userInput: string) => {
  const engine = await getEngine();
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await engine.runTurnWithUsage(userInput, (progress) => {
    win?.webContents.send('agent:progress', progress);
  });
  return result;
});

ipcMain.handle('agent:health', async () => {
  return {
    app: 'ok',
    engineReady: true,
    hint: 'ready',
  };
});

ipcMain.handle('agent:getPersonaPanel', async () => {
  return readPersonaPanelData();
});

ipcMain.handle('agent:getMemoryPanel', async () => {
  const engine = await getEngine();
  const liveState = engine.getModuleState?.('memory');
  const snapshot = engine.getSnapshot?.('memory');
  const memoryState = liveState ?? snapshot?.state;
  const loadedFragments = Array.isArray(memoryState?.loadedFragments)
    ? memoryState.loadedFragments
    : [];
  const recallInboxCount = Array.isArray(memoryState?.recallInbox) ? memoryState.recallInbox.length : 0;
  const runtimeStatus = memoryState?.runtimeStatus
    ? {
        phase: String(memoryState.runtimeStatus.phase ?? 'idle'),
        message: String(memoryState.runtimeStatus.message ?? ''),
        active: Boolean(memoryState.runtimeStatus.active),
        updatedAt: Number(memoryState.runtimeStatus.updatedAt ?? 0),
      }
    : null;
  const panelData: MemoryPanelData = {
    loadedAt: new Date().toISOString(),
    recallInboxCount,
    runtimeStatus,
    loadedFragments: loadedFragments.map((item: any) => ({
      filePath: String(item?.filePath ?? ''),
      layer: String(item?.layer ?? ''),
      keyword: String(item?.keyword ?? ''),
      summary: String(item?.summary ?? ''),
      timestamp: Number(item?.timestamp ?? 0),
      relevanceScore: Number(item?.relevanceScore ?? 0),
      relevanceReason: String(item?.relevanceReason ?? ''),
      sourceType: item?.sourceType === 'strategy' ? 'strategy' : 'time',
      sourceStrategy: String(item?.sourceStrategy ?? ''),
      sourceDetail: String(item?.sourceDetail ?? ''),
    })),
  };
  return panelData;
});

ipcMain.handle('agent:getMemoryMetrics', async () => {
  const metricsPath = path.join(getStateDir(), 'memory', 'memory.metrics.json');
  try {
    const raw = await readFile(metricsPath, 'utf-8');
    const parsed = JSON.parse(raw) as MemoryMetricsData;
    return parsed;
  } catch {
    return null;
  }
});

async function readActions(): Promise<ActionItem[]> {
  const actionsPath = path.join(getActionDir(), 'actions.json');
  try {
    if (fs.existsSync(actionsPath)) {
      const raw = await readFile(actionsPath, 'utf-8');
      const parsed = JSON.parse(raw) as ActionItem[];
      return parsed.map((item) => ({
        ...item,
        isIdle: Boolean(item.isIdle),
        edgeSkipSeconds: Number.isFinite(Number(item.edgeSkipSeconds))
          ? Math.max(0, Number(item.edgeSkipSeconds))
          : DEFAULT_EDGE_SKIP_SECONDS,
      }));
    }
  } catch {}
  return [];
}

async function writeActions(actions: ActionItem[]) {
  const actionDir = getActionDir();
  if (!fs.existsSync(actionDir)) {
    await mkdir(actionDir, { recursive: true });
  }
  const actionsPath = path.join(actionDir, 'actions.json');
  await writeFile(actionsPath, JSON.stringify(actions, null, 2), 'utf-8');
}

ipcMain.handle('agent:getLLMConfig', async () => {
  const baseURL = process.env.LLM_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/beta';
  const model = process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  return {
    provider: process.env.LLM_PROVIDER ?? 'deepseek',
    baseURL,
    apiKey: process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? '',
    model,
  };
});

ipcMain.handle('agent:saveLLMConfig', async (_event: any, baseURL: string, apiKey: string, model: string) => {
  const normalizedBaseURL = (baseURL || 'https://api.deepseek.com/beta').trim().replace(/\/+$/, '');
  const normalizedModel = (model || 'deepseek-v4-flash').trim();
  process.env.LLM_PROVIDER = 'deepseek';
  process.env.LLM_BASE_URL = normalizedBaseURL;
  process.env.LLM_MODEL = normalizedModel;
  process.env.DEEPSEEK_BASE_URL = normalizedBaseURL;
  process.env.DEEPSEEK_MODEL = normalizedModel;
  process.env.OPENAI_API_KEY = apiKey;
  process.env.DEEPSEEK_API_KEY = apiKey;
  
  if (enginePromise) {
    const engine = await enginePromise;
    const { OpenAILLMClient } = await import('../../src/llm/LLMClient.js');
    engine.setLLMClient(new OpenAILLMClient({
      baseURL: normalizedBaseURL,
      apiKey,
      model: normalizedModel,
    }));
  }

  // Save to .cda_env
  try {
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }
    const lines = envContent.split('\n').filter(line => 
      !line.startsWith('LLM_PROVIDER=') &&
      !line.startsWith('LLM_BASE_URL=') &&
      !line.startsWith('LLM_MODEL=') &&
      !line.startsWith('DEEPSEEK_BASE_URL=') && 
      !line.startsWith('DEEPSEEK_MODEL=') &&
      !line.startsWith('DEEPSEEK_API_KEY=') && 
      !line.startsWith('OPENAI_API_KEY=')
    );
    lines.push('LLM_PROVIDER=deepseek');
    lines.push(`LLM_BASE_URL=${normalizedBaseURL}`);
    lines.push(`LLM_MODEL=${normalizedModel}`);
    lines.push(`DEEPSEEK_BASE_URL=${normalizedBaseURL}`);
    lines.push(`DEEPSEEK_MODEL=${normalizedModel}`);
    lines.push(`DEEPSEEK_API_KEY=${apiKey}`);
    lines.push(`OPENAI_API_KEY=${apiKey}`);
    fs.writeFileSync(envPath, lines.join('\n').trim() + '\n', 'utf8');
  } catch (e) {
    console.error('Failed to save LLM config to .env:', e);
  }
  return true;
});

ipcMain.handle('agent:getActions', async () => {
  return readActions();
});

ipcMain.handle('agent:startIdleVideoStream', async () => {
  void prewarmActionVideoStreams();
  return startIdleVideoStream();
});

ipcMain.handle('agent:stopIdleVideoStream', async () => {
  await stopIdleVideoStream();
  return true;
});

ipcMain.handle(
  'agent:startActionVideoStream',
  async (_event: any, videoPath: string, edgeSkipSeconds?: number, actionId?: string) => {
    return enqueueActionIntoIdleLive(videoPath, edgeSkipSeconds, actionId);
  }
);

ipcMain.handle('agent:stopActionVideoStream', async () => {
  await stopActionVideoStream();
  return true;
});

ipcMain.handle('agent:pickImage', async (event: any) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
  const options = {
    title: '选择图片',
    properties: ['openFile' as const],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  };
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('agent:pickMp4', async (event: any) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
  const result = win
    ? await dialog.showOpenDialog(win, {
        title: '选择动作视频',
        properties: ['openFile'],
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      })
    : await dialog.showOpenDialog({
        title: '选择动作视频',
        properties: ['openFile'],
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('agent:getVideoDataUrl', async (_event: any, videoPath: string) => {
  try {
    if (!videoPath || !fs.existsSync(videoPath)) {
      return null;
    }
    const videoBuffer = await readFile(videoPath);
    const ext = path.extname(videoPath).toLowerCase();
    const mime = ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
    return `data:${mime};base64,${videoBuffer.toString('base64')}`;
  } catch {
    return null;
  }
});

ipcMain.handle('agent:addAction', async (_event: any, actionInfo: Omit<ActionItem, 'id' | 'videoPath'>, sourceVideoPath: string) => {
  const actions = await readActions();
  const id = crypto.randomUUID();
  const videoDir = path.join(getActionDir(), 'videos');
  if (!fs.existsSync(videoDir)) {
    await mkdir(videoDir, { recursive: true });
  }
  const destVideoPath = path.join(videoDir, `${id}.mp4`);
  await transcodeActionVideoToMp4(sourceVideoPath, destVideoPath);
  
  const newAction: ActionItem = {
    ...actionInfo,
    id,
    videoPath: destVideoPath,
    isIdle: Boolean(actionInfo.isIdle),
    edgeSkipSeconds: Number.isFinite(Number(actionInfo.edgeSkipSeconds))
      ? Math.max(0, Number(actionInfo.edgeSkipSeconds))
      : DEFAULT_EDGE_SKIP_SECONDS,
  };
  actions.push(newAction);
  await writeActions(actions);
  await clearActionVodCacheById(newAction.id);
  void startActionVideoStream(newAction.videoPath, newAction.edgeSkipSeconds, newAction.id);
  await stopIdleVideoStream();
  return newAction;
});

ipcMain.handle(
  'agent:updateAction',
  async (
    _event: any,
    id: string,
    actionInfo: Omit<ActionItem, 'id' | 'videoPath'>,
    sourceVideoPath?: string
  ) => {
    const actions = await readActions();
    const idx = actions.findIndex((a) => a.id === id);
    if (idx === -1) {
      throw new Error('动作不存在');
    }
    const oldAction = actions[idx];
    let nextVideoPath = oldAction.videoPath;

    if (sourceVideoPath && sourceVideoPath.trim()) {
      const videoDir = path.join(getActionDir(), 'videos');
      if (!fs.existsSync(videoDir)) {
        await mkdir(videoDir, { recursive: true });
      }
      const newVideoPath = path.join(videoDir, `${id}.mp4`);
      await transcodeActionVideoToMp4(sourceVideoPath, newVideoPath);
      nextVideoPath = newVideoPath;
      if (oldAction.videoPath !== newVideoPath && fs.existsSync(oldAction.videoPath)) {
        try {
          await unlink(oldAction.videoPath);
        } catch {}
      }
    }

    const updatedAction: ActionItem = {
      id,
      name: actionInfo.name,
      description: actionInfo.description,
      triggerCondition: actionInfo.triggerCondition,
      videoPath: nextVideoPath,
      isIdle: Boolean(actionInfo.isIdle),
      edgeSkipSeconds: Number.isFinite(Number(actionInfo.edgeSkipSeconds))
        ? Math.max(0, Number(actionInfo.edgeSkipSeconds))
        : oldAction.edgeSkipSeconds ?? DEFAULT_EDGE_SKIP_SECONDS,
    };
    actions[idx] = updatedAction;
    await writeActions(actions);
    await clearActionVodCacheById(updatedAction.id);
    void startActionVideoStream(updatedAction.videoPath, updatedAction.edgeSkipSeconds, updatedAction.id);
    await stopIdleVideoStream();
    return updatedAction;
  }
);

ipcMain.handle('agent:deleteAction', async (_event: any, id: string) => {
  const actions = await readActions();
  const idx = actions.findIndex(a => a.id === id);
  if (idx !== -1) {
    const action = actions[idx];
    try {
      if (fs.existsSync(action.videoPath)) {
        await unlink(action.videoPath);
      }
    } catch {}
    await clearActionVodCacheById(action.id);
    actions.splice(idx, 1);
    await writeActions(actions);
    await stopIdleVideoStream();
  }
  return true;
});

app.whenReady().then(async () => {
  await ensureActiveProfileContext();
  registerAssetProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopActionStreamProcess();
  if (idleStreamServer) {
    try {
      idleStreamServer.close();
    } catch {}
    idleStreamServer = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
