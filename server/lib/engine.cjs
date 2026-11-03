const __imp0 = require('node:fs');
const __imp1 = require('node:path');
const __imp2 = require('./core.cjs');
const __imp3 = require('./sources/index.cjs');
const __imp4 = require('./identity.cjs');
const fs = __imp0;
const path = __imp1;
const { cleanGitError, decodeSegment, decodeSession, encodeSegment, exists, expandHome, formatBytes, globMatch, homeDir, isDir, projectKey, readJson, remoteUrl, runGit, sha256, workbuddySlug, writeFileAtomic, writeJsonAtomic } = __imp2;
const { buildSources } = __imp3;
const { buildMarker, MARKER_FILE } = __imp4;
/**
 * 仓库管理 + 同步引擎（按软件原生层级）。
 *
 * 规则：
 *   · 一个软件只绑定一个仓库（DSH 只进 DSH 仓，WorkBuddy 只进 WB 仓）；
 *   · 展示与勾选按软件自己的层级：工作区 → 对话；
 *   · 每个软件配一个「总目录」，克隆时按它推导具体路径。
 */







const ENGINE_VERSION = '4.0.0';

function defaultConfig() {
  return {
    version: 4,
    machine: hostSlug(),
    github: { login: '', avatar: '' },
    proxy: '',
    /** 每个软件一个总目录（软件自己的数据目录） */
    softwareHome: {
      dsh: '~/.dsh',
      workbuddy: '~/.workbuddy',
      agents: '~/.agents',
      codex: '~/.codex',
      claude: '~/.claude',
      cursor: '~/.cursor',
      aider: '~/.aider',
    },
    /** 工作区根目录：项目都放在这下面，换机只改这里 */
    workspaceRoot: { dsh: '', workbuddy: '' },
    /** 兼容旧配置：显式路径映射仍然优先 */
    roots: [],
    extraRewrites: [],
    repos: [],
    customSources: [],
    exclude: {
      filePatterns: ['*.bak', '*.bak.*', '*.tmp', '*.tmp.*', '*~', '.DS_Store', 'Thumbs.db'],
    },
    limits: { maxFileBytes: 90 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 * 1024 },
    backup: { keep: 20 },
  };
}

function hostSlug() {
  const raw = (process.env.COMPUTERNAME || homeDir.split(path.sep).pop() || 'pc').toString();
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'pc';
}

/** 判断 git 失败是不是网络问题，值得换通道重试。 */
function isNetworkError(stderr) {
  const text = String(stderr ?? '').toLowerCase();
  return [
    'could not connect',
    'failed to connect',
    'connection was reset',
    'connection refused',
    'recv failure',
    'timeout',
    'timed out',
    'network is unreachable',
    'could not resolve host',
    'econnrefused',
    'econnreset',
    'etimedout',
  ].some((needle) => text.includes(needle));
}

function normalizeConfig(config) {
  const base = defaultConfig();
  const merged = { ...base, ...(config ?? {}) };
  merged.exclude = { ...base.exclude, ...(config?.exclude ?? {}) };
  merged.limits = { ...base.limits, ...(config?.limits ?? {}) };
  merged.backup = { ...base.backup, ...(config?.backup ?? {}) };
  merged.github = { ...base.github, ...(config?.github ?? {}) };
  merged.softwareHome = { ...base.softwareHome, ...(config?.softwareHome ?? {}) };
  merged.workspaceRoot = { ...base.workspaceRoot, ...(config?.workspaceRoot ?? {}) };

  // 旧配置的顶层路径迁到 softwareHome
  for (const key of ['dshHome', 'workbuddyHome', 'agentsHome', 'codexHome', 'claudeHome', 'cursorHome', 'aiderHome']) {
    if (typeof config?.[key] === 'string' && config[key]) {
      merged.softwareHome[key.replace(/Home$/, '')] = config[key];
    }
  }
  for (const key of Object.keys(merged.softwareHome)) {
    merged.softwareHome[key] = expandHome(merged.softwareHome[key]);
  }

  merged.roots = Array.isArray(merged.roots) ? merged.roots : [];
  merged.extraRewrites = Array.isArray(merged.extraRewrites) ? merged.extraRewrites : [];
  merged.repos = Array.isArray(merged.repos) ? merged.repos.map(normalizeRepo) : [];
  merged.customSources = Array.isArray(merged.customSources) ? merged.customSources : [];
  return merged;
}

