import { BaseModule } from './BaseModule.js';
import { FetchResult, GateContext, GlobalSnapshot, ModuleState, SubconsciousContext } from '../types/index.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs';
import { OpenAILLMClient } from '../llm/LLMClient.js';
import { getConfiguredActionDir, getConfiguredStateDir } from '../utils/runtimeStatePaths.js';
import { toStoredActionVideoPath } from '../utils/actionVideoPaths.js';

interface ActionItem {
  id: string;
  name: string;
  description: string;
  triggerCondition: string;
  videoPath: string;
  isIdle?: boolean;
  edgeSkipSeconds?: number;
}

interface ActionState extends ModuleState {
  currentAction: ActionItem | null;
  availableActions: ActionItem[];
  triggeredActionSummary: {
    id: string;
    name: string;
    description: string;
    triggerCondition: string;
  } | null;
}

export class ActionModule extends BaseModule {
  id = 'action';
  dependencies = ['memory'];
  private readonly stateDir = getConfiguredStateDir();
  private readonly actionDir = getConfiguredActionDir();
  private readonly actionsPath = path.join(this.actionDir, 'actions.json');
  private lifecycleTrace: string[] = [];

  constructor(sort = 18) {
    super(sort);
    this.directives = {
      ...this.directives,
      triggerEvaluation: true,
    };
  }

  protected override state: ActionState = {
    activeTopics: [],
    temporalFocus: 'latest',
    currentAction: null,
    availableActions: [],
    triggeredActionSummary: null,
  };

  async activationGate(ctx: GateContext): Promise<boolean> {
    return true;
  }

  async subconsciousAdjust(ctx: SubconsciousContext): Promise<void> {
    this.lifecycleTrace = [];
    this.state.currentAction = null;
    this.state.triggeredActionSummary = null;
    
    // Load available actions
    try {
      if (fs.existsSync(this.actionsPath)) {
        const raw = await readFile(this.actionsPath, 'utf-8');
        const allActions = JSON.parse(raw) as ActionItem[];
        this.state.availableActions = allActions
          .map((action) => ({
            ...action,
            videoPath: toStoredActionVideoPath(this.actionDir, action.videoPath, action.id),
          }))
          .filter((a) => !a.isIdle);
      }
    } catch (e) {
      this.state.availableActions = [];
    }

    if (this.state.availableActions.length === 0) {
      console.log('[ActionModule] no actions configured, skip evaluation');
      return;
    }

    // Evaluate trigger using a lightweight LLM call
    const actionListDesc = this.state.availableActions.map(a => 
      `- ID: ${a.id}\n  名称: ${a.name}\n  描述: ${a.description}\n  触发条件: ${a.triggerCondition}`
    ).join('\n\n');

    const prompt = `你是一个动作决策引擎。
当前用户输入: "${ctx.userInput}"
请根据用户的输入以及当前的对话氛围，判断是否触发以下动作库中的某个动作。

可用动作库:
${actionListDesc}

规则:
1. 只能选择一个动作，如果都不满足触发条件，则输出 null。
2. 必须严格按照触发条件进行判断。
3. 请以 JSON 格式输出，例如 {"matchedActionId": "xxx"} 或者 {"matchedActionId": null}。不要输出任何其他解释文本。
`;
    console.log('[ActionModule] evaluate start', {
      userInput: ctx.userInput,
      actionCount: this.state.availableActions.length,
      actionIds: this.state.availableActions.map((a) => a.id),
    });
    console.log('[ActionModule] prompt =>\n' + prompt);

    try {
      const llmClient = new OpenAILLMClient({
        baseURL: process.env.LLM_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/beta',
        model: process.env.LLM_MODEL ?? 'deepseek-v4-flash',
        apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY,
      });
      const response = await llmClient.generate(prompt, { temperature: 0.1 });
      console.log('[ActionModule] llm raw response =>', response.text);
      const jsonStr = response.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}';
      console.log('[ActionModule] extracted json =>', jsonStr);
      const parsed = JSON.parse(jsonStr);
      console.log('[ActionModule] parsed =>', parsed);
      if (parsed.matchedActionId) {
        const matched = this.state.availableActions.find(a => a.id === parsed.matchedActionId);
        if (matched) {
          this.state.currentAction = matched;
          this.state.triggeredActionSummary = {
            id: matched.id,
            name: matched.name,
            description: matched.description,
            triggerCondition: matched.triggerCondition,
          };
          this.trace(`Action triggered: ${matched.name} (${matched.id})`);
          console.log('[ActionModule] matched action =>', {
            id: matched.id,
            name: matched.name,
            triggerCondition: matched.triggerCondition,
            videoPath: matched.videoPath,
          });
        }
      } else {
        console.log('[ActionModule] no matched action');
      }
    } catch (e) {
      this.trace(`Error evaluating action trigger: ${e}`);
      console.error('[ActionModule] evaluate error =>', e);
    }
  }

  async fetchData(): Promise<FetchResult[]> {
    return [];
  }

  async update(userInput: string, snapshot: GlobalSnapshot, freshData: FetchResult[]): Promise<void> {
    // nothing to persist
  }

  async render(): Promise<string> {
    if (!this.state.triggeredActionSummary) {
      return '';
    }
    const action = this.state.triggeredActionSummary;
    return [
      '# Triggered Action',
      '本轮已触发一个动作，并且该动作已经进入执行链路。',
      '你必须知道这个动作已经发生或正在发生，不要在回复里否认、忽略或假装自己没有做这个动作。',
      '请让文字回复与该动作的情绪、语气、身体表现保持一致，但不要机械重复动作名。',
      `- 动作ID: ${action.id}`,
      `- 动作名称: ${action.name}`,
      `- 动作描述: ${action.description}`,
      `- 触发原因: ${action.triggerCondition}`,
    ].join('\n');
  }

  getLifecycleTrace(): string[] {
    return [...this.lifecycleTrace];
  }

  private trace(message: string): void {
    this.lifecycleTrace.push(message);
  }
}
