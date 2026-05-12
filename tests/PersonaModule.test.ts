import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonaModule } from '../src/modules/PersonaModule.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('PersonaModule', () => {
  let tempRoot = '';

  async function makeModule(): Promise<PersonaModule> {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'cda-persona-test-'));
    process.env.CDA_STATE_ROOT = tempRoot;
    return new PersonaModule();
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CDA_STATE_ROOT;
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('should reflect persona updates and apply them in subconsciousAdjust', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reason: '用户希望更简洁和更友好',
                confidence: 0.8,
                updates: {
                  tone_style: {
                    constraint: '保持温和、友好、专业，不使用命令口吻。',
                    fewshot: ['可以先确认需求，再给两步执行方案。'],
                  },
                  answer_structure: {
                    constraint: '12345', // should be filtered out by natural-language validator
                    fewshot: ['67890'],
                  },
                },
              }),
            },
          },
        ],
      }),
    } as unknown as Response);

    const mod = await makeModule();
    const before = await mod.render();
    expect(before).toContain('tone_style');

    await mod.subconsciousReflect({
      userInput: '回答请简洁一点，也更友好',
      response: '好的，我会尽量简洁。',
      myPromptSegment: before,
    });

    const pending = mod.getState().pendingSuggestion;
    expect(pending).not.toBeNull();
    expect(
      pending?.adjustedFetchDirectives?.personaAttributeUpdates?.tone_style?.constraint
    ).toContain('友好');

    await mod.subconsciousAdjust({
      userInput: '请保持更友好的语气继续回答',
      state: mod.getState(),
      pendingSuggestion: pending ?? null,
    });
    const freshData = await mod.fetchData();
    await mod.update(
      '继续',
      {
        conversationState: mod.getState(),
        conversationRender: '',
        moduleSnapshots: {},
      },
      freshData
    );

    const after = await mod.render();
    expect(after).toContain('保持温和、友好、专业');
    // invalid numeric-only update should not overwrite answer_structure
    expect(after).toContain('先给结论，再给关键变更与验证结果');
  });

  it('should use llm-generated tone update through directives and fetch/update flow', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                updates: {
                  tone_style: {
                    constraint: '语气轻快但不轻佻，保持积极、友好、专业。',
                    fewshot: ['可以，我来带你一步步完成这个改动。'],
                  },
                },
              }),
            },
          },
        ],
      }),
    } as unknown as Response);

    const mod = await makeModule();
    await mod.subconsciousAdjust({
      userInput: '请更活泼一点',
      state: mod.getState(),
      pendingSuggestion: null,
    });
    const freshData = await mod.fetchData();
    await mod.update(
      '请更活泼一点',
      {
        conversationState: mod.getState(),
        conversationRender: '',
        moduleSnapshots: {},
      },
      freshData
    );

    const rendered = await mod.render();
    expect(rendered).toContain('语气轻快但不轻佻');
  });

  it('should update personaBase when user asks to rename persona', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key';

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                personaBase: '你叫柳晴，是一个谦虚好学、认真负责的实习生助手。',
                updates: {
                  identity_scope: {
                    constraint: '始终以谦虚好学的实习生身份回答，听从前辈指导并主动落实任务。',
                    fewshot: ['前辈您好，我是柳晴，我先按理解做一版，再请您帮我review。'],
                  },
                },
              }),
            },
          },
        ],
      }),
    } as unknown as Response);

    const mod = await makeModule();
    await mod.subconsciousAdjust({
      userInput: '我给你起名叫柳晴，记住你的实习生身份',
      state: mod.getState(),
      pendingSuggestion: null,
    });
    const freshData = await mod.fetchData();
    await mod.update(
      '我给你起名叫柳晴，记住你的实习生身份',
      {
        conversationState: mod.getState(),
        conversationRender: '',
        moduleSnapshots: {},
      },
      freshData
    );

    const rendered = await mod.render();
    expect(rendered).toContain('你叫柳晴');
    expect(rendered).toContain('实习生身份');
  });
});
