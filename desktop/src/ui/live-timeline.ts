import type { TimelineItem } from '../domain/models';
import { renderMarkdown } from './markdown';
import { syncRegionContent } from './keyed-list';

// Keep completed rows untouched; append large bursts over several frames.
const activeContainerTimeline = new WeakMap<HTMLElement, LiveTimeline>();

export class LiveTimeline {
  private rows = new Map<string, { element: HTMLElement; item: TimelineItem; paintedAt: number }>();
  private items: TimelineItem[] = [];
  private frame: number | undefined;
  private streamTimer: number | undefined;

  constructor(private container: HTMLElement, private html: (item: TimelineItem) => string,
    private initialize: (element: HTMLElement) => void, private afterPaint: () => void) {
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
    const wanted = new Set(this.items.map((item) => item.itemId));
    for (const [id, row] of this.rows) {
      if (!wanted.has(id)) { row.element.remove(); this.rows.delete(id); }
    }
    const started = performance.now();
    let changed = 0;
    let position = this.container.firstElementChild;
    for (const item of this.items) {
      let row = this.rows.get(item.itemId);
      if (!row || row.item !== item) {
        // Coalesce token bursts without postponing the final paint. Reuse
        // Markdown blocks so tables keep their horizontal scroll position.
        if (row && row.item.kind === 'AGENT' && item.kind === 'AGENT'
          && row.item.status === 'STREAMING' && item.status === 'STREAMING'
          && row.item.body !== item.body) {
          const remaining = (item.body.length > 32_000 ? 250 : 100) - (performance.now() - row.paintedAt);
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
        if (row && this.patchStream(row, item)) {
          row.item = item;
          row.paintedAt = performance.now();
        } else {
          const template = document.createElement('template');
          template.innerHTML = this.html(item);
          const element = template.content.firstElementChild as HTMLElement;
          this.initialize(element);
          if (row) {
            const open = [...row.element.querySelectorAll('details')].map((detail) => detail.open);
            element.querySelectorAll('details').forEach((detail, i) => { detail.open = open[i] ?? detail.open; });
            if (position === row.element) position = element;
            row.element.replaceWith(element);
          }
          row = { element, item, paintedAt: performance.now() };
          this.rows.set(item.itemId, row);
        }
        changed++;
      }
      if (position !== row.element) this.container.insertBefore(row.element, position);
      position = row.element.nextElementSibling;
    }
    if (changed) this.afterPaint();
  }

  private patchStream(row: { element: HTMLElement; item: TimelineItem }, next: TimelineItem): boolean {
    const previous = row.item;
    if (previous.kind !== 'AGENT' || next.kind !== 'AGENT'
      || Boolean(previous.thinking) !== Boolean(next.thinking)
      || Object.keys({ ...previous, ...next }).some((key) =>
        key !== 'body' && key !== 'status' && key !== 'thinkingCompletedAtMs' && key !== 'thinkingLabel'
        && previous[key as keyof TimelineItem] !== next[key as keyof TimelineItem])) return false;
    if (next.thinking) {
      const details = row.element.querySelector<HTMLDetailsElement>('.timeline-thinking-details');
      const body = row.element.querySelector<HTMLElement>('.timeline-thinking-body');
      const summaryLabel = row.element.querySelector<HTMLElement>('.timeline-thinking-label');
      if (!details || !body || !summaryLabel) return false;
      if (next.body !== previous.body) {
        body.classList.add('markdown-body');
        syncRegionContent(body, renderMarkdown(next.body), () => {});
      }
      row.element.dataset.status = next.status;
      if (previous.status !== next.status) {
        const baseLabel = next.thinkingLabel || '思考过程';
        if (next.status === 'COMPLETE') {
          const secs = Math.max(1, Math.round(((next.thinkingCompletedAtMs ?? Date.now()) - next.createdAtMs) / 1000));
          summaryLabel.textContent = `已${baseLabel}（${secs} 秒）`;
          if (details.dataset.userToggled !== '1') details.open = false;
          row.element.querySelector('.timeline-thinking-spinner')?.remove();
        } else {
          summaryLabel.textContent = `${baseLabel}…`;
        }
      }
      return true;
    }
    const body = row.element.querySelector<HTMLElement>('.timeline-body');
    if (!body) return false;
    if (next.body !== previous.body) {
      body.classList.add('markdown-body');
      syncRegionContent(body, renderMarkdown(next.body), () => {});
    }
    row.element.dataset.status = next.status;
    const status = row.element.querySelector<HTMLElement>('.timeline-status');
    if (status && previous.status !== next.status) {
      status.className = `timeline-status timeline-status-${next.status.toLowerCase()}`;
      status.textContent = { STREAMING: '进行中', COMPLETE: '已完成', PENDING: '等待中', ERROR: '错误' }[next.status];
    }
    const caret = row.element.querySelector('.stream-caret');
    if (next.status !== 'STREAMING') caret?.remove();
    else if (!caret) {
      const node = document.createElement('span');
      node.className = 'stream-caret';
      node.setAttribute('aria-label', '正在生成');
      row.element.querySelector('.timeline-content')?.append(node);
    }
    return true;
  }
}
