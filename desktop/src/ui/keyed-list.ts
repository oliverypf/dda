// Reconcile trusted application markup without unmounting live scroll containers,
// focused controls or animated icons. Entity keys take precedence over position.
const regionNodeKey = (node: Node): string => {
  if (!(node instanceof Element)) return `node:${node.nodeType}`;
  const identity = ['id', 'data-key', 'data-disclosure-id', 'data-agent-id',
    'data-memory-id', 'data-decision-id', 'data-item-id', 'data-live-region', 'name']
    .find((attribute) => node.hasAttribute(attribute));
  if (node.hasAttribute('data-action')) {
    return `${node.tagName}:${[...node.attributes].filter(attribute => attribute.name.startsWith('data-'))
      .map(attribute => `${attribute.name}=${attribute.value}`).sort().join('|')}`;
  }
  if (identity) return `${node.tagName}:${identity}:${node.getAttribute(identity)}`;
  return `${node.tagName}:${node.classList.item(0) ?? ''}`;
};

export function syncRegionContent(container: Element, content: string,
  initialize: (root: ParentNode) => void): void {
  const template = document.createElement('template');
  template.innerHTML = content;
  // Convert icons before matching, so an existing SVG is never swapped for <i>.
  initialize(template.content);
  reconcileRegionChildren(container, template.content);
}

function reconcileRegionChildren(container: Node, desired: Node): void {
  const available = new Map<string, Node[]>();
  for (const node of [...container.childNodes]) {
    const key = regionNodeKey(node);
    const matches = available.get(key) ?? [];
    matches.push(node);
    available.set(key, matches);
  }
  let position = container.firstChild;
  for (const next of [...desired.childNodes]) {
    const current = available.get(regionNodeKey(next))?.shift();
    if (!current) {
      container.insertBefore(next, position);
      continue;
    }
    if (current !== position) container.insertBefore(current, position);
    if (current instanceof Element && next instanceof Element) {
      const preserve = (name: string): boolean => current instanceof HTMLDetailsElement && name === 'open';
      for (const attribute of [...current.attributes]) {
        if (!preserve(attribute.name) && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      }
      for (const attribute of [...next.attributes]) {
        if (!preserve(attribute.name) && current.getAttribute(attribute.name) !== attribute.value) {
          current.setAttribute(attribute.name, attribute.value);
        }
      }
      // Form drafts belong to the user; streaming data must not reset them.
      if (!(current instanceof HTMLTextAreaElement) && !(current instanceof HTMLInputElement)
        && !(current instanceof HTMLSelectElement) && !current.isEqualNode(next)) {
        reconcileRegionChildren(current, next);
      }
    } else if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    position = current.nextSibling;
  }
  for (const remaining of available.values()) for (const node of remaining) container.removeChild(node);
}

// Only changed/new rows are parsed. Existing rows retain focus, disclosure
// state and DOM identity when older pages are prepended.
const rendered = new WeakMap<Element, string>();

export function preserveDisclosureStates(previous: HTMLElement, next: HTMLElement): void {
  const previousKeyed = new Map<string, HTMLDetailsElement>();
  const previousUnkeyed: HTMLDetailsElement[] = [];
  for (const detail of previous.querySelectorAll('details')) {
    const detailKey = detail.dataset.detailKey;
    if (detailKey) previousKeyed.set(detailKey, detail);
    else if (!detail.hasAttribute('data-auto-open')) previousUnkeyed.push(detail);
  }
  const previousAuto = [...previous.querySelectorAll<HTMLDetailsElement>('details[data-auto-open]')];
  let autoIndex = 0;
  let unkeyedIndex = 0;
  for (const detail of next.querySelectorAll('details')) {
    const detailKey = detail.dataset.detailKey;
    if (detailKey) {
      const prior = previousKeyed.get(detailKey);
      if (prior) detail.open = prior.open;
      continue;
    }
    if (detail.hasAttribute('data-auto-open')) {
      const prior = previousAuto[autoIndex++];
      if (prior?.dataset.userToggled === '1') {
        detail.dataset.userToggled = '1';
        detail.open = prior.open;
      }
      continue;
    }
    const prior = previousUnkeyed[unkeyedIndex++];
    if (prior) detail.open = prior.open;
  }
}

export type KeyedListHooks<T> = {
  /** Skip HTML when the mounted row already represents this exact item. */
  reuse?: (element: HTMLElement, item: T) => boolean;
  /** Remember which item a row displays, including rows that were just reused. */
  bind?: (element: HTMLElement, item: T) => void;
};
const createRow = (id: string, content: string,
  initialize: (element: HTMLElement) => void): HTMLElement => {
  const template = document.createElement('template');
  template.innerHTML = content;
  const element = template.content.firstElementChild as HTMLElement;
  element.dataset.key = id;
  rendered.set(element, content);
  initialize(element);
  return element;
};

export function syncKeyedList<T>(container: HTMLElement, items: T[], key: (item: T) => string,
  html: (item: T) => string, initialize: (element: HTMLElement) => void = () => {},
  hooks?: KeyedListHooks<T>): void {
  const existing = new Map([...container.children].map((element) => [(element as HTMLElement).dataset.key, element as HTMLElement]));
  let position = container.firstElementChild;
  const seen = new Set<string>();
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    let element = existing.get(id);
    // Rebuilding Markdown for every row is the expensive part of a task switch.
    // A row that already displays this object stays mounted.
    if (element && hooks?.reuse?.(element, item)) {
      hooks.bind?.(element, item);
    } else {
      const content = html(item);
      if (!element || rendered.get(element) !== content) {
        const next = createRow(id, content, initialize);
        if (element) {
          preserveDisclosureStates(element, next);
          if (position === element) position = next;
          element.replaceWith(next);
        }
        element = next;
        rendered.set(element, content);
      }
      hooks?.bind?.(element, item);
    }
    if (position !== element) container.insertBefore(element, position);
    position = element.nextElementSibling;
  }
  for (const [id, element] of existing) if (!seen.has(id!)) element.remove();
}