function normalizeRepo(repo) {
  return {
    id: repo.id,
    name: repo.name ?? 'sync',
    provider: repo.provider ?? 'github',
    owner: repo.owner ?? '',
    repoName: repo.repoName ?? 'dsh-work-sync',
    branch: repo.branch ?? 'main',
    private: repo.private !== false,
    description: repo.description ?? '',
    homepage: repo.homepage ?? '',
    gitignoreTemplate: repo.gitignoreTemplate ?? '',
    licenseTemplate: repo.licenseTemplate ?? '',
    hasIssues: Boolean(repo.hasIssues),
    hasWiki: Boolean(repo.hasWiki),
    hasProjects: Boolean(repo.hasProjects),
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    /** 这个仓库收哪个软件 */
    source: repo.source ?? (Array.isArray(repo.sources) ? repo.sources[0] : '') ?? '',
    cacheDir: repo.cacheDir ?? '',
    createdAt: repo.createdAt ?? new Date().toISOString(),
    lastSyncAt: repo.lastSyncAt ?? '',
    lastSyncResult: repo.lastSyncResult ?? '',
    htmlUrl: repo.htmlUrl ?? '',
    /**
     * 可选的远端地址覆盖。
     *
     * 默认按 owner/repoName 拼 GitHub 地址；但有些场景必须用别的地址：
     *   · 本地 bare 仓库（离线测试、局域网镜像）
     *   · 企业内网镜像
     *   · 测试夹具
     * 不设时留空，行为与之前完全一致。
     */
    remoteUrl: repo.remoteUrl ?? '',
  };
}

// ───────────────────────────────────────────── 路径映射

/**
 * 软件原生层级下的路径映射。
 *
 * 用户只配「工作区根目录」，具体项目路径由它推导：
 *   本机 D:\work\proj  →  @ws/proj
 *   另一台 E:\W\proj   →  按那台的根目录还原
 */
class SoftwarePathMapper {
  constructor(config, sourceId) {
    this.config = config;
    this.machine = config.machine;
    this.sourceId = sourceId;

    const root = expandHome(config.workspaceRoot?.[sourceId]);
    this.root = typeof root === 'string' && root.length > 0 ? path.resolve(root) : undefined;
    this.unmapped = new Set();
  }

  toLogical(absPath) {
    if (typeof absPath !== 'string' || absPath.length === 0) return absPath;

    for (const rule of this.config.extraRewrites ?? []) {
      if (!rule || typeof rule.from !== 'string') continue;
      if (samePath(absPath, rule.from) || under(absPath, rule.from)) {
        const rest = absPath
          .replace(/\\/g, '/')
          .slice(rule.from.replace(/\\/g, '/').replace(/\/+$/, '').length)
          .replace(/^\/+/, '');
        return rest ? `@${rule.id}/${rest}` : `@${rule.id}`;
      }
    }
    for (const item of this.config.roots ?? []) {
      const value = expandHome(item?.paths?.[this.machine]);
      if (typeof value !== 'string' || value.length === 0) continue;
      if (samePath(absPath, value) || under(absPath, value)) {
        const rest = absPath
          .replace(/\\/g, '/')
          .slice(value.replace(/\\/g, '/').replace(/\/+$/, '').length)
          .replace(/^\/+/, '');
        return rest ? `@${item.id}/${rest}` : `@${item.id}`;
      }
    }

    if (this.root && (samePath(absPath, this.root) || under(absPath, this.root))) {
      const rest = absPath
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .slice(this.root.replace(/\\/g, '/').replace(/\/+$/, '').length)
        .replace(/^\/+/, '');
      return rest ? `@ws/${rest}` : '@ws';
    }

    this.unmapped.add(absPath);
    return absPath;
  }

