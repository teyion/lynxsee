import { describe, expect, it } from 'vitest';
import { ContextEngine } from '../src/core/ContextEngine.js';
import { LLMClient, MockLLMClient } from '../src/llm/LLMClient.js';
import { ConversationModule } from '../src/modules/ConversationModule.js';
import { MemoryModule } from '../src/modules/MemoryModule.js';
import { PersonaModule } from '../src/modules/PersonaModule.js';
import { TaskModule } from '../src/modules/TaskModule.js';
import { ToolRegistryModule } from '../src/modules/ToolRegistryModule.js';
import { ToolsModule } from '../src/modules/ToolsModule.js';
import { LoopInterceptorModule } from '../src/modules/LoopInterceptorModule.js';
import { ActionModule } from '../src/modules/ActionModule.js';

class RecordingLLMClient implements LLMClient {
  calls: Array<{
    prompt: string;
    options?: {
      assistantPrefix?: string;
      stop?: string[];
      source?: string;
      temperature?: number;
      allowEmpty?: boolean;
    };
  }> = [];
  inFlight = 0;
  maxInFlight = 0;

  async generate(
    prompt: string,
    options?: {
      assistantPrefix?: string;
      stop?: string[];
      source?: string;
      temperature?: number;
      allowEmpty?: boolean;
    }
  ): Promise<{ text: string; usage: { inputTokens: number; cachedTokens: number; outputTokens: number } }> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.calls.push({ prompt, options });
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.inFlight -= 1;
    const text = `S${this.calls.length}`;
    return {
      text,
      usage: {
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
      },
    };
  }
}

