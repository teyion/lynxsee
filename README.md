# LynxSee（灵觉空间）

## 当前实现说明

本 README 以当前代码实现为准，描述默认运行时的真实架构，而不是最初的蓝图。

## 概述

LynxSee 是一个以上下文模块为核心的 Agent 运行时。每个模块围绕某一类职责维护自己的状态，并在每轮对话中经历统一的生命周期：

`activationGate -> subconsciousAdjust -> fetchData -> update -> render -> subconsciousReflect`

当前实现的关键特点有三点：

- 使用依赖图 + 层级并发调度模块。
- 使用 `LayeredLLMRunner` 做增量式生成，而不是只在最后调用一次主 LLM。
- 使用 `loop` 模块在必要时重跑 `task/tools`，直到满足最终整合条件或达到最大重试次数。

## 当前核心原则

- **模块同构**：所有模块都实现 `ContextModule` 接口。
- **层级执行**：模块按依赖拓扑分层执行，同层并发。
- **排序可控**：除依赖层级外，还通过 `getSort()` 控制 prompt 拼接与同层顺序。
- **生成与上下文解耦**：模块主要负责产出上下文片段，是否触发增量生成由 `shouldRunLLM()` 决定。
- **快照驱动协同**：模块通过 `GlobalSnapshot` 观察其他模块状态，而不是直接互相调用。
- **反思异步化**：本轮回复完成后，模块反思在后台异步执行，不阻塞首包与主返回。
- **角色态隔离**：状态目录通过环境变量绑定到当前激活角色/风格，实现多角色状态隔离。

## 在线调度流程

当前 `ContextEngine` 的执行逻辑如下：

```text
用户输入
  │
  ▼
ConversationModule 先执行完整生命周期
  │
  ├─ 产出本轮 conversationRender
  └─ 建立运行时快照
         │
         ▼
其余模块按层并发执行
  │
  ├─ activationGate
  ├─ subconsciousAdjust
  ├─ fetchData
  ├─ update
  └─ render
         │
         ├─ active render 进入本轮上下文池
         └─ 如果 shouldRunLLM() 为 true，则触发一次增量生成
                    │
                    ▼
loop 模块检查 task/tools 是否已满足最终整合条件
  │
  ├─ 满足：直接进入 finalize
  └─ 不满足：按优先级重跑 tools / task / loop
                    │
                    ▼
LayeredLLMRunner finalize
  │
  ▼
返回最终回复
  │
  ├─ 异步排队 subconsciousReflect
  └─ 刷新 lastSnapshots
```

和早期设计不同，当前不是“所有模块完成后只调用一次主 LLM”，而是“模块执行过程中可以持续触发增量生成，最后再做一次 `finalize` 收口”。

## `GlobalSnapshot` 的当前语义

`GlobalSnapshot` 仍然是模块间协作的核心只读视图，但当前实现不是严格的“上一轮静态快照”。

当前规则如下：

- `conversationRender` 是本轮最新的 `conversation` 输出。
- 对于尚未在本轮执行的模块，`moduleSnapshots[id]` 来自上一轮 `lastSnapshots`。
- 对于已经在本轮执行完成的模块，后续模块在同一轮中会看到它们的本轮最新 `state` 和 `render`。

这意味着当前快照更接近“运行时滚动快照”，而不是纯过去时快照。这样做的好处是联动更强，但时序语义比最初蓝图更复杂。

接口定义如下：

```ts
export interface GlobalSnapshot {
  conversationState: ModuleState;
  conversationRender: string;
  moduleSnapshots: Record<
    string,
    {
      state: ModuleState;
      lastRender: string;
    }
  >;
}
```

## 核心接口

### `ContextModule`

当前接口定义：

```ts
export interface ContextModule {
  readonly id: string;
  readonly dependencies: string[];

  activationGate(ctx: GateContext): Promise<boolean>;
  subconsciousAdjust(ctx: SubconsciousContext): Promise<void>;
  fetchData(): Promise<FetchResult[]>;
  update(userInput: string, snapshot: GlobalSnapshot, freshData: FetchResult[]): Promise<void>;
  render(): Promise<string>;
  subconsciousReflect(ctx: ReflectContext): Promise<void>;

  getState(): ModuleState;
  getDirectives(): RenderDirectives;
  getBindings(): DataBinding[];
  getSort(): number;
  shouldRunLLM(): boolean;
  getLoopDirective?(): LoopDirective | null;
  getLifecycleTrace?(): string[];

  receiveTidyRequest(tidyQuery: string): Promise<void>;
}
```

相比早期版本，当前多了四个关键接口：

- `getSort()`：控制 prompt 顺序与同层排序。
- `shouldRunLLM()`：控制该模块完成后是否触发增量生成。
- `getLoopDirective()`：由 `loop` 模块暴露重跑指令。
- `getLifecycleTrace()`：用于调试与 UI 展示。

### `ModuleState`