  toLocal(logicalPath) {
    if (typeof logicalPath !== 'string' || !logicalPath.startsWith('@')) return logicalPath;

    const slash = logicalPath.indexOf('/');
    const id = slash === -1 ? logicalPath.slice(1) : logicalPath.slice(1, slash);
    const rest = slash === -1 ? '' : logicalPath.slice(slash + 1);

    if (id === 'ws') {
      if (!this.root) return logicalPath;
      return joinPath(this.root, rest);
    }

    const extra = (this.config.extraRewrites ?? []).find((rule) => rule && rule.id === id);
    if (extra && typeof extra.to === 'string') return joinPath(extra.to, rest);

    const item = (this.config.roots ?? []).find((x) => x && x.id === id);
    const target = expandHome(item?.paths?.[this.machine]);
    if (typeof target !== 'string' || target.length === 0) return logicalPath;
    return joinPath(target, rest);
  }

  /**
   * 尽量把任何 @xxx 前缀还原成本机路径。
   *
   * 老版本用过「一个软件配一堆 roots」的方案（@DSHPRO、@WBPRO、@lan…），
   * 那些仓库里存的就是这些前缀。现在改成「每个软件一个根目录」，
   * 但已经传上去的内容不能因此变成「路径未映射」——所以这里额外做一次猜测：
   *   前缀像 WBPRO → 用 workbuddy 的根目录
   *   前缀像 DSHPRO → 用 dsh 的根目录
   *   前缀是盘符或绝对路径的一部分 → 直接当路径
   */
  toLocalLenient(logicalPath) {
    const strict = this.toLocal(logicalPath);
    if (strict !== logicalPath) return strict;

    if (typeof logicalPath !== 'string' || !logicalPath.startsWith('@')) {
      // 本来就是绝对路径（老数据里可能直接存了 C:\…），原样返回
      return logicalPath;
    }

    const slash = logicalPath.indexOf('/');
    const id = slash === -1 ? logicalPath.slice(1) : logicalPath.slice(1, slash);
    const rest = slash === -1 ? '' : logicalPath.slice(slash + 1);

    // 按名字猜它属于哪个软件
    const lower = id.toLowerCase();
    const guessSource =
      lower.includes('wb') || lower.includes('workbuddy')
        ? 'workbuddy'
        : lower.includes('dsh') || lower.includes('harness')
          ? 'dsh'
          : this.sourceId;

    const root = expandHome(this.config.workspaceRoot?.[guessSource]);
    if (typeof root === 'string' && root.length > 0) {
      return joinPath(root, rest);
    }

    // 最后兜底：把前缀当成盘符路径的一部分（@lan → 可能是 D:\lan）
    return logicalPath;
  }

  rootIdOf(logicalPath) {
    if (typeof logicalPath !== 'string' || !logicalPath.startsWith('@')) return undefined;
    const slash = logicalPath.indexOf('/');
    return slash === -1 ? logicalPath.slice(1) : logicalPath.slice(1, slash);
  }

