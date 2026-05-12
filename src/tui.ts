import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createDefaultEngine } from './createDefaultEngine.js';
import { ModuleDebugInfo, TurnProgressEvent } from './core/ContextEngine.js';
import { UsageEvent } from './llm/usageTracker.js';
import { TurnRenderer } from './tui/TurnRenderer.js';

const EXIT_COMMANDS = new Set(['exit', 'quit', '/exit', '/quit']);
const DEBUG_MODE = process.argv.includes('--debug') || process.env.TUI_DEBUG === '1';

function parseDebugModuleFilter(): Set<string> | null {
  const arg = process.argv.find(
    (item) => item.startsWith('--debug-modules=') || item.startsWith('--modules=')
  );
  const argValue = arg ? arg.split('=')[1] : '';
  const envValue = process.env.TUI_DEBUG_MODULES ?? '';
  const raw = (argValue || envValue).trim();
  if (!raw) {
    return null;
  }

  const modules = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return modules.length > 0 ? new Set(modules) : null;
}

const DEBUG_MODULE_FILTER = parseDebugModuleFilter();

function printModuleDebug(info: ModuleDebugInfo): void {
  console.log(`\n[DEBUG][模块] ${info.moduleId} (active=${info.active})`);
  console.log('[DEBUG][directives]');
  console.log(JSON.stringify(info.directives, null, 2));
  console.log('[DEBUG][render]');
  console.log(info.render || '(empty)');
  if (info.lifecycleTrace.length > 0) {
    console.log('[DEBUG][lifecycle]');
    for (const line of info.lifecycleTrace) {
      console.log(`- ${line}`);
    }
  }
}

function printUsageLine(usage: {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}): void {
  console.log(
    `[TokenUsage] input=${usage.inputTokens} cached=${usage.cachedTokens} output=${usage.outputTokens}`
  );
}

function printRawUsageEvents(events: UsageEvent[]): void {
  if (events.length === 0) {
    console.log('[TokenUsageRaw] (no usage events)');
    return;
  }
  console.log('[TokenUsageRaw]');
  for (const event of events) {
    const raw = event.rawUsage ?? {};
    console.log(
      `- source=${event.source} raw=${JSON.stringify(raw)} normalized=${JSON.stringify(event.normalized)}`
    );
  }
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(11, 23);
}

function printProgressEvent(event: TurnProgressEvent): void {
  const ts = formatClock(event.at);
  if (event.phase === 'usage') {
    const raw = event.usageEvent?.rawUsage ?? {};
    const source = event.usageEvent?.source ?? 'unknown';
    const normalized = event.usageEvent?.normalized ?? {
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    };
    console.log(
      `[DEBUG][progress][${ts}] usage source=${source} raw=${JSON.stringify(raw)} normalized=${JSON.stringify(normalized)}`
    );
    return;
  }
  const moduleText = event.moduleId ? ` module=${event.moduleId}` : '';
  const layerText = typeof event.layer === 'number' ? ` layer=${event.layer}` : '';
  console.log(`[DEBUG][progress][${ts}] ${event.phase}${layerText}${moduleText} ${event.message}`);
}

async function main(): Promise<void> {
  const engine = createDefaultEngine();
  const rl = readline.createInterface({ input, output });
  const filterText = DEBUG_MODULE_FILTER ? ` 模块过滤: ${[...DEBUG_MODULE_FILTER].join(',')}` : '';

  console.log(
    `LynxSee TUI 已启动。输入 exit 或 quit 退出。${DEBUG_MODE ? ` 当前为 DEBUG 模式。${filterText}` : ''}`
  );

  try {
    while (true) {
      const userInput = (await rl.question('你> ')).trim();
      if (!userInput) {
        continue;
      }

      if (EXIT_COMMANDS.has(userInput.toLowerCase())) {
        console.log('已退出对话。');
        break;
      }

      try {
        if (DEBUG_MODE) {
          const result = await engine.runTurnWithDebug(userInput, printProgressEvent);
          for (const moduleInfo of result.debug?.modules ?? []) {
            if (
              DEBUG_MODULE_FILTER &&
              !DEBUG_MODULE_FILTER.has(moduleInfo.moduleId.toLowerCase())
            ) {
              continue;
            }
            printModuleDebug(moduleInfo);
          }
          console.log('\n[DEBUG][LLM Prompt]');
          console.log(result.debug?.prompt ?? '');
          printUsageLine(result.usage);
          printRawUsageEvents(result.usageEvents ?? []);
          console.log(`\nAI> ${result.response}\n`);
        } else {
          const renderer = new TurnRenderer();
          let alive = true;
          const result = await engine.runTurnWithUsage(userInput, (event) => {
            if (!alive) {
              return;
            }
            renderer.onProgress(event);
          });
          alive = false;
          renderer.finish(result.response, result.usage);
          console.log('');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`请求失败: ${message}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`启动失败: ${message}`);
  process.exit(1);
});