```ts
export interface ModuleState {
  activeTopics: string[];
  temporalFocus: 'latest' | string;
  pendingSuggestion?: Suggestion | null;
  fetchDirectives?: Record<string, any>;
  [key: string]: any;
}
```

### `Suggestion`

```ts
export interface Suggestion {
  adjustedFetchDirectives: Record<string, any>;
  reason: string;
  confidence: number;
}
```

## 默认模块图

默认引擎由 `createDefaultEngine()` 注册以下模块：

- `conversation`
- `persona`
- `memory`
- `tool_registry`
- `task`
- `tools`
- `action`
- `loop`

默认依赖关系如下：

```text
conversation
  ├── persona
  └── tool_registry

persona
  └── memory

memory
  ├── task
  └── action

tool_registry
  └── task

task
  └── tools

tools
  └── loop
```

按当前依赖层级，大致可分为：

```text
layer 0: conversation
layer 1: persona, tool_registry
layer 2: memory
layer 3: action, task
layer 4: tools
layer 5: loop
```

注意：

- 层级只由依赖决定。
- 同层内与最终 prompt 顺序还会受到 `sort` 影响。

## 模块职责

### 1. `ConversationModule`

职责：

- 管理当前会话 JSONL。
- 拉取当前会话最近消息，以及其他会话的少量参考历史。
- 产出 `# Conversation` 片段，作为全局语境锚点。
- 在 `subconsciousReflect` 中把 assistant 回复追加回当前会话文件。

当前特征：

- 始终激活。
- `shouldRunLLM()` 返回 `false`，它本身不直接触发增量生成。
- 对话历史已是持久化状态的一部分，而不是纯内存摘要。

### 2. `PersonaModule`

职责：

- 读取角色人设文件与属性配置。
- 渲染当前人设约束、语气风格、目标等内容。
- 在反思阶段根据用户输入与回复做轻量人设修正。

当前特征：

- 依赖 `conversation`。
- 是默认上下文生成链路中的重要文本提供者。
- 反思结果会写入 `pendingSuggestion` 和人设历史。

### 3. `MemoryModule`

职责：

- 维护角色作用域下的记忆碎片目录。
- 根据 directives、建议与当前规则选择要加载的记忆片段。
- 把选中的记忆片段渲染成 `# Memory` 上下文块。
- 在反思阶段生成下一轮检索建议，并决定是否写入/更新记忆碎片。

当前特征：

- 依赖 `persona`，不是直接依赖 `conversation`。
- 记忆读取主要是自定义逻辑，不完全依赖通用 `DataBinding`。
- 当前在线检索采用“离线策略指定碎片优先 + 时间 TopK 补齐”的混合策略。
- `subconsciousReflect` 是异步的，所以它给下一轮的建议存在时序差。

### 4. `ToolRegistryModule`

职责：

- 提供一份静态工具注册表。
- 描述每个工具覆盖的能力意图，如 `understand_request`、`execution_plan`、`result_check`。
- 为 `task` 和 `tools` 模块提供工具可用性视图。

当前特征：

- 依赖 `conversation`。
- `shouldRunLLM()` 返回 `false`。
- 目前注册表是内置静态数据，不从外部服务实时拉取。

### 5. `TaskModule`

职责：

- 根据用户输入推断目标类型。
- 将任务需求映射为一组所需工具意图。
- 结合工具注册表和工具执行状态，生成当前任务计划、验收清单和下一步动作。

当前特征：

- 依赖 `conversation`、`memory`、`tool_registry`。
- 不是传统“任务树管理器”，更像“任务编排与验收约束器”。
- `shouldRunLLM()` 返回 `false`，主要负责结构化上下文。

### 6. `ToolsModule`

职责：

- 根据 `task` 所需意图，逐轮覆盖缺失能力。
- 记录本轮/本回合已覆盖的 intents 与 recentResults。
- 为 `loop` 模块提供是否仍需补跑的信息。

当前特征：

- 依赖 `task` 和 `tool_registry`。
- 并不直接调用真实外部工具，而是维护一套“能力覆盖”状态机。
- `shouldRunLLM()` 返回 `false`。

### 7. `ActionModule`

职责：

- 读取当前角色动作库。
- 用一次轻量 LLM 判断是否触发某个动作。
- 将动作摘要写入 prompt，使文本回复和动作状态一致。

当前特征：

- 依赖 `memory`。
- 即使不产出文本工具结果，也会通过进度事件把动作信息送到前端。
- 当前动作选择不经过 `LayeredLLMRunner`，而是在模块内部独立调用轻量模型。

### 8. `LoopInterceptorModule`

职责：

- 检查 `task` 和 `tools` 是否已经具备最终整合所需条件。
- 在条件未满足时，请求引擎重跑指定模块。
- 限制最大循环次数，防止无限重试。

当前特征：

- 依赖 `tools`。
- `shouldRunLLM()` 返回 `false`。
- 通过 `getLoopDirective()` 向引擎暴露 `continueLoop / targetModuleIds / maxPasses`。

## `ContextEngine` 当前执行细节

