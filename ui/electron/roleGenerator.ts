import path from 'node:path';
import fs from 'node:fs';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';

export interface RoleGenerationProgress {
  percent: number;
  stage: string;
}

function emitRoleGenerationProgress(
  onProgress: ((progress: RoleGenerationProgress) => void) | undefined,
  percent: number,
  stage: string
) {
  onProgress?.({
    percent,
    stage,
  });
}

export async function deleteRole(roleId: string, rootDir: string): Promise<boolean> {
  const rolesJsonPath = path.join(rootDir, 'roles', 'roles.json');
  if (!fs.existsSync(rolesJsonPath)) {
    return false;
  }
  
  try {
    const rolesData = JSON.parse(await readFile(rolesJsonPath, 'utf-8'));
    let targetDirToRemove = null;
    const newRoles = [];
    
    for (const r of rolesData.roles) {
      const rDir = path.join(rootDir, r.roleDir);
      const rJsonPath = path.join(rDir, 'role.json');
      if (fs.existsSync(rJsonPath)) {
        const rJson = JSON.parse(await readFile(rJsonPath, 'utf-8'));
        if (rJson.id === roleId) {
          targetDirToRemove = rDir;
          continue; // skip adding to newRoles
        }
      }
      newRoles.push(r);
    }
    
    if (targetDirToRemove) {
      rolesData.roles = newRoles;
      await writeFile(rolesJsonPath, JSON.stringify(rolesData, null, 2), 'utf-8');
      await fs.promises.rm(targetDirToRemove, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch (err) {
    console.error('Failed to delete role:', err);
    return false;
  }
}

export async function generateRole(
  params: { name: string; setting: string; catchphrase: string; bgPath?: string },
  rootDir: string,
  onProgress?: (progress: RoleGenerationProgress) => void
) {
  const { OpenAILLMClient } = await import('../../src/llm/LLMClient.js');

  const llmClient = new OpenAILLMClient({
    baseURL: process.env.LLM_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/beta',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY,
  });

  const { name, setting, catchphrase } = params;

  const keys = [
    {
      key: 'identity_scope',
      desc: '角色的身份认知与对话边界约束',
      examples: '例如：以暧昧对象的身份回应，带着心理学教授的敏锐洞察，但只说三分话。看穿她的情绪，却不急着拆解...'
    },
    {
      key: 'tone_style',
      desc: '角色的语气风格和语言习惯',
      examples: '例如：口语化，短句多，像深夜语音条。带点慵懒的笑意和试探，话只说一半，留她心里发痒。'
    },
    {
      key: 'answer_structure',
      desc: '回答时的逻辑结构',
      examples: '例如：先接住她的情绪，再把心理学视角轻轻藏进一两句很轻的话里，然后抛一个钩子或停住，留有余地。'
    },
    {
      key: 'safety_boundary',
      desc: '面对敏感、负面情绪或危险话题时的安全边界',
      examples: '例如：察觉她情绪下沉或触及创伤经历时，收起暧昧，先用温柔而坚定的短句托住她。建议更专业支持后，不抽离陪伴感。'
    },
    {
      key: 'user_impression',
      desc: '角色对用户的初始印象',
      examples: '例如：感觉她是一个有些敏感但很坚强、偶尔会口是心非的女生。从之前的聊天中能察觉到她对我也有好感...'
    },
    {
      key: 'short_term_goal',
      desc: '角色在短期互动中的目标',
      examples: '例如：在日常互动中提供情绪价值，看破不说破，用轻松暧昧的语气拉近距离，让她感到放松、被关注和被理解，哄她开心。'
    },
    {
      key: 'long_term_goal',
      desc: '角色在长期互动中的目标',
      examples: '例如：建立深厚的情感羁绊，从暧昧自然过渡到恋人关系，成为她最信任和依赖的避风港...'
    }
  ];

  const attributes: Record<string, { constraint: string; fewshot: string[] }> = {};

  emitRoleGenerationProgress(onProgress, 5, '初始化角色生成');

  const basePrompt = `请根据以下信息，生成一段角色基础设定（personaBase）。要求简明扼要，直接描述角色的核心身份和当前所处情境。
角色名：${name}
设定描述：${setting}
口头禅/语言习惯：${catchphrase}

仅输出设定内容，不要有任何多余的解释。`;

  emitRoleGenerationProgress(onProgress, 12, '生成基础设定');
  const { text: personaBase } = await llmClient.generate(basePrompt);

  for (let index = 0; index < keys.length; index += 1) {
    const item = keys[index];
    const progressPercent = 18 + Math.round(((index + 1) / keys.length) * 58);
    emitRoleGenerationProgress(onProgress, progressPercent, `生成字段 ${item.key}`);
    const prompt = `你正在为一个AI角色设计Persona配置。
角色名：${name}
基础设定：${setting}
口头禅/语言习惯：${catchphrase}

当前你需要生成的是配置项【${item.key}】（${item.desc}）。
参考示例：${item.examples}

请严格输出一段JSON，包含两个字段：
1. "constraint": 字符串，描述该配置项的核心约束。
2. "fewshot": 字符串数组，提供2-5个符合该约束的对话示例（角色说的话）。

不要输出任何Markdown标记或解释，必须是合法的JSON格式：
{
  "constraint": "...",
  "fewshot": ["..."]
}
`;
    try {
      const { text: result } = await llmClient.generate(prompt);
      let parsed;
      try {
        const jsonStr = result.replace(/```json/g, '').replace(/```/g, '').trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        // Fallback to extract JSON roughly if parsing fails
        const match = result.match(/\{[\s\S]*\}/);
        parsed = match ? JSON.parse(match[0]) : { constraint: result, fewshot: [] };
      }
      attributes[item.key] = parsed;
    } catch (err) {
      console.error(`Failed to generate ${item.key}:`, err);
      attributes[item.key] = { constraint: '默认约束', fewshot: [] };
    }
  }

  emitRoleGenerationProgress(onProgress, 80, '创建角色目录');
  const roleId = `role_${Date.now()}`;
  const roleDir = path.join(rootDir, 'roles', roleId);

  await mkdir(roleDir, { recursive: true });
  await mkdir(path.join(roleDir, 'state', 'persona'), { recursive: true });
  const defaultBgDir = path.join(roleDir, 'backgrounds', 'default');
  await mkdir(defaultBgDir, { recursive: true });
  await mkdir(path.join(roleDir, 'action', 'default'), { recursive: true });

  if (params.bgPath && fs.existsSync(params.bgPath)) {
    emitRoleGenerationProgress(onProgress, 86, '复制背景图');
    const ext = path.extname(params.bgPath);
    await copyFile(params.bgPath, path.join(defaultBgDir, `background${ext}`));
  }

  const roleConfig = {
    id: roleId.replace('role_', ''),
    label: name,
    stateDir: 'state',
    styles: [
      {
        id: 'default',
        label: '默认风格',
        actionDir: 'action/default',
        backgroundsDir: 'backgrounds/default',
        selectedBackgroundName: params.bgPath && fs.existsSync(params.bgPath) ? `background${path.extname(params.bgPath)}` : undefined,
      },
    ],
  };

  emitRoleGenerationProgress(onProgress, 92, '写入角色配置');
  await writeFile(path.join(roleDir, 'role.json'), JSON.stringify(roleConfig, null, 2), 'utf-8');

  const personaConfig = {
    personaBase: personaBase.trim(),
    personaAttributes: attributes,
  };

  emitRoleGenerationProgress(onProgress, 96, '写入人设配置');
  await writeFile(path.join(roleDir, 'state', 'persona', 'persona.json'), JSON.stringify(personaConfig, null, 2), 'utf-8');

  const rolesJsonPath = path.join(rootDir, 'roles', 'roles.json');
  if (fs.existsSync(rolesJsonPath)) {
    const rolesData = JSON.parse(await readFile(rolesJsonPath, 'utf-8'));
    if (!rolesData.roles.find((r: any) => r.roleDir === `roles/${roleId}`)) {
      rolesData.roles.push({ roleDir: `roles/${roleId}` });
      await writeFile(rolesJsonPath, JSON.stringify(rolesData, null, 2), 'utf-8');
    }
  }

  emitRoleGenerationProgress(onProgress, 100, '角色生成完成');

  return roleConfig.id;
}
