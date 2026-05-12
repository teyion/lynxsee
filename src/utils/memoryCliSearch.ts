import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);

function parseTimestampFromFile(filePath: string): number | null {
  const base = path.basename(filePath);
  const hit = base.match(/^(\d{13})__/);
  if (!hit) {
    return null;
  }
  const ts = Number(hit[1]);
  return Number.isFinite(ts) ? ts : null;
}

export function inferMemoryLayer(filePath: string): string {
  const parts = filePath.split(path.sep);
  const idx = parts.lastIndexOf('fragments');
  if (idx >= 0 && parts[idx + 1]) {
    return parts[idx + 1];
  }
  return 'unknown';
}

export interface MemoryCandidate {
  filePath: string;
  timestamp: number;
  layer: string;
}

export async function searchMemoryFilesByKeyword(
  rootDir: string,
  keyword: string,
  beforeTs: number,
  headLimit = 30
): Promise<MemoryCandidate[]> {
  if (!keyword.trim()) {
    return [];
  }

  let stdout = '';
  try {
    const res = await execFileAsync('grep', [
      '-R',
      '-l',
      '-i',
      '--include=*.md',
      '--',
      keyword,
      rootDir,
    ]);
    stdout = res.stdout ?? '';
  } catch (error: any) {
    // grep exit code 1 means no matches.
    if (typeof error?.code === 'number' && error.code === 1) {
      stdout = error.stdout ?? '';
    } else {
      throw error;
    }
  }

  const files = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const candidates: MemoryCandidate[] = [];
  for (const filePath of files) {
    const timestamp = parseTimestampFromFile(filePath);
    if (timestamp === null || timestamp > beforeTs) {
      continue;
    }
    candidates.push({
      filePath,
      timestamp,
      layer: inferMemoryLayer(filePath),
    });
  }

  return candidates.sort((a, b) => b.timestamp - a.timestamp).slice(0, Math.max(1, headLimit));
}
