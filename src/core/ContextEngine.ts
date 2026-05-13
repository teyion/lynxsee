import { ContextModule } from './ContextModule.js';
import { SnapshotEntry } from './GlobalSnapshot.js';
import { LLMClient } from '../llm/LLMClient.js';
import { LayeredLLMRunner } from '../llm/LayeredLLMRunner.js';
import { GateContext, GlobalSnapshot, ModuleState, ReflectContext } from '../types/index.js';
import { buildDependencyLayers } from '../utils/dependencyGraph.js';
import { runWithUsageTracking, TokenUsage, UsageEvent } from '../llm/usageTracker.js';

interface ModuleNode {
  module: ContextModule;
  dependents: string[];
  layer: number;
}

interface ExecuteResult {
  active: boolean;
  render: string;
}

export interface ModuleDebugInfo {
  moduleId: string;
  active: boolean;
  directives: Record<string, any>;
  render: string;
  lifecycleTrace: string[];
}

export interface TurnDebugInfo {
  modules: ModuleDebugInfo[];
  prompt: string;
}

export interface TurnResult {
  response: string;
  usage: TokenUsage;
  usageEvents: UsageEvent[];
  debug?: TurnDebugInfo;
}

export interface TurnProgressEvent {
  at: number;
  phase: 'turn' | 'layer' | 'module' | 'llm' | 'reflect' | 'usage' | 'action' | 'loop';
  message: string;
  moduleId?: string;
  layer?: number;
  llmChunk?: string;
  usageEvent?: UsageEvent;
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
}

