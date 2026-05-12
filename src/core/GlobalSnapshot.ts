import { ContextModule } from './ContextModule.js';
import { GlobalSnapshot, ModuleState } from '../types/index.js';

export interface SnapshotEntry {
  state: ModuleState;
  render: string;
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function buildGlobalSnapshot(
  conversationModule: ContextModule,
  conversationRender: string,
  lastSnapshots: Map<string, SnapshotEntry>
): GlobalSnapshot {
  const moduleSnapshots: GlobalSnapshot['moduleSnapshots'] = {};

  for (const [moduleId, snapshot] of lastSnapshots.entries()) {
    if (moduleId === 'conversation') {
      continue;
    }
    moduleSnapshots[moduleId] = {
      state: cloneState(snapshot.state),
      lastRender: snapshot.render,
    };
  }

  return {
    conversationState: cloneState(conversationModule.getState()),
    conversationRender,
    moduleSnapshots,
  };
}
