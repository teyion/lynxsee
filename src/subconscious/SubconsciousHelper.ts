import { Suggestion } from '../types/index.js';
import { PERSONA_REFLECT_PROMPT, PERSONA_UPDATE_PROMPT } from './prompts.js';
import { addOpenAIUsage, OpenAIStyleUsage } from '../llm/usageTracker.js';

function tokenize(text: string): Set<string> {
  const clean = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return new Set(clean);
}

export async function evaluateSuggestionMatch(
  userInput: string,
  suggestion: Suggestion
): Promise<number> {
  const inputTokens = tokenize(userInput);
  const reasonTokens = tokenize(suggestion.reason);

  if (inputTokens.size === 0 || reasonTokens.size === 0) {
    return 0;
  }

  let hit = 0;
  for (const token of inputTokens) {
    if (reasonTokens.has(token)) {
      hit += 1;
    }
  }

  return hit / Math.max(inputTokens.size, reasonTokens.size);
}

export async function generateInitialDirectives(
  userInput: string,
  moduleId: string
): Promise<Record<string, any>> {
  const keywords = Array.from(tokenize(userInput)).slice(0, 6);
  return {
    module: moduleId,
    keywords,
    timeRange: 'latest',
  };
}

export async function buildSuggestion(
  userInput: string,
  response: string,
  moduleId: string
): Promise<Suggestion> {
  const missingContext = response.includes('无法') || response.includes('不确定');
  return {
    adjustedFetchDirectives: {
      keywords: Array.from(tokenize(userInput)).slice(0, 8),
      timeRange: missingContext ? 'recent' : 'latest',
    },
    reason: `${moduleId} 反思：${missingContext ? '信息可能不足' : '当前策略基本有效'}`,
    confidence: missingContext ? 0.8 : 0.55,
  };
}

export interface PersonaAttributeSpec {
  key: string;
  purpose: string;
}

export interface PersonaAttributeValue {
  constraint: string;
  fewshot: string[];
}

export interface PersonaReflectInput {
  userInput: string;
  response: string;
  myPromptSegment: string;
  currentPersonaBase: string;
  attributeSpecs: PersonaAttributeSpec[];
  currentAttributes: Record<string, PersonaAttributeValue>;
}

export interface PersonaUpdateInput {
  userInput: string;
  currentPersonaBase: string;
  attributeSpecs: PersonaAttributeSpec[];
  currentAttributes: Record<string, PersonaAttributeValue>;
  targetKeys?: string[];
}

export interface PersonaUpdateResult {
  personaBase?: string;
  updates: Record<string, PersonaAttributeValue>;
}

function isNaturalLanguageValue(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (/^[\d\s.,:+\-_/]+$/.test(trimmed)) {
    return false;
  }
  return /[\p{L}]/u.test(trimmed);
}

function safeJsonParse<T>(raw: string): T | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

