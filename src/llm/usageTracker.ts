import { AsyncLocalStorage } from 'node:async_hooks';

export interface TokenUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface OpenAIStyleUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface UsageEvent {
  source: string;
  rawUsage?: OpenAIStyleUsage;
  normalized: TokenUsage;
}

interface UsageTrackerState {
  total: TokenUsage;
  events: UsageEvent[];
  onUsageEvent?: (event: UsageEvent) => void;
}

const storage = new AsyncLocalStorage<UsageTrackerState>();

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
  };
}

export function normalizeUsage(raw?: OpenAIStyleUsage): TokenUsage {
  if (!raw) {
    return emptyUsage();
  }
  return {
    inputTokens: Math.max(0, Number(raw.prompt_tokens ?? 0)),
    cachedTokens: Math.max(0, Number(raw.prompt_tokens_details?.cached_tokens ?? 0)),
    outputTokens: Math.max(0, Number(raw.completion_tokens ?? 0)),
  };
}

export function addUsage(delta: Partial<TokenUsage>): void {
  const state = storage.getStore();
  if (!state) {
    return;
  }
  state.total.inputTokens += Math.max(0, Number(delta.inputTokens ?? 0));
  state.total.cachedTokens += Math.max(0, Number(delta.cachedTokens ?? 0));
  state.total.outputTokens += Math.max(0, Number(delta.outputTokens ?? 0));
}

export function addOpenAIUsage(raw?: OpenAIStyleUsage, source = 'unknown'): void {
  const normalized = normalizeUsage(raw);
  addUsage(normalized);
  const state = storage.getStore();
  if (!state) {
    return;
  }
  const event: UsageEvent = {
    source,
    rawUsage: raw,
    normalized,
  };
  state.events.push(event);
  state.onUsageEvent?.(event);
}

export async function runWithUsageTracking<T>(
  fn: () => Promise<T>,
  options?: { onUsageEvent?: (event: UsageEvent) => void }
): Promise<{ result: T; usage: TokenUsage; events: UsageEvent[] }> {
  const state: UsageTrackerState = {
    total: emptyUsage(),
    events: [],
    onUsageEvent: options?.onUsageEvent,
  };
  const result = await storage.run(state, fn);
  return {
    result,
    usage: { ...state.total },
    events: [...state.events],
  };
}