  localRoot(id) {
    if (id === 'ws') return this.root;
    const item = (this.config.roots ?? []).find((x) => x && x.id === id);
    const value = expandHome(item?.paths?.[this.machine]);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}

function samePath(a, b) {
  const norm = (v) => String(v).replace(/\\/g, '/').replace(/\/+$/, '');
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function under(child, parent) {
  const norm = (v) => String(v).replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(child);
  const p = norm(parent);
  if (c.length <= p.length) return false;
  const head = c.slice(0, p.length);
  const equal = process.platform === 'win32' ? head.toLowerCase() === p.toLowerCase() : head === p;
  return equal && c[p.length] === '/';
}

function joinPath(base, rest) {
  const segments = String(rest)
    .split('/')
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  return segments.length === 0 ? base : path.join(base, ...segments);
}

// ───────────────────────────────────────────── 单仓库 git 会话

class RepoSession {
  constructor({ repo, config, token, stateDir, onProgress }) {
    this.repo = repo;
    this.config = config;
    this.token = token;
    this.stateDir = stateDir;
    this.onProgress = onProgress ?? (() => {});
    this.dir = repo.cacheDir || path.join(stateDir, 'repos', repo.id);
  }

  emit(event) {
    try {
      this.onProgress(event);
    } catch {}
  }

  url() {
    // 允许仓库自带 remoteUrl（本地 bare 仓库、企业内网镜像、测试夹具）。
    // 没有时才按 owner/repoName 拼 GitHub 地址。
    if (typeof this.repo.remoteUrl === 'string' && this.repo.remoteUrl.length > 0) {
      return this.repo.remoteUrl;
    }
    return remoteUrl({ owner: this.repo.owner, name: this.repo.repoName }, this.token);
  }

  /**
   * 判断这份缓存是不是一个**能用的** git 仓库。
   *
   * 只看 .git 目录在不在不够：中断的 clone、手动动过文件的目录，
   * 都可能留下残缺的 .git（只有 objects/refs，没有 HEAD），
   * git 会报 "not a git repository"，之后所有操作全废。
   */
  async gitHealthy() {
    const result = await runGit(['rev-parse', '--git-dir'], { cwd: this.dir, timeoutMs: 10000 });
    return result.ok;
  }

  /**
   * 删掉缓存目录，返回**残留的文件数**。
   *
   * Windows 上删目录经常「部分成功」：只读文件、被占用的 .git/objects
   * 会让 rmSync 抛错，但前面的文件已经没了 —— 于是目录还在、内容不全。
   * 所以这里不吞异常，而是把残留数报出来，让上层给出可操作的提示。
   */
  removeCacheDir() {
    if (!exists(this.dir)) return 0;

    // Windows 上 .git/objects 里的 pack 文件常带只读位，先清掉
    try {
      fs.chmodSync(this.dir, 0o777);
    } catch {}
    this.clearReadonly(this.dir);

    try {
      fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {}

    // 再试一次（文件可能刚被释放）
    if (exists(this.dir)) {
      try {
        fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {}
    }

    if (!exists(this.dir)) return 0;

    // 还删不掉：数一下剩多少，报告给用户
    let count = 0;
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        count++;
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else count++;
      }
    };
    walk(this.dir);
    return count;
  }

  /** 递归清掉只读位（Windows 删不掉文件多半是这个原因）。 */
  clearReadonly(root) {
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        try {
          fs.chmodSync(full, 0o777);
        } catch {}
        if (e.isDirectory()) walk(full);
      }
    };
    walk(root);
  }

  async ensure() {
    if (isDir(path.join(this.dir, '.git'))) {
      if (await this.gitHealthy()) return { ok: true };
      // 缓存坏了：删掉重来，否则整个仓库都用不了
      this.emit({ stage: 'clone', message: `本机缓存损坏，正在重建 ${this.repo.repoName}…` });
      this.removeCacheDir();
    }

    const url = this.url();
    if (!url) return { ok: false, error: '仓库还没有配置地址' };

    // 目标目录必须不存在（git clone 不接受非空目录，
    // 空目录虽然能接受，但半删状态最容易在这里翻车）
    if (isDir(this.dir)) {
      const leftovers = this.removeCacheDir();
      if (isDir(this.dir) && leftovers > 0) {
        return {
          ok: false,
          error: `本机缓存目录删不掉（还有 ${leftovers} 个文件被占用），请关闭正在使用它的程序后重试：${this.dir}`,
        };
      }
    }

    fs.mkdirSync(path.dirname(this.dir), { recursive: true });
    this.emit({ type: 'stage', stage: 'clone', message: `克隆 ${this.repo.repoName}…` });

    let result = await runGit(['clone', url, this.dir], { cwd: path.dirname(this.dir), proxy: this.config.proxy });

    if (!result.ok && isNetworkError(result.stderr)) {
      const { probeTransport } = await import('./github.mjs');
      this.emit({ type: 'stage', stage: 'network', message: '网络不通，正在寻找可用通道…' });
      const probe = await probeTransport();
      if (probe.ok && probe.proxy !== this.config.proxy) {
        this.config.proxy = probe.proxy;
        this.emit({ type: 'stage', stage: 'network', message: `改用 ${probe.proxy || '直连'} 重试…` });
        result = await runGit(['clone', url, this.dir], { cwd: path.dirname(this.dir), proxy: probe.proxy });
      }
    }

    if (!result.ok) return { ok: false, error: cleanGitError(result.stderr) };
    await this.ensureIdentity();
    return { ok: true };
  }

  async ensureIdentity() {
    const name = await runGit(['config', 'user.name'], { cwd: this.dir });
    if (!name.ok || !name.stdout.trim()) {
      await runGit(['config', 'user.name', this.config.machine], { cwd: this.dir });
    }
    const email = await runGit(['config', 'user.email'], { cwd: this.dir });
    if (!email.ok || !email.stdout.trim()) {
      await runGit(['config', 'user.email', `${this.config.machine}@dshwb-sync.local`], { cwd: this.dir });
    }
  }