interface PendingActionEvent {
  id: string;
  videoPath: string;
  edgeSkipSeconds?: number;
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export class ContextEngine {
  private modules = new Map<string, ModuleNode>();
  private lastSnapshots = new Map<string, SnapshotEntry>();
  private llmClient: LLMClient;
  private graphDirty = false;
  private backgroundReflectTasks = new Set<Promise<void>>();
  private lastReflectCounters = {
    personaChanges: 0,
    memoryFragmentChanges: 0,
    updatedAt: 0,
  };

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  public setLLMClient(client: LLMClient) {
    this.llmClient = client;
  }

  registerModule(mod: ContextModule): void {
    if (this.modules.has(mod.id)) {
      throw new Error(`Module ${mod.id} already registered`);
    }

    this.modules.set(mod.id, {
      module: mod,
      dependents: [],
      layer: 0,
    });
    this.graphDirty = true;
  }

  async runTurn(userInput: string): Promise<string> {
    const result = await this.runTurnInternal(userInput, false);
    return result.response;
  }

  async runTurnWithUsage(
    userInput: string,
    onProgress?: (event: TurnProgressEvent) => void
  ): Promise<TurnResult> {
    return this.runTurnInternal(userInput, false, onProgress);
  }

  async runTurnWithDebug(
    userInput: string,
    onProgress?: (event: TurnProgressEvent) => void
  ): Promise<TurnResult> {
    return this.runTurnInternal(userInput, true, onProgress);
  }

  private async runTurnInternal(
    userInput: string,
    collectDebug: boolean,
    onProgress?: (event: TurnProgressEvent) => void
  ): Promise<TurnResult> {
    const emit = (event: Omit<TurnProgressEvent, 'at'>): void => {
      onProgress?.({ at: Date.now(), ...event });
    };
    const wrapped = await runWithUsageTracking(async () => {
      const pendingActions: PendingActionEvent[] = [];
      let llmResponseStarted = false;
      const flushPendingActions = (reason: 'llm-chunk' | 'llm-active' | 'llm-fallback'): void => {
        if (pendingActions.length === 0) {
          return;
        }
        while (pendingActions.length > 0) {
          const action = pendingActions.shift();
          if (!action) {
            break;
          }
          emit({
            phase: 'action',
            message: `Action released(${reason}): ${action.id}`,
            actionData: {
              id: action.id,
              videoPath: action.videoPath,
              edgeSkipSeconds: action.edgeSkipSeconds,
            },
          });
        }
      };
      emit({ phase: 'turn', message: 'turn start' });
      emit({
        phase: 'reflect',
        message: `reflect(last) persona=${this.lastReflectCounters.personaChanges} memory=${this.lastReflectCounters.memoryFragmentChanges}`,
        reflectCounters: {
          personaChanges: this.lastReflectCounters.personaChanges,
          memoryFragmentChanges: this.lastReflectCounters.memoryFragmentChanges,
          scope: 'last',
        },
      });
      this.ensureGraphMetadataReady();

      const conversationNode = this.modules.get('conversation');
      if (!conversationNode) {
        throw new Error('Conversation module is required before runTurn');
      }

      const activeRenders = new Map<string, string>();
      const moduleDebugMap = new Map<string, ModuleDebugInfo>();

      const bootstrapSnapshot: GlobalSnapshot = {
        conversationState: cloneState(conversationNode.module.getState()),
        conversationRender: this.lastSnapshots.get('conversation')?.render ?? '',
        moduleSnapshots: Object.fromEntries(
          [...this.lastSnapshots.entries()]
            .filter(([id]) => id !== 'conversation')
            .map(([id, snap]) => [id, { state: cloneState(snap.state), lastRender: snap.render }])
        ),
      };

      emit({ phase: 'module', moduleId: 'conversation', layer: 0, message: 'start conversation' });
      const conversationStart = Date.now();
      const conversationResult = await this.executeModule(
        conversationNode.module,
        userInput,
        bootstrapSnapshot,
        emit,
        0
      );
      const conversationCost = Date.now() - conversationStart;
      emit({
        phase: 'module',
        moduleId: 'conversation',
        layer: 0,
        message: `done conversation active=${conversationResult.active} ms=${conversationCost}`,
      });

      if (conversationResult.active) {
        activeRenders.set('conversation', conversationResult.render);
      }
      if (collectDebug) {
        moduleDebugMap.set('conversation', {
          moduleId: 'conversation',
          active: conversationResult.active,
          directives: cloneState(conversationNode.module.getDirectives()),
          render: conversationResult.render,
          lifecycleTrace: cloneState(conversationNode.module.getLifecycleTrace?.() ?? []),
        });
      }

      let response = '';
      let lastPrompt = '';
      let llmTriggerCount = 0;
      const runner = new LayeredLLMRunner({
        llmClient: this.llmClient,
        buildLayerPrompt: (contextPrompt, isFinal) =>
          this.buildLayerGenerationPrompt(contextPrompt, isFinal),
        onProgress: (event) => {
          if (event.phase === 'start') {
            emit({
              phase: 'llm',
              moduleId: event.moduleId,
              layer: event.layer,
              message: `module ${event.moduleId} layer ${event.layer} llm start promptChars=${event.prompt?.length ?? 0} prefixChars=${event.prefixLength ?? 0} final=${event.isFinal}`,
            });
            return;
          }
          const chunk = event.chunk ?? '';
          if (!llmResponseStarted && chunk.length > 0) {
            llmResponseStarted = true;
            flushPendingActions('llm-chunk');
          }
          const chunkText = chunk.replaceAll('\n', '\\n');
          emit({
            phase: 'llm',
            moduleId: event.moduleId,
            layer: event.layer,
            message: `module ${event.moduleId} layer ${event.layer} llm chunk="${chunkText}" totalChars=${event.prefixLength ?? 0}`,
            llmChunk: chunk,
          });
        },
      });
      const triggerModuleLLM = (moduleId: string, layer: number): void => {
        const contextPrompt = this.buildPromptFromRenders(activeRenders);
        runner.publishTrigger({
          moduleId,
          layer,
          contextPrompt,
          isFinal: false,
        });
        llmTriggerCount += 1;
      };
      if (conversationResult.active && conversationNode.module.shouldRunLLM()) {
        triggerModuleLLM(conversationNode.module.id, 0);
      }

      const executeNodeForTurn = async (node: ModuleNode): Promise<void> => {
        emit({
          phase: 'module',
          moduleId: node.module.id,
          layer: node.layer,
          message: `start ${node.module.id}`,
        });
        const started = Date.now();
        const snapshot = this.buildRuntimeSnapshot(conversationNode.module, conversationResult.render, activeRenders);
        const result = await this.executeModule(node.module, userInput, snapshot, emit, node.layer);
        const elapsed = Date.now() - started;
        emit({
          phase: 'module',
          moduleId: node.module.id,
          layer: node.layer,
          message: `done ${node.module.id} active=${result.active} ms=${elapsed}`,
        });
        if (node.module.id === 'action') {
          const state = node.module.getState() as any;
          if (state.currentAction) {
            const actionEvent = {
              id: state.currentAction.id,
              videoPath: state.currentAction.videoPath,
              edgeSkipSeconds: state.currentAction.edgeSkipSeconds,
            };
            if (llmResponseStarted) {
              emit({
                phase: 'action',
                message: `Action released(llm-active): ${actionEvent.id}`,
                actionData: actionEvent,
              });
            } else {
              pendingActions.push(actionEvent);
              emit({
                phase: 'action',
                message: `Action buffered: ${state.currentAction.id}`,
              });
            }
          }
        }
        if (result.active) {
          activeRenders.set(node.module.id, result.render);
          if (node.module.shouldRunLLM()) {
            triggerModuleLLM(node.module.id, node.layer);
          }
        }
        if (collectDebug) {
          moduleDebugMap.set(node.module.id, {
            moduleId: node.module.id,
            active: result.active,
            directives: cloneState(node.module.getDirectives()),
            render: result.render,
            lifecycleTrace: cloneState(node.module.getLifecycleTrace?.() ?? []),
          });
        }
      };


      const grouped = this.groupModulesByLayer();
      for (const [layer, nodes] of grouped.entries()) {
        if (layer === 0) {
          continue;
        }
        emit({
          phase: 'layer',
          layer,
          message: `layer ${layer} start modules=[${nodes.map((n) => n.module.id).join(', ')}]`,
        });

        const results = await Promise.all(nodes.map((node) => executeNodeForTurn(node)));
        emit({ phase: 'layer', layer, message: `layer ${layer} done` });
        void results;
      }

      const loopNode = this.modules.get('loop');
      let loopPass = 0;
      while (loopNode) {
        const directive = loopNode.module.getLoopDirective?.();
        if (!directive?.continueLoop) {
          if (loopPass > 0) {
            emit({ phase: 'loop', message: `loop settled after ${loopPass} pass(es)` });
          }
          break;
        }
        const maxPasses = Math.max(1, Number(directive.maxPasses ?? 3));
        if (loopPass >= maxPasses) {
          emit({
            phase: 'loop',
            message: `loop stopped at maxPasses=${maxPasses} reason=${directive.reason}`,
          });
          break;
        }
        loopPass += 1;
        const rerunPriority = new Map<string, number>([
          ['tools', 0],
          ['task', 1],
          [loopNode.module.id, 2],
        ]);
        const rerunIds = [...new Set([...directive.targetModuleIds, loopNode.module.id])];
        const rerunNodes = rerunIds
          .map((moduleId) => this.modules.get(moduleId))
          .filter((node): node is ModuleNode => Boolean(node))
          .sort((a, b) => {
            const aPriority = rerunPriority.get(a.module.id) ?? 99;
            const bPriority = rerunPriority.get(b.module.id) ?? 99;
            if (aPriority !== bPriority) {
              return aPriority - bPriority;
            }
            return this.compareExecutionOrder(a, b);
          });
        emit({
          phase: 'loop',
          message: `loop pass=${loopPass} reason=${directive.reason} rerun=[${rerunNodes.map((node) => node.module.id).join(', ')}]`,
        });
        for (const node of rerunNodes) {
          await executeNodeForTurn(node);
        }
      }

      if (llmTriggerCount > 0) {
        runner.publishTrigger({
          moduleId: 'finalize',
          layer: 999,
          contextPrompt: this.buildPromptFromRenders(activeRenders),
          isFinal: true,
        });
        const layered = await runner.waitForDrain();
        response = layered.response;
        lastPrompt = layered.lastPrompt;
        flushPendingActions('llm-fallback');
        emit({
          phase: 'llm',
          message: `module-trigger llm assembled totalChars=${response.length} triggers=${llmTriggerCount}`,
        });
      } else {
        await runner.waitForDrain();
        flushPendingActions('llm-fallback');
        emit({
          phase: 'llm',
          message: 'main llm skipped: no llm-enabled module render',
        });
      }

      emit({ phase: 'reflect', message: 'post-reflect queued (async)' });
      this.enqueuePostSubconscious(userInput, response, activeRenders, emit);
      this.refreshSnapshots(activeRenders);

      if (!collectDebug) {
        return { response };
      }

      for (const [moduleId, node] of this.modules.entries()) {
        if (!moduleDebugMap.has(moduleId)) {
          moduleDebugMap.set(moduleId, {
            moduleId,
            active: false,
            directives: cloneState(node.module.getDirectives()),
            render: '',
            lifecycleTrace: cloneState(node.module.getLifecycleTrace?.() ?? []),
          });
        } else {
          const existed = moduleDebugMap.get(moduleId)!;
          existed.lifecycleTrace = cloneState(node.module.getLifecycleTrace?.() ?? existed.lifecycleTrace);
        }
      }

      const modules = [...this.modules.values()]
        .sort((a, b) => this.comparePromptOrder(a, b))
        .map((node) => moduleDebugMap.get(node.module.id)!)
        .filter(Boolean);

      return {
        response,
        debug: {
          modules,
          prompt: lastPrompt,
        },
      };
    }, {
      onUsageEvent: (event) =>
        emit({
          phase: 'usage',
          message: `usage source=${event.source}`,
          usageEvent: event,
        }),
    });

    emit({ phase: 'turn', message: 'turn done' });

    return {
      ...wrapped.result,
      usage: wrapped.usage,
      usageEvents: wrapped.events,
    };
  }

  private async executeModule(
    mod: ContextModule,
    userInput: string,
    snapshot: GlobalSnapshot,
    emit?: (event: Omit<TurnProgressEvent, 'at'>) => void,
    layer?: number
  ): Promise<ExecuteResult> {
    const emitStage = (stage: string, detail: string): void => {
      emit?.({
        phase: 'module',
        moduleId: mod.id,
        layer,
        message: `progress ${mod.id} stage=${stage} ${detail}`,
      });
    };
    const gateCtx: GateContext = {
      userInput,
      currentState: cloneState(mod.getState()),
      globalSnapshot: snapshot,
    };

    emitStage('gate', 'checking activation');
    const active = await mod.activationGate(gateCtx);
    if (!active) {
      emitStage('gate', 'closed');
      return { active: false, render: '' };
    }

    emitStage('adjust', 'updating directives');
    await mod.subconsciousAdjust({
      userInput,
      state: mod.getState(),
      pendingSuggestion: mod.getState().pendingSuggestion ?? null,
    });

    emitStage('fetch', 'loading bound data');
    const freshData = await mod.fetchData();
    emitStage('update', `merging freshData=${freshData.length}`);
    await mod.update(userInput, snapshot, freshData);
    emitStage('render', 'building prompt segment');
    const render = await mod.render();
    emitStage('render', `ready chars=${render.length}`);

    return { active: true, render };
  }

  private async runPostSubconscious(
    userInput: string,
    response: string,
    activeRenders: Map<string, string>,
    emit: (event: Omit<TurnProgressEvent, 'at'>) => void
  ): Promise<void> {
    const jobs: Promise<void>[] = [];
    let personaChanges = 0;
    let memoryFragmentChanges = 0;

    for (const [id, segment] of activeRenders.entries()) {
      const mod = this.modules.get(id)?.module;
      if (!mod) {
        continue;
      }
      const ctx: ReflectContext = {
        userInput,
        response,
        myPromptSegment: segment,
      };
      jobs.push(
        (async () => {
          emit({
            phase: 'reflect',
            moduleId: id,
            message: `reflect start ${id}`,
          });
          await mod.subconsciousReflect(ctx);
          if (id === 'persona') {
            const count = Math.max(0, Number(mod.getState().lastReflectPersonaChangeCount ?? 0));
            personaChanges = count;
            emit({
              phase: 'reflect',
              moduleId: id,
              message: `reflect done persona changes=${count}`,
              reflectCounters: {
                personaChanges: count,
                scope: 'module',
              },
            });
          }
          if (id === 'memory') {
            const count = Math.max(0, Number(mod.getState().lastReflectMemoryFragmentWriteCount ?? 0));
            memoryFragmentChanges = count;
            emit({
              phase: 'reflect',
              moduleId: id,
              message: `reflect done memory fragments=${count}`,
              reflectCounters: {
                memoryFragmentChanges: count,
                scope: 'module',
              },
            });
          }
        })()
      );
    }

    await Promise.all(jobs);
    this.lastReflectCounters = {
      personaChanges,
      memoryFragmentChanges,
      updatedAt: Date.now(),
    };
    emit({
      phase: 'reflect',
      message: `reflect(turn) persona=${personaChanges} memory=${memoryFragmentChanges}`,
      reflectCounters: {
        personaChanges,
        memoryFragmentChanges,
        scope: 'turn',
      },
    });
  }

  private enqueuePostSubconscious(
    userInput: string,
    response: string,
    activeRenders: Map<string, string>,
    emit: (event: Omit<TurnProgressEvent, 'at'>) => void
  ): void {
    const detachedRenders = new Map(activeRenders);
    let task: Promise<void>;
    task = this.runPostSubconscious(userInput, response, detachedRenders, emit)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        emit({
          phase: 'reflect',
          message: `post-reflect async error: ${message}`,
        });
      })
      .finally(() => {
        this.backgroundReflectTasks.delete(task);
      });
    this.backgroundReflectTasks.add(task);
  }

  private refreshSnapshots(activeRenders: Map<string, string>): void {
    for (const [id, node] of this.modules.entries()) {
      const prevRender = this.lastSnapshots.get(id)?.render ?? '';
      const render = activeRenders.get(id) ?? prevRender;
      this.lastSnapshots.set(id, {
        state: cloneState(node.module.getState()),
        render,
      });
    }
  }

  private buildRuntimeSnapshot(
    conversationModule: ContextModule,
    conversationRender: string,
    activeRenders: Map<string, string>
  ): GlobalSnapshot {
    const moduleSnapshots: GlobalSnapshot['moduleSnapshots'] = {};
    for (const [id, node] of this.modules.entries()) {
      if (id === 'conversation') {
        continue;
      }
      const fallbackRender = this.lastSnapshots.get(id)?.render ?? '';
      moduleSnapshots[id] = {
        state: cloneState(node.module.getState()),
        lastRender: activeRenders.get(id) ?? fallbackRender,
      };
    }
    return {
      conversationState: cloneState(conversationModule.getState()),
      conversationRender,
      moduleSnapshots,
    };
  }

  private rebuildGraphMetadata(): void {
    const modMap = new Map<string, ContextModule>();
    for (const [id, node] of this.modules.entries()) {
      modMap.set(id, node.module);
      node.dependents = [];
    }

    const layers = buildDependencyLayers(modMap);

    for (const [id, node] of this.modules.entries()) {
      node.layer = layers.get(id) ?? 0;
      for (const dep of node.module.dependencies) {
        this.modules.get(dep)?.dependents.push(id);
      }
    }

    this.graphDirty = false;
  }

  private ensureGraphMetadataReady(): void {
    if (this.graphDirty) {
      this.rebuildGraphMetadata();
    }
  }

  private groupModulesByLayer(): Map<number, ModuleNode[]> {
    const grouped = new Map<number, ModuleNode[]>();

    for (const node of this.modules.values()) {
      const list = grouped.get(node.layer) ?? [];
      list.push(node);
      grouped.set(node.layer, list);
    }

    for (const [layer, nodes] of grouped.entries()) {
      const sorted = [...nodes].sort((a, b) => this.compareExecutionOrder(a, b));
      grouped.set(layer, sorted);
    }

    return new Map([...grouped.entries()].sort((a, b) => a[0] - b[0]));
  }

  private buildPromptFromRenders(renders: Map<string, string>): string {
    const orderedIds = [...this.modules.values()]
      .sort((a, b) => this.comparePromptOrder(a, b))
      .map((n) => n.module.id)
      .filter((id) => renders.has(id));

    return orderedIds
      .map((id) => `## ${id}\n${renders.get(id)}`)
      .join('\n\n')
      .trim();
  }

  private buildLayerGenerationPrompt(contextPrompt: string, isLastLayer: boolean): string {
    const objective = isLastLayer
      ? '请基于以上各个模块的上下文信息，进行一次最终的整合与回复。你的回答必须直接呈现给用户，请保持语气连贯自然。'
      : '请基于以上上下文仅补全一句短语（一个短句），用于构建最终回复。这个补全文本会直接展示给用户，必须从第一字开始就是对用户说的话。';
    return [
      '# Layered Response Generation',
      objective,
      '核心防幻觉纪律：',
      '1. 必须基于当前已加载的模块数据（如 Memory 或 Conversation）作答。',
      '2. 若某些事件在上下文中未被提及，绝对不可自行编造、猜测或承认。若被问及未记录的细节，请坦诚说明不记得或仅作礼貌回应。',
      '3. 输出会直接展示给用户，必须直接进入角色回复，不要写任何准备语、解释语、过渡语或自我说明。',
      '4. 禁止输出类似“我这就…/我来…/根据当前对话…/按照你的要求…/下面我…”这类过程性表达。',
      '只输出新增补全文本，不要重复已有前缀，不要输出解释，不要描述你将要如何回答。',
      '',
      '## Context',
      contextPrompt || '(empty)',
    ].join('\n');
  }

  private compareExecutionOrder(a: ModuleNode, b: ModuleNode): number {
    if (a.layer !== b.layer) {
      return a.layer - b.layer;
    }
    return this.comparePromptOrder(a, b);
  }

  private comparePromptOrder(a: ModuleNode, b: ModuleNode): number {
    const aSort = a.module.getSort();
    const bSort = b.module.getSort();
    if (aSort !== bSort) {
      return aSort - bSort;
    }
    return a.module.id.localeCompare(b.module.id);
  }

  getSnapshot(moduleId: string): { state: ModuleState; render: string } | undefined {
    const snapshot = this.lastSnapshots.get(moduleId);
    if (!snapshot) {
      return undefined;
    }
    return {
      state: cloneState(snapshot.state),
      render: snapshot.render,
    };
  }

  getModuleState(moduleId: string): ModuleState | undefined {
    const node = this.modules.get(moduleId);
    if (!node) {
      return undefined;
    }
    return cloneState(node.module.getState());
  }
}
