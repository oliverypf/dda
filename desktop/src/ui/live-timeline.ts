import type { TimelineItem } from '../domain/models';
import {
  groupConversationTimelineEntries,
  sameTimelineRenderEntry,
  type TimelineRenderEntry
} from '../domain/tool-command';
import { renderMarkdown } from './markdown';
import { preserveDisclosureStates, syncRegionContent } from './keyed-list';

// Keep completed rows untouched; append large bursts over several frames.
const activeContainerTimeline = new WeakMap<HTMLElement, LiveTimeline>();

export class LiveTimeline {
  private rows = new Map<string, { element: HTMLElement; entry: TimelineRenderEntry; paintedAt: number }>();
  private items: TimelineItem[] = [];
  private frame: number | undefined;
  private streamTimer: number | undefined;

  constructor(
    private container: HTMLElement,
    private html: (entry: TimelineRenderEntry) => string,
    private initialize: (element: HTMLElement) => void,
    private afterPaint: () => void,
    private isLiveActive: () => boolean = () => false,
    private labelForTool?: (toolName: string) => string
  ) {
    const previous = activeContainerTimeline.get(container);
    if (previous && previous !== this) previous.pause();
    activeContainerTimeline.set(container, this);
    // Session switches reuse the live workbench container; clear any DOM nodes
    // left by the previous session before mounting this session's items.
    container.replaceChildren();
  }

  update(items: TimelineItem[]): void {
    this.items = items;
    this.flush();
  }

  pause(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (this.streamTimer !== undefined) window.clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
  }

  clear(): void {
    this.pause();
    this.items = [];
    this.rows.clear();
    if (activeContainerTimeline.get(this.container) === this) {
      this.container.replaceChildren();
      activeContainerTimeline.delete(this.container);
    }
  }

  hasRows(): boolean {
    return this.rows.size > 0;
  }

  isMountedIn(container: HTMLElement): boolean {
    return this.container === container;
  }

  /**
   * Detach the painted rows from the visible transcript without destroying
   * them. A later retarget puts the same nodes back, so switching tasks does
   * not parse Markdown again.
   */
  park(): void {
    this.pause();
    const holder = document.createElement('div');
    while (this.container.firstChild) holder.appendChild(this.container.firstChild);
    if (activeContainerTimeline.get(this.container) === this) activeContainerTimeline.delete(this.container);
    this.container = holder;
    activeContainerTimeline.set(holder, this);
  }

  retarget(container: HTMLElement): void {
    this.pause();
    const previous = activeContainerTimeline.get(container);
    if (previous && previous !== this) previous.pause();
    const holder = this.container;
    if (holder === container) return;
    if (activeContainerTimeline.get(holder) === this) activeContainerTimeline.delete(holder);
    this.container = container;
    activeContainerTimeline.set(container, this);
    container.replaceChildren();
    while (holder.firstChild) container.appendChild(holder.firstChild);
  }