  async pull() {
    const branch = this.repo.branch;
    this.emit({ type: 'stage', stage: 'fetch', message: `获取 ${this.repo.repoName}…` });

    // 只在确实能算出 GitHub 地址时才改写 origin。
    // 否则会把用户自己配好的 remote（比如本地裸仓库、企业内网镜像）覆盖掉，
    // 后续 fetch 失败还会被误判成「远端是空的」。
    const url = this.url();
    if (url) {
      await runGit(['remote', 'set-url', 'origin', url], { cwd: this.dir, proxy: this.config.proxy });
    }

    const fetch = await runGit(['fetch', 'origin', branch], { cwd: this.dir, proxy: this.config.proxy });
    if (!fetch.ok) {
      // 区分「远端真的没这个分支」和「网络/地址不对」
      const hasAnyRef = await runGit(['ls-remote', '--heads', 'origin'], { cwd: this.dir, proxy: this.config.proxy });
      if (!hasAnyRef.ok) {
        return { ok: false, error: cleanGitError(fetch.stderr) };
      }

      this.emit({ type: 'stage', stage: 'fetch', message: '远端还没有内容，准备首次上传' });
      await runGit(['checkout', '-B', branch], { cwd: this.dir });
      return { ok: true, empty: true };
    }
    const hasRemote = await runGit(['rev-parse', '--verify', `origin/${branch}`], { cwd: this.dir });
    if (!hasRemote.ok) {
      await runGit(['checkout', '-B', branch], { cwd: this.dir });
      return { ok: true, empty: true };
    }
    const checkout = await runGit(['checkout', '-B', branch, `origin/${branch}`], { cwd: this.dir });
    if (!checkout.ok) return { ok: false, error: cleanGitError(checkout.stderr) };
    const reset = await runGit(['reset', '--hard', `origin/${branch}`], { cwd: this.dir });
    if (!reset.ok) return { ok: false, error: cleanGitError(reset.stderr) };
    return { ok: true };
  }

  async commitAndPush(message) {
    const branch = this.repo.branch;
    await this.ensureIdentity();

    await runGit(['add', '-A'], { cwd: this.dir });
    const staged = await runGit(['diff', '--cached', '--name-only'], { cwd: this.dir });
    if (!staged.stdout.trim()) return { ok: true, pushed: false, reason: '没有新的变化' };

    const commit = await runGit(['commit', '-m', message, '--no-verify'], { cwd: this.dir });
    if (!commit.ok) return { ok: false, error: cleanGitError(commit.stderr) };

    this.emit({ type: 'stage', stage: 'push', message: `推送到 ${this.repo.repoName}…` });
    const push = await runGit(['push', 'origin', branch], { cwd: this.dir, proxy: this.config.proxy });
    if (!push.ok) return { ok: false, error: cleanGitError(push.stderr) };
    return { ok: true, pushed: true };
  }

  listFiles(prefix = '') {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push({ abs: full, rel: path.relative(this.dir, full).split(path.sep).join('/') });
      }
    };
    walk(prefix ? path.join(this.dir, prefix) : this.dir);
    return out;
  }
}

// ───────────────────────────────────────────── 引擎

