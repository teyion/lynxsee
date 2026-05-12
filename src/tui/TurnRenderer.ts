import { clearScreenDown, cursorTo, moveCursor } from 'node:readline';
import { stdout as output } from 'node:process';
import { TurnProgressEvent } from '../core/ContextEngine.js';
import { TokenUsage } from '../llm/usageTracker.js';

type ModuleStage = 'pending' | 'running' | 'done' | 'skipped';

interface ModuleViewState {
  moduleId: string;
  layer: number | '-';
  stage: ModuleStage;
  active: boolean | null;
}

function stageLabel(stage: ModuleStage): string {
  if (stage === 'pending') {
    return 'PENDING';
  }
  if (stage === 'running') {
    return 'RUNNING';
  }
  if (stage === 'done') {
    return 'DONE';
  }
  return 'SKIPPED';
}

function activeLabel(active: boolean | null): string {
  if (active === true) {
    return 'ACTIVE ';
  }
  if (active === false) {
    return 'INACTIVE';
  }
  return '-';
}

function charDisplayWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += charDisplayWidth(ch);
  }
  return width;
}

function fitDisplay(text: string, targetWidth: number): string {
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = charDisplayWidth(ch);
    if (width + w > targetWidth) {
      break;
    }
    out += ch;
    width += w;
  }
  if (width < targetWidth) {
    out += ' '.repeat(targetWidth - width);
  }
  return out;
}

function wrapDisplay(text: string, lineWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  const normalized = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [fitDisplay('', lineWidth)];
  }
  for (const ch of normalized) {
    const w = charDisplayWidth(ch);
    if (currentWidth + w > lineWidth) {
      lines.push(fitDisplay(current, lineWidth));
      current = '';
      currentWidth = 0;
    }
    current += ch;
    currentWidth += w;
  }
  lines.push(fitDisplay(current, lineWidth));
  return lines;
}

export class TurnRenderer {
  private moduleState = new Map<string, ModuleViewState>();
  private aiText = '';
  private renderedLineCount = 0;
  private lastEventText = '等待执行';
  private closed = false;
  private usage: TokenUsage = {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
  };
  private personaChangeCount = 0;
  private memoryFragmentChangeCount = 0;

  onProgress(event: TurnProgressEvent): void {
    if (this.closed) {
      return;
    }
    this.lastEventText = event.message;
    if (event.phase === 'module' && event.moduleId) {
      this.updateModuleState(event);
    }
    if (event.phase === 'llm' && event.llmChunk) {
      this.aiText += event.llmChunk;
    }
    if (event.phase === 'usage' && event.usageEvent?.normalized) {
      this.usage.inputTokens += event.usageEvent.normalized.inputTokens;
      this.usage.cachedTokens += event.usageEvent.normalized.cachedTokens;
      this.usage.outputTokens += event.usageEvent.normalized.outputTokens;
    }
    if (event.phase === 'reflect' && event.reflectCounters) {
      if (typeof event.reflectCounters.personaChanges === 'number') {
        this.personaChangeCount = Math.max(0, event.reflectCounters.personaChanges);
      }
      if (typeof event.reflectCounters.memoryFragmentChanges === 'number') {
        this.memoryFragmentChangeCount = Math.max(0, event.reflectCounters.memoryFragmentChanges);
      }
    }
    this.render();
  }

  finish(finalResponse: string, finalUsage?: TokenUsage): void {
    this.closed = true;
    if (!this.aiText.trim() && finalResponse.trim()) {
      this.aiText = finalResponse;
    }
    if (finalUsage) {
      this.usage = { ...finalUsage };
    }
    this.render();
    output.write('\n');
  }

  private updateModuleState(event: TurnProgressEvent): void {
    const moduleId = event.moduleId as string;
    const prev = this.moduleState.get(moduleId) ?? {
      moduleId,
      layer: typeof event.layer === 'number' ? event.layer : '-',
      stage: 'pending' as ModuleStage,
      active: null as boolean | null,
    };
    if (typeof event.layer === 'number') {
      prev.layer = event.layer;
    }

    if (event.message.startsWith('start ')) {
      prev.stage = 'running';
    }
    if (event.message.startsWith('done ')) {
      const active = /active=(true|false)/.exec(event.message)?.[1];
      prev.active = active === 'true';
      prev.stage = prev.active ? 'done' : 'skipped';
    }
    this.moduleState.set(moduleId, prev);
  }