describe('ContextEngine', () => {
  it('should run one turn and produce model response', async () => {
    const engine = new ContextEngine(new MockLLMClient());

    engine.registerModule(new ConversationModule());
    engine.registerModule(new PersonaModule());
    engine.registerModule(new MemoryModule());
    engine.registerModule(new ToolRegistryModule());
    engine.registerModule(new TaskModule());
    engine.registerModule(new ToolsModule());
    engine.registerModule(new LoopInterceptorModule());

    const response = await engine.runTurn('帮我查一下销售数据并生成图表');
    expect(response).toContain('MockLLMResponse');

    const snap = engine.getSnapshot('conversation');
    expect(snap?.render).toContain('User: 帮我查一下销售数据并生成图表');
  });

  it('should allow out-of-order registration and order prompt by sort', async () => {
    const engine = new ContextEngine(new MockLLMClient());

    // Intentionally register in dependency-reversed order.
    engine.registerModule(new ToolsModule(40));
    engine.registerModule(new TaskModule(30));
    engine.registerModule(new ToolRegistryModule(10));
    engine.registerModule(new PersonaModule(50));
    engine.registerModule(new MemoryModule(5));
    engine.registerModule(new ConversationModule(0));
    engine.registerModule(new LoopInterceptorModule(45));

    const result = await engine.runTurnWithDebug('帮我查销售数据并生成图表，我喜欢咖啡');
    const prompt = result.debug?.prompt ?? '';
    expect(result.response).toContain('MockLLMResponse');

    const conversationIndex = prompt.indexOf('## conversation');
    const memoryIndex = prompt.indexOf('## memory');
    const personaIndex = prompt.indexOf('## persona');
    const registryIndex = prompt.indexOf('## tool_registry');
    const taskIndex = prompt.indexOf('## task');
    const toolsIndex = prompt.indexOf('## tools');
    expect(conversationIndex).toBeGreaterThan(-1);
    expect(memoryIndex).toBeGreaterThan(-1);
    expect(personaIndex).toBeGreaterThan(-1);
    expect(registryIndex).toBeGreaterThan(-1);
    expect(taskIndex).toBeGreaterThan(-1);
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(conversationIndex).toBeLessThan(memoryIndex);
    expect(memoryIndex).toBeLessThan(taskIndex);
    expect(registryIndex).toBeLessThan(taskIndex);
    expect(taskIndex).toBeLessThan(toolsIndex);
    expect(toolsIndex).toBeLessThan(personaIndex);
  });

  it('should generate on module completion serially with prefix carry-over', async () => {
    const llm = new RecordingLLMClient();
    const engine = new ContextEngine(llm);

    engine.registerModule(new ConversationModule());
    engine.registerModule(new PersonaModule());
    engine.registerModule(new MemoryModule());
    engine.registerModule(new ToolRegistryModule());
    engine.registerModule(new TaskModule());
    engine.registerModule(new ToolsModule());
    engine.registerModule(new LoopInterceptorModule());

    const result = await engine.runTurnWithUsage('帮我查一下销售数据并生成图表');
    expect(llm.calls.length).toBeGreaterThan(1);

    let expectedPrefix = '';
    for (let i = 0; i < llm.calls.length; i += 1) {
      const call = llm.calls[i];
      expect(call.options?.assistantPrefix).toBe(expectedPrefix || undefined);
      if (i < llm.calls.length - 1) {
        expect(call.options?.stop).toEqual(['[stream-break]']);
        expect(call.prompt).toContain('[stream-break]');
      } else {
        expect(call.options?.stop).toBeUndefined();
        expect(call.prompt).toContain('不要输出 [stream-break]');
      }
      expectedPrefix += `S${i + 1}`;
    }
    expect(result.response).toBe(expectedPrefix);
    expect(llm.maxInFlight).toBe(1);
    const sources = llm.calls.map((item) => item.options?.source ?? '');
    expect(sources.some((source) => source === 'main:module-conversation-layer-0')).toBe(false);
    expect(sources[sources.length - 1]).toBe('main:finalize');

    for (const call of llm.calls) {
      expect(call.prompt.length).toBeGreaterThan(0);
      expect(call.prompt).toContain('## Stream Output Protocol');
    }
  });

  it('should rerun task/tools before final when loop interceptor requires more passes', async () => {
    const engine = new ContextEngine(new MockLLMClient());

    engine.registerModule(new ConversationModule());
    engine.registerModule(new PersonaModule());
    engine.registerModule(new MemoryModule());
    engine.registerModule(new ToolRegistryModule());
    engine.registerModule(new TaskModule());
    engine.registerModule(new ToolsModule());
    engine.registerModule(new LoopInterceptorModule());

    await engine.runTurn('请帮我分析原因并给出修改方案，还要确认结果是否生效');

    const taskSnap = engine.getSnapshot('task');
    const registrySnap = engine.getSnapshot('tool_registry');
    const toolsSnap = engine.getSnapshot('tools');
    const loopSnap = engine.getSnapshot('loop');
    expect(registrySnap?.state.availableTools?.length).toBeGreaterThan(0);
    expect(taskSnap?.render).toContain('selectedTools:');
    expect(taskSnap?.state.currentTask?.readyForFinal).toBe(true);
    expect(toolsSnap?.state.coveredIntents).toContain('execution_plan');
    expect(toolsSnap?.state.coveredIntents).toContain('result_check');
    expect((toolsSnap?.state.executionPass ?? 0) > 1).toBe(true);
    expect(loopSnap?.state.continueLoop).toBe(false);
  });

  it('should let task see tool registry on first planning pass', async () => {
    const engine = new ContextEngine(new MockLLMClient());

    engine.registerModule(new ConversationModule());
    engine.registerModule(new PersonaModule());
    engine.registerModule(new MemoryModule());
    engine.registerModule(new ToolRegistryModule());
    engine.registerModule(new TaskModule());
    engine.registerModule(new ToolsModule());
    engine.registerModule(new LoopInterceptorModule());

    await engine.runTurn('请帮我分析原因并给出修改方案');

    const taskSnap = engine.getSnapshot('task');
    expect(taskSnap?.state.currentTask?.selectedTools?.length).toBeGreaterThan(0);
    expect(taskSnap?.state.currentTask?.selectedTools?.some((item: { toolName: string }) => item.toolName === 'plan_execution')).toBe(true);
  });

  it('should include triggered action context in action render', async () => {
    const actionModule = new ActionModule();
    const actionState = actionModule.getState() as any;
    actionState.triggeredActionSummary = {
      id: 'wave-1',
      name: '挥手',
      description: '开心地朝用户挥手',
      triggerCondition: '当用户打招呼时触发',
    };

    const render = await actionModule.render();
    expect(render).toContain('# Triggered Action');
    expect(render).toContain('本轮已触发一个动作');
    expect(render).toContain('挥手');
    expect(render).toContain('开心地朝用户挥手');
    expect(render).toContain('当用户打招呼时触发');
  });
});