// History pages can contain many detail elements. Insert new rows in small
// frame-sized batches so a conversation switch yields to input and paint.
export async function syncKeyedListIncrementally<T>(container: HTMLElement, items: T[], key: (item: T) => string,
  html: (item: T) => string, initialize: (element: HTMLElement) => void = () => {},
  isCancelled: () => boolean = () => false, batchSize = 16, hooks?: KeyedListHooks<T>): Promise<void> {
  const unique = new Map<string, T>();
  for (const item of items) unique.set(key(item), item);
  const existing = new Map([...container.children].map((element) => [(element as HTMLElement).dataset.key!, element as HTMLElement]));
  const existingKeys = new Set(existing.keys());
  const originalFirst = container.firstElementChild as HTMLElement | null;
  const newItems = [...unique.entries()].filter(([id]) => !existingKeys.has(id));
  const firstExistingDesired = [...unique.keys()].find((id) => existingKeys.has(id));
  const insertionAnchor = firstExistingDesired ? existing.get(firstExistingDesired) ?? originalFirst : null;
  for (let offset = 0; offset < newItems.length; offset += batchSize) {
    if (isCancelled()) return;
    const fragment = document.createDocumentFragment();
    for (const [id, item] of newItems.slice(offset, offset + batchSize)) {
      const row = createRow(id, html(item), initialize);
      hooks?.bind?.(row, item);
      fragment.append(row);
    }
    if (insertionAnchor?.parentNode === container) container.insertBefore(fragment, insertionAnchor);
    else container.append(fragment);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (isCancelled()) return;
  // Existing rows retain identity; only changed rows are replaced after the
  // incremental insert completes. This keeps the common switch path cheap.
  for (const [id, item] of unique) {
    const element = existing.get(id);
    if (!element) continue;
    if (hooks?.reuse?.(element, item)) {
      hooks.bind?.(element, item);
      continue;
    }
    const content = html(item);
    if (rendered.get(element) === content) {
      hooks?.bind?.(element, item);
      continue;
    }
    const next = createRow(id, content, initialize);
    hooks?.bind?.(next, item);
    preserveDisclosureStates(element, next);
    element.replaceWith(next);
  }
  for (const [id, element] of [...container.children].map((child) => [(child as HTMLElement).dataset.key!, child as HTMLElement] as const)) {
    if (!unique.has(id)) element.remove();
  }
}
