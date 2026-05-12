import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function rebuildIndex() {
  const stateRoot = process.env.CDA_STATE_ROOT ?? process.cwd();
  const memoryRoot = path.join(stateRoot, 'state', 'memory', 'fragments');
  const indexPath = path.join(memoryRoot, 'memory.index.md');
  const layers = ['short_term', 'episodic', 'semantic'];
  
  const entries = [];

  for (const layer of layers) {
    const layerDir = path.join(memoryRoot, layer);
    let files = [];
    try {
      files = await readdir(layerDir);
    } catch {
      continue;
    }
    
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.join(layerDir, file);
      const tsMatch = file.match(/^(\d+)__/);
      const ts = tsMatch ? Number(tsMatch[1]) : 0;
      if (!ts) continue;
      
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      
      // 提取摘要：从 '## Assistant' 的下一行提取，或者回退到文件名
      const assistantIdx = lines.findIndex(l => l.startsWith('## Assistant'));
      let summary = file.replace(/^\d+__/, '').replace('.md', '');
      if (assistantIdx !== -1 && assistantIdx + 1 < lines.length) {
        summary = lines[assistantIdx + 1].slice(0, 100).replace(/\n/g, ' ');
      }
      
      entries.push({ ts, layer, path: filePath, summary });
    }
  }

  // 按照时间戳升序排序，保证最新的在后面
  entries.sort((a, b) => a.ts - b.ts);
  
  const indexLines = entries.map(e => `- [${String(e.ts)}] [${e.layer}] ${e.path} : ${e.summary}`);
  await writeFile(indexPath, indexLines.join('\n') + '\n', 'utf-8');
  console.log(`Index rebuilt with ${entries.length} entries.`);
}

rebuildIndex().catch(console.error);
