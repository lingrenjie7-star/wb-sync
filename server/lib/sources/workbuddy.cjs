const __imp0 = require('node:fs');
const __imp1 = require('node:os');
const __imp2 = require('node:path');
const __imp4 = require('../core.cjs');
const __imp5 = require('./base.cjs');
const fs = __imp0;
const os = __imp1;
const path = __imp2;

const { exists, isDir, walkFiles, looksSecret, writeFileAtomic, workbuddySlug, rewriteJsonCwd } = __imp4;
const { allowed, putFile, safeName } = __imp5;
/**
 * WorkBuddy 数据源。
 *
 * 原生层级：**项目 → 对话**
 *
 * 三个坑：
 *   1. 对话目录名由 cwd 派生（`projects/<slug>`），换机要重算；
 *   2. 光有 jsonl 不够——会话列表在 workbuddy.db 里，不补表就是「文件在、列表空」；
 *   3. 有些子线程文件不带 cwd，得靠索引里的记录兜底。
 */

// ───────────────────────────────────────────── sqlite

function DatabaseSyncClass() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
}

function sqliteAvailable() {
  return DatabaseSyncClass() !== undefined;
}

/** 复制一份数据库再读，避免锁住正在运行的应用。 */
function readWorkbuddyIndex(workbuddyHome) {
  const DatabaseSync = DatabaseSyncClass();
  if (!DatabaseSync) return undefined;
  const file = path.join(workbuddyHome, 'workbuddy.db');
  if (!exists(file)) return undefined;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshwb-db-'));
  const copy = path.join(dir, 'workbuddy.db');
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (exists(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const sessions = db
        .prepare(
          'select id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at, source_mode, mode, model, thought_level, permission_mode, deleted_at from sessions',
        )
        .all();
      const workspaces = db.prepare('select path, last_opened_at from workspaces').all();
      return { sessions, workspaces };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 只补本机缺的行，已有的不动。 */
function mergeWorkbuddyIndex(workbuddyHome, rows, workspaces) {
  const DatabaseSync = DatabaseSyncClass();
  if (!DatabaseSync) return { inserted: 0 };
  const file = path.join(workbuddyHome, 'workbuddy.db');
  if (!exists(file)) return { inserted: 0, missing: true };

  const db = new DatabaseSync(file);
  let inserted = 0;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const insert = db.prepare(
      `insert or ignore into sessions
       (id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at,
        source_mode, mode, model, thought_level, permission_mode, is_playground, unread, transport)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,'local')`,
    );
    const insertWorkspace = db.prepare('insert or ignore into workspaces (path, last_opened_at) values (?,?)');
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const result = insert.run(
          row.id,
          row.cwd,
          row.user_id,
          row.title ?? null,
          row.custom_title ?? null,
          row.status ?? 'completed',
          row.created_at,
          row.updated_at,
          row.last_activity_at ?? row.updated_at,
          row.source_mode ?? null,
          row.mode ?? null,
          row.model ?? null,
          row.thought_level ?? null,
          row.permission_mode ?? null,
        );
        if (result.changes > 0) inserted++;
      }
      for (const workspace of workspaces) insertWorkspace.run(workspace.path, workspace.last_opened_at);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    return { inserted, error: error.message };
  } finally {
    db.close();
  }
  return { inserted };
}

// ───────────────────────────────────────────── 项目

function projectCwd(projectDir, cwdById) {
  let files;
  try {
    files = fs.readdirSync(projectDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  for (const name of files) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(projectDir, name), 'utf8').split('\n').slice(0, 4);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue;
      try {
        const value = JSON.parse(line);
        if (typeof value.cwd === 'string' && value.cwd.length > 0) return value.cwd;
      } catch {}
    }
  }
  for (const name of files) {
    const cwd = cwdById.get(name.replace(/\.jsonl$/, ''));
    if (cwd) return cwd;
  }
  return undefined;
}

