

/**
 * 数据源适配器接口 v2 —— 按软件原生层级组织。
 *
 * 每个软件自己都有一套「容器 → 内容」的结构：
 *   DSH       : 工作区 → 对话
 *   WorkBuddy : 项目   → 对话
 *   Codex     : 会话目录 → 会话
 *
 * 界面上必须按这套原生层级展示，否则用户面对一堆文件根本认不出是什么。
 * 所以适配器不再吐扁平列表，而是吐「容器树」：
 *
 *   containers(ctx) → [{ id, label, detail, path, items: [...] }]
 *
 * 每个 container 里有 items，每个 item 是「可引起同步的最小单位」，
 * 它的 key 同时用于选择集和仓库路径。
 *
 * 适配器契约：
 *   meta                 { id, label, icon, description, tier: {containerLabel, itemLabel} }
 *   detect(ctx)          { installed, detail }
 *   containers(ctx)      [{ id, key, label, detail, localPath, gcount, bytes, items: [{ key, label, detail, meta, bytes, blocked }] }]
 *   collect(ctx, sel)    写仓库，返回说明文字
 *   apply(ctx, sel)      合并到本机，返回 { applied, conflicts }
 */

const ADAPTER_API_VERSION = 2;

/** 选择集里是否包含某个 key。keys 为 null 表示全选。 */
function allowed(selection, key) {
  if (!selection || selection.keys === null || selection.keys === undefined) return true;
  if (selection.keys.includes(key)) return true;

  // 勾了「工作区」就等于勾了它下面的所有对话——
  // 用户点工作区那个框时想的是「这个项目整块都要」，
  // 不该再要求他逐个展开去点对话。
  for (const selected of selection.keys) {
    if (key.startsWith(selected + '/')) return true;
  }
  return false;
}

/** 写仓库里的一个文件，并记录。 */
function putFile(ctx, relPath, buffer) {
  const target = ctx.joinRepo(relPath);
  ctx.writeRepoFile(target, buffer);
  ctx.collected.push(relPath);
  return true;
}

/** 把「容器 id」编成安全的仓库目录名。 */
function safeName(value, fallback = 'unnamed') {
  const text = String(value ?? '').trim();
  if (text.length === 0) return fallback;
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === '/' || ch === '\\' || ch === ':' || ch === '*' || ch === '?' || ch === '"' || ch === '<' || ch === '>' || ch === '|') {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    } else if (code < 0x20) {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out.slice(0, 120) || fallback;
}

/** 反过来解。 */
function unsafeName(value) {
  return String(value ?? '').replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

for (const __name of ["allowed","putFile","safeName","unsafeName","ADAPTER_API_VERSION"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
