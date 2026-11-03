const __imp0 = require('node:fs');
const __imp1 = require('node:path');
const __imp2 = require('./core.cjs');
const fs = __imp0;
const path = __imp1;
const { cleanGitError, decodeSession, detokenizePaths, displayTitle, encodeSegment, exists, homeDir, isDir, runGit, sha256, tokenizePaths, writeFileAtomic } = __imp2;
/**
 * 远端内容浏览与版本对比（按软件原生层级）。
 *
 * 远端文件不能直接铺给用户看——一屏 `dsh/sessions/xxx.jsonl` 谁也认不出是什么。
 * 所以这里做两件事：
 *   1. 把仓库里的文件反解成「工作区 → 对话」树，和本机界面一致；
 *   2. 对比时按这个层级逐项检查。
 */





// ───────────────────────────────────────────── 远端读取

async function showRemoteFile(repoDir, branch, relPath, proxy) {
  const result = await runGit(['show', `origin/${branch}:${relPath}`], { cwd: repoDir, proxy, timeoutMs: 60000 });
  if (!result.ok) return { ok: false, error: cleanGitError(result.stderr) };
  // 必须用 buffer：stdout 已被 UTF-8 解码，再用 binary 还原会毁掉中文和转义
  return { ok: true, buffer: result.buffer };
}

async function listRemoteFiles(repoDir, branch, proxy) {
  const result = await runGit(['ls-tree', '-r', '--long', `origin/${branch}`], { cwd: repoDir, proxy, timeoutMs: 60000 });
  if (!result.ok) return { ok: false, error: cleanGitError(result.stderr) };

  const files = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    if (meta[1] !== 'blob') continue;
    files.push({
      path: line.slice(tab + 1).trim(),
      size: Number.isFinite(Number(meta[3])) ? Number(meta[3]) : 0,
      hash: meta[2],
    });
  }
  return { ok: true, files };
}

async function ensureRemoteRef(engine, repo, session) {
  const branch = repo.branch;

  const attempt = async (proxy) => {
    const existsRef = await runGit(['rev-parse', '--verify', `origin/${branch}`], { cwd: session.dir, timeoutMs: 15000 });
    if (existsRef.ok) {
      const fetch = await runGit(['fetch', 'origin', branch], { cwd: session.dir, proxy, timeoutMs: 90000 });
      return fetch.ok ? { ok: true } : { ok: false, error: cleanGitError(fetch.stderr) };
    }
    const pulled = await session.pull();
    if (!pulled.ok) return { ok: false, error: pulled.error };
    if (pulled.empty) return { ok: true, empty: true };
    return { ok: true };
  };

  let result = await attempt(engine.config.proxy);
  if (result.ok) return result;

  if (isNetworkMessage(result.error)) {
    const { probeTransport } = await import('./github.mjs');
    const probe = await probeTransport();
    if (probe.ok && probe.proxy !== engine.config.proxy) {
      engine.config.proxy = probe.proxy;
      result = await attempt(probe.proxy);
    }
  }
  return result;
}

function isNetworkMessage(message) {
  const text = String(message ?? '').toLowerCase();
  return ['could not connect', 'failed to connect', 'connection was reset', 'recv failure', 'timeout', 'timed out', 'network'].some(
    (needle) => text.includes(needle),
  );
}

// ───────────────────────────────────────────── 层级反解

/**
 * 把仓库文件整理成「容器 → 条目」树，和本机界面对齐。
 *
 * DSH 仓库里的布局：
 *   dsh/storages/workspace.json     ← 工作区登记表
 *   dsh/sessions/<id>.jsonl         ← 对话（cwd 决定属于哪个工作区）
 *   dsh/profiles/...                ← 全局配置
 */