function normalizeCompareText(text: string): string {
  return text.replace(/\s+/g, '').replace(/[。！!,.，；;：:“”"'‘’（）()\[\]{}]/g, '').toLowerCase();
}

function isDirectedShortTermGoal(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12) return false;
  // 目标必须体现“本轮动作 + 预期结果”，避免空泛。
  const hasAction = /(先|优先|在本轮|当前轮|本次|先行|先做|完成|帮助|澄清|安抚|推进|输出|提供|定位|修复)/.test(trimmed);
  const hasOutcome = /(让|以便|从而|确保|达到|实现|目标|结果|更|减少|降低|明确|落地|收敛)/.test(trimmed);
  return hasAction && hasOutcome;
}

function deriveDirectedShortTermGoal(input: PersonaReflectInput): string {
  const text = `${input.userInput}\n${input.response}`;
  if (/难过|焦虑|紧张|害怕|委屈|失眠|崩溃|压力|想你|抱抱|安慰/.test(text)) {
    return '在本轮优先接住用户情绪并给出可执行的安抚建议，先确认其感受，再提供1到2个低负担动作，以便让用户尽快稳定下来并恢复安全感。';
  }
  if (/bug|报错|报错码|异常|编译|构建|部署|日志|测试|代码|修复|定位|排查|依赖/.test(text)) {
    return '在本轮优先帮助用户推进当前技术问题，先明确根因与约束，再给出最短可执行步骤和验证方式，以便用户能快速完成修复并继续工作。';
  }
  if (/计划|方案|怎么做|下一步|选择|取舍|路线|架构|优化|重构/.test(text)) {
    return '在本轮优先帮助用户做清晰决策，先收敛关键选项与风险，再给出推荐路径和下一步行动，以便用户能立即推进任务。';
  }
  return '在本轮优先准确理解用户当下诉求，先给出直接回应与下一步建议，再确认是否需要补充支持，以便让用户明确方向并降低沟通成本。';
}

function enforceShortTermGoal(
  candidate: string | undefined,
  input: PersonaReflectInput
): string {
  if (candidate && isNaturalLanguageValue(candidate) && isDirectedShortTermGoal(candidate)) {
    return candidate.trim();
  }
  return deriveDirectedShortTermGoal(input);
}

function buildPersonaReflectFallback(input: PersonaReflectInput): {
  personaBase?: string;
  updates: Record<string, PersonaAttributeValue>;
  reason: string;
  confidence: number;
} {
  const updates: Record<string, PersonaAttributeValue> = {};
  const text = `${input.userInput}\n${input.response}`;
  let personaBase: string | undefined;

  if (/简洁|精炼|直接/.test(text)) {
    updates.answer_structure = {
      constraint: '优先给出简洁结论，再补充必要细节，避免冗长铺垫。',
      fewshot: [
        '先给结论：可以。原因是依赖缺失；再给两步修复命令。',
        '先给结果：建议使用 debug 模式。然后列出关键日志字段。',
      ],
    };
  }

  if (/友好|温和|礼貌/.test(text)) {
    updates.tone_style = {
      constraint: '语气保持友好且专业，避免生硬命令式表达。',
      fewshot: [
        '可以这样做：先确认目标，再逐步执行并回报结果。',
        '这个问题很好，我建议先看依赖图，再看排序配置。',
      ],
    };
  }

  if (/叫.{0,8}|起名|实习生|不要再说.*工程助手/.test(text)) {
    personaBase = '你叫柳晴，是一个谦虚好学、认真负责的实习生助手。';
    updates.identity_scope = {
      constraint: '始终以谦虚好学的实习生身份回答，听从前辈指导并主动落实任务。',
      fewshot: [
        '前辈您好，我是柳晴，我先按理解做一版，再请您帮我review。',
        '这个点我还在学习中，我先验证一下再给您确认结果。',
      ],
    };
  }

  // 每轮都审视 short_term_goal，并确保文案具备明确指向性。
  const currentShortGoal = input.currentAttributes.short_term_goal?.constraint ?? '';
  const nextShortGoal = enforceShortTermGoal(undefined, input);
  if (normalizeCompareText(nextShortGoal) !== normalizeCompareText(currentShortGoal)) {
    updates.short_term_goal = {
      constraint: nextShortGoal,
      fewshot: [],
    };
  }

  return {
    personaBase,
    updates,
    reason: Object.keys(updates).length > 0 ? '基于用户偏好做轻量人设微调。' : '本轮无需调整人设。',
    confidence: Object.keys(updates).length > 0 ? 0.6 : 0.35,
  };
}

async function callPersonaReflectLLM(
  input: PersonaReflectInput
): Promise<{
  personaBase?: string;
  updates: Record<string, PersonaAttributeValue>;
  reason: string;
  confidence: number;
} | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const baseURL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';

  const prompt = `${PERSONA_REFLECT_PROMPT}

属性定义:
${JSON.stringify(input.attributeSpecs, null, 2)}

当前属性:
${JSON.stringify(input.currentAttributes, null, 2)}

当前基础人设:
${input.currentPersonaBase}

用户输入:
${input.userInput}

最终回复:
${input.response}

Persona片段:
${input.myPromptSegment}

输出格式:
{
  "reason": "简短理由",
  "confidence": 0.0-1.0,
  "updates": {
    "属性key": {
      "constraint": "自然语言约束",
      "fewshot": ["示例1", "示例2"]
    }
  }
}`;

  const resp = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    return null;
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: OpenAIStyleUsage;
  };
  addOpenAIUsage(data.usage, 'persona:reflect');
  const content = data.choices?.[0]?.message?.content ?? '';
  const parsed = safeJsonParse<{
    personaBase?: string;
    reason?: string;
    confidence?: number;
    updates?: Record<string, { constraint?: string; fewshot?: string[] }>;
  }>(content);

  if (!parsed?.updates) {
    return null;
  }

  const allowedKeys = new Set(input.attributeSpecs.map((item) => item.key));
  const updates: Record<string, PersonaAttributeValue> = {};
  for (const [key, value] of Object.entries(parsed.updates)) {
    if (!allowedKeys.has(key) || !value?.constraint) {
      continue;
    }
    if (!isNaturalLanguageValue(value.constraint)) {
      continue;
    }
    const cleanedFewshot = (value.fewshot ?? []).filter(isNaturalLanguageValue).slice(0, 3);
    updates[key] = {
      constraint: value.constraint.trim(),
      fewshot: cleanedFewshot,
    };
  }

  // 强化 short_term_goal：每轮都评估，并保证目标具备明确动作与结果导向。
  const llmShortGoal = parsed.updates?.short_term_goal?.constraint;
  const enforcedShortGoal = enforceShortTermGoal(llmShortGoal, input);
  const currentShortGoal = input.currentAttributes.short_term_goal?.constraint ?? '';
  if (normalizeCompareText(enforcedShortGoal) !== normalizeCompareText(currentShortGoal)) {
    const llmFewshot = (parsed.updates?.short_term_goal?.fewshot ?? []).filter(isNaturalLanguageValue).slice(0, 3);
    updates.short_term_goal = {
      constraint: enforcedShortGoal,
      fewshot: llmFewshot,
    };
  }

  return {
    personaBase: parsed.personaBase && isNaturalLanguageValue(parsed.personaBase) ? parsed.personaBase : undefined,
    updates,
    reason: parsed.reason?.trim() || '已完成人设反思。',
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0.55,
  };
}

