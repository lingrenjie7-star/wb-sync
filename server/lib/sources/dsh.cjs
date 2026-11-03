const __imp0 = require('node:fs');
const __imp1 = require('node:path');
const __imp2 = require('../core.cjs');
const __imp3 = require('./base.cjs');
const fs = __imp0;
const path = __imp1;
const { decodeSession, displayTitle, encodeSegment, encodeSession, exists, isDir, listDshSessions, mergeBySeq, orderedUnion, projectKey, readJson, sessionTitle, walkFiles, looksSecret, writeFileAtomic } = __imp2;
const { allowed, putFile, safeName } = __imp3;
/**
 * DSH（DeepSeek Harness）数据源。
 *
 * 原生层级：**工作区 → 对话**
 * DSH 自己的侧边栏就是这么组织的，所以这里也按这个来。
 *
 * 工作区来自 `storages/workspace.json`，每个工作区下挂着它的对话。
 * 没归属到任何工作区的对话单独列一组。
 */






const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'AGENTS.md'];

/** 读工作区存储；读不到就返回空结构。 */
function readWorkspaceStore(config) {
  const file = path.join(config.softwareHome.dsh, 'storages', 'workspace.json');
  const store = readJson(file, undefined);
  return { file, store, workspaces: store?.tables?.workspaces ?? {} };
}

/** 扫描本机所有对话，按 cwd 归类。 */
function scanSessions(config) {
  const out = [];
  for (const item of listDshSessions(config.softwareHome.dsh)) {
    let decoded;
    let size = 0;
    try {
      const buffer = fs.readFileSync(item.abs);
      size = buffer.length;
      decoded = decodeSession(buffer, item.compression);
    } catch {
      continue;
    }
    const id = decoded.header?.id;
    if (typeof id !== 'string') continue;
    out.push({
      id,
      abs: item.abs,
      compression: item.compression,
      cwd: decoded.header?.cwd ?? '',
      title: displayTitle(decoded.events, decoded.header, id),
      events: decoded.events.length,
      bytes: size,
      mtime: safeMtime(item.abs),
    });
  }
  return out;
}

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

