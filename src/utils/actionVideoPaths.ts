import fs from 'node:fs';
import path from 'node:path';

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function getPreferredVideoPath(actionDir: string, actionId?: string): string {
  const normalizedId = String(actionId ?? '').trim();
  if (!normalizedId) {
    return '';
  }
  return path.join(actionDir, 'videos', `${normalizedId}.mp4`);
}

export function resolveActionVideoPath(actionDir: string, videoPath: string, actionId?: string): string {
  const rawVideoPath = String(videoPath ?? '').trim();
  const preferredVideoPath = getPreferredVideoPath(actionDir, actionId);

  if (preferredVideoPath && fs.existsSync(preferredVideoPath)) {
    if (!rawVideoPath || path.isAbsolute(rawVideoPath)) {
      return preferredVideoPath;
    }
    const resolvedPreferredRelative = path.resolve(actionDir, rawVideoPath);
    if (!fs.existsSync(resolvedPreferredRelative)) {
      return preferredVideoPath;
    }
  }

  if (!rawVideoPath) {
    return preferredVideoPath;
  }

  if (path.isAbsolute(rawVideoPath)) {
    return path.normalize(rawVideoPath);
  }

  return path.resolve(actionDir, rawVideoPath);
}

export function toStoredActionVideoPath(actionDir: string, videoPath: string, actionId?: string): string {
  const preferredVideoPath = getPreferredVideoPath(actionDir, actionId);
  if (preferredVideoPath && fs.existsSync(preferredVideoPath)) {
    return toPosixPath(path.join('videos', path.basename(preferredVideoPath)));
  }

  const resolvedVideoPath = resolveActionVideoPath(actionDir, videoPath, actionId);
  if (!resolvedVideoPath) {
    return '';
  }

  const relativePath = path.relative(actionDir, resolvedVideoPath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return toPosixPath(relativePath);
  }

  return toPosixPath(path.basename(resolvedVideoPath));
}
