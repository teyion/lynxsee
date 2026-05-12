import { describe, expect, it } from 'vitest';
import { ConversationModule } from '../src/modules/ConversationModule.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('ConversationModule', () => {
  it('should render latest user message and persist jsonl by session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'conversation-module-'));
    const prevRoot = process.env.CDA_STATE_ROOT;
    process.env.CDA_STATE_ROOT = root;
    try {
      const mod = new ConversationModule();
      const directives = mod.getDirectives() as Record<string, any>;
      directives.historyMessageCount = 2;

      await mod.subconsciousAdjust({
        userInput: '你好',
        state: mod.getState(),
        pendingSuggestion: null,
      });

      await mod.update('你好', {
        conversationState: mod.getState(),
        conversationRender: '',
        moduleSnapshots: {},
      }, await mod.fetchData());

      await mod.subconsciousReflect({
        userInput: '你好',
        response: '你好，我在。',
        myPromptSegment: 'User: 你好',
      });

      const out = await mod.render();
      expect(out).toContain('User: 你好');
      const raw = await readFile(String(directives.sessionFilePath), 'utf-8');
      expect(raw).toContain('"role":"user"');
      expect(raw).toContain('"role":"assistant"');
    } finally {
      process.env.CDA_STATE_ROOT = prevRoot;
    }
  });
});
