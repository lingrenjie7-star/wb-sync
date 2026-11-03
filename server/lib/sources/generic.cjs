const __imp0 = require('node:fs');
const __imp1 = require('node:os');
const __imp2 = require('node:path');
const __imp3 = require('../core.cjs');
const __imp4 = require('./base.cjs');
const fs = __imp0;
const os = __imp1;
const path = __imp2;
const { detokenizePaths, exists, isDir, tokenizePaths, walkFiles, writeFileAtomic } = __imp3;
const { allowed, putFile, safeName } = __imp4;
/**
 * 通用目录数据源：接任何「把数据放在一个目录里」的软件。
 *
 * 原生层级：**子目录 → 文件**
 *
 * Codex、Claude Code、Cursor 这些工具结构各异，但共同点是
 * 「一个子目录放一类东西，路径以文本形式写在文件里」。所以：
 *   · 顶层子目录当作「容器」，里面的文件当作「条目」；
 *   · 内容做路径令牌化，换机器时再还原。
 */







const TEXT_EXTENSIONS = new Set([
  '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.md', '.txt', '.log', '.sql', '.csv', '.tsv', '.xml', '.html',
  '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.ps1', '.bat',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'cache', 'Cache', 'Caches', 'tmp', 'temp', 'Temp',
  'logs', 'Logs', 'crashpad', 'GPUCache', 'Code Cache', 'blob_storage',
  'Service Worker', 'Local Storage', 'Session Storage', 'IndexedDB',
]);

function isTextFile(name) {
  const ext = path.extname(String(name)).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === '';
}

function shouldSkip(relPath) {
  for (const part of String(relPath).split('/')) {
    if (SKIP_DIRS.has(part)) return true;
    if (part.endsWith('.tmp') || part.endsWith('.lock') || part.endsWith('-shm') || part.endsWith('-wal')) return true;
  }
  return false;
}

function safeStat(file) {
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, mtime: stat.mtimeMs };
  } catch {
    return { size: 0, mtime: 0 };
  }
}