function listProjects(workbuddyHome) {
  const projectsRoot = path.join(workbuddyHome, 'projects');
  if (!isDir(projectsRoot)) return [];

  const index = sqliteAvailable() ? readWorkbuddyIndex(workbuddyHome) : undefined;
  const cwdById = new Map();
  const titleById = new Map();
  for (const row of index?.sessions ?? []) {
    if (typeof row.id === 'string') {
      if (typeof row.cwd === 'string') cwdById.set(row.id, row.cwd);
      if (typeof row.title === 'string') titleById.set(row.id, row.title);
    }
  }

  const out = [];
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsRoot, entry.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true }).filter(
        (e) => e.isFile() && e.name.endsWith('.jsonl') && !e.name.includes('.fork-') && !e.name.includes('.conflict-'),
      );
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const cwd = projectCwd(dir, cwdById);
    const items = files
      .map((file) => {
        const id = file.name.replace(/\.jsonl$/, '');
        const stat = safeStat(path.join(dir, file.name));
        return {
          key: `workbuddy/sessions/${entry.name}/${file.name}`,
          id,
          name: file.name,
          label: titleById.get(id) ?? `对话 ${id.slice(0, 8)}`,
          detail: stat.mtime ? formatWhen(stat.mtime) : '',
          meta: formatShort(stat.size),
          bytes: stat.size,
          mtime: stat.mtime,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    out.push({
      dirName: entry.name,
      dir,
      cwd,
      files,
      bytes: items.reduce((sum, i) => sum + i.bytes, 0),
      items,
    });
  }
  return out;
}

function safeStat(file) {
  try {
    const stat = fs.statSync(file);
    return { size: stat.size, mtime: stat.mtimeMs };
  } catch {
    return { size: 0, mtime: 0 };
  }
}

function formatWhen(ms) {
  const date = new Date(ms);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatShort(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ───────────────────────────────────────────── 适配器

const workbuddySource = {
  meta: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    shortLabel: 'WorkBuddy',
    icon: '◈',
    description: '按项目管理对话与记忆',
    tier: { containerLabel: '项目', itemLabel: '对话' },
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
    const home = ctx.config.softwareHome.workbuddy;
    if (!isDir(home)) return { installed: false, detail: `找不到 ${home}` };
    const projects = listProjects(home).length;
    return { installed: true, detail: `${projects} 个项目` };
  },

  containers(ctx) {
    const home = ctx.config.softwareHome.workbuddy;
    const containers = [];

    for (const project of listProjects(home)) {
      containers.push({
        id: project.dirName,
        key: `workbuddy/projects/${project.dirName}`,
        label: project.cwd ? path.basename(project.cwd) : project.dirName,
        detail: project.cwd ?? '（缺少路径记录）',
        localPath: project.cwd ?? '',
        bytes: project.bytes,
        items: project.items.map((item) => ({
          // 对话 key 挂在项目下，这样「勾项目 = 勾全部对话」
          key: `workbuddy/projects/${project.dirName}/${item.name}`,
          label: item.label,
          detail: item.detail,
          meta: item.meta,
          bytes: item.bytes,
        })),
      });
    }

    // 会话列表索引：让对话能在应用里显示
    if (sqliteAvailable()) {
      const index = readWorkbuddyIndex(home);
      if (index) {
        containers.push({
          id: '_index',
          key: 'workbuddy/index',
          label: '会话列表',
          detail: '让对话在 WorkBuddy 里正常显示',
          global: true,
          bytes: 0,
          items: [
            {
              key: 'workbuddy/index',
              label: '会话列表索引',
              detail: 'workbuddy.db 里的 sessions / workspaces 表',
              meta: `${index.sessions.length} 条`,
              bytes: 0,
            },
          ],
        });
      }
    }

    // 记忆与配置
    const memoryItems = [];
    for (const file of walkFiles(path.join(home, 'memory'), (rel) => ctx.skipByPattern(rel))) {
      memoryItems.push({
        key: `workbuddy/memory/${file.rel}`,
        label: path.posix.basename(file.rel),
        detail: `memory/${file.rel}`,
        meta: formatShort(file.size),
        bytes: file.size,
      });
    }
    for (const name of ['MEMORY.md', 'models.json', 'settings.json']) {
      const abs = path.join(home, name);
      if (!exists(abs)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      const blocked = looksSecret(text);
      memoryItems.push({
        key: `workbuddy/config/${name}`,
        label: name,
        detail: blocked ? '全局配置（含密钥，不会同步）' : '全局配置',
        meta: blocked ? '跳过' : formatShort(safeStat(abs).size),
        bytes: blocked ? 0 : safeStat(abs).size,
        blocked,
      });
    }
    if (memoryItems.length > 0) {
      containers.push({
        id: '_memory',
        key: 'workbuddy/memory-root',
        label: '记忆与配置',
        detail: '全局生效',
        global: true,
        bytes: memoryItems.reduce((sum, i) => sum + i.bytes, 0),
        items: memoryItems,
      });
    }

    // 技能
    const skillsRoot = path.join(home, 'skills');
    if (isDir(skillsRoot)) {
      const items = [];
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const files = walkFiles(path.join(skillsRoot, entry.name), (rel) => ctx.skipByPattern(rel));
        items.push({
          key: `workbuddy/skills/${entry.name}`,
          label: entry.name,
          detail: '~/.workbuddy/skills',
          meta: `${files.length} 个文件`,
          bytes: files.reduce((sum, f) => sum + f.size, 0),
        });
      }
      if (items.length > 0) {
        containers.push({
          id: '_skills',
          key: 'workbuddy/skills',
          label: '技能',
          detail: '全局生效',
          global: true,
          bytes: items.reduce((sum, i) => sum + i.bytes, 0),
          items,
        });
      }
    }

    return containers;
  },

  collect(ctx, selection) {
    const home = ctx.config.softwareHome.workbuddy;
    let written = 0;

    const projects = [];
    for (const project of listProjects(home)) {
      // 勾了项目容器就带上它的全部对话
      const projectKey = `workbuddy/projects/${project.dirName}`;
      const viaProject = allowed(selection, projectKey);
      const kept = project.items.filter(
        (item) => viaProject || allowed(selection, `${projectKey}/${item.name}`),
      );
      if (kept.length === 0) continue;

      const logicalCwd = project.cwd ? ctx.mapper.toLogical(project.cwd) : undefined;
      const logicalKey = logicalCwd ? workbuddySlug(logicalCwd) : `_unknown-${project.dirName}`;
      projects.push({ key: logicalKey, cwd: logicalCwd ?? null, dirName: project.dirName });

      for (const item of kept) {
        const raw = fs.readFileSync(path.join(project.dir, item.name));
        const text = rewriteJsonCwd(raw.toString('utf8'), (value) => ctx.mapper.toLogical(value));
        putFile(ctx, path.posix.join('workbuddy', 'sessions', logicalKey, item.name), Buffer.from(text, 'utf8'));
        written++;
      }
    }

    // 一个对话都没选上也别写空清单，那会让远端丢项目记录
    if (projects.length > 0 || !selection?.keys) {
      putFile(
        ctx,
        'workbuddy/projects.json',
        Buffer.from(JSON.stringify({ schema: 'dshwb-sync/workbuddy-projects@2', projects }, null, 2) + '\n', 'utf8'),
      );
    }

    if (sqliteAvailable() && allowed(selection, 'workbuddy/index')) {
      const index = readWorkbuddyIndex(home);
      if (index) {
        const sessions = index.sessions
          .filter((row) => row.deleted_at === null || row.deleted_at === undefined)
          .filter((row) => typeof row.cwd === 'string' && row.cwd.length > 0)
          .map((row) => ({ ...row, cwd: ctx.mapper.toLogical(row.cwd) }));
        const workspaces = index.workspaces
          .filter((row) => typeof row.path === 'string' && row.path.length > 0)
          .map((row) => ({ ...row, path: ctx.mapper.toLogical(row.path) }));

        putFile(
          ctx,
          'workbuddy/index.json',
          Buffer.from(JSON.stringify({ schema: 'dshwb-sync/workbuddy-index@1', sessions, workspaces }, null, 2) + '\n', 'utf8'),
        );
        written++;
      }
    }

    for (const file of walkFiles(path.join(home, 'memory'), (rel) => ctx.skipByPattern(rel))) {
      if (!allowed(selection, `workbuddy/memory/${file.rel}`)) continue;
      putFile(ctx, path.posix.join('workbuddy', 'memory', file.rel), fs.readFileSync(file.abs));
      written++;
    }
    for (const name of ['MEMORY.md', 'models.json', 'settings.json']) {
      const abs = path.join(home, name);
      if (!exists(abs)) continue;
      if (!allowed(selection, `workbuddy/config/${name}`)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      if (looksSecret(text)) {
        ctx.warn(`${name} 含密钥，已跳过`);
        continue;
      }
      putFile(ctx, path.posix.join('workbuddy', 'config', name), Buffer.from(text, 'utf8'));
      written++;
    }

    const skillsRoot = path.join(home, 'skills');
    if (isDir(skillsRoot)) {
      for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!allowed(selection, `workbuddy/skills/${entry.name}`)) continue;
        for (const file of walkFiles(path.join(skillsRoot, entry.name), (rel) => ctx.skipByPattern(rel))) {
          putFile(ctx, path.posix.join('workbuddy', 'skills', entry.name, file.rel), fs.readFileSync(file.abs));
          written++;
        }
      }
    }

    return written > 0 ? `WorkBuddy：采集 ${written} 个文件` : undefined;
  },

  apply(ctx, selection) {
    const applied = [];
    const conflicts = [];
    const home = ctx.config.softwareHome.workbuddy;

    // 项目清单决定「仓库里的逻辑项目」对应本机哪个目录
    const projectsEntry = ctx.findRepoFile('workbuddy/projects.json');
    const projectCwd = new Map();
    if (projectsEntry) {
      try {
        const manifest = JSON.parse(projectsEntry.buffer.toString('utf8'));
        for (const project of manifest.projects ?? []) {
          if (typeof project?.key === 'string' && typeof project?.cwd === 'string') projectCwd.set(project.key, project.cwd);
        }
      } catch {}
    }

    for (const entry of ctx.listRepoFiles('workbuddy/')) {
      if (entry.rel === 'workbuddy/projects.json') continue;

      if (entry.rel === 'workbuddy/index.json') {
        if (!allowed(selection, 'workbuddy/index')) continue;
        const result = applyIndex(ctx, entry);
        if (result.applied) applied.push(result.applied);
        continue;
      }

      if (entry.rel.startsWith('workbuddy/sessions/')) {
        const parts = entry.rel.split('/');
        const logicalKey = parts[2];
        const sessionName = parts[3];
        // 仓库按 slug 分目录，选择集按本机 dirName 记；两边都要能对上
        const viaProject = projectCwd.has(logicalKey)
          ? allowed(selection, `workbuddy/projects/${logicalKey}`) ||
            allowed(selection, `workbuddy/projects/${findDirName(projectCwd, logicalKey) ?? logicalKey}`)
          : allowed(selection, `workbuddy/projects/${logicalKey}`);
        const viaSession = allowed(selection, entry.rel);
        if (!viaProject && !viaSession) continue;
        const result = applySession(ctx, entry, logicalKey, sessionName, projectCwd);
        if (result.applied) applied.push(result.applied);
        if (result.conflict) conflicts.push(result.conflict);
        continue;
      }

      if (entry.rel.startsWith('workbuddy/memory/')) {
        if (!allowed(selection, `workbuddy/memory/${entry.rel.slice('workbuddy/memory/'.length)}`)) continue;
        const localPath = path.join(home, 'memory', ...entry.rel.split('/').slice(2));
        const result = ctx.mergeFile(entry, localPath);
        if (result.applied) applied.push(result.applied);
        if (result.conflict) conflicts.push(result.conflict);
        continue;
      }

      if (entry.rel.startsWith('workbuddy/config/')) {
        const name = entry.rel.split('/')[2];
        if (!allowed(selection, `workbuddy/config/${name}`)) continue;
        const result = ctx.mergeFile(entry, path.join(home, name));
        if (result.applied) applied.push(result.applied);
        if (result.conflict) conflicts.push(result.conflict);
        continue;
      }

      if (entry.rel.startsWith('workbuddy/skills/')) {
        const name = entry.rel.split('/')[2];
        if (!allowed(selection, `workbuddy/skills/${name}`)) continue;
        const localPath = path.join(home, 'skills', ...entry.rel.split('/').slice(2));
        const result = ctx.mergeFile(entry, localPath);
        if (result.applied) applied.push(result.applied);
        if (result.conflict) conflicts.push(result.conflict);
      }
    }

    return { applied, conflicts };
  },
};

// ───────────────────────────────────────────── 内部

/** 仓库里的项目键是 slug，本机界面用的是 dirName；查回 dirName。 */
function findDirName(projectCwd, logicalKey) {
  for (const [key, cwd] of projectCwd.entries()) {
    if (key === logicalKey) return key;
    if (cwd && workbuddySlug(cwd) === logicalKey) return key;
  }
  return undefined;
}

function applySession(ctx, entry, logicalKey, sessionName, projectCwd) {
  const logicalCwd = projectCwd.get(logicalKey);
  if (!logicalCwd) {
    ctx.warn(`WorkBuddy 项目 ${logicalKey} 没有记录路径，跳过`);
    return {};
  }

  const rootId = ctx.mapper.rootIdOf(logicalCwd);
  if (rootId && ctx.mapper.localRoot(rootId) === undefined) return { skipped: true };

  const localCwd = ctx.mapper.toLocalLenient(logicalCwd);
  const dir = path.join(ctx.config.softwareHome.workbuddy, 'projects', workbuddySlug(localCwd));
  const target = path.join(dir, sessionName);
  const remoteText = rewriteJsonCwd(entry.buffer.toString('utf8'), (value) => ctx.mapper.toLocalLenient(value));

  if (!exists(target)) {
    writeFileAtomic(target, Buffer.from(remoteText, 'utf8'));
    return { applied: `导入 WorkBuddy 对话 ${sessionName.slice(0, 8)}` };
  }

  const localText = fs.readFileSync(target, 'utf8');
  if (localText === remoteText) return {};

  if (remoteText.startsWith(localText)) {
    ctx.backupFile(target);
    writeFileAtomic(target, Buffer.from(remoteText, 'utf8'));
    const added = remoteText.split('\n').length - localText.split('\n').length;
    return { applied: `追加 WorkBuddy 对话 ${sessionName.slice(0, 8)}（+${added} 行）` };
  }

  if (localText.startsWith(remoteText)) {
    const backText = rewriteJsonCwd(localText, (value) => ctx.mapper.toLogical(value));
    ctx.writeRepoFile(entry.abs, Buffer.from(backText, 'utf8'));
    return {};
  }

  const forkName = sessionName.replace(/\.jsonl$/, '') + `.fork-${ctx.machine}-${Date.now()}.jsonl`;
  writeFileAtomic(path.join(dir, forkName), Buffer.from(remoteText, 'utf8'));
  return { conflict: `WorkBuddy 对话 ${sessionName.slice(0, 8)} 两边都改过，已另存一份` };
}

function applyIndex(ctx, entry) {
  const home = ctx.config.softwareHome.workbuddy;
  let index;
  try {
    index = JSON.parse(entry.buffer.toString('utf8'));
  } catch {
    return {};
  }
  if (!sqliteAvailable()) {
    ctx.warn('当前环境没有 node:sqlite，WorkBuddy 会话列表无法落地');
    return {};
  }
  const local = readWorkbuddyIndex(home);
  const dbFile = path.join(home, 'workbuddy.db');
  if (!local) {
    if (!exists(dbFile)) ctx.warn('本机还没运行过 WorkBuddy，先启动一次它再同步，对话列表就能补上');
    return {};
  }

  const localIds = new Set(local.sessions.map((row) => row.id));
  const missing = (index.sessions ?? [])
    .filter((row) => typeof row?.id === 'string' && !localIds.has(row.id))
    .filter((row) => typeof row.cwd === 'string' && row.cwd.length > 0)
    .map((row) => ({ ...row, cwd: ctx.mapper.toLocalLenient(row.cwd).replace(/\\/g, '/') }));

  const localPaths = new Set(local.workspaces.map((row) => row.path));
  const missingWorkspaces = (index.workspaces ?? [])
    .filter((row) => typeof row?.path === 'string')
    .map((row) => ({ path: ctx.mapper.toLocalLenient(row.path).replace(/\\/g, '/'), last_opened_at: row.last_opened_at ?? Date.now() }))
    .filter((row) => !localPaths.has(row.path));

  if (missing.length === 0 && missingWorkspaces.length === 0) return {};

  ctx.backupFile(dbFile);
  const result = mergeWorkbuddyIndex(home, missing, missingWorkspaces);
  return { applied: result.inserted > 0 ? `补齐 WorkBuddy 会话列表（+${result.inserted} 条）` : undefined };
}

for (const __name of ["sqliteAvailable","readWorkbuddyIndex","mergeWorkbuddyIndex","workbuddySource"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
