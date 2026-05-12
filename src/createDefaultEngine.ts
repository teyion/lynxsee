import 'dotenv/config';
import { ContextEngine } from './core/ContextEngine.js';
import { OpenAILLMClient } from './llm/LLMClient.js';
import { ConversationModule } from './modules/ConversationModule.js';
import { MemoryModule } from './modules/MemoryModule.js';
import { PersonaModule } from './modules/PersonaModule.js';
import { TaskModule } from './modules/TaskModule.js';
import { ToolRegistryModule } from './modules/ToolRegistryModule.js';
import { ToolsModule } from './modules/ToolsModule.js';
import { LoopInterceptorModule } from './modules/LoopInterceptorModule.js';

import { ActionModule } from './modules/ActionModule.js';

export function createDefaultEngine(): ContextEngine {
  const llmProvider = process.env.LLM_PROVIDER ?? 'deepseek';
  const llmBaseURL = process.env.LLM_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/beta';
  const llmApiKey = process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  const llmModel = process.env.LLM_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
  const engine = new ContextEngine(
    new OpenAILLMClient({
      baseURL: llmProvider === 'deepseek' ? llmBaseURL : 'https://api.deepseek.com/beta',
      model: llmModel,
      apiKey: llmApiKey,
    })
  );

    engine.registerModule(new MemoryModule(15));
    engine.registerModule(new ActionModule(1));
    engine.registerModule(new ConversationModule(20));
    engine.registerModule(new PersonaModule(0));
    engine.registerModule(new ToolRegistryModule(5));
    engine.registerModule(new TaskModule(10));
    engine.registerModule(new ToolsModule(15));
    engine.registerModule(new LoopInterceptorModule(16));

  return engine;
}
