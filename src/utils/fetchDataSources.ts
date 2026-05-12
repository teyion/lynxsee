import { DataBinding, FetchResult } from '../types/index.js';

export async function fetchDataSources(
  bindings: DataBinding[],
  directives: Record<string, any> = {}
): Promise<FetchResult[]> {
  return bindings.map((binding, idx) => ({
    bindingIndex: idx,
    data: {
      bindingType: binding.type,
      locator: binding.locator,
      mergedDirectives: {
        ...binding.fetchDirectives,
        ...directives,
      },
      fetchedAt: Date.now(),
    },
  }));
}