export async function buildPersonaReflectSuggestion(input: PersonaReflectInput): Promise<Suggestion> {
  const llmResult = await callPersonaReflectLLM(input);
  const fallback = buildPersonaReflectFallback(input);
  const result = llmResult ?? fallback;

  return {
    adjustedFetchDirectives: {
      personaBaseUpdate: result.personaBase,
      personaAttributeUpdates: result.updates,
    },
    reason: result.reason,
    confidence: result.confidence,
  };
}

function buildPersonaUpdateFallback(input: PersonaUpdateInput): PersonaUpdateResult {
  const updates: Record<string, PersonaAttributeValue> = {};
  const text = input.userInput;
  let personaBase: string | undefined;
  const allowed = new Set(input.targetKeys ?? input.attributeSpecs.map((item) => item.key));
  if (allowed.has('tone_style') && /更活泼|更轻快|更热情/.test(text)) {
    updates.tone_style = {
      constraint: '语气更轻快、友好并有鼓励感，同时保持专业与信息准确。',
      fewshot: [
        '我们可以这样做：先快速定位，再一步步落地，过程我会和你同步。',
        '这个方向很好，我先给你最短可执行路径，再补充可选优化。',
      ],
    };
  } else if (allowed.has('tone_style') && /更正式|更严谨|更克制/.test(text)) {
    updates.tone_style = {
      constraint: '语气更正式、克制、严谨，优先使用精确、可执行的表达。',
      fewshot: [
        '结论如下：先修改配置，再执行构建与测试验证。',
        '该问题的根因是依赖关系配置不完整，建议按以下步骤修复。',
      ],
    };
  }

  if (/叫柳晴|起名.*柳晴|不要再说.*工程助手|实习生身份/.test(text)) {
    personaBase = '你叫柳晴，是一个谦虚好学、认真负责的实习生助手。';
    if (allowed.has('identity_scope')) {
      updates.identity_scope = {
        constraint: '始终以谦虚好学的实习生身份回答，听从前辈指导并主动落实任务。',
        fewshot: [
          '前辈您好，我是柳晴，我先按理解做一版，再请您帮我review。',
          '这个点我还在学习中，我先验证一下再给您确认结果。',
        ],
      };
    }
  }

  return { personaBase, updates };
}

