#!/usr/bin/env node
/**
 * docs/build-project-pptx.mjs
 *
 * 生成介绍本项目的演示文稿 docs/dda-project-intro.pptx（16:9、深色主题、12 页）。
 *
 * 实现说明：
 * - 纯 Node 标准库：手写 ZIP 打包（deflateRaw + CRC32）+ Office Open XML PresentationML；
 *   不引入任何第三方依赖，本机没有 PowerPoint/WPS/LibreOffice 也能生成。
 * - 内容来源为仓库 README.md 与 docs/ 设计文档中的项目事实，不包含凭据或敏感信息。
 * - 产物用 docs/verify-project-pptx.mjs 独立核验（结构、链接、标题与关键事实覆盖）。
 *
 * 用法（仓库根目录执行）：
 *   node docs/build-project-pptx.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DOCS = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(DOCS, 'dda-project-intro.pptx');

// ---------- 幻灯片几何（EMU，16:9） ----------
const EMU_W = 12192000;
const EMU_H = 6858000;
const MARGIN_X = 838200;
const CONTENT_W = EMU_W - MARGIN_X * 2;

const COLORS = {
  bg: '070B16',
  title: 'FFFFFF',
  lead: 'E9F0FF',
  body: 'C7D2E8',
  muted: '7C8DB0',
  accent: '5B8CFF',
};
const FONT_LATIN = 'Segoe UI';
const FONT_EA = 'Microsoft YaHei';

// ---------- 命名空间与关系类型 ----------
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_OFFICE_DOCUMENT = `${NS_R}/officeDocument`;
const REL_CORE_PROPS = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const REL_EXTENDED_PROPS = `${NS_R}/extended-properties`;
const REL_SLIDE = `${NS_R}/slide`;
const REL_SLIDE_MASTER = `${NS_R}/slideMaster`;
const REL_SLIDE_LAYOUT = `${NS_R}/slideLayout`;
const REL_THEME = `${NS_R}/theme`;

// ---------- ZIP（无依赖实现） ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    dosTime: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    dosDate: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

class ZipBuilder {
  constructor() {
    this.entries = [];
    this.chunks = [];
    this.offset = 0;
  }

  add(name, data) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const { dosTime, dosDate } = dosDateTime(new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.concat([local, nameBuf]);
    this.chunks.push(header, payload);
    this.entries.push({ name, nameBuf, method, dosTime, dosDate, crc, compSize: payload.length, uncompSize: data.length, offset: this.offset });
    this.offset += header.length + payload.length;
  }

  finish() {
    const central = [];
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4); // version made by
      c.writeUInt16LE(20, 6); // version needed
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.dosTime, 12);
      c.writeUInt16LE(e.dosDate, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.compSize, 20);
      c.writeUInt32LE(e.uncompSize, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt32LE(e.offset, 42);
      central.push(Buffer.concat([c, e.nameBuf]));
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.chunks, centralBuf, eocd]);
  }
}

// ---------- XML 基础 ----------
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rPr(size, { color, bold = false } = {}) {
  return (
    `<a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    `<a:latin typeface="${FONT_LATIN}"/><a:ea typeface="${FONT_EA}"/><a:cs typeface="${FONT_LATIN}"/></a:rPr>`
  );
}

function run(text, size, opts = {}) {
  return `<a:r>${rPr(size, opts)}<a:t>${esc(text)}</a:t></a:r>`;
}

function para(runsXml, { bullet = true, level = 0, spaceBefore = 900, align } = {}) {
  const marL = bullet ? 342900 + level * 285750 : 0;
  const indent = bullet ? (level === 0 ? -342900 : -285750) : 0;
  const bulletXml = bullet
    ? `<a:buClr><a:srgbClr val="${COLORS.accent}"/></a:buClr><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="•"/>`
    : '<a:buNone/>';
  return (
    `<a:p><a:pPr${align ? ` algn="${align}"` : ''} marL="${marL}" indent="${indent}">` +
    '<a:lnSpc><a:spcPct val="114000"/></a:lnSpc>' +
    `<a:spcBef><a:spcPts val="${spaceBefore}"/></a:spcBef>${bulletXml}</a:pPr>${runsXml}</a:p>`
  );
}

function textBox(id, name, x, y, cx, cy, parasXml) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/>' +
    `<a:lstStyle/>${parasXml}</p:txBody></p:sp>`
  );
}

function rect(id, name, x, y, cx, cy, color) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>'
  );
}

function slideXml(shapesXml) {
  return (
    XML_DECL +
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    '<p:cSld>' +
    `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${COLORS.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU_W}" cy="${EMU_H}"/><a:chOff x="0" y="0"/><a:chExt cx="${EMU_W}" cy="${EMU_H}"/></a:xfrm></p:grpSpPr>` +
    `${shapesXml}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    '</p:sld>'
  );
}

// ---------- 幻灯片构建 ----------
function contentSlideXml(slide, index, total) {
  let id = 2;
  const shapes = [];
  shapes.push(
    textBox(id++, `title-${index}`, MARGIN_X, 480000, CONTENT_W, 1000000,
      para(run(slide.title, 3000, { color: COLORS.title, bold: true }), { bullet: false, spaceBefore: 0 }))
  );
  shapes.push(rect(id++, `accent-${index}`, MARGIN_X, 1520000, 1800000, 72000, COLORS.accent));
  const bullets = slide.bullets
    .map((b, i) => {
      const body = typeof b === 'string' ? { text: b } : b;
      const runsXml =
        (body.lead ? run(body.lead, 1600, { color: COLORS.lead, bold: true }) : '') +
        run(body.text, 1600, { color: COLORS.body });
      return para(runsXml, { bullet: true, spaceBefore: i === 0 ? 300 : 1100 });
    })
    .join('');
  shapes.push(textBox(id++, `body-${index}`, MARGIN_X, 1900000, CONTENT_W, 4100000, bullets));
  shapes.push(
    textBox(id++, `footer-${index}`, MARGIN_X, 6420000, 7000000, 320000,
      para(run('dda · 多平台 Agent 工作台', 1000, { color: COLORS.muted }), { bullet: false, spaceBefore: 0 }))
  );
  shapes.push(
    textBox(id++, `pagenum-${index}`, EMU_W - MARGIN_X - 1600000, 6420000, 1600000, 320000,
      para(run(`${index} / ${total}`, 1000, { color: COLORS.muted }), { bullet: false, spaceBefore: 0, align: 'r' }))
  );
  return slideXml(shapes.join(''));
}

function heroSlideXml(slide) {
  const isCover = slide.kind === 'cover';
  let id = 2;
  const shapes = [];
  const bigSize = isCover ? 8800 : 6600;
  const titleY = isCover ? 1500000 : 1600000;
  const titleH = isCover ? 1900000 : 1400000;
  const accentY = isCover ? 3520000 : 3200000;
  const accentW = isCover ? 2200000 : 1800000;
  const subY = isCover ? 3800000 : 3480000;
  const subSize = isCover ? 2400 : 2000;
  const metaY = isCover ? 4900000 : 4500000;
  shapes.push(
    textBox(id++, 'hero-title', MARGIN_X, titleY, CONTENT_W, titleH,
      para(run(slide.title, bigSize, { color: COLORS.title, bold: true }), { bullet: false, spaceBefore: 0 }))
  );
  shapes.push(rect(id++, 'hero-accent', MARGIN_X, accentY, accentW, 90000, COLORS.accent));
  shapes.push(
    textBox(id++, 'hero-sub', MARGIN_X, subY, CONTENT_W, 700000,
      para(run(slide.subtitle, subSize, { color: COLORS.body }), { bullet: false, spaceBefore: 0 }))
  );
  const metaRuns = slide.meta
    .map((m, i) => para(run(m, 1300, { color: COLORS.muted }), { bullet: false, spaceBefore: i === 0 ? 1500 : 500 }))
    .join('');
  shapes.push(textBox(id++, 'hero-meta', MARGIN_X, metaY, CONTENT_W, 1200000, metaRuns));
  return slideXml(shapes.join(''));
}

function buildSlideXml(slide, index, total) {
  if (slide.kind === 'cover' || slide.kind === 'closing') return heroSlideXml(slide);
  return contentSlideXml(slide, index, total);
}

// ---------- 演示文稿内容（来源：README.md 与 docs/ 设计文档） ----------
const SLIDES = [
  {
    kind: 'cover',
    title: 'dda',
    subtitle: '面向 HarmonyOS、Windows 与 Linux 的多平台 Agent 工作台',
    meta: [
      '本地优先 · 独立安装、独立运行 · Windows 阶段四进行中',
      '演示文稿 · 生成时间 {DATE} · docs/build-project-pptx.mjs',
    ],
  },
  {
    title: '项目定位',
    bullets: [
      { lead: '本地优先', text: '：独立安装、独立运行的 Agent 工作台，不依赖 App Server' },
      { lead: 'Windows 优先', text: '：Tauri 2 桌面客户端 + 自研 Node/Cordis runtime' },
      { lead: 'runtime 承载', text: '：模型调用、任务编排、受控工具、审批、验证与审计' },
      { lead: '命名兼容', text: '：产品名统一为 dda，数据目录与应用标识沿用 hmCodex' },
      { lead: '多平台路线', text: '：Linux 为无界面 CLI；HarmonyOS 保留迁移期实现' },
    ],
  },
  {
    title: '核心概念：Thread / Turn / Item',
    bullets: [
      { lead: 'Thread', text: '：会话与历史' },
      { lead: 'Turn', text: '：一次用户请求及其完整执行过程' },
      { lead: 'Item', text: '：消息、推理摘要、命令、文件变更与工具调用' },
      { lead: '版本化命令与事件', text: '：任务请求、流式状态与审批回执' },
      { lead: '呈现层', text: '：流式消息、命令输出、审批卡片与错误状态' },
    ],
  },
  {
    title: '多平台架构',
    bullets: [
      { lead: '目标架构', text: '：UI 经 HarnessFacade 提交命令，订阅 HarnessReadModel' },
      { lead: 'Core 端口', text: '：仅依赖模型调用、执行、工作区、审批四类领域端口' },
      { lead: 'Windows 桌面', text: '：已消费 HarnessReadModel 聚合读模型' },
      { lead: 'Linux CLI', text: '：直接消费 command result 与 runtime-event JSONL' },
      { lead: 'HarmonyOS', text: '：直连 App Server 为迁移期历史实现，暂不推进产品化' },
    ],
  },
  {
    title: 'Windows 桌面客户端',
    bullets: [
      { lead: '默认 READ_ONLY', text: '：授权目录、目录浏览、限量文本预览与 SHA-256 摘要' },
      { lead: '流式工作台', text: '：流式时间线、Mock 任务、取消终止 runtime 进程树' },
      { lead: '审批卡片', text: '：展示风险、快照 scope、策略版本与过期时间' },
      { lead: '崩溃恢复', text: '：启动执行只读 recovery，对账遗留 Approval、Lease、Intent' },
      { lead: '后台治理', text: '：Dream 维护由治理面板显式启停，只生成 PROPOSED memory' },
    ],
  },
  {
    title: 'Cordis Runtime',
    bullets: [
      { lead: '模型路由', text: '：默认 OpenAI Responses，可切换 Chat Completions、兼容网关、DeepSeek Harness' },
      { lead: '配置安全', text: '：model-config.json 存于用户数据目录，API key 只从环境变量读取' },
      { lead: '工具注册表', text: '：workspace.list / workspace.read / 受控 shell.execute、file.write、test.execute' },
      { lead: '副作用门控', text: '：RuntimeSafetyMonitor、一次性 Lease、逐项审批与审计' },
      { lead: '多轮调用', text: '：Responses 与 Chat Completions 的 function-call 有界解析' },
    ],
  },
  {
    title: '安全模型：默认只读 + 一次性 Lease',
    bullets: [
      { lead: 'READ_ONLY 默认', text: '：本地 shell、任意路径访问与网络调用不默认开放' },
      { lead: 'PolicyLease', text: '：PROPOSED → ACTIVE → CONSUMING → CONSUMED，一次性消费' },
      { lead: 'fail closed', text: '：拒绝、过期、崩溃恢复与未知副作用一律拒绝执行' },
      { lead: '最小权限', text: '：Tauri capability 仅保留核心窗口权限' },
      { lead: '边界不变', text: '：Jev 不能执行动作、授予权限、签发租约或绕过审批' },
    ],
  },
  {
    title: 'Jev Decision Plane',
    bullets: [
      { lead: '结构化决策', text: '：候选、证据、选择、预期与结果，用于审计与归因' },
      { lead: '语义辅助', text: '：任务分类、执行拓扑、模型/角色候选、工具门禁与 Stop/Continue' },
      { lead: '有界输入', text: '：只在有限候选与有界证据内判断，不保存隐藏思维链' },
      { lead: '路线门控', text: '：Phase 1 只读闭环先行，Phase 1.5 安全闭环通过后才开放写入与网络' },
      { lead: '不越权', text: '：不覆盖确定性安全组件、审批与 Executor 的控制' },
    ],
  },
  {
    title: '跨平台契约 contracts/v1',
    bullets: [
      { lead: '版本化 Schema', text: '：领域命令、事件、错误、ContextSummary 与能力快照' },
      { lead: '已落地', text: '：harness-read-model、runtime-event、action-intent、verifier-report 等' },
      { lead: '状态机契约', text: '：Approval、PolicyLease、ExecutionState 独立表达，不折叠为布尔' },
      { lead: '同源回归', text: '：ArkTS、TypeScript、Rust 与本地 runtime 通过同一 fixture 断言' },
      { lead: '隐私红线', text: '：凭据、完整源代码、隐藏思维链不进入契约与 fixture' },
    ],
  },
  {
    title: '测试与验证',
    bullets: [
      { lead: '并行套件', text: '：desktop 目录 npm run test:all:parallel（runtime / desktop / TS / Tauri）' },
      { lead: 'runtime 测试', text: '：node --test test/**/*.test.mjs 覆盖 Cordis 组合与受控工具' },
      { lead: 'UI 回归', text: '：Playwright + 模拟 native bridge，不调用真实模型' },
      { lead: '本地路径', text: '：开发副本位于 C:\\Users\\User\\hmCodex-local，避免网络盘与 UNC' },
      { lead: '验收矩阵', text: '：阶段四逐项推进，每项有明确状态记录' },
    ],
  },
  {
    title: '路线图与后续工作',
    bullets: [
      { lead: '阶段四主线', text: '：Windows 命令契约、durable facade 与事实源收敛' },
      { lead: '运行时收敛', text: '：长期驻留 runtime、随包 Node、capability/路径/凭据适配' },
      { lead: '交互补齐', text: '：候选/角色、审批与 Diff、运行记录、反馈归因与治理诊断' },
      { lead: '发布验收', text: '：Git 互验、Bayesian F4/F5、性能、无障碍与真实 Windows 发布观察' },
      { lead: '范围边界', text: '：Linux CLI 按独立计划推进；远程 Gateway 暂不纳入阶段四' },
    ],
  },
  {
    kind: 'closing',
    title: '谢谢',
    subtitle: 'dda · 多平台 Agent 工作台',
    meta: [
      '设计索引：docs/LONG_TERM_DESIGN_INDEX.md',
      '阶段四实施：docs/WINDOWS_PHASE4_IMPLEMENTATION_PLAN.md',
      'Harness 总体设计：docs/AGENT_HARNESS_DESIGN.md',
    ],
  },
];

