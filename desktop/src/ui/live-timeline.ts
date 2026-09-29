import type { TimelineItem } from '../domain/models';

// Keep completed rows untouched; append large bursts over several frames.
export class LiveTimeline {
  private rows = new Map<string, { element: HTMLElement; item: TimelineItem }>();
  private items: TimelineItem[] = [];
  private frame: number | undefined;

  constructor(private container: HTMLElement, private html: (item: TimelineItem) => string,
    private initialize: (element: HTMLElement) => void, private afterPaint: () => void) {}

  update(items: TimelineItem[]): void {
    this.items = items;
    this.flush();
  }

  pause(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
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
        if (changed >= 8 || (changed > 0 && performance.now() - started >= 3)) {
          this.frame = requestAnimationFrame(() => this.flush());
          break;
        }
        if (row && this.patchStream(row, item)) {
          row.item = item;
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
          row = { element, item };
          this.rows.set(item.itemId, row);
        }
        changed++;
      }
      if (position !== row.element) this.container.insertBefore(row.element, position);
      position = row.element.nextElementSibling;
    }
    if (changed) this.afterPaint();
  }

  private appendText(body: HTMLElement, value: string): void {
    body.classList.add('stream-text-body');
    for (const line of value.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      let chunk = body.lastElementChild as HTMLElement | null;
      if (!chunk || Number(chunk.dataset.lines ?? 0) >= 8) {
        if (chunk?.firstChild instanceof Text && chunk.firstChild.data.endsWith('\n')) {
          chunk.firstChild.deleteData(chunk.firstChild.length - 1, 1);
          // Preserve exact text/copy boundaries without a spare rendered line
          // at each block boundary. The parent collapses separator whitespace.
          body.append(document.createTextNode('\n'));
        }
        chunk = document.createElement('span');
        chunk.className = 'stream-text-chunk';
        chunk.dataset.lines = '0';
        body.append(chunk);
      }
      const text = chunk.firstChild;
      if (text instanceof Text) text.appendData(line);
      else chunk.append(document.createTextNode(line));
      if (line.endsWith('\n')) chunk.dataset.lines = String(Number(chunk.dataset.lines) + 1);
    }
  }

  private patchStream(row: { element: HTMLElement; item: TimelineItem }, next: TimelineItem): boolean {
    const previous = row.item;
    if (previous.kind !== 'AGENT' || next.kind !== 'AGENT'
      || Object.keys({ ...previous, ...next }).some((key) => key !== 'body' && key !== 'status'
        && previous[key as keyof TimelineItem] !== next[key as keyof TimelineItem])) return false;
    const body = row.element.querySelector<HTMLElement>('.timeline-body');
    if (!body) return false;
    if (next.body !== previous.body) {
      // Isolate completed line groups so appending to a long response does
      // not reflow one ever-growing text node on every animation frame.
      if (!body.firstElementChild?.classList.contains('stream-text-chunk')
        || !next.body.startsWith(previous.body)) {
        body.replaceChildren();
        this.appendText(body, next.body);
      } else this.appendText(body, next.body.slice(previous.body.length));
    }
    row.element.dataset.status = next.status;
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