export async function buildPersonaUpdateFromUserInput(
  input: PersonaUpdateInput
): Promise<PersonaUpdateResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  const fallback = buildPersonaUpdateFallback(input);
  if (!apiKey) {
    return fallback;
  }

  const baseURL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const allowedKeys = new Set(input.targetKeys ?? input.attributeSpecs.map((item) => item.key));

  const prompt = `${PERSONA_UPDATE_PROMPT}

目标属性:
${JSON.stringify(input.attributeSpecs.filter((item) => allowedKeys.has(item.key)), null, 2)}

当前属性:
${JSON.stringify(input.currentAttributes, null, 2)}

当前基础人设:
${input.currentPersonaBase}

用户输入:
${input.userInput}

输出格式:
{
  "personaBase": "可选，基础人设文本",
  "updates": {
    "属性key": {
      "constraint": "自然语言约束",
      "fewshot": ["示例1", "示例2"]
    }
  }
}`;

  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    });

    if (!resp.ok) {
      return fallback;
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: OpenAIStyleUsage;
    };
    addOpenAIUsage(data.usage, 'persona:update');
    const content = data.choices?.[0]?.message?.content ?? '';
    const parsed = safeJsonParse<{
      personaBase?: string;
      updates?: Record<string, { constraint?: string; fewshot?: string[] }>;
    }>(content);
    if (!parsed?.updates) {
      return fallback;
    }

    const updates: Record<string, PersonaAttributeValue> = {};
    for (const [key, value] of Object.entries(parsed.updates)) {
      if (!allowedKeys.has(key) || !value?.constraint || !isNaturalLanguageValue(value.constraint)) {
        continue;
      }
      const cleanedFewshot = (value.fewshot ?? []).filter(isNaturalLanguageValue).slice(0, 3);
      updates[key] = {
        constraint: value.constraint.trim(),
        fewshot: cleanedFewshot,
      };
    }

    const personaBase =
      parsed.personaBase && isNaturalLanguageValue(parsed.personaBase)
        ? parsed.personaBase.trim()
        : fallback.personaBase;
    return Object.keys(updates).length > 0 || personaBase
      ? { personaBase, updates }
      : fallback;
  } catch {
    return fallback;
  }
}

export interface MemoryRelevanceInput {
  userInput: string;
  conversationRender: string;
  keyword: string;
  fragmentPath: string;
  fragmentText: string;
}

export interface MemoryRelevanceResult {
  related: boolean;
  score: number;
  reason: string;
}

function fallbackKeywords(userInput: string, previousKeywords: string[], limit: number): string[] {
  const fromHistory = previousKeywords.map((x) => x.trim()).filter((x) => x.length > 0);
  if (fromHistory.length > 0) {
    return fromHistory.slice(0, limit);
  }
  const cleaned = userInput.trim().slice(0, 80);
  if (cleaned.length > 0) {
    return [cleaned];
  }
  return ['current_turn'];
}

