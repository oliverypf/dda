import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { fileIo as fs, picker } from '@kit.CoreFileKit';
import { readBoundedFile } from './LocalFileIO';

export interface LocalSkill {
  name: string;
  description: string;
  body: string;
}

export function validLocalSkill(skill: LocalSkill): boolean {
  return !!skill && typeof skill.name === 'string' && skill.name.trim().length > 0 &&
    typeof skill.description === 'string' && skill.description.trim().length > 0 &&
    typeof skill.body === 'string' && skill.body.trim().length > 0;
}

// Only the two display fields are consumed. Additional metadata, references
// and executable files are never loaded from an imported document.
function frontMatterValue(raw: string, lines: string[]): string {
  const value = raw.trim();
  if (/^[>|][+-]?$/.test(value)) {
    return lines.map((line: string) => line.trim()).join(value[0] === '>' ? ' ' : '\n').trim();
  }
  const scalar = [value].concat(lines.map((line: string) => line.trim())).join(' ').trim();
  if (scalar.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(scalar);
    if (!quoted) { throw new Error('技能元数据引号格式无效'); }
    return (JSON.parse(quoted[1]) as string).trim();
  }
  if (scalar.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(scalar);
    if (!quoted) { throw new Error('技能元数据引号格式无效'); }
    return quoted[1].replace(/''/g, "'").trim();
  }
  if (scalar.startsWith('#')) { return ''; }
  if (/^[\[\]{},&*!]/.test(scalar) || /^[-?]\s/.test(scalar) || /:\s/.test(scalar)) {
    throw new Error('技能名称和说明必须为文本，包含冒号时可使用引号');
  }
  return scalar.replace(/\s+#.*$/, '').trim();
}

export function parseLocalSkill(source: string): LocalSkill {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (!lines.length || lines[0].trimEnd() !== '---') { throw new Error('SKILL.md 需要包含 YAML 文档头'); }
  let name: string | undefined;
  let description: string | undefined;
  let cursor = 1;
  while (cursor < lines.length && lines[cursor].trimEnd() !== '---') {
    const line = lines[cursor++];
    if (!line.trim() || line.trimStart().startsWith('#')) { continue; }
    const header = /^([\w-]+):(?:\s+(.*))?$/.exec(line);
    if (!header) { throw new Error('SKILL.md 的 YAML 文档头格式无效'); }
    const folded: string[] = [];
    while (cursor < lines.length && (/^\s/.test(lines[cursor]) || !lines[cursor])) {
      folded.push(lines[cursor++]);
    }
    if (header[1] === 'name') {
      if (name !== undefined) { throw new Error('SKILL.md 包含重复的 name'); }
      name = frontMatterValue(header[2] ?? '', folded);
    } else if (header[1] === 'description') {
      if (description !== undefined) { throw new Error('SKILL.md 包含重复的 description'); }
      description = frontMatterValue(header[2] ?? '', folded);
    }
  }
  if (cursor === lines.length) { throw new Error('SKILL.md 缺少文档头结束标记'); }
  const skill: LocalSkill = { name: name ?? '', description: description ?? '', body: lines.slice(cursor + 1).join('\n').trim() };
  if (!validLocalSkill(skill)) { throw new Error('SKILL.md 需要非空的 name、description 和正文'); }
  return skill;
}

export async function importSkill(context: common.UIAbilityContext): Promise<LocalSkill | null> {
  const options = new picker.DocumentSelectOptions();
  options.maxSelectNumber = 1;
  options.fileSuffixFilters = ['Markdown|.md'];
  const uris = await new picker.DocumentViewPicker(context).select(options);
  if (!uris.length) { return null; }
  const document = await fs.open(uris[0], fs.OpenMode.READ_ONLY);
  try {
    const bytes = await readBoundedFile(document.fd, 128 * 1024);
    const source = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(bytes);
    if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(source)) { throw new Error('技能文档必须是 UTF-8 文本'); }
    return parseLocalSkill(source);
  } finally {
    await fs.close(document);
  }
}