// ---------- OOXML 部件 ----------
function contentTypesXml(n) {
  let overrides = '';
  overrides += '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>';
  overrides += '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>';
  overrides += '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>';
  overrides += '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>';
  overrides += '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>';
  overrides += '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
  for (let i = 1; i <= n; i += 1) {
    overrides += `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  }
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `${overrides}</Types>`
  );
}

function rootRelsXml() {
  return (
    XML_DECL + `<Relationships xmlns="${NS_REL}">` +
    `<Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="ppt/presentation.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_CORE_PROPS}" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${REL_EXTENDED_PROPS}" Target="docProps/app.xml"/>` +
    '</Relationships>'
  );
}

function coreXml(nowIso) {
  return (
    XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(DECK_TITLE)}</dc:title><dc:subject>多平台 Agent 工作台</dc:subject>` +
    '<dc:creator>dda</dc:creator><cp:keywords>dda,Agent,Tauri,HarmonyOS,Linux</cp:keywords>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}
const DECK_TITLE = 'dda 项目介绍';

function appXml(slides) {
  const items = [`<vt:lpstr>${esc(DECK_TITLE)}</vt:lpstr>`, ...slides.map((s) => `<vt:lpstr>${esc(s.title)}</vt:lpstr>`)].join('');
  return (
    XML_DECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>dda build-project-pptx.mjs</Application>' +
    `<Slides>${slides.length}</Slides>` +
    `<TitlesOfParts><vt:vector size="${slides.length + 1}" baseType="lpstr">${items}</vt:vector></TitlesOfParts>` +
    '</Properties>'
  );
}

function presentationXml(n) {
  const ids = Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('');
  return (
    XML_DECL +
    `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${ids}</p:sldIdLst>` +
    `<p:sldSz cx="${EMU_W}" cy="${EMU_H}"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>'
  );
}