### 1. 注册与拓扑

`registerModule()` 只负责注册节点；真正的层级计算在首次运行前由 `buildDependencyLayers()` 完成。

### 2. 单模块执行

引擎执行单模块时遵循固定顺序：

```ts
activationGate
subconsciousAdjust
fetchData
update
render
```

如果门关闭，模块本轮完全静默。

### 3. 分层并发

除 `conversation` 外，其他模块按 layer 分组，层内 `Promise.all` 并发执行。

### 4. 增量生成

当模块满足以下条件时，会向 `LayeredLLMRunner` 发布一次触发：

- 模块本轮 active
- `shouldRunLLM()` 返回 `true`

当前默认会触发增量生成的模块主要是：

- `memory`
- `persona`
- `action`（如果有内容）

而 `conversation`、`tool_registry`、`task`、`tools`、`loop` 都显式关闭了模块级 LLM 触发。

### 5. Loop 重跑

所有层跑完后，引擎会检查 `loop` 模块的 `getLoopDirective()`：

- 若 `continueLoop = false`，进入 `finalize`
- 若 `continueLoop = true`，按优先级重跑 `tools -> task -> loop`
- 到达 `maxPasses` 后强制停止

### 6. Finalize

如果本轮有任何模块触发过增量生成，引擎最后会用当前全部 active renders 做一次 `finalize`，产出最终回复。

### 7. Reflect 与快照刷新

当前顺序是：

```text
final response ready
-> enqueuePostSubconscious()
-> refreshSnapshots()
-> return result
```

因此：

- `subconsciousReflect` 在后台异步执行。
- `lastSnapshots` 会先于 reflect 完成被刷新。
- `lastReflectCounters` 记录的是最近一次后台 reflect 的统计，而不是严格同步于刚返回的这一轮。

## 文件与目录

当前项目结构中的关键部分：

```text
.
├── src/
│   ├── core/
│   │   ├── ContextEngine.ts
│   │   ├── ContextModule.ts
│   │   └── GlobalSnapshot.ts
│   ├── modules/
│   │   ├── BaseModule.ts
│   │   ├── ConversationModule.ts
│   │   ├── PersonaModule.ts
│   │   ├── MemoryModule.ts
│   │   ├── ToolRegistryModule.ts
│   │   ├── TaskModule.ts
│   │   ├── ToolsModule.ts
│   │   ├── ActionModule.ts
│   │   └── LoopInterceptorModule.ts
│   ├── subconscious/
│   │   ├── SubconsciousHelper.ts
│   │   └── prompts.ts
│   ├── llm/
│   │   ├── LLMClient.ts
│   │   ├── LayeredLLMRunner.ts
│   │   └── usageTracker.ts
│   ├── utils/
│   │   ├── dependencyGraph.ts
│   │   ├── fetchDataSources.ts
│   │   └── runtimeStatePaths.ts
│   └── createDefaultEngine.ts
├── roles/
│   └── ... 角色、状态、动作、记忆、人设数据
├── ui/
│   └── ... Electron + React 前端
└── tests/
    └── engine.test.ts
```

## 当前已落地与未完全落地的部分

### 已落地

- 依赖分层执行
- 同层并发
- 模块级 gate / adjust / fetch / update / render / reflect
- 模块级生命周期追踪
- 模块排序与 prompt 拼接控制
- 增量式 LLM 生成
- loop 重跑机制
- 角色作用域状态目录
- UI 侧调试、记忆面板、动作联动

### 预留但未完全成为默认主流程

- 离线 `TidyModule`
- 全局睡眠整理调度
- 基于通用 `DataBinding` 的统一在线数据获取
- 严格意义上的“上一轮静态快照”

`receiveTidyRequest()` 目前仍保留在接口中，作为未来离线整理的扩展点，但默认运行时并没有自动触发一套完整的 tidy cycle。

## 最小示例

```ts
import { createDefaultEngine } from './src/createDefaultEngine.js';

const engine = createDefaultEngine();
const result = await engine.runTurnWithUsage('帮我分析当前项目里的记忆调度逻辑');

console.log(result.response);
```

## 调试建议

- 需要查看模块执行轨迹时，优先使用 `runTurnWithDebug()`。
- 需要查看模块生命周期时，读取各模块的 `getLifecycleTrace()`。
- 需要查看上一轮模块状态时，使用 `engine.getSnapshot(moduleId)`。
- 排查“为什么某模块没生效”时，优先检查：
  - `activationGate` 是否通过
  - `subconsciousAdjust` 是否写入了有效 directives
  - `fetchData` 是否真的返回了数据
  - `render` 是否返回空字符串
  - `shouldRunLLM()` 是否关闭

## 备注

当前 README 描述的是默认代码路径与默认引擎装配方式。若后续修改了：

- 模块依赖关系
- `shouldRunLLM()` 策略
- loop 重跑范围
- reflect 时序
- 状态目录解析逻辑

请同步更新本文档，避免设计文档与运行时再次脱节。