function formatShort(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function createGenericSource(definition) {
  const { id, label, description, icon, homeKey } = definition;

  /** 路径令牌：把绝对路径换成稳定占位符。 */
  function buildTokens(ctx) {
    const tokens = [];
    const add = (token, value) => {
      if (typeof value === 'string' && value.length >= 4) tokens.push([token, value]);
    };
    add('{{HOME}}', os.homedir());
    add('{{SOURCE_HOME}}', ctx.config[homeKey]);
    add('{{DSH_HOME}}', ctx.config.dshHome);
    add('{{WORKBUDDY_HOME}}', ctx.config.workbuddyHome);
    for (const root of ctx.config.roots ?? []) {
      const value = root?.paths?.[ctx.config.machine];
      if (typeof value === 'string' && value.length >= 4) add(`@${root.id}`, value);
    }
    return tokens.sort((a, b) => b[1].length - a[1].length);
  }

  const source = {
    meta: {
      id,
      label,
      shortLabel: label,
      icon: icon ?? '▣',
      description,
      tier: { containerLabel: '目录', itemLabel: '文件' },
      generic: true,
    },

    get id() {
      return id;
    },
    get label() {
      return label;
    },
    get icon() {
      return icon ?? '▣';
    },

    detect(ctx) {
      const home = ctx.config[homeKey];
      if (!isDir(home)) return { installed: false, detail: `找不到 ${home}` };
      const files = walkFiles(home, (rel) => shouldSkip(rel));
      return { installed: true, detail: `${files.length} 个文件` };
    },

    containers(ctx) {
      const home = ctx.config[homeKey];
      if (!isDir(home)) return [];

      const containers = [];
      let entries;
      try {
        entries = fs.readdirSync(home, { withFileTypes: true });
      } catch {
        return [];
      }

      // 顶层散文件放一组
      const rootFiles = entries.filter((e) => e.isFile() && isTextFile(e.name) && !shouldSkip(e.name));
      if (rootFiles.length > 0) {
        const items = rootFiles
          .map((entry) => {
            const stat = safeStat(path.join(home, entry.name));
            return {
              key: `${id}/files/${entry.name}`,
              label: entry.name,
              detail: '根目录',
              meta: formatShort(stat.size),
              bytes: stat.size,
            };
          })
          .sort((a, b) => a.label.localeCompare(b.label));
        containers.push({
          id: '_root',
          key: `${id}/files/_root`,
          label: '根目录文件',
          detail: home,
          localPath: home,
          bytes: items.reduce((sum, i) => sum + i.bytes, 0),
          items,
        });
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (shouldSkip(entry.name)) continue;
        const dir = path.join(home, entry.name);
        const files = walkFiles(dir, (rel) => shouldSkip(rel));
        if (files.length === 0) continue;

        containers.push({
          id: entry.name,
          key: `${id}/files/${safeName(entry.name)}`,
          label: entry.name,
          detail: `${files.length} 个文件`,
          localPath: dir,
          bytes: files.reduce((sum, f) => sum + f.size, 0),
          items: files.map((file) => ({
            key: `${id}/files/${safeName(entry.name)}/${file.rel}`,
            label: path.posix.basename(file.rel),
            detail: path.posix.dirname(file.rel) === '.' ? entry.name : `${entry.name}/${path.posix.dirname(file.rel)}`,
            meta: formatShort(file.size),
            bytes: file.size,
          })),
        });
      }

      return containers;
    },

    collect(ctx, selection) {
      const home = ctx.config[homeKey];
      if (!isDir(home)) return undefined;
      const tokens = buildTokens(ctx);
      let written = 0;

      for (const container of this.containers(ctx)) {
        for (const item of container.items) {
          if (!allowed(selection, item.key)) continue;
          const relPath = item.key.slice(`${id}/files/`.length);
          const abs = path.join(home, ...relPath.split('/'));
          if (!exists(abs)) continue;

          const buffer = fs.readFileSync(abs);
          const content = isTextFile(abs)
            ? Buffer.from(tokenizePaths(buffer.toString('utf8'), ctx.mapper, tokens), 'utf8')
            : buffer;
          putFile(ctx, path.posix.join(id, 'files', relPath), content);
          written++;
        }
      }

      return written > 0 ? `${label}：采集 ${written} 个文件` : undefined;
    },

    apply(ctx, selection) {
      const home = ctx.config[homeKey];
      const applied = [];
      const conflicts = [];
      const tokens = buildTokens(ctx);

      for (const entry of ctx.listRepoFiles(`${id}/files/`)) {
        const relPath = entry.rel.slice(`${id}/files/`.length);
        if (!allowed(selection, `${id}/files/${relPath}`)) continue;

        const localPath = path.join(home, ...relPath.split('/'));
        const isText = isTextFile(localPath);
        const content = isText ? Buffer.from(detokenizePaths(entry.buffer.toString('utf8'), tokens), 'utf8') : entry.buffer;

        if (!exists(localPath)) {
          writeFileAtomic(localPath, content);
          applied.push(`新建 ${relPath}`);
          continue;
        }

        const localBuffer = fs.readFileSync(localPath);
        if (localBuffer.equals(content)) continue;

        if (isText) {
          const localText = localBuffer.toString('utf8');
          const remoteText = content.toString('utf8');
          if (remoteText.startsWith(localText)) {
            ctx.backupFile(localPath);
            writeFileAtomic(localPath, content);
            applied.push(`追加 ${relPath}`);
            continue;
          }
          if (localText.startsWith(remoteText)) {
            ctx.backupFile(entry.abs);
            ctx.writeRepoFile(entry.abs, Buffer.from(tokenizePaths(localText, ctx.mapper, tokens), 'utf8'));
            continue;
          }
        }

        writeFileAtomic(`${localPath}.fork-${ctx.machine}-${Date.now()}`, content);
        conflicts.push(`${relPath} 两边都改过，保留本机，远端另存`);
      }

      return { applied, conflicts };
    },
  };

  return source;
}

for (const __name of ["createGenericSource"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