class Engine {
  constructor(options) {
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.token = options.token;
    this.onProgress = options.onProgress ?? (() => {});
    this.machine = this.config.machine;
    this.sources = buildSources(this.config);
    this.warnings = [];
    this.notes = [];
    this.collected = [];
    this.backupDir = path.join(this.stateDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  }

  emit(event) {
    try {
      this.onProgress(event);
    } catch {}
  }

  warn(message) {
    if (this.warnings.includes(message)) return;
    this.warnings.push(message);
    this.emit({ type: 'warning', message });
  }

  note(message) {
    this.notes.push(message);
    this.emit({ type: 'note', message });
  }

  repoSession(repo) {
    return new RepoSession({
      repo,
      config: this.config,
      token: this.token,
      stateDir: this.stateDir,
      onProgress: (event) => this.emit(event),
    });
  }

  mapperFor(sourceId) {
    return new SoftwarePathMapper(this.config, sourceId);
  }

  sourceById(id) {
    return this.sources.find((s) => s.id === id);
  }

  sourceForRepo(repo) {
    return repo.source ? this.sourceById(repo.source) : undefined;
  }

  contextFor(session, sourceId) {
    const engine = this;
    const dir = session.dir;
    return {
      config: this.config,
      mapper: this.mapperFor(sourceId),
      machine: this.machine,
      stateDir: this.stateDir,
      sourceId,
      joinRepo: (rel) => path.join(dir, ...rel.split('/')),
      readRepoFile: (abs) => fs.readFileSync(abs),
      writeRepoFile: (abs, buffer) => {
        if (buffer.length > engine.config.limits.maxFileBytes) {
          engine.warn(`跳过超过单文件上限的文件：${path.basename(abs)}（${formatBytes(buffer.length)}）`);
          return;
        }
        writeFileAtomic(abs, buffer);
      },
      listRepoFiles: (prefix) =>
        session.listFiles(prefix).map((entry) => ({ ...entry, buffer: fs.readFileSync(entry.abs) })),
      findRepoFile: (rel) => {
        const abs = path.join(dir, ...rel.split('/'));
        if (!exists(abs)) return undefined;
        return { abs, rel, buffer: fs.readFileSync(abs) };
      },
      warn: (message) => engine.warn(message),
      note: (message) => engine.note(message),
      collected: engine.collected,
      backupFile: (target) => engine.backupFile(target),
      skipByPattern: (rel) => {
        const base = path.posix.basename(rel);
        for (const pattern of engine.config.exclude.filePatterns ?? []) {
          if (globMatch(base, pattern) || globMatch(rel, pattern)) return true;
        }
        return false;
      },
      mergeFile: (entry, localPath) => engine.mergeFile(entry, localPath),
    };
  }

  async inspect() {
    const out = [];
    for (const source of this.sources) {
      const ctx = this.contextFor({ dir: this.stateDir, listFiles: () => [] }, source.id);
      let detected;
      try {
        detected = source.detect(ctx);
      } catch (error) {
        detected = { installed: false, detail: error.message };
      }

      let containers = [];
      if (detected.installed) {
        try {
          containers = source.containers(ctx);
        } catch (error) {
          this.warn(`${source.label} 读取失败：${error.message}`);
        }
      }

      // 一个软件可以绑多个仓库（比如私备份 + 分享版），全部列出来
      const bound = this.config.repos.filter((repo) => repo.source === source.id);
      out.push({
        id: source.id,
        label: source.label,
        shortLabel: source.meta?.shortLabel ?? source.label,
        icon: source.icon,
        description: source.meta?.description ?? '',
        tier: source.meta?.tier ?? { containerLabel: '分组', itemLabel: '条目' },
        installed: detected.installed,
        detail: detected.detail,
        generic: Boolean(source.meta?.generic),
        repos: bound.map((repo) => ({
          id: repo.id,
          name: repo.name,
          repoName: repo.repoName,
          owner: repo.owner,
          private: repo.private,
          description: repo.description,
        })),
        boundRepo: bound[0]
          ? { id: bound[0].id, name: bound[0].name, repoName: bound[0].repoName }
          : undefined,
        containers,
        totalItems: containers.reduce((sum, c) => sum + c.items.length, 0),
        totalBytes: containers.reduce((sum, c) => sum + (c.bytes ?? 0), 0),
      });
    }
    return out;
  }

  async collectTo(repo, selection) {
    const source = this.sourceForRepo(repo);
    if (!source) return { ok: false, error: '这个仓库还没有绑定软件' };

    const session = this.repoSession(repo);
    const prepared = await session.ensure();
    if (!prepared.ok) return { ok: false, error: prepared.error };

    this.collected = [];
    const ctx = this.contextFor(session, source.id);

    this.emit({ type: 'stage', stage: 'collect', message: `整理 ${source.label}…` });
    try {
      const note = source.collect(ctx, selection);
      if (note) this.note(note);
    } catch (error) {
      this.warn(`${source.label} 采集失败：${error.message}`);
    }

    this.writeManifest(session, repo, source);

    let bytes = 0;
    for (const rel of this.collected) {
      const abs = path.join(session.dir, ...rel.split('/'));
      if (exists(abs)) bytes += fs.statSync(abs).size;
    }
    return { ok: true, files: this.collected.length, bytes, session };
  }

  writeManifest(session, repo, source) {
    const file = path.join(session.dir, 'manifest.json');
    const previous = readJson(file, { machines: {} });
    const machines = previous.machines ?? {};
    machines[this.machine] = {
      lastExportAt: new Date().toISOString(),
      workspaceRoot: this.config.workspaceRoot,
      tool: ENGINE_VERSION,
    };
    const manifest = {
      schema: 'dshwb-sync/repo@4',
      // 这几行是给「另一台机器」看的：它靠这里的 source 认出该绑哪个软件，
      // 所以必须落在仓库里，而不能只存在 GitHub 的 topics 或本机配置。
      repo: {
        name: repo.name,
        source: source.id,
        sourceLabel: source.label,
        owner: repo.owner,
        repoName: repo.repoName,
        private: repo.private,
      },
      note: '此仓库由 dshwb-sync 维护：路径已写成 @ws/… 形式，导入时按各机器的工作区根目录还原。',
      machines,
    };
    writeJsonAtomic(file, manifest);

    // 同时写一份身份标识文件：manifest 是同步产物（要克隆整个仓库才看得到），
    // 标识文件是「这个仓库属于谁」的声明——发现仓库时只读它一个文件就够了。
    writeJsonAtomic(
      path.join(session.dir, MARKER_FILE),
      buildMarker({
        sourceId: source.id,
        sourceLabel: source.label,
        owner: repo.owner,
        repoName: repo.repoName,
        machine: this.machine,
        version: ENGINE_VERSION,
        createdAt: machines[this.machine]?.lastExportAt,
      }),
    );
    this.collected.push(MARKER_FILE);
  }

  /**
   * 读远端仓库的 manifest，识别它属于哪个软件。
   *
   * 换台机器时用户只需要（或干脆不用）填仓库地址：程序先拉一次，
   * 从 manifest.json 里读出 source，就知道该把它挂到哪个软件上。
   * @returns {Promise<{ok: boolean, source?: string, sourceLabel?: string, name?: string, error?: string}>}
   */
  async identifyRepo(repo) {
    const session = this.repoSession(repo);
    const prepared = await session.ensure();
    if (!prepared.ok) return { ok: false, error: prepared.error };

    const pulled = await session.pull();
    if (!pulled.ok) return { ok: false, error: pulled.error };
    if (pulled.empty) return { ok: true, empty: true };

    const manifest = readJson(path.join(session.dir, 'manifest.json'), undefined);
    if (!manifest?.repo?.source) {
      return { ok: true, unidentified: true, error: '这个仓库里没有标识文件' };
    }
    return {
      ok: true,
      source: manifest.repo.source,
      sourceLabel: manifest.repo.sourceLabel,
      name: manifest.repo.name,
    };
  }

  async applyFrom(repo, selection) {
    const source = this.sourceForRepo(repo);
    if (!source) return { ok: false, error: '这个仓库还没有绑定软件' };

    const session = this.repoSession(repo);
    const prepared = await session.ensure();
    if (!prepared.ok) return { ok: false, error: prepared.error };

    const ctx = this.contextFor(session, source.id);
    this.emit({ type: 'stage', stage: 'apply', message: `写入 ${source.label}…` });
    try {
      const result = source.apply(ctx, selection);
      return { ok: true, applied: result.applied ?? [], conflicts: result.conflicts ?? [], session };
    } catch (error) {
      this.warn(`${source.label} 落地失败：${error.message}`);
      return { ok: true, applied: [], conflicts: [], session };
    }
  }

  /**
   * 只做两个动作：上传、下载。
   *
   * 刻意不做「双向同步」：一次操作里既拉又推，一旦两端都改过同一份内容，
   * 合并规则再怎么设计也可能把用户心里的版本搞乱。分开做，
   * 用户永远清楚「这次是往哪边动」。
   */
  async runRepo({ repo, mode, selection }) {
    const source = this.sourceForRepo(repo);
    if (!source) return { ok: false, error: '这个仓库还没有绑定软件' };
    if (mode !== 'upload' && mode !== 'download') {
      return { ok: false, error: `不支持的同步方式：${mode}（只支持 upload / download）` };
    }

    const session = this.repoSession(repo);
    const steps = [];
    const conflicts = [];

    const prepared = await session.ensure();
    if (!prepared.ok) return { ok: false, error: prepared.error };

    // ── 下载：拉远端 → 落到本机
    if (mode === 'download') {
      const pulled = await session.pull();
      if (!pulled.ok) return { ok: false, error: pulled.error };
      if (pulled.empty) {
        return { ok: true, steps: ['远端还是空的，先上传一次'], conflicts, warnings: this.warnings, notes: this.notes, repoId: repo.id };
      }

      this.emit({ type: 'stage', stage: 'apply', message: '把远端内容写到本机…' });
      const ctx = this.contextFor(session, source.id);
      try {
        const result = source.apply(ctx, selection);
        steps.push(...(result.applied ?? []));
        conflicts.push(...(result.conflicts ?? []));
      } catch (error) {
        this.warn(`${source.label} 落地失败：${error.message}`);
      }
      if (steps.length === 0) steps.push('本机已经是最新的');
      return { ok: true, steps, conflicts, warnings: this.warnings, notes: this.notes, repoId: repo.id };
    }

    // ── 上传：采集本机 → 提交推送（不先拉，避免把远端内容悄悄合进本机）
    this.collected = [];
    const ctx = this.contextFor(session, source.id);
    this.emit({ type: 'stage', stage: 'collect', message: `整理 ${source.label}…` });
    try {
      const note = source.collect(ctx, selection);
      if (note) this.note(note);
    } catch (error) {
      this.warn(`${source.label} 采集失败：${error.message}`);
    }
    this.writeManifest(session, repo, source);

    let bytes = 0;
    for (const rel of this.collected) {
      const abs = path.join(session.dir, ...rel.split('/'));
      if (exists(abs)) bytes += fs.statSync(abs).size;
    }
    steps.push(`整理 ${this.collected.length} 个文件（${formatBytes(bytes)}）`);

    const pushed = await session.commitAndPush(`${mode} from ${this.machine} @ ${new Date().toISOString()}`);
    if (!pushed.ok) return { ok: false, error: pushed.error, steps, conflicts };
    steps.push(pushed.pushed ? `已同步到 ${repo.repoName}` : '本机与远端已一致');

    return {
      ok: true,
      steps,
      conflicts,
      warnings: this.warnings,
      notes: this.notes,
      files: this.collected.length,
      bytes,
      repoId: repo.id,
    };
  }

  mergeFile(entry, localPath) {
    const repoBuffer = entry.buffer;
    const repoHash = sha256(repoBuffer);
    const localExists = exists(localPath);
    const localBuffer = localExists ? fs.readFileSync(localPath) : undefined;
    const localHash = localBuffer ? sha256(localBuffer) : undefined;

    if (localHash === repoHash) return {};
    if (!localExists) {
      writeFileAtomic(localPath, repoBuffer);
      return { applied: `新建 ${path.basename(localPath)}` };
    }
    if (localBuffer.equals(repoBuffer)) return {};

    const localText = localBuffer.toString('utf8');
    const repoText = repoBuffer.toString('utf8');
    if (repoText.startsWith(localText)) {
      this.backupFile(localPath);
      writeFileAtomic(localPath, repoBuffer);
      return { applied: `追加 ${path.basename(localPath)}` };
    }
    if (localText.startsWith(repoText)) {
      writeFileAtomic(entry.abs, localBuffer);
      return {};
    }

    const forkPath = `${localPath}.conflict-${this.machine}-${Date.now()}`;
    writeFileAtomic(forkPath, repoBuffer);
    return { conflict: `${path.basename(localPath)} 两边都改过，保留本机，远端另存` };
  }

  backupFile(target) {
    if (!target || !exists(target)) return;
    const rel = path.relative(homeDir, target);
    const safe = (rel.startsWith('..') ? target.replace(/^[A-Za-z]:/, '') : rel).split(/[\\/]/).join('__');
    const dest = path.join(this.backupDir, safe);
    if (exists(dest)) return;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(target, dest);
    } catch {}
  }

  hasBackup() {
    return exists(this.backupDir) && fs.readdirSync(this.backupDir).length > 0;
  }
}



for (const __name of ["defaultConfig","normalizeConfig","normalizeRepo","ENGINE_VERSION","SoftwarePathMapper","RepoSession","Engine","_RepoSession","decodeSession","encodeSegment","decodeSegment","projectKey","workbuddySlug"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