const dshSource = {
  meta: {
    id: 'dsh',
    label: 'DeepSeek Harness',
    shortLabel: 'DSH',
    icon: '◆',
    description: '按工作区管理对话与配置',
    tier: { containerLabel: '工作区', itemLabel: '对话' },
  },

  get id() {
    return this.meta.id;
  },
  get label() {
    return this.meta.label;
  },
  get icon() {
    return this.meta.icon;
  },

  detect(ctx) {
    const home = ctx.config.softwareHome.dsh;
    if (!isDir(home)) return { installed: false, detail: `找不到 ${home}` };
    const count = listDshSessions(home).length;
    return { installed: true, detail: `${count} 个对话` };
  },

  /**
   * 产出「工作区 → 对话」树。
   * 另外两个伪容器放配置与技能——它们不属于任何工作区，
   * 但用户仍然需要能单独勾选，所以当作「全局」分组。
   */
  containers(ctx) {
    const config = ctx.config;
    const { workspaces } = readWorkspaceStore(config);
    const sessions = scanSessions(config);
    const byCwd = new Map();
    for (const session of sessions) {
      const key = session.cwd || '';
      byCwd.set(key, [...(byCwd.get(key) ?? []), session]);
    }

    const containers = [];
    const claimed = new Set();

    // 1) 真实工作区
    for (const [wsId, record] of Object.entries(workspaces)) {
      const list = (record.sessionIds ?? [])
        .map((id) => sessions.find((s) => s.id === id))
        .filter(Boolean);
      for (const session of list) claimed.add(session.id);

      // 工作区目录下还有没登记的对话（比如新开但没刷新存储的）
      const extra = (byCwd.get(record.path) ?? []).filter((s) => !claimed.has(s.id));
      for (const session of extra) claimed.add(session.id);
      const all = [...list, ...extra];

      containers.push({
        id: wsId,
        key: `dsh/workspaces/${wsId}`,
        label: record.title ?? path.basename(record.path ?? ''),
        detail: record.path ?? '',
        localPath: record.path ?? '',
        bytes: all.reduce((sum, s) => sum + s.bytes, 0),
        items: all
          .sort((a, b) => b.mtime - a.mtime)
          .map((session) => ({
            key: `dsh/sessions/${session.id}`,
            label: session.title,
            detail: `${session.events} 条消息`,
            meta: formatShort(session.bytes),
            bytes: session.bytes,
          })),
      });
    }

    // 2) 没归属的对话
    const orphans = sessions.filter((s) => !claimed.has(s.id));
    if (orphans.length > 0) {
      const byProject = new Map();
      for (const session of orphans) {
        const key = session.cwd || '（无工作目录）';
        byProject.set(key, [...(byProject.get(key) ?? []), session]);
      }
      for (const [cwd, list] of byProject) {
        containers.push({
          id: `orphan:${cwd}`,
          key: `dsh/orphan/${safeName(cwd || 'no-cwd')}`,
          label: cwd ? path.basename(cwd) : '（无工作目录）',
          detail: cwd ? `${cwd}（未登记为工作区）` : '这些对话没有工作目录',
          localPath: cwd,
          bytes: list.reduce((sum, s) => sum + s.bytes, 0),
          items: list
            .sort((a, b) => b.mtime - a.mtime)
            .map((session) => ({
              key: `dsh/sessions/${session.id}`,
              label: session.title,
              detail: `${session.events} 条消息`,
              meta: formatShort(session.bytes),
              bytes: session.bytes,
            })),
        });
      }
    }

    // 3) 全局配置（插件、补丁层）
    const profilesRoot = path.join(config.softwareHome.dsh, 'profiles');
    if (isDir(profilesRoot)) {
      const items = [];
      for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        let bytes = 0;
        for (const name of PROFILE_FILES) {
          try {
            bytes += fs.statSync(path.join(profilesRoot, entry.name, name)).size;
          } catch {}
        }
        items.push({
          key: `dsh/profiles/${entry.name}`,
          label: `配置 · ${entry.name}`,
          detail: '插件清单 / 补丁层 / 锁文件',
          meta: formatShort(bytes),
          bytes,
        });
      }
      if (items.length > 0) {
        containers.push({
          id: '_profiles',
          key: 'dsh/profiles',
          label: '插件与配置',
          detail: '不属于任何工作区，全局生效',
          global: true,
          bytes: items.reduce((sum, i) => sum + i.bytes, 0),
          items,
        });
      }
    }

    // 4) 技能
    const skillItems = [];
    for (const [label, dir] of [
      ['dsh', path.join(config.softwareHome.dsh, 'skills')],
      ['agents', path.join(config.softwareHome.agents, 'skills')],
    ]) {
      if (!isDir(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const files = walkFiles(path.join(dir, entry.name), (rel) => ctx.skipByPattern(rel));
        skillItems.push({
          key: `dsh/skills/${label}/${entry.name}`,
          label: entry.name,
          detail: label === 'agents' ? '~/.agents/skills' : '~/.dsh/skills',
          meta: `${files.length} 个文件`,
          bytes: files.reduce((sum, f) => sum + f.size, 0),
        });
      }
    }
    if (skillItems.length > 0) {
      containers.push({
        id: '_skills',
        key: 'dsh/skills',
        label: '技能',
        detail: '自定义技能，全局生效',
        global: true,
        bytes: skillItems.reduce((sum, i) => sum + i.bytes, 0),
        items: skillItems,
      });
    }

    return containers;
  },

  collect(ctx, selection) {
    const config = ctx.config;
    let written = 0;

    // 对话：勾了工作区就带上它的对话
    const { workspaces: wsMap } = readWorkspaceStore(config);
    const sessionToWorkspace = new Map();
    for (const [wsId, record] of Object.entries(wsMap)) {
      for (const sessionId of record.sessionIds ?? []) sessionToWorkspace.set(sessionId, wsId);
    }

    for (const item of listDshSessions(config.softwareHome.dsh)) {
      let decoded;
      try {
        decoded = decodeSession(fs.readFileSync(item.abs), item.compression);
      } catch (error) {
        ctx.warn(`读不了对话 ${path.basename(item.abs)}：${error.message}`);
        continue;
      }
      const header = decoded.header;
      if (typeof header?.id !== 'string') continue;

      // 两种 key 都认：直接勾对话，或者勾它所属的工作区
      const key = `dsh/sessions/${header.id}`;
      const wsId = sessionToWorkspace.get(header.id);
      const viaWorkspace = wsId ? allowed(selection, `dsh/workspaces/${wsId}`) : false;
      if (!allowed(selection, key) && !viaWorkspace) continue;

      const rel = path.posix.join('dsh', 'sessions', `${encodeSegment(header.id)}.jsonl`);
      const exportedHeader = { ...header, cwd: ctx.mapper.toLogical(header.cwd) };
      const lines = [JSON.stringify(exportedHeader), ...decoded.events.map((e) => JSON.stringify(e))];
      putFile(ctx, rel, Buffer.from(lines.join('\n') + '\n', 'utf8'));
      written++;
    }

    // 工作区登记表：只保留被选中的工作区，去掉未选中的对话
    const { store, workspaces } = readWorkspaceStore(config);
    if (store) {
      const chosen = new Set(
        (selection?.keys ?? []).filter((k) => k.startsWith('dsh/workspaces/')).map((k) => k.slice('dsh/workspaces/'.length)),
      );
      const allSelected = !selection || selection.keys === null || selection.keys === undefined;

      const kept = {};
      for (const [id, record] of Object.entries(workspaces)) {
        if (!allSelected && !chosen.has(id)) continue;
        const clone = { ...record };
        if (typeof clone.path === 'string') clone.path = ctx.mapper.toLogical(clone.path);
        kept[id] = clone;
      }

      const out = structuredClone(store);
      out.tables = { ...(out.tables ?? {}), workspaces: kept };
      if (out.global) {
        out.global.workspaceIds = (out.global.workspaceIds ?? []).filter((id) => kept[id]);
        if (out.global.defaultWorkspaceId && !kept[out.global.defaultWorkspaceId]) delete out.global.defaultWorkspaceId;
      }
      putFile(ctx, 'dsh/storages/workspace.json', Buffer.from(JSON.stringify(out, null, 2) + '\n', 'utf8'));
      written++;
    }

    // 配置
    const profilesRoot = path.join(config.softwareHome.dsh, 'profiles');
    if (isDir(profilesRoot)) {
      for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!allowed(selection, `dsh/profiles/${entry.name}`)) continue;
        for (const name of PROFILE_FILES) {
          const abs = path.join(profilesRoot, entry.name, name);
          if (!exists(abs)) continue;
          const text = fs.readFileSync(abs, 'utf8');
          if (looksSecret(text)) {
            ctx.warn(`跳过疑似含密钥的配置：${name}`);
            continue;
          }
          putFile(ctx, path.posix.join('dsh', 'profiles', entry.name, name), Buffer.from(text, 'utf8'));
          written++;
        }
      }
    }

    // 技能
    for (const [label, dir] of [
      ['dsh', path.join(config.softwareHome.dsh, 'skills')],
      ['agents', path.join(config.softwareHome.agents, 'skills')],
    ]) {
      if (!isDir(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!allowed(selection, `dsh/skills/${label}/${entry.name}`)) continue;
        for (const file of walkFiles(path.join(dir, entry.name), (rel) => ctx.skipByPattern(rel))) {
          putFile(ctx, path.posix.join('dsh', 'skills', label, entry.name, file.rel), fs.readFileSync(file.abs));
          written++;
        }
      }
    }

    return written > 0 ? `DSH：采集 ${written} 个文件` : undefined;
  },

  apply(ctx, selection) {
    const applied = [];
    const conflicts = [];
    const config = ctx.config;

    /**
     * 「勾了工作区就带上它的对话」需要一张 对话 → 工作区 的索引。
     *
     * 关键：这张索引必须**同时**来自本机和远端仓库。
     *
     * 真实故障：原来只读本机的 workspace.json。在新机器上（从没同步过），
     * 本机是空的，于是远端的 sessA1 找不到所属工作区，被当成「未勾选」跳过 ——
     * 结果工作区同步过来了，但里面的对话一条都没有。
     */
    const wsIndex = new Map();
    const addIndex = (store) => {
      for (const [wsId, record] of Object.entries(store?.tables?.workspaces ?? {})) {
        for (const sessionId of record.sessionIds ?? []) wsIndex.set(sessionId, wsId);
      }
    };

    // 本机的
    addIndex(readWorkspaceStore(config).store);

    // 远端的（从仓库里那份 workspace.json 读）
    const remoteWsEntry = ctx.listRepoFiles('dsh/').find((e) => e.rel === 'dsh/storages/workspace.json');
    if (remoteWsEntry) {
      try {
        addIndex(JSON.parse(remoteWsEntry.buffer.toString('utf8')));
      } catch {}
    }

    const selectedViaWorkspace = (sessionId) => {
      const wsId = wsIndex.get(sessionId);
      return wsId ? allowed(selection, `dsh/workspaces/${wsId}`) : false;
    };

    for (const entry of ctx.listRepoFiles('dsh/')) {
      if (entry.rel === 'dsh/storages/workspace.json') {
        const result = applyWorkspaceStore(ctx, entry, selection);
        if (result.applied) applied.push(result.applied);
        continue;
      }
      if (entry.rel.startsWith('dsh/sessions/')) {
        const id = decodeSessionId(path.posix.basename(entry.rel));
        // 直接勾对话，或勾了它所属的工作区，都要落
        if (!allowed(selection, `dsh/sessions/${id}`) && !selectedViaWorkspace(id)) continue;
        const result = applySession(ctx, entry);
        if (result.applied) applied.push(result.applied);
        if (result.conflict) conflicts.push(result.conflict);
        continue;
      }
      if (entry.rel.startsWith('dsh/profiles/')) {
        const profile = entry.rel.split('/')[2];
        if (!allowed(selection, `dsh/profiles/${profile}`)) continue;
        const localPath = path.join(config.softwareHome.dsh, 'profiles', ...entry.rel.split('/').slice(2));
        const result = ctx.mergeFile(entry, localPath);
        if (result.applied) applied.push(result.applied);
        if (result.conflict) conflicts.push(result.conflict);
        continue;
      }
      if (entry.rel.startsWith('dsh/skills/')) {
        const [, , label, name] = entry.rel.split('/');
        if (!allowed(selection, `dsh/skills/${label}/${name}`)) continue;
        const base = label === 'agents' ? path.join(config.softwareHome.agents, 'skills') : path.join(config.softwareHome.dsh, 'skills');
        const localPath = path.join(base, ...entry.rel.split('/').slice(3));
        const result = ctx.mergeFile(entry, localPath);
        if (result.applied) applied.push(result.applied);
        if (result.conflict) conflicts.push(result.conflict);
      }
    }

    return { applied, conflicts };
  },
};

