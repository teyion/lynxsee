import { EventEmitter } from 'node:events';
import { LLMClient } from './LLMClient.js';

export interface LLMTriggerEvent {
  moduleId: string;
  layer: number;
  contextPrompt: string;
  isFinal: boolean;
}

export interface LayeredLLMProgressEvent {
  phase: 'start' | 'chunk';
  moduleId: string;
  layer: number;
  prompt?: string;
  chunk?: string;
  isFinal: boolean;
  prefixLength?: number;
}

interface LayeredLLMRunnerOptions {
  llmClient: LLMClient;
  buildLayerPrompt: (contextPrompt: string, isFinal: boolean) => string;
  onProgress?: (event: LayeredLLMProgressEvent) => void;
}

export class LayeredLLMRunner {
  private bus = new EventEmitter();
  private chain: Promise<void> = Promise.resolve();
  private response = '';
  private lastPrompt = '';
  private triggerSeq = 0;

  constructor(private options: LayeredLLMRunnerOptions) {
    this.bus.on('llm-trigger', (event: LLMTriggerEvent) => {
      this.chain = this.chain.then(() => this.handleTrigger(event));
    });
  }

  publishTrigger(event: LLMTriggerEvent): void {
    const queuedSeq = this.triggerSeq + 1;
    this.log(
      `queue trigger#${queuedSeq} module=${event.moduleId} layer=${event.layer} final=${event.isFinal} contextChars=${event.contextPrompt.length}`
    );
    this.bus.emit('llm-trigger', event);
  }

  async waitForDrain(): Promise<{ response: string; lastPrompt: string }> {
    await this.chain;
    return {
      response: this.response,
      lastPrompt: this.lastPrompt,
    };
  }

  private async handleTrigger(event: LLMTriggerEvent): Promise<void> {
    const seq = ++this.triggerSeq;
    const startedAt = Date.now();
    const basePrompt = this.options.buildLayerPrompt(event.contextPrompt, event.isFinal);
    const prompt = this.appendStreamInstruction(basePrompt, event.isFinal);
    this.lastPrompt = prompt;
    this.log(
      `start trigger#${seq} module=${event.moduleId} layer=${event.layer} final=${event.isFinal} promptChars=${prompt.length} prefixChars=${this.response.length}`
    );
    this.logBlock(
      `trigger#${seq} prompt module=${event.moduleId} layer=${event.layer} final=${event.isFinal}`,
      prompt
    );
    this.options.onProgress?.({
      phase: 'start',
      moduleId: event.moduleId,
      layer: event.layer,
      prompt,
      isFinal: event.isFinal,
      prefixLength: this.response.length,
    });

    const llm = await this.options.llmClient.generate(prompt, {
      assistantPrefix: this.response || undefined,
      stop: event.isFinal ? undefined : ['[stream-break]'],
      source: event.isFinal
        ? 'main:finalize'
        : `main:module-${event.moduleId}-layer-${event.layer}`,
      allowEmpty: true,
    });
    this.log(
      `response trigger#${seq} module=${event.moduleId} layer=${event.layer} chars=${llm.text.length} usage(in=${llm.usage.inputTokens},cached=${llm.usage.cachedTokens},out=${llm.usage.outputTokens})`
    );
    this.logBlock(
      `trigger#${seq} response module=${event.moduleId} layer=${event.layer} final=${event.isFinal}`,
      llm.text
    );
    let chunk = llm.text;
    if (event.isFinal && !chunk.trim()) {
      this.log(`final-empty trigger#${seq} module=${event.moduleId} retry=true`);
      const retry = await this.options.llmClient.generate(prompt, {
        assistantPrefix: this.response || undefined,
        source: 'main:finalize-retry',
        allowEmpty: true,
      });
      chunk = retry.text;
      this.log(
        `retry-response trigger#${seq} module=${event.moduleId} chars=${retry.text.length} usage(in=${retry.usage.inputTokens},cached=${retry.usage.cachedTokens},out=${retry.usage.outputTokens})`
      );
      this.logBlock(
        `trigger#${seq} retry-response module=${event.moduleId} layer=${event.layer}`,
        retry.text
      );
    }
    chunk = chunk.replaceAll('[stream-break]', '');
    this.response += chunk;
    this.log(
      `done trigger#${seq} module=${event.moduleId} layer=${event.layer} chunkChars=${chunk.length} totalChars=${this.response.length} elapsedMs=${Date.now() - startedAt}`
    );
    this.options.onProgress?.({
      phase: 'chunk',
      moduleId: event.moduleId,
      layer: event.layer,
      chunk,
      isFinal: event.isFinal,
      prefixLength: this.response.length,
    });
  }

  private appendStreamInstruction(prompt: string, isFinal: boolean): string {
    if (isFinal) {
      return [
        prompt,
        '',
        '## Stream Output Protocol',
        '这是最终收尾段。请直接补全自然结尾，不要输出 [stream-break]。',
      ].join('\n');
    }
    return [
      prompt,
      '',
      '## Stream Output Protocol',
      '请根据上下文补充一段流式输出 chunk。',
      '当这一段应当结束时，请输出 [stream-break] 作为结束标记。',
      '只输出新增补全文本，不要解释。',
    ].join('\n');
  }

  private log(message: string): void {
    console.log(`[LLMRunner] ${message}`);
  }

  private logBlock(title: string, content: string): void {
    const body = content && content.length > 0 ? content : '(empty)';
    console.log(`[LLMRunner] ${title}\n${body}\n[LLMRunner] /${title}`);
  }
}
