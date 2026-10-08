import type { TimelineItem } from '../domain/models';
import { renderMarkdown } from './markdown';
import { syncRegionContent } from './keyed-list';

// Keep completed rows untouched; append large bursts over several frames.
export class LiveTimeline {
  private rows = new Map<string, { element: HTMLElement; item: TimelineItem; paintedAt: number }>();
  private items: TimelineItem[] = [];
  private frame: number | undefined;
  private streamTimer: number | undefined;

  constructor(private container: HTMLElement, private html: (item: TimelineItem) => string,
    private initialize: (element: HTMLElement) => void, private afterPaint: () => void) {}

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

  private flush(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    if (!this.container.isConnected) return;
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
      || Object.keys({ ...previous, ...next }).some((key) => key !== 'body' && key !== 'status'
        && previous[key as keyof TimelineItem] !== next[key as keyof TimelineItem])) return false;
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
