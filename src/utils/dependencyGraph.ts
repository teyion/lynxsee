import { ContextModule } from '../core/ContextModule.js';

export function buildDependencyLayers(modules: Map<string, ContextModule>): Map<string, number> {
  const indegree = new Map<string, number>();
  const layer = new Map<string, number>();
  const edges = new Map<string, string[]>();

  for (const [id] of modules) {
    indegree.set(id, 0);
    edges.set(id, []);
    layer.set(id, 0);
  }

  for (const [id, mod] of modules) {
    for (const dep of mod.dependencies) {
      if (!modules.has(dep)) {
        throw new Error(`Module ${id} depends on missing module ${dep}`);
      }
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      edges.get(dep)!.push(id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;

    for (const next of edges.get(current) ?? []) {
      const nextLayer = Math.max(layer.get(next) ?? 0, (layer.get(current) ?? 0) + 1);
      layer.set(next, nextLayer);

      const nextDeg = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, nextDeg);
      if (nextDeg === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== modules.size) {
    throw new Error('Dependency graph contains cycle(s)');
  }

  return layer;
}