function presentationRelsXml(n) {
  const rels = [`<Relationship Id="rId1" Type="${REL_SLIDE_MASTER}" Target="slideMasters/slideMaster1.xml"/>`];
  for (let i = 1; i <= n; i += 1) {
    rels.push(`<Relationship Id="rId${i + 1}" Type="${REL_SLIDE}" Target="slides/slide${i}.xml"/>`);
  }
  return XML_DECL + `<Relationships xmlns="${NS_REL}">${rels.join('')}</Relationships>`;
}

function masterXml() {
  return (
    XML_DECL + `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${COLORS.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU_W}" cy="${EMU_H}"/><a:chOff x="0" y="0"/><a:chExt cx="${EMU_W}" cy="${EMU_H}"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>'
  );
}

function masterRelsXml() {
  return (
    XML_DECL + `<Relationships xmlns="${NS_REL}">` +
    `<Relationship Id="rId1" Type="${REL_SLIDE_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_THEME}" Target="../theme/theme1.xml"/>` +
    '</Relationships>'
  );
}

function layoutXml() {
  return (
    XML_DECL + `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1">` +
    '<p:cSld name="Blank"><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU_W}" cy="${EMU_H}"/><a:chOff x="0" y="0"/><a:chExt cx="${EMU_W}" cy="${EMU_H}"/></a:xfrm></p:grpSpPr>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  );
}

function layoutRelsXml() {
  return (
    XML_DECL + `<Relationships xmlns="${NS_REL}">` +
    `<Relationship Id="rId1" Type="${REL_SLIDE_MASTER}" Target="../slideMasters/slideMaster1.xml"/>` +
    '</Relationships>'
  );
}

function slideRelsXml() {
  return (
    XML_DECL + `<Relationships xmlns="${NS_REL}">` +
    `<Relationship Id="rId1" Type="${REL_SLIDE_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>` +
    '</Relationships>'
  );
}

function themeXml() {
  return (
    XML_DECL + `<a:theme xmlns:a="${NS_A}" name="dda-dark">
<a:themeElements>
<a:clrScheme name="dda-dark">
<a:dk1><a:srgbClr val="0B1220"/></a:dk1>
<a:lt1><a:srgbClr val="F2F6FF"/></a:lt1>
<a:dk2><a:srgbClr val="14213D"/></a:dk2>
<a:lt2><a:srgbClr val="C7D2E8"/></a:lt2>
<a:accent1><a:srgbClr val="5B8CFF"/></a:accent1>
<a:accent2><a:srgbClr val="38C6B9"/></a:accent2>
<a:accent3><a:srgbClr val="F5B14C"/></a:accent3>
<a:accent4><a:srgbClr val="EF6E7B"/></a:accent4>
<a:accent5><a:srgbClr val="8A7BFF"/></a:accent5>
<a:accent6><a:srgbClr val="63D38A"/></a:accent6>
<a:hlink><a:srgbClr val="5B8CFF"/></a:hlink>
<a:folHlink><a:srgbClr val="A9C4FF"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="dda">
<a:majorFont><a:latin typeface="${FONT_LATIN}"/><a:ea typeface="${FONT_EA}"/><a:cs typeface="${FONT_LATIN}"/></a:majorFont>
<a:minorFont><a:latin typeface="${FONT_LATIN}"/><a:ea typeface="${FONT_EA}"/><a:cs typeface="${FONT_LATIN}"/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="dda">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"><a:shade val="85000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:tint val="35000"/></a:schemeClr></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"><a:shade val="70000"/></a:schemeClr></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
<a:objectDefaults/>
<a:extraClrSchemeLst/>
</a:theme>`
  );
}

// ---------- 组装 ----------
function main() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const slides = SLIDES.map((s) => ({
    ...s,
    ...(s.meta ? { meta: s.meta.map((m) => m.replace('{DATE}', dateStr)) } : {}),
  }));
  const n = slides.length;

  const parts = new Map();
  parts.set('[Content_Types].xml', Buffer.from(contentTypesXml(n), 'utf8'));
  parts.set('_rels/.rels', Buffer.from(rootRelsXml(), 'utf8'));
  parts.set('docProps/core.xml', Buffer.from(coreXml(now.toISOString()), 'utf8'));
  parts.set('docProps/app.xml', Buffer.from(appXml(slides), 'utf8'));
  parts.set('ppt/presentation.xml', Buffer.from(presentationXml(n), 'utf8'));
  parts.set('ppt/_rels/presentation.xml.rels', Buffer.from(presentationRelsXml(n), 'utf8'));
  parts.set('ppt/slideMasters/slideMaster1.xml', Buffer.from(masterXml(), 'utf8'));
  parts.set('ppt/slideMasters/_rels/slideMaster1.xml.rels', Buffer.from(masterRelsXml(), 'utf8'));
  parts.set('ppt/slideLayouts/slideLayout1.xml', Buffer.from(layoutXml(), 'utf8'));
  parts.set('ppt/slideLayouts/_rels/slideLayout1.xml.rels', Buffer.from(layoutRelsXml(), 'utf8'));
  parts.set('ppt/theme/theme1.xml', Buffer.from(themeXml(), 'utf8'));
  slides.forEach((slide, i) => {
    const idx = i + 1;
    parts.set(`ppt/slides/slide${idx}.xml`, Buffer.from(buildSlideXml(slide, idx, n), 'utf8'));
    parts.set(`ppt/slides/_rels/slide${idx}.xml.rels`, Buffer.from(slideRelsXml(), 'utf8'));
  });

  const zip = new ZipBuilder();
  for (const [name, data] of parts) zip.add(name, data);
  const outBuf = zip.finish();
  fs.writeFileSync(OUTPUT, outBuf);

  const rel = path.relative(process.cwd(), OUTPUT).replace(/\\/g, '/');
  const sha256 = crypto.createHash('sha256').update(outBuf).digest('hex');
  const summary = {
    generatedAt: now.toISOString(),
    output: rel,
    bytes: outBuf.length,
    slides: n,
    slideTitles: slides.map((s) => s.title),
    parts: parts.size,
    sha256,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  const artifact = { version: 1, path: rel, sha256: `sha256:${sha256}`, disposition: 'GENERATED' };
  process.stdout.write(`DDA_BUILD_ARTIFACT ${JSON.stringify(artifact)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`生成失败：${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