async function callLlmJson<T>(prompt: string, temperature = 0.1, source = 'subconscious:llm-json'): Promise<T | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseURL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  try {
    const resp = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: OpenAIStyleUsage;
    };
    addOpenAIUsage(data.usage, source);
    const content = data.choices?.[0]?.message?.content ?? '';
    return safeJsonParse<T>(content);
  } catch {
    return null;
  }
}

export interface MemoryAdjustPlanInput {
  userInput: string;
  previousKeywords: string[];
  previousCursor: Record<string, string>;
  pendingSuggestion: Suggestion | null;
  currentFragmentLimit: number;
  memoryIndex: string;
}

export interface MemoryAdjustPlanResult {
  keywords: string[];
  targetFiles: string[];
  fragmentLimit: number;
  adoptSuggestion: boolean;
  seekOlderKeywords: string[];
  reason: string;
}

export async function buildMemoryAdjustPlan(
  input: MemoryAdjustPlanInput
): Promise<MemoryAdjustPlanResult> {
  const fallbackPlanKeywords = fallbackKeywords(input.userInput, input.previousKeywords, 6);
  const fallback: MemoryAdjustPlanResult = {
    keywords: fallbackPlanKeywords,
    targetFiles: [],
    fragmentLimit: Math.max(1, input.currentFragmentLimit || 3),
    adoptSuggestion: false,
    seekOlderKeywords: [],
    reason: 'fallback: 无法调用LLM，使用最小语言无关策略',
  };

  const prompt = `
你是 Memory 模块的在线决策器。你必须只输出 JSON，不要输出其他文本。
目标：基于当前输入、全局记忆索引和上轮建议，决定本轮检索的特定文件(targetFiles)、检索关键词(keywords)、是否采纳建议、是否回溯旧记忆。
优先基于 memoryIndex 挑选最相关的历史记忆文件路径放入 targetFiles 中，确保时间较近且相关的碎片排在前面。

输入:
{
  "userInput": ${JSON.stringify(input.userInput)},
  "previousKeywords": ${JSON.stringify(input.previousKeywords)},
  "pendingSuggestion": ${JSON.stringify(input.pendingSuggestion)},
  "currentFragmentLimit": ${JSON.stringify(input.currentFragmentLimit)},
  "memoryIndex": ${JSON.stringify(input.memoryIndex)}
}

输出格式:
{
  "keywords": ["关键词1","关键词2"],
  "targetFiles": ["文件路径1", "文件路径2"],
  "fragmentLimit": 3,
  "adoptSuggestion": true,
  "seekOlderKeywords": ["关键词1"],
  "reason": "简短原因"
}
`;

  const parsed = await callLlmJson<{
    keywords?: string[];
    targetFiles?: string[];
    fragmentLimit?: number;
    adoptSuggestion?: boolean;
    seekOlderKeywords?: string[];
    reason?: string;
  }>(prompt, 0.1, 'memory:adjust-plan');

  if (!parsed) return fallback;
  const keywords = (parsed.keywords ?? [])
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0)
    .slice(0, 8);
  const targetFiles = (parsed.targetFiles ?? [])
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0);
  return {
    keywords: keywords.length > 0 ? keywords : fallback.keywords,
    targetFiles,
    fragmentLimit:
      typeof parsed.fragmentLimit === 'number' && parsed.fragmentLimit > 0
        ? Math.floor(parsed.fragmentLimit)
        : fallback.fragmentLimit,
    adoptSuggestion: Boolean(parsed.adoptSuggestion),
    seekOlderKeywords: (parsed.seekOlderKeywords ?? []).map((x) => String(x)).filter((x) => x.length > 0),
    reason: parsed.reason?.trim() || fallback.reason,
  };
}

export interface MemoryLoadedFragmentBrief {
  filePath: string;
  keyword: string;
  summary: string;
  relevanceScore: number;
}

export interface MemoryReflectPlanInput {
  userInput: string;
  response: string;
  conversationRender: string;
  currentKeywords: string[];
  loadedFragments: MemoryLoadedFragmentBrief[];
  fragmentLimit: number;
}