async function buildHierarchy({ engine, repo, session, files }) {
  const source = engine.sourceForRepo(repo);
  const sourceId = source?.id ?? '';
  const mapper = engine.mapperFor(sourceId);
  const tier = source?.meta?.tier ?? { containerLabel: '分组', itemLabel: '条目' };
  const containers = [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  const fileEntry = (file, label, detail) => ({
    key: file.path,
    path: file.path,
    label,
    detail,
    size: file.size,
    state: 'unknown',
    localPath: '',
  });

  if (sourceId === 'dsh') {
    // 工作区登记表
    let workspaces = {};
    const storeFile = byPath.get('dsh/storages/workspace.json');
    if (storeFile) {
      const raw = await showRemoteFile(session.dir, repo.branch, storeFile.path, engine.config.proxy);
      if (raw.ok) {
        try {
          workspaces = JSON.parse(raw.buffer.toString('utf8'))?.tables?.workspaces ?? {};
        } catch {}
      }
    }

    const sessionFiles = [...byPath.values()].filter((f) => f.path.startsWith('dsh/sessions/'));
    const usedSessions = new Set();

    for (const [wsId, record] of Object.entries(workspaces)) {
      const ids = new Set(record.sessionIds ?? []);
      const items = [];
      for (const file of sessionFiles) {
        const id = decodeSessionId(path.posix.basename(file.path));
        if (!ids.has(id)) continue;
        usedSessions.add(file.path);
        const decoded = await readSessionMeta(engine, repo, session, file.path);
        items.push(fileEntry(file, decoded.title ?? `对话 ${id.slice(0, 8)}`, `${decoded.events} 条消息`));
      }
      containers.push({
        id: wsId,
        key: `dsh/workspaces/${wsId}`,
        label: record.title ?? path.basename(record.path ?? ''),
        detail: record.path ?? '',
        logicalPath: record.path ?? '',
        items,
      });
    }

    // 没登记到工作区的对话
    const orphans = sessionFiles.filter((f) => !usedSessions.has(f.path));
    if (orphans.length > 0) {
      const items = [];
      for (const file of orphans) {
        const decoded = await readSessionMeta(engine, repo, session, file.path);
        items.push(fileEntry(file, decoded.title ?? path.posix.basename(file.path), `${decoded.events} 条消息`));
      }
      containers.push({
        id: '_orphan',
        key: 'dsh/orphan',
        label: '未归类对话',
        detail: '没有登记到任何工作区',
        items,
      });
    }

    // 全局配置
    const profileFiles = [...byPath.values()].filter((f) => f.path.startsWith('dsh/profiles/'));
    if (profileFiles.length > 0) {
      const grouped = new Map();
      for (const file of profileFiles) {
        const name = file.path.split('/')[2];
        grouped.set(name, [...(grouped.get(name) ?? []), file]);
      }
      containers.push({
        id: '_profiles',
        key: 'dsh/profiles',
        label: '插件与配置',
        detail: '全局生效',
        global: true,
        items: [...grouped.entries()].map(([name, list]) => ({
          key: list[0].path,
          path: list[0].path,
          label: `${name} · ${list.length} 个文件`,
          detail: list.map((f) => path.posix.basename(f.path)).join('、'),
          size: list.reduce((sum, f) => sum + f.size, 0),
          state: 'unknown',
          multi: list.map((f) => f.path),
        })),
      });
    }

    // 技能
    const skillFiles = [...byPath.values()].filter((f) => f.path.startsWith('dsh/skills/'));
    if (skillFiles.length > 0) {
      const grouped = new Map();
      for (const file of skillFiles) {
        const name = file.path.split('/')[3];
        grouped.set(name, [...(grouped.get(name) ?? []), file]);
      }
      containers.push({
        id: '_skills',
        key: 'dsh/skills',
        label: '技能',
        detail: '全局生效',
        global: true,
        items: [...grouped.entries()].map(([name, list]) => ({
          key: list[0].path,
          path: list[0].path,
          label: name,
          detail: `${list.length} 个文件`,
          size: list.reduce((sum, f) => sum + f.size, 0),
          state: 'unknown',
          multi: list.map((f) => f.path),
        })),
      });
    }
  } else if (sourceId === 'workbuddy') {
    // 项目清单
    let projects = [];
    const projectsFile = byPath.get('workbuddy/projects.json');
    if (projectsFile) {
      const raw = await showRemoteFile(session.dir, repo.branch, projectsFile.path, engine.config.proxy);
      if (raw.ok) {
        try {
          projects = JSON.parse(raw.buffer.toString('utf8'))?.projects ?? [];
        } catch {}
      }
    }

    const projectByKey = new Map(projects.map((p) => [p.key, p]));
    const sessionFiles = [...byPath.values()].filter((f) => f.path.startsWith('workbuddy/sessions/'));
    const grouped = new Map();
    for (const file of sessionFiles) {
      const key = file.path.split('/')[2];
      grouped.set(key, [...(grouped.get(key) ?? []), file]);
    }

    for (const [key, list] of grouped) {
      const project = projectByKey.get(key);
      containers.push({
        id: key,
        key: `workbuddy/projects/${key}`,
        label: project?.cwd ? path.basename(project.cwd) : key,
        detail: project?.cwd ?? '（仓库里没有记录项目路径）',
        logicalPath: project?.cwd ?? '',
        items: list.map((file) => ({
          key: file.path,
          path: file.path,
          label: path.posix.basename(file.path).replace(/\.jsonl$/, '').slice(0, 16),
          detail: path.posix.basename(file.path),
          size: file.size,
          state: 'unknown',
          localPath: '',
        })),
      });
    }

    const indexFile = byPath.get('workbuddy/index.json');
    const memoryFiles = [...byPath.values()].filter((f) => f.path.startsWith('workbuddy/memory/') || f.path.startsWith('workbuddy/config/'));
    const skillFiles = [...byPath.values()].filter((f) => f.path.startsWith('workbuddy/skills/'));

    if (indexFile || memoryFiles.length > 0 || skillFiles.length > 0) {
      const items = [];
      if (indexFile) items.push(fileEntry(indexFile, '会话列表索引', '让对话在 WorkBuddy 里显示'));
      for (const file of memoryFiles) {
        items.push(fileEntry(file, path.posix.basename(file.path), file.path.slice('workbuddy/'.length)));
      }
      for (const file of skillFiles) {
        items.push(fileEntry(file, path.posix.basename(file.path), file.path.slice('workbuddy/'.length)));
      }
      containers.push({
        id: '_extra',
        key: 'workbuddy/extra',
        label: '会话列表 / 记忆 / 技能',
        detail: '全局生效',
        global: true,
        items,
      });
    }
  } else {
    // 通用数据源：按 <id>/files/ 下的目录分组
    const prefix = `${sourceId}/files/`;
    const files2 = files.filter((f) => f.path.startsWith(prefix));
    const grouped = new Map();
    for (const file of files2) {
      const rel = file.path.slice(prefix.length);
      const top = rel.includes('/') ? rel.split('/')[0] : '_root';
      grouped.set(top, [...(grouped.get(top) ?? []), file]);
    }
    for (const [top, list] of grouped) {
      containers.push({
        id: top,
        key: `${sourceId}/files/${top}`,
        label: top === '_root' ? '根目录文件' : top,
        detail: `${list.length} 个文件`,
        items: list.map((file) => ({
          key: file.path,
          path: file.path,
          label: path.posix.basename(file.path),
          detail: file.path.slice(prefix.length),
          size: file.size,
          state: 'unknown',
          localPath: '',
        })),
      });
    }
  }

  // 标记每个条目的本机状态
  for (const container of containers) {
    for (const item of container.items) {
      const localPath = localPathFor(engine, sourceId, item.path, container);
      item.localPath = localPath ?? '';
      item.localExists = Boolean(localPath && exists(localPath));

      if (!item.localExists) {
        item.state = 'remote-only';
        continue;
      }

      const localBuffer = fs.readFileSync(localPath);
      item.localSize = localBuffer.length;

      // 关键：仓库里存的是「逻辑路径 + 明文」，本机是「真实路径 + zstd」。
      // 两边都先规整成同一种形式再比，否则永远不相等。
      const remote = await showRemoteFile(session.dir, repo.branch, item.path, engine.config.proxy);
      if (!remote.ok) {
        item.state = 'differs';
        continue;
      }

      const comparable = await comparableRemote({ engine, sourceId, item, remoteBuffer: remote.buffer });
      if (comparable.unresolved) {
        // 仓库里记录的路径在这台机器上没有对应位置：不是「改过了」，是「对不上」
        item.state = 'unmapped';
        item.detail = `${item.detail ?? ''} · 路径在本机无映射`;
        continue;
      }

      const localNormalized = normalizeLocal({ engine, sourceId, item, localPath });
      item.state = sha256(localNormalized) === sha256(comparable) ? 'same' : 'differs';
    }
  }

  return { containers, tier };
}

/**
 * 把仓库内容还原成「本机等价形式」，用于和本机文件比字节。
 *
 * 上传时做的变换（路径 → @ws/…，jsonl 里的 cwd 改写）在这里反向做一遍；
 * 否则「刚上传完」也会全部标成差异——这正是之前的 bug。
 */
async function comparableRemote({ engine, sourceId, item, remoteBuffer }) {
  const source = engine.sourceById(sourceId);
  const mapper = engine.mapperFor(sourceId);

  // 通用数据源：走令牌替换
  if (source?.meta?.generic || sourceId.startsWith('custom-')) {
    const tokens = buildTokenTable(engine, sourceId);
    return Buffer.from(detokenizePaths(remoteBuffer.toString('utf8'), tokens), 'utf8');
  }

  // 结构化数据源：jsonl 里逐行还原 cwd
  const text = remoteBuffer.toString('utf8');
  if (!text.includes('"cwd"')) return remoteBuffer;

  let unresolved = false;
  const restored = text
    .split('\n')
    .map((line) => {
      if (!line.includes('"cwd"')) return line;
      try {
        const value = JSON.parse(line);
        if (value && typeof value.cwd === 'string') {
          // 逻辑路径还原不了（比如那台机器配过、这台没配的映射），
          // 说明这个文件本机接不上，交给调用方标记，而不是假装「有差异」
          if (value.cwd.startsWith('@')) {
            // 用宽松还原：老版本存过 @DSHPRO / @WBPRO 这类前缀，
            // 不能因为格式变了就把它们全判成「路径未映射」
            const local = mapper.toLocalLenient(value.cwd);
            if (local === value.cwd) unresolved = true;
            value.cwd = local;
          }
          return JSON.stringify(value);
        }
      } catch {}
      return line;
    })
    .join('\n');

  return Object.assign(Buffer.from(restored, 'utf8'), { unresolved });
}

/**
 * 本机文件 → 可与仓库内容比较的形式。
 *
 * 两处差异必须抹平：
 *   1. DSH 会话在本机是 zstd，仓库里是明文 jsonl；
 *   2. 仓库里 cwd 是 @ws/… 这种逻辑路径。
 * 不处理这两点，「刚上传完」也会全部标成差异——之前的 bug 就在这。
 */
function normalizeLocal({ engine, sourceId, item, localPath }) {
  const source = engine.sourceById(sourceId);
  const mapper = engine.mapperFor(sourceId);
  const raw = fs.readFileSync(localPath);

  if (source?.meta?.generic || sourceId.startsWith('custom-')) {
    // 通用数据源：令牌化再还原 = 按本机配置算出的标准形式
    const tokens = buildTokenTable(engine, sourceId);
    return Buffer.from(detokenizePaths(tokenizePaths(raw.toString('utf8'), mapper, tokens), tokens), 'utf8');
  }

  // 结构化数据源：zstd → 明文
  let text;
  try {
    text = serializeSession(raw, localPath);
  } catch {
    return raw;
  }
  if (!text.includes('"cwd"')) return Buffer.from(text, 'utf8');

  // 再把路径统一成「本机真实路径」表示（和 comparableRemote 的结果对齐）
  const restored = text
    .split('\n')
    .map((line) => {
      if (!line.includes('"cwd"')) return line;
      try {
        const value = JSON.parse(line);
        if (value && typeof value.cwd === 'string') {
          value.cwd = mapper.toLocalLenient(mapper.toLogical(value.cwd));
          return JSON.stringify(value);
        }
      } catch {}
      return line;
    })
    .join('\n');
  return Buffer.from(restored, 'utf8');
}

function detectCompression(localPath, buffer) {
  if (localPath.endsWith('.zstd')) return 'zstd';
  if (buffer.length > 4 && buffer.readUInt32LE(0) === 0xfd2fb528) return 'zstd';
  return 'none';
}

/** 把本机会话（可能是 zstd）转成仓库里的明文 jsonl 形式。 */
function serializeSession(raw, localPath) {
  const decoded = decodeSession(raw, detectCompression(localPath, raw));
  const lines = [JSON.stringify(decoded.header), ...decoded.events.map((e) => JSON.stringify(e))];
  return lines.join('\n') + '\n';
}

/** 通用数据源用的令牌表（与采集时一致）。 */
function buildTokenTable(engine, sourceId) {
  const config = engine.config;
  const tokens = [];
  const add = (token, value) => {
    if (typeof value === 'string' && value.length >= 4) tokens.push([token, value]);
  };
  add('{{HOME}}', homeDir);
  add('{{SOURCE_HOME}}', config.softwareHome?.[sourceId]);
  for (const [id, value] of Object.entries(config.softwareHome ?? {})) {
    if (id !== sourceId) add(`{{${id.toUpperCase()}_HOME}}`, value);
  }
  const root = config.workspaceRoot?.[sourceId];
  if (typeof root === 'string' && root.length >= 4) add('@ws', root);
  for (const item of config.roots ?? []) {
    add(`@${item.id}`, item?.paths?.[config.machine]);
  }
  return tokens.sort((a, b) => b[1].length - a[1].length);
}

function decodeSessionId(fileName) {
  return String(fileName)
    .replace(/\.jsonl$/, '')
    .replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function readSessionMeta(engine, repo, session, relPath) {
  const raw = await showRemoteFile(session.dir, repo.branch, relPath, engine.config.proxy);
  if (!raw.ok) return { events: 0, title: undefined, cwd: undefined };
  try {
    // 仓库里存的是明文 jsonl（采集时解过 zstd）
    const lines = raw.buffer.toString('utf8').split('\n').filter((l) => l.trim());
    const header = JSON.parse(lines[0]);
    const events = [];
    for (const line of lines.slice(1)) {
      try {
        events.push(JSON.parse(line));
      } catch {}
    }
    return { events: events.length, title: displayTitle(events, header, header.id), cwd: header.cwd };
  } catch {
    return { events: 0, title: undefined, cwd: undefined };
  }
}

/** 远端文件 → 本机路径。 */
function localPathFor(engine, sourceId, relPath, container) {
  const config = engine.config;
  const home = config.softwareHome?.[sourceId] ?? '';

  if (sourceId === 'dsh') {
    if (relPath === 'dsh/storages/workspace.json') return path.join(home, 'storages', 'workspace.json');
    if (relPath.startsWith('dsh/profiles/')) return path.join(home, 'profiles', ...relPath.slice('dsh/profiles/'.length).split('/'));
    if (relPath.startsWith('dsh/skills/dsh/')) return path.join(home, 'skills', ...relPath.slice('dsh/skills/dsh/'.length).split('/'));
    if (relPath.startsWith('dsh/skills/agents/')) {
      return path.join(config.softwareHome?.agents ?? '~/.agents', 'skills', ...relPath.slice('dsh/skills/agents/'.length).split('/'));
    }
    if (relPath.startsWith('dsh/sessions/')) {
      const id = decodeSessionId(path.posix.basename(relPath));
      const found = findLocalDshSession(engine, id);
      return found;
    }
    return undefined;
  }

  if (sourceId === 'workbuddy') {
    if (relPath === 'workbuddy/index.json' || relPath === 'workbuddy/projects.json') return undefined;
    if (relPath.startsWith('workbuddy/sessions/')) {
      return findLocalWorkbuddySession(engine, relPath);
    }
    if (relPath.startsWith('workbuddy/memory/')) return path.join(home, 'memory', ...relPath.slice('workbuddy/memory/'.length).split('/'));
    if (relPath.startsWith('workbuddy/config/')) return path.join(home, ...relPath.slice('workbuddy/config/'.length).split('/'));
    if (relPath.startsWith('workbuddy/skills/')) return path.join(home, 'skills', ...relPath.slice('workbuddy/skills/'.length).split('/'));
    return undefined;
  }

  if (relPath.startsWith(`${sourceId}/files/`)) {
    return path.join(home, ...relPath.slice(`${sourceId}/files/`.length).split('/'));
  }
  return undefined;
}

function findLocalDshSession(engine, id) {
  const root = path.join(engine.config.softwareHome?.dsh ?? '', 'sessions');
  const wanted = encodeSegment(id);
  if (!isDir(root)) return undefined;
  for (const projectEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const dir = path.join(root, projectEntry.name, wanted);
    if (!isDir(dir)) continue;
    const files = fs.readdirSync(dir).filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name));
    if (files.length > 0) return path.join(dir, files.sort().reverse()[0]);
  }
  return undefined;
}

