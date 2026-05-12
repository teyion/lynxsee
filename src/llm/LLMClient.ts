import { addOpenAIUsage, OpenAIStyleUsage, TokenUsage } from './usageTracker.js';

export interface LLMClient {
  generate(prompt: string, options?: {
    assistantPrefix?: string;
    stop?: string[];
    source?: string;
    temperature?: number;
    allowEmpty?: boolean;
  }): Promise<{
    text: string;
    usage: TokenUsage;
  }>;
}

export class MockLLMClient implements LLMClient {
  async generate(
    prompt: string,
    options?: {
      assistantPrefix?: string;
      stop?: string[];
      source?: string;
      temperature?: number;
      allowEmpty?: boolean;
    }
  ): Promise<{ text: string; usage: TokenUsage }> {
    const clipped = prompt.slice(0, 120);
    const prefix = options?.assistantPrefix ?? '';
    const text = `MockLLMResponse(${options?.source ?? 'main'}) ${clipped}`;
    const usage = {
      inputTokens: Math.ceil((prompt.length + prefix.length) / 4),
      cachedTokens: 0,
      outputTokens: Math.ceil(text.length / 4),
    };
    addOpenAIUsage({
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedTokens },
    }, options?.source ?? 'main:mock-reply');
    return { text, usage };
  }
}

interface OpenAILLMClientOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: OpenAIStyleUsage;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  prefix?: boolean;
}

export class OpenAILLMClient implements LLMClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly temperature: number;

  constructor(options: OpenAILLMClientOptions = {}) {
    const envApiKey = process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
    this.apiKey = options.apiKey ?? envApiKey ?? '';
    this.baseURL = (
      options.baseURL ??
      process.env.LLM_BASE_URL ??
      process.env.DEEPSEEK_BASE_URL ??
      'https://api.deepseek.com/beta'
    ).replace(/\/+$/, '');
    this.model = options.model ?? process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
    this.temperature = options.temperature ?? 0.2;
  }

  private resolveBaseURL(usePrefix: boolean): string {
    if (!usePrefix) {
      return this.baseURL;
    }
    // DeepSeek prefix completion requires beta endpoint.
    if (this.baseURL.includes('api.deepseek.com') && !this.baseURL.includes('/beta')) {
      return `${this.baseURL}/beta`;
    }
    return this.baseURL;
  }

  async generate(
    prompt: string,
    options?: {
      assistantPrefix?: string;
      stop?: string[];
      source?: string;
      temperature?: number;
      allowEmpty?: boolean;
    }
  ): Promise<{ text: string; usage: TokenUsage }> {
    if (!this.apiKey) {
      throw new Error('Missing API key. Set DEEPSEEK_API_KEY (or OPENAI_API_KEY).');
    }
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: prompt,
      },
    ];
    if (options?.assistantPrefix) {
      messages.push({
        role: 'assistant',
        content: options.assistantPrefix,
        prefix: true,
      });
    }

    const requestBaseURL = this.resolveBaseURL(Boolean(options?.assistantPrefix));
    const response = await fetch(`${requestBaseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stop: options?.stop && options.stop.length > 0 ? options.stop : undefined,
        temperature: options?.temperature ?? this.temperature,
      }),
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${details}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content ?? '';
    if (!content && !options?.allowEmpty) {
      throw new Error('LLM response is empty.');
    }
    const usage = {
      inputTokens: Number(data.usage?.prompt_tokens ?? 0),
      cachedTokens: Number(data.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      outputTokens: Number(data.usage?.completion_tokens ?? 0),
    };
    addOpenAIUsage(data.usage, options?.source ?? 'main:reply');
    return { text: content, usage };
  }
}