export interface MemoryReflectPlanResult {
  reason: string;
  confidence: number;
  adjustedFetchDirectives: Record<string, any>;
  writePlan: {
    shouldWrite: boolean;
    action: 'ADD' | 'UPDATE';
    targetFilePath?: string;
    layer: 'short_term' | 'episodic' | 'semantic';
    layerReason: string;
    keywords: string[];
    title: string;
    summary: string;
    facts: Array<{
      type: '事实' | '偏好' | '事件' | '目标' | '风险' | '其他';
      content: string;
      confidence: number;
    }>;
  };
}

function routeMemoryLayerByHeuristic(input: {
  userInput: string;
  response: string;
  currentLayer: 'short_term' | 'episodic' | 'semantic';
  facts: Array<{ type: '事实' | '偏好' | '事件' | '目标' | '风险' | '其他'; content: string; confidence: number }>;
  confidence: number;
}): {
  layer: 'short_term' | 'episodic' | 'semantic';
  layerReason: string;
} {
  const text = `${input.userInput}\n${input.response}`;
  const hasShortTermSignal = /(本轮|这轮|当前|马上|稍后|先|待会|临时|正在|先做|先排查|下一步)/.test(text);
  const hasSemanticSignal = /(一直|长期|稳定|偏好|习惯|常用|称呼|喜欢被叫|身份设定|价值观|原则)/.test(text);
  const hasEventSignal = /(昨天|今天|刚刚|当时|发生|经历|这次|上次|某次)/.test(text);
  const hasPreferenceFact = input.facts.some((f) => f.type === '偏好');
  const highFactConfidence = input.facts.some((f) => f.confidence >= 0.8);

  if (hasSemanticSignal && hasPreferenceFact && highFactConfidence && input.confidence >= 0.78) {
    return { layer: 'semantic', layerReason: '检测到稳定偏好/长期事实，且置信度较高，进入语义长期层。' };
  }
  if (hasShortTermSignal && !hasSemanticSignal) {
    return { layer: 'short_term', layerReason: '内容以当前轮临时意图与短期任务为主，写入短期层。' };
  }
  if (hasEventSignal || input.currentLayer === 'episodic') {
    return { layer: 'episodic', layerReason: '内容主要描述具体情境或一次性事件，写入情节层。' };
  }
  return { layer: 'episodic', layerReason: '默认落在情节层，避免把不稳定信息写入长期层。' };
}