  private render(): void {
    const lines = this.buildLines();
    if (this.renderedLineCount > 0) {
      moveCursor(output, 0, -this.renderedLineCount);
      cursorTo(output, 0);
      clearScreenDown(output);
    }
    output.write(`${lines.join('\n')}\n`);
    this.renderedLineCount = lines.length;
  }

  private buildLines(): string[] {
    const termCols = output.columns ?? 100;
    const totalWidth = Math.max(60, Math.min(120, termCols - 1));
    const innerWidth = totalWidth - 2;
    const lines: string[] = [];
    lines.push(`┌${this.ruleTitle('Module Status', innerWidth)}┐`);
    lines.push(this.row(this.formatColumns('Module', 'Layer', 'Stage', 'Active', innerWidth)));
    const states = [...this.moduleState.values()].sort((a, b) => {
      if (a.layer === '-' && b.layer !== '-') {
        return 1;
      }
      if (a.layer !== '-' && b.layer === '-') {
        return -1;
      }
      if (a.layer !== b.layer) {
        return Number(a.layer) - Number(b.layer);
      }
      return a.moduleId.localeCompare(b.moduleId);
    });
    if (states.length === 0) {
      lines.push(this.row(this.fitInner('(no module updates yet)', innerWidth)));
    } else {
      for (const s of states) {
        lines.push(
          this.row(
            this.formatColumns(
              s.moduleId,
              String(s.layer),
              stageLabel(s.stage),
              activeLabel(s.active),
              innerWidth
            )
          )
        );
      }
    }
    lines.push(`├${this.ruleTitle('Token Usage', innerWidth)}┤`);
    lines.push(
      this.row(
        this.fitInner(
          `input=${this.usage.inputTokens} cached=${this.usage.cachedTokens} output=${this.usage.outputTokens}`,
          innerWidth
        )
      )
    );
    lines.push(`├${this.ruleTitle('Reflect Changes', innerWidth)}┤`);
    lines.push(
      this.row(
        this.fitInner(
          `persona=${this.personaChangeCount} memoryFragments=${this.memoryFragmentChangeCount}`,
          innerWidth
        )
      )
    );
    lines.push(`├${this.ruleTitle('AI Stream', innerWidth)}┤`);
    for (const line of wrapDisplay(this.aiText || '(waiting chunk)', innerWidth)) {
      lines.push(this.row(line));
    }
    lines.push(`├${this.ruleTitle('Last Event', innerWidth)}┤`);
    for (const line of wrapDisplay(this.lastEventText, innerWidth)) {
      lines.push(this.row(line));
    }
    lines.push(`└${'─'.repeat(innerWidth)}┘`);
    return lines;
  }

  private fitInner(text: string, width: number): string {
    const target = Math.max(1, width);
    const plain = text.replace(/\s+/g, ' ').trim();
    if (displayWidth(plain) <= target) {
      return fitDisplay(plain, target);
    }
    return fitDisplay(plain, target);
  }

  private row(inner: string): string {
    return `│${inner}│`;
  }

  private ruleTitle(title: string, width: number): string {
    const text = `─ ${title} `;
    const w = Math.max(0, width - displayWidth(text));
    return `${text}${'─'.repeat(w)}`;
  }

  private formatColumns(
    col1: string,
    col2: string,
    col3: string,
    col4: string,
    innerWidth: number
  ): string {
    const c1 = fitDisplay(col1, 16);
    const c2 = fitDisplay(col2, 8);
    const c3 = fitDisplay(col3, 10);
    const c4 = fitDisplay(col4, 10);
    const base = `${c1}${c2}${c3}${c4}`;
    const target = Math.max(1, innerWidth);
    return fitDisplay(base, target);
  }
}
