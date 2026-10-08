import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const escapeText = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]!));

// Reply markup is content, never application controls. Raw HTML stays visible
// as text; images do not trigger network requests while a reply is displayed.
const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => escapeText(text),
    image: ({ text }) => escapeText(text)
  }
});
const cache = new Map<string, string>();

export const renderMarkdown = (source: string): string => {
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const parsed = markdown.parse(source, { async: false });
  const fragment = DOMPurify.sanitize(parsed, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code',
      'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'align', 'start', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false
  });
  fragment.querySelectorAll('a').forEach((link) => {
    const href = link.getAttribute('href') ?? '';
    if (!/^(?:https?:\/\/|mailto:)/iu.test(href)) link.removeAttribute('href');
    else {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  });
  fragment.querySelectorAll('input').forEach((input) => {
    input.type = 'checkbox';
    input.disabled = true;
  });
  fragment.querySelectorAll('table').forEach((table) => {
    const scroll = document.createElement('div');
    scroll.className = 'markdown-table-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', '表格（可横向滚动）');
    table.replaceWith(scroll);
    scroll.append(table);
  });
  fragment.querySelectorAll('pre').forEach((block) => { block.tabIndex = 0; });
  const wrapper = document.createElement('div');
  wrapper.append(fragment);
  const html = wrapper.innerHTML;
  if (source.length <= 128_000) {
    cache.set(source, html);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
  }
  return html;
};