function findLocalWorkbuddySession(engine, relPath) {
  const parts = relPath.split('/');
  const logicalKey = parts[2];
  const name = parts[3];
  const root = path.join(engine.config.softwareHome?.workbuddy ?? '', 'projects');
  if (!isDir(root)) return undefined;

  // 仓库里按「逻辑项目键」存放，本机按 slug 存放；扫一遍找同名的会话文件
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// ───────────────────────────────────────────── 对外接口

/**
 * 浏览远端仓库内容，按软件原生层级返回。
 */
async function browseRemote({ engine, repo, query = '' }) {
  const session = engine.repoSession(repo);
  const prepared = await session.ensure();
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const ref = await ensureRemoteRef(engine, repo, session);
  if (!ref.ok) return { ok: false, error: ref.error };
  if (ref.empty) return { ok: true, containers: [], tier: {}, empty: true };

  const listed = await listRemoteFiles(session.dir, repo.branch, engine.config.proxy);
  if (!listed.ok) return { ok: false, error: listed.error };

  const needle = String(query ?? '').trim().toLowerCase();
  const filtered = needle ? listed.files.filter((f) => f.path.toLowerCase().includes(needle)) : listed.files;

  const { containers, tier } = await buildHierarchy({ engine, repo, session, files: filtered });

  // 去掉一个文件都没有的容器。
  // 那种卡片看着像「有内容但删不掉」——实际仓库里就是没有对应文件，
  // 摆在界面上只会让人困惑（用户点「删除整组」时也确实没东西可删）。
  const visible = containers.filter((c) => c.items.length > 0);

  if (visible.length === 0) {
    return {
      ok: true,
      containers: [],
      tier,
      empty: true,
      totalFiles: listed.files.length,
      shownFiles: filtered.length,
    };
  }

  return {
    ok: true,
    containers: visible,
    tier,
    totalFiles: listed.files.length,
    shownFiles: filtered.length,
  };
}

/** 对比单个文件。 */
async function compareFile({ engine, repo, relPath }) {
  const session = engine.repoSession(repo);
  const prepared = await session.ensure();
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const ref = await ensureRemoteRef(engine, repo, session);
  if (!ref.ok) return { ok: false, error: ref.error };

  const remote = await showRemoteFile(session.dir, repo.branch, relPath, engine.config.proxy);
  if (!remote.ok) return { ok: false, error: remote.error };

  const sourceId = engine.sourceForRepo(repo)?.id ?? '';
  const localPath = localPathFor(engine, sourceId, relPath, undefined);
  const localExists = localPath ? exists(localPath) : false;
  const localBuffer = localExists ? fs.readFileSync(localPath) : undefined;

  // 和列表判定用同一套规整逻辑，保证「列表说一致、点进去也说一致」
  const comparable = await comparableRemote({ engine, sourceId, item: { path: relPath }, remoteBuffer: remote.buffer });
  const localNormalized = localExists ? normalizeLocal({ engine, sourceId, item: { path: relPath }, localPath }) : undefined;

  const remoteHash = sha256(comparable);
  const localHash = localNormalized ? sha256(localNormalized) : undefined;
  const binary = looksBinary(comparable, relPath) || (localNormalized ? looksBinary(localNormalized, relPath) : false);

  return {
    ok: true,
    relPath,
    localPath: localPath ?? '',
    localExists,
    remoteSize: comparable.length,
    localSize: localNormalized?.length ?? 0,
    remoteHash,
    localHash,
    same: remoteHash === localHash,
    binary,
    remoteText: binary ? undefined : comparable.toString('utf8'),
    localText: binary ? undefined : localNormalized?.toString('utf8'),
    hunks: binary ? undefined : diffLines(localNormalized?.toString('utf8') ?? '', comparable.toString('utf8')),
  };
}

async function takeRemote({ engine, repo, relPath }) {
  const session = engine.repoSession(repo);
  const prepared = await session.ensure();
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const ref = await ensureRemoteRef(engine, repo, session);
  if (!ref.ok) return { ok: false, error: ref.error };

  const remote = await showRemoteFile(session.dir, repo.branch, relPath, engine.config.proxy);
  if (!remote.ok) return { ok: false, error: remote.error };

  const sourceId = engine.sourceForRepo(repo)?.id ?? '';
  const localPath = localPathFor(engine, sourceId, relPath, undefined);
  if (!localPath) return { ok: false, error: '这个文件在本机没有对应位置' };

  // 写入前必须先还原成本机路径形式，否则会把 @ws/… 写进本地文件，App 就打不开了
  const comparable = await comparableRemote({ engine, sourceId, item: { path: relPath }, remoteBuffer: remote.buffer });

  engine.backupFile(localPath);
  writeFileAtomic(localPath, comparable);
  return { ok: true, localPath };
}

async function pushLocal({ engine, repo, relPath }) {
  const session = engine.repoSession(repo);
  const prepared = await session.ensure();
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const ref = await ensureRemoteRef(engine, repo, session);
  if (!ref.ok) return { ok: false, error: ref.error };

  const sourceId = engine.sourceForRepo(repo)?.id ?? '';
  const localPath = localPathFor(engine, sourceId, relPath, undefined);
  if (!localPath || !exists(localPath)) return { ok: false, error: '本机没有这个文件' };

  // 写进仓库前要转成逻辑路径形式，和整仓同步保持一致
  const localBuffer = fs.readFileSync(localPath);
  const stored = await logicalizeLocal({ engine, sourceId, item: { path: relPath }, localBuffer });

  writeFileAtomic(path.join(session.dir, ...relPath.split('/')), stored);
  const committed = await session.commitAndPush(`update ${relPath} from ${engine.machine}`);
  if (!committed.ok) return { ok: false, error: committed.error };
  return { ok: true, pushed: committed.pushed };
}

/** comparableRemote 的反向操作：本机内容 → 仓库里该有的形式。 */
async function logicalizeLocal({ engine, sourceId, item, localBuffer }) {
  const source = engine.sourceById(sourceId);
  const mapper = engine.mapperFor(sourceId);

  if (source?.meta?.generic || sourceId.startsWith('custom-')) {
    const tokens = buildTokenTable(engine, sourceId);
    return Buffer.from(tokenizePaths(localBuffer.toString('utf8'), mapper, tokens), 'utf8');
  }

  const text = localBuffer.toString('utf8');
  if (!text.includes('"cwd"')) return localBuffer;

  const stored = text
    .split('\n')
    .map((line) => {
      if (!line.includes('"cwd"')) return line;
      try {
        const value = JSON.parse(line);
        if (value && typeof value.cwd === 'string') {
          value.cwd = mapper.toLogical(value.cwd);
          return JSON.stringify(value);
        }
      } catch {}
      return line;
    })
    .join('\n');

  return Buffer.from(stored, 'utf8');
}

async function writeRemoteFile({ engine, repo, relPath, content, message }) {
  const session = engine.repoSession(repo);
  const prepared = await session.ensure();
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const ref = await ensureRemoteRef(engine, repo, session);
  if (!ref.ok) return { ok: false, error: ref.error };

  writeFileAtomic(path.join(session.dir, ...relPath.split('/')), Buffer.from(content, 'utf8'));
  const committed = await session.commitAndPush(message || `edit ${relPath} from ${engine.machine}`);
  if (!committed.ok) return { ok: false, error: committed.error };
  return { ok: true, pushed: committed.pushed };
}

/**
 * 删除远端文件。
 *
 * 支持一次删多条：全部删完只做**一次** commit + push。
 * 之前每条都单独提交推送，删一组 20 个文件就要 20 个来回，
 * 用户看到的就是「一直卡在加载 GitHub」。
 *
 * @param {string[]} relPaths
 */
async function deleteRemoteFiles({ engine, repo, relPaths }) {
  const paths = (Array.isArray(relPaths) ? relPaths : [relPaths]).filter(Boolean);
  if (paths.length === 0) return { ok: true, removed: 0, pushed: false, missing: [] };

  const session = engine.repoSession(repo);
  const prepared = await session.ensure();
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const ref = await ensureRemoteRef(engine, repo, session);
  if (!ref.ok) return { ok: false, error: ref.error };

  const branch = repo.branch;

  /**
   * 先把工作区对齐到 origin/<branch>。
   *
   * 为什么必须先做：
   *   界面列的是 origin/<branch> 的内容；如果本地 HEAD 落后（比如上次
   *   fetch 之后远端又变了），工作区里就没有那些文件。
   *   既会误判「文件不存在」，又会让后续 push 变成 non-fast-forward。
   *
   *   这里用 `reset --hard`：这棵工作树只是远端仓库的镜像，
   *   本机真正的数据在 ~/.dsh 里，不存在覆盖用户数据的风险。
   */
  const aligned = await runGit(['reset', '--hard', `origin/${branch}`], {
    cwd: session.dir,
    proxy: engine.config.proxy,
    timeoutMs: 60000,
  });
  if (!aligned.ok) {
    return { ok: false, error: `同步远端状态失败：${cleanGitError(aligned.stderr)}` };
  }

  /**
   * 判断「文件在远端存不存在」，必须以 **git 里的记录**为准，不能看工作区。
   *
   * 真实故障：界面列的是 origin/<branch> 的内容（那是远端的真实状态），
   * 但删除时却用 fs.existsSync(工作区路径) 去判断 —— 本地工作区可能因为
   * 从没检出、或 HEAD 落后于 origin 而没有这个文件，于是把「远端有」
   * 误判成「远端没有」，用户看到「这些文件在远端已经不存在了」。
   */
  const fileExistsInGit = async (relPath) => {
    const r = await runGit(['cat-file', '-e', `origin/${branch}:${relPath}`], {
      cwd: session.dir,
      proxy: engine.config.proxy,
      timeoutMs: 15000,
    });
    return r.ok;
  };

  const missing = [];
  let removed = 0;

  for (const relPath of paths) {
    const target = path.join(session.dir, ...relPath.split('/'));
    const inRemote = await fileExistsInGit(relPath);

    if (!inRemote) {
      missing.push(relPath);
      continue;
    }

    // 对齐之后理论上文件就在；万一还是缺，从 origin 取出来再删，
    // 保证 git 一定能感知到这次删除。
    if (!exists(target)) {
      const read = await runGit(['show', `origin/${branch}:${relPath}`], {
        cwd: session.dir,
        proxy: engine.config.proxy,
        timeoutMs: 60000,
      });
      if (!read.ok) {
        missing.push(relPath);
        continue;
      }
      writeFileAtomic(target, read.buffer);
    }

    fs.rmSync(target, { force: true });
    removed++;
  }

  if (removed === 0) {
    const detail = missing.length > 0 ? `（${missing.length} 个文件在远端确实不存在）` : '';
    return { ok: false, error: `这些文件在远端已经不存在了${detail}`, missing };
  }

  const label = paths.length === 1 ? `remove ${paths[0]}` : `remove ${removed} files`;
  const committed = await session.commitAndPush(`${label} from ${engine.machine}`);
  if (!committed.ok) return { ok: false, error: committed.error, removed, missing };
  return { ok: true, removed, pushed: committed.pushed, missing };
}

/** 单条删除的薄包装。 */
async function deleteRemoteFile({ engine, repo, relPath }) {
  return deleteRemoteFiles({ engine, repo, relPaths: [relPath] });
}

// ───────────────────────────────────────────── 工具

const TEXT_EXT = new Set([
  '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.md', '.txt', '.log', '.csv', '.tsv', '.xml', '.html', '.css', '.js', '.mjs',
  '.cjs', '.ts', '.py', '.sh', '.ps1', '.bat', '.gitignore',
]);

function looksBinary(buffer, relPath = '') {
  if (!buffer || buffer.length === 0) return false;
  const ext = path.extname(relPath).toLowerCase();
  if (TEXT_EXT.has(ext)) return false;

  const sample = buffer.subarray(0, Math.min(8192, buffer.length));
  let nul = 0;
  for (const byte of sample) if (byte === 0) nul++;
  return nul > 0 && nul / sample.length > 0.02;
}

function diffLines(leftText, rightText) {
  const left = leftText.split('\n');
  const right = rightText.split('\n');

  if (left.length * right.length > 4_000_000) {
    return [{ type: 'note', left: `本地 ${left.length} 行`, right: `远端 ${right.length} 行` }];
  }

  const n = left.length;
  const m = right.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      out.push({ type: 'same', left: left[i], right: right[j], leftLine: i + 1, rightLine: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ type: 'del', left: left[i], leftLine: i + 1 });
      i++;
    } else {
      out.push({ type: 'add', right: right[j], rightLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'del', left: left[i], leftLine: i + 1 });
    i++;
  }
  while (j < m) {
    out.push({ type: 'add', right: right[j], rightLine: j + 1 });
    j++;
  }

  return condense(out, 3);
}

function condense(rows, context) {
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'same') continue;
    for (let d = -context; d <= context; d++) {
      const index = i + d;
      if (index >= 0 && index < rows.length) keep[index] = true;
    }
  }

  const out = [];
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (skipped > 0) {
        out.push({ type: 'skip', count: skipped });
        skipped = 0;
      }
      out.push(rows[i]);
    } else {
      skipped++;
    }
  }
  if (skipped > 0) out.push({ type: 'skip', count: skipped });
  return out;
}

for (const __name of ["browseRemote","compareFile","takeRemote","pushLocal","writeRemoteFile","deleteRemoteFiles","deleteRemoteFile","diffLines"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