  private flush(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (!this.container.isConnected || activeContainerTimeline.get(this.container) !== this) return;
    const entries = groupConversationTimelineEntries(this.items, {
      liveTaskActive: this.isLiveActive(),
      labelForTool: this.labelForTool
    });
    const wanted = new Set(entries.map((entry) => entry.key));
    for (const [id, row] of this.rows) {
      if (!wanted.has(id)) { row.element.remove(); this.rows.delete(id); }
    }
    const started = performance.now();
    let changed = 0;
    let position = this.container.firstElementChild;
    for (const entry of entries) {
      let row = this.rows.get(entry.key);
      if (!row || !sameTimelineRenderEntry(row.entry, entry)) {
        // Coalesce token bursts without postponing the final paint. Reuse
        // Markdown blocks so tables keep their horizontal scroll position.
        if (row && row.entry.kind === 'item' && entry.kind === 'item'
          && row.entry.item.kind === 'AGENT' && entry.item.kind === 'AGENT'
          && row.entry.item.status === 'STREAMING' && entry.item.status === 'STREAMING'
          && row.entry.item.body !== entry.item.body) {
          const remaining = (entry.item.body.length > 32_000 ? 250 : 100) - (performance.now() - row.paintedAt);
          if (remaining > 0) {
            if (this.streamTimer === undefined) this.streamTimer = window.setTimeout(() => {
              this.streamTimer = undefined;
              this.flush();
            }, remaining);
            break;
          }
        }
        // Opening the audit list should settle in a handful of frames even
        // for a long run.  Streaming text still uses the lightweight patch
        // path below, so a larger mount batch does not rebuild the app shell.
        if (changed >= 32 || (changed > 0 && performance.now() - started >= 5)) {
          this.frame = requestAnimationFrame(() => this.flush());
          break;
        }
        if (row && row.entry.kind === 'item' && entry.kind === 'item' && this.patchStream(row.element, row.entry.item, entry.item)) {
          row.entry = entry;
          row.paintedAt = performance.now();
        } else {
          const previousCount = row
            ? (row.entry.kind === 'tool-group' ? row.entry.items.length : 1)
            : 0;
          const previousScrollTop = row?.element.querySelector<HTMLElement>('.timeline-tool-group-list')?.scrollTop;
          const template = document.createElement('template');
          template.innerHTML = this.html(entry);
          const element = template.content.firstElementChild as HTMLElement;
          this.initialize(element);
          if (row) {
            preserveDisclosureStates(row.element, element);
            if (position === row.element) position = element;
            row.element.replaceWith(element);
          }
          if (entry.kind === 'tool-group') {
            const list = element.querySelector<HTMLElement>('.timeline-tool-group-list');
            const details = element.querySelector<HTMLDetailsElement>('.timeline-tool-group-details');
            if (list && details?.open) {
              if (entry.items.length > previousCount) {
                requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
              } else if (previousScrollTop !== undefined) {
                list.scrollTop = previousScrollTop;
              }
            }
          }
          row = { element, entry, paintedAt: performance.now() };
          this.rows.set(entry.key, row);
        }
        changed++;
      }
      if (position !== row.element) this.container.insertBefore(row.element, position);
      position = row.element.nextElementSibling;
    }
    if (changed) this.afterPaint();
  }

  private patchStream(element: HTMLElement, previous: TimelineItem, next: TimelineItem): boolean {
    if (previous.kind !== 'AGENT' || next.kind !== 'AGENT'
      || Boolean(previous.thinking) !== Boolean(next.thinking)
      || Object.keys({ ...previous, ...next }).some((key) =>
        key !== 'body' && key !== 'status' && key !== 'thinkingCompletedAtMs' && key !== 'thinkingLabel'
        && previous[key as keyof TimelineItem] !== next[key as keyof TimelineItem])) return false;
    if (next.thinking) {
      const details = element.querySelector<HTMLDetailsElement>('.timeline-thinking-details');
      const body = element.querySelector<HTMLElement>('.timeline-thinking-body');
      const summaryLabel = element.querySelector<HTMLElement>('.timeline-thinking-label');
      if (!details || !body || !summaryLabel) return false;
      if (next.body !== previous.body) {
        body.classList.add('markdown-body');
        syncRegionContent(body, renderMarkdown(next.body), () => {});
      }
      element.dataset.status = next.status;
      if (previous.status !== next.status) {
        const baseLabel = next.thinkingLabel || '思考过程';
        if (next.status === 'COMPLETE') {
          const secs = Math.max(1, Math.round(((next.thinkingCompletedAtMs ?? Date.now()) - next.createdAtMs) / 1000));
          summaryLabel.textContent = `已${baseLabel}（${secs} 秒）`;
          if (details.dataset.userToggled !== '1') details.open = false;
          element.querySelector('.timeline-thinking-spinner')?.remove();
        } else {
          summaryLabel.textContent = `${baseLabel}…`;
        }
      }
      return true;
    }
    const body = element.querySelector<HTMLElement>('.timeline-body');
    if (!body) return false;
    if (next.body !== previous.body) {
      body.classList.add('markdown-body');
      syncRegionContent(body, renderMarkdown(next.body), () => {});
    }
    element.dataset.status = next.status;
    const status = element.querySelector<HTMLElement>('.timeline-status');
    if (status && previous.status !== next.status) {
      status.className = `timeline-status timeline-status-${next.status.toLowerCase()}`;
      status.textContent = { STREAMING: '进行中', COMPLETE: '已完成', PENDING: '等待中', ERROR: '错误' }[next.status];
    }
    const caret = element.querySelector('.stream-caret');
    if (next.status !== 'STREAMING') caret?.remove();
    else if (!caret) {
      const node = document.createElement('span');
      node.className = 'stream-caret';
      node.setAttribute('aria-label', '正在生成');
      element.querySelector('.timeline-content')?.append(node);
    }
    return true;
  }
}