export async function buildMemoryReflectPlan(
  input: MemoryReflectPlanInput
): Promise<MemoryReflectPlanResult> {
  const suggestOlder = input.loadedFragments.length === 0;
  const fallback: MemoryReflectPlanResult = {
    reason: suggestOlder ? 'fallback: 当前回答可能未命中关键记忆，建议回溯更早碎片' : 'fallback: 默认保留当前检索策略',
    confidence: suggestOlder ? 0.82 : 0.4,
    adjustedFetchDirectives: {
      seekOlderKeywords: suggestOlder ? input.currentKeywords.slice(0, 4) : [],
      fragmentLimit: Math.max(2, input.fragmentLimit),
      targetFiles: input.loadedFragments.slice(0, 3).map((x) => x.filePath),
      keywords: input.currentKeywords.slice(0, 6),
    },
    writePlan: {
      shouldWrite: true,
      action: input.loadedFragments.length > 0 ? 'UPDATE' : 'ADD',
      targetFilePath: input.loadedFragments[0]?.filePath,
      layer: 'episodic',
      layerReason: '默认将单轮对话沉淀为情节记忆，后续按规则自动分流。',
      keywords: input.currentKeywords.slice(0, 4),
      title: input.userInput.slice(0, 30) || 'turn-memory',
      summary: input.response.slice(0, 120),
      facts: [
        {
          type: '事实',
          content: `用户当前输入要点：${input.userInput.slice(0, 90)}`,
          confidence: 0.7,
        },
        {
          type: '事件',
          content: `本轮回复要点：${input.response.slice(0, 90)}`,
          confidence: 0.65,
        },
      ],
    },
  };
  if (fallback.writePlan.keywords.length === 0) {
    fallback.writePlan.keywords = fallbackKeywords(input.userInput, ['current_turn'], 4);
  }

  const prompt = `
你是 Memory 模块的离线反思器。你必须只输出 JSON。
目标：判断是否建议下轮回溯旧记忆，并给出本轮是否写入记忆碎片及其元信息。
重点：减少重复写入。优先输出结构化事实，不要转存整段对话。
若当前内容与 loadedFragments 中某条记忆是同主题延续，优先 action="UPDATE" 并给出 targetFilePath。
layer 选择规则：
- short_term：临时任务、当前轮意图、短期状态，预计很快失效；
- episodic：具体事件、具体对话场景；
- semantic：长期稳定偏好/事实（仅在高置信度时使用）。
必须输出 layerReason 说明为什么选这个层级。

输入:
{
  "userInput": ${JSON.stringify(input.userInput)},
  "response": ${JSON.stringify(input.response)},
  "conversationRender": ${JSON.stringify(input.conversationRender)},
  "currentKeywords": ${JSON.stringify(input.currentKeywords)},
  "loadedFragments": ${JSON.stringify(input.loadedFragments)},
  "fragmentLimit": ${JSON.stringify(input.fragmentLimit)}
}

输出格式:
{
  "reason": "简短原因",
  "confidence": 0.0,
  "adjustedFetchDirectives": {
    "seekOlderKeywords": ["关键词A"],
    "fragmentLimit": 3,
    "targetFiles": ["建议下轮优先读取的碎片路径1","路径2"]
  },
  "writePlan": {
    "shouldWrite": true,
    "action": "ADD | UPDATE",
    "targetFilePath": "当 action=UPDATE 时填写目标路径",
    "layer": "episodic",
    "layerReason": "为什么选择该layer",
    "keywords": ["关键词1","关键词2"],
    "title": "标题",
    "summary": "一句话摘要短语",
    "facts": [
      {"type":"事实","content":"用户今天压力偏高","confidence":0.82},
      {"type":"事件","content":"用户正在排查UI样式问题","confidence":0.88}
    ]
  }
}
`;
  const parsed = await callLlmJson<{
    reason?: string;
    confidence?: number;
    adjustedFetchDirectives?: Record<string, any>;
    writePlan?: {
      shouldWrite?: boolean;
      action?: 'ADD' | 'UPDATE';
      targetFilePath?: string;
      layer?: 'short_term' | 'episodic' | 'semantic';
      layerReason?: string;
      keywords?: string[];
      title?: string;
      summary?: string;
      facts?: Array<{
        type?: '事实' | '偏好' | '事件' | '目标' | '风险' | '其他';
        content?: string;
        confidence?: number;
      }>;
    };
  }>(prompt, 0.1, 'memory:reflect-plan');

  if (!parsed) return fallback;
  const plan = parsed.writePlan ?? {};
  const layer =
    plan.layer === 'short_term' || plan.layer === 'episodic' || plan.layer === 'semantic'
      ? plan.layer
      : fallback.writePlan.layer;
  const keywords = (plan.keywords ?? [])
    .map((x) => String(x).trim())
    .filter((x) => x.length > 0)
    .slice(0, 6);
  const facts = (plan.facts ?? [])
    .map((item) => ({
      type:
        item?.type === '事实' ||
        item?.type === '偏好' ||
        item?.type === '事件' ||
        item?.type === '目标' ||
        item?.type === '风险' ||
        item?.type === '其他'
          ? item.type
          : '其他',
      content: String(item?.content ?? '').trim(),
      confidence:
        typeof item?.confidence === 'number' && item.confidence >= 0 && item.confidence <= 1
          ? item.confidence
          : 0.6,
    }))
    .filter((item) => item.content.length > 0)
    .slice(0, 6);
  const targetFilePath = typeof plan.targetFilePath === 'string' ? plan.targetFilePath.trim() : undefined;
  const action: 'ADD' | 'UPDATE' =
    plan.action === 'UPDATE' && targetFilePath
      ? 'UPDATE'
      : plan.action === 'ADD'
        ? 'ADD'
        : fallback.writePlan.action;
  const routed = routeMemoryLayerByHeuristic({
    userInput: input.userInput,
    response: input.response,
    currentLayer: layer,
    facts: facts.length > 0 ? facts : fallback.writePlan.facts,
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : fallback.confidence,
  });
  const adjustedRaw = parsed.adjustedFetchDirectives ?? {};
  const adjustedTargetFiles = Array.isArray(adjustedRaw.targetFiles)
    ? adjustedRaw.targetFiles.map((x: any) => String(x).trim()).filter((x: string) => x.length > 0).slice(0, 6)
    : [];
  const adjustedKeywords = Array.isArray(adjustedRaw.keywords)
    ? adjustedRaw.keywords.map((x: any) => String(x).trim()).filter((x: string) => x.length > 0).slice(0, 8)
    : [];
  return {
    reason: parsed.reason?.trim() || fallback.reason,
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : fallback.confidence,
    adjustedFetchDirectives: {
      ...adjustedRaw,
      targetFiles:
        adjustedTargetFiles.length > 0
          ? adjustedTargetFiles
          : fallback.adjustedFetchDirectives.targetFiles,
      keywords:
        adjustedKeywords.length > 0
          ? adjustedKeywords
          : fallback.adjustedFetchDirectives.keywords,
    },
    writePlan: {
      shouldWrite: typeof plan.shouldWrite === 'boolean' ? plan.shouldWrite : fallback.writePlan.shouldWrite,
      action,
      targetFilePath: action === 'UPDATE' ? targetFilePath ?? fallback.writePlan.targetFilePath : undefined,
      layer: routed.layer,
      layerReason: (plan.layerReason?.trim() || routed.layerReason).slice(0, 120),
      keywords: keywords.length > 0 ? keywords : fallback.writePlan.keywords,
      title: (plan.title ?? fallback.writePlan.title).slice(0, 80),
      summary: (plan.summary ?? fallback.writePlan.summary).slice(0, 200),
      facts: facts.length > 0 ? facts : fallback.writePlan.facts,
    },
  };
}