// ───────────────────────────────────────────── 内部

function formatShort(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function decodeSessionId(fileName) {
  const raw = fileName.replace(/\.jsonl$/, '');
  return raw.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function findLocalSession(ctx, id) {
  const root = path.join(ctx.config.softwareHome.dsh, 'sessions');
  const wanted = encodeSegment(id);
  if (!isDir(root)) return undefined;
  for (const projectEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const sessionDir = path.join(root, projectEntry.name, wanted);
    if (!isDir(sessionDir)) continue;
    const files = fs.readdirSync(sessionDir);
    const chosen = files
      .map((name) => {
        const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name);
        return match ? { name, version: Number(match[1]), compression: match[2] ? 'zstd' : 'none' } : undefined;
      })
      .filter(Boolean)
      .sort((a, b) => b.version - a.version)[0];
    if (chosen) return { abs: path.join(sessionDir, chosen.name), ...chosen };
  }
  return undefined;
}

function applySession(ctx, entry) {
  const lines = entry.buffer
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return {};

  let repoHeader;
  try {
    repoHeader = JSON.parse(lines[0]);
  } catch {
    return {};
  }
  const repoEvents = [];
  for (const line of lines.slice(1)) {
    try {
      repoEvents.push(JSON.parse(line));
    } catch {}
  }
  const id = repoHeader.id;
  if (typeof id !== 'string') return {};

  const local = findLocalSession(ctx, id);
  let localHeader;
  let localEvents = [];
  if (local) {
    try {
      const decoded = decodeSession(fs.readFileSync(local.abs), local.compression);
      localHeader = decoded.header;
      localEvents = decoded.events;
    } catch {
      localHeader = undefined;
    }
  }

  const { events, added, forked } = mergeBySeq(localEvents, repoEvents);

  const logicalCwd = typeof repoHeader.cwd === 'string' ? repoHeader.cwd : undefined;
  const mappedCwd = logicalCwd ? ctx.mapper.toLocalLenient(logicalCwd) : undefined;
  const cwd = typeof localHeader?.cwd === 'string' ? localHeader.cwd : mappedCwd;
  if (typeof cwd !== 'string' || cwd.length === 0) {
    ctx.warn(`对话 ${id.slice(0, 12)} 没有工作目录，跳过`);
    return {};
  }

  const version = typeof (localHeader ?? repoHeader).version === 'number' ? (localHeader ?? repoHeader).version : 4;
  const compression = local ? local.compression : 'zstd';
  const header = { ...repoHeader, ...(localHeader ?? {}), id, cwd };
  const merged = encodeSession(header, events, compression);

  const repoHeaderLogical = { ...header, cwd: ctx.mapper.toLogical(cwd) };
  const repoLines = [JSON.stringify(repoHeaderLogical), ...events.map((e) => JSON.stringify(e))];
  const nextRepoBuffer = Buffer.from(repoLines.join('\n') + '\n', 'utf8');
  if (!nextRepoBuffer.equals(entry.buffer)) ctx.writeRepoFile(entry.abs, nextRepoBuffer);

  let applied;
  if (local && merged.equals(fs.readFileSync(local.abs))) {
    applied = undefined;
  } else {
    const dir = path.join(ctx.config.softwareHome.dsh, 'sessions', projectKey(cwd), encodeSegment(id));
    fs.mkdirSync(dir, { recursive: true });
    if (local) ctx.backupFile(local.abs);
    writeFileAtomic(path.join(dir, `session.v${version}.jsonl${compression === 'zstd' ? '.zstd' : ''}`), merged);
    const title = sessionTitle(events) ?? id.slice(0, 12);
    applied = local ? `合并对话「${title}」（+${added} 条）` : `导入对话「${title}」`;
  }

  let conflict;
  if (forked.length > 0) {
    const forkId = `${id}.fork-${ctx.machine}-${Date.now()}`;
    const dir = path.join(ctx.config.softwareHome.dsh, 'sessions', projectKey(cwd), encodeSegment(forkId));
    fs.mkdirSync(dir, { recursive: true });
    const forkHeader = { type: 'session', version, id: forkId, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 };
    writeFileAtomic(
      path.join(dir, `session.v${version}.jsonl${compression === 'zstd' ? '.zstd' : ''}`),
      encodeSession(forkHeader, forked, compression),
    );
    conflict = `对话 ${id.slice(0, 12)} 有 ${forked.length} 条消息冲突，已另存分支`;
  }

  return { applied, conflict };
}

function applyWorkspaceStore(ctx, entry, selection) {
  let remote;
  try {
    remote = JSON.parse(entry.buffer.toString('utf8'));
  } catch {
    return {};
  }
  const config = ctx.config;
  const file = path.join(config.softwareHome.dsh, 'storages', 'workspace.json');
  const local = readJson(file, undefined);
  const merged = combineWorkspaces(ctx, local, remote, selection);
  const localText = local ? JSON.stringify(local) : '';
  const applied = localText === JSON.stringify(merged) ? undefined : `合并 DSH 工作区（${Object.keys(merged.tables.workspaces).length} 个）`;
  if (applied) {
    ctx.backupFile(file);
    writeFileAtomic(file, Buffer.from(JSON.stringify(merged, null, 2) + '\n', 'utf8'));
  }

  const repoView = structuredClone(merged);
  for (const record of Object.values(repoView.tables?.workspaces ?? {})) {
    if (typeof record.path === 'string') record.path = ctx.mapper.toLogical(record.path);
  }
  const nextRepo = Buffer.from(JSON.stringify(repoView, null, 2) + '\n', 'utf8');
  if (!nextRepo.equals(entry.buffer)) ctx.writeRepoFile(entry.abs, nextRepo);
  return { applied };
}

function combineWorkspaces(ctx, local, remote, selection) {
  const records = {};
  const allowedKey = (id) => allowed(selection, `dsh/workspaces/${id}`);

  for (const [id, record] of Object.entries(local?.tables?.workspaces ?? {})) {
    records[id] = { ...record, path: ctx.mapper.toLocalLenient(record.path), sessionIds: [...(record.sessionIds ?? [])] };
  }
  for (const [id, record] of Object.entries(remote?.tables?.workspaces ?? {})) {
    if (!allowedKey(id)) continue;
    const localPath = ctx.mapper.toLocalLenient(record.path);
    if (!records[id]) {
      records[id] = {
        path: localPath,
        title: record.title ?? path.basename(localPath),
        sessionIds: [...(record.sessionIds ?? [])],
        createdAt: record.createdAt ?? new Date().toISOString(),
        updatedAt: record.updatedAt ?? new Date().toISOString(),
      };
      continue;
    }
    const target = records[id];
    target.sessionIds = orderedUnion(target.sessionIds, record.sessionIds ?? []);
    if (String(record.updatedAt ?? '') > String(target.updatedAt ?? '')) {
      target.title = record.title ?? target.title;
      target.updatedAt = record.updatedAt;
    }
  }

  const byPath = new Map();
  for (const [id, record] of Object.entries(records)) {
    const key = process.platform === 'win32' ? record.path.toLowerCase() : record.path;
    const holder = byPath.get(key);
    if (holder === undefined) {
      byPath.set(key, id);
      continue;
    }
    const keeper = records[holder];
    keeper.sessionIds = orderedUnion(keeper.sessionIds, record.sessionIds);
    delete records[id];
  }

  const claimed = new Set();
  for (const record of Object.values(records)) {
    record.sessionIds = record.sessionIds.filter((sessionId) => {
      if (claimed.has(sessionId)) return false;
      claimed.add(sessionId);
      return true;
    });
  }

  const workspaceIds = orderedUnion(
    (local?.global?.workspaceIds ?? []).filter((id) => records[id]),
    (remote?.global?.workspaceIds ?? []).filter((id) => records[id]),
  );
  for (const id of Object.keys(records)) if (!workspaceIds.includes(id)) workspaceIds.push(id);

  const localDefault = local?.global?.defaultWorkspaceId;
  const defaultWorkspaceId = (localDefault && records[localDefault] ? localDefault : undefined) ?? workspaceIds[0];

  return {
    unit: local?.unit ?? remote?.unit ?? { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds,
      archivedSessionIds: orderedUnion(local?.global?.archivedSessionIds ?? [], remote?.global?.archivedSessionIds ?? []),
      pinnedSessionIds: orderedUnion(local?.global?.pinnedSessionIds ?? [], remote?.global?.pinnedSessionIds ?? []),
      ...(defaultWorkspaceId ? { defaultWorkspaceId } : {}),
    },
    tables: { workspaces: records },
  };
}

for (const __name of ["dshSource"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
