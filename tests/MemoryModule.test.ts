import { describe, expect, it } from 'vitest';
import { MemoryModule } from '../src/modules/MemoryModule.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('MemoryModule', () => {
  it('should load memory fragments from markdown storage', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-module-'));
    process.env.CDA_STATE_ROOT = root;
    const dir = path.join(root, 'state', 'memory', 'fragments', 'semantic');
    await mkdir(dir, { recursive: true });
    const ts = Date.now();
    const file = path.join(dir, `${ts}__报表.md`);
    await writeFile(
      file,
      '# 报表偏好\n\n- source: user\n- keywords: 报表,偏好\n\n我喜欢简洁报表，重点看趋势变化。',
      'utf-8'
    );

    const mod = new MemoryModule();
    await mod.activationGate({
      userInput: '报表',
      currentState: mod.getState(),
      globalSnapshot: {
        conversationState: mod.getState(),
        conversationRender: 'User: 报表',
        moduleSnapshots: {},
      },
    });

    await mod.subconsciousAdjust({
      userInput: '报表',
      state: mod.getState(),
      pendingSuggestion: null,
    });

    const fetched = await mod.fetchData();
    await mod.update(
      '报表',
      {
        conversationState: mod.getState(),
        conversationRender: 'User: 报表',
        moduleSnapshots: {},
      },
      fetched
    );

    const rendered = await mod.render();
    expect(rendered).toContain('# Memory');
    expect(rendered).toContain('semantic');
  });

  it('should suggest older retrieval when user is dissatisfied', async () => {
    const mod = new MemoryModule();
    await mod.subconsciousReflect({
      userInput: '你这个回答不满意，不相关',
      response: '抱歉，我不确定',
      myPromptSegment: '',
    });
    const state = mod.getState() as any;
    expect(state.pendingSuggestion).toBeTruthy();
    expect(state.pendingSuggestion.adjustedFetchDirectives.seekOlderKeywords).toBeTruthy();
  });
});
