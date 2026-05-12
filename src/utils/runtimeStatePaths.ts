import path from 'node:path';

export function getConfiguredStateRoot(): string {
  return process.env.CDA_STATE_ROOT?.trim() || process.cwd();
}

export function getConfiguredStateDir(): string {
  return process.env.CDA_STATE_DIR?.trim() || path.join(getConfiguredStateRoot(), 'state');
}

export function getConfiguredActionDir(): string {
  return process.env.CDA_ACTION_DIR?.trim() || path.join(getConfiguredStateDir(), 'action');
}