function containsAny(text: string, pieces: string[]): number {
  const lower = text.toLowerCase();
  let hit = 0;
  for (const p of pieces) {
    if (!p) continue;
    if (lower.includes(p.toLowerCase())) hit += 1;
  }
  return hit;
}

export async function assessMemoryFragmentRelevance(
  input: MemoryRelevanceInput
): Promise<MemoryRelevanceResult> {
  const quickHits = containsAny(input.fragmentText, [input.keyword, input.userInput]);
  const quickScore = Math.max(0, Math.min(1, quickHits / 2));
  const parsed = await callLlmJson<{ related?: boolean; score?: number; reason?: string }>(
    `
你是 Memory 模块的相关性判定器。请判断下面记忆碎片是否与当前上下文相关。
只输出 JSON:
{
  "related": true,
  "score": 0.0,
  "reason": "简短原因"
}

用户输入:
${input.userInput}

对话上下文:
${input.conversationRender}

检索关键词:
${input.keyword}

记忆碎片路径:
${input.fragmentPath}

记忆碎片内容:
${input.fragmentText.slice(0, 1800)}
`,
    0.1,
    'memory:relevance'
  );

  if (!parsed || typeof parsed.related !== 'boolean') {
    return {
      related: quickScore >= 0.5,
      score: quickScore,
      reason: quickScore >= 0.5 ? 'fallback: 文本包含关键词' : 'fallback: 未命中关键词',
    };
  }
  const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : quickScore;
  return {
    related: parsed.related,
    score,
    reason: parsed.reason?.trim() || 'LLM 判定',
  };
}
