const __imp0 = require('./github.cjs');
const __imp1 = require('./identity.cjs');
const { getRepo, listRepos, readRepoJsonFile } = __imp0;
const { LEGACY_MANIFEST, MARKER_FILE, parseIdentity } = __imp1;
/**
 * 从 GitHub 上反查「这个账号里已经有哪些同步仓库」。
 *
 * 为什么需要这个：
 * 本机配置里只记着自己建过的仓库。换一台机器（或者重装之后）打开「仓库」页，
 * 明明 GitHub 上早就有一个 DSH 仓库，界面却显示「还没有仓库」——
 * 用户只能点「加入已有仓库」手填地址，还得先知道仓库叫什么。
 *
 * ══ 归属只认证据，不猜名字 ══
 *
 * 早期版本会「按名字猜」（仓库名里有 dsh 就算 DSH 的仓库），
 * 这一条已经删掉了：账号里叫 dsh、dsh-notes、dsh-demo 的仓库可能一大堆，
 * 猜错之后用户点「加入本机」，DSH 的对话就会被写进一个不相干的仓库。
 *
 * 现在按下面的顺序认定，越靠前越硬：
 *   1. 本机已登记    —— 用户自己加进来的，不用再认（confidence=local）
 *   2. 身份标识文件  —— 仓库根的 dshwb-sync.json（建仓时写的，confidence=marker）
 *   3. topics        —— `dshwb-<软件>`（列表接口免费带回，confidence=topic）
 *   4. 描述前缀      —— `[软件名] …`（同上，confidence=description）
 *   5. 老仓库的 manifest.json —— 只有文件名/描述像时才去读（confidence=legacy）
 * 全都对不上的进 unknown，界面上单独一段「未识别的仓库」，
 * 用户可以「当作 XX 的仓库」手动认领（点一下会补写标识）。
 *
 * 请求预算：列表 1 次；之后再不动网络——除非某个仓库看着像同步仓库
 * （名字/描述里带 dshwb 或软件名），才会去读一次标识文件。
 */




/** 一次发现最多验证多少个「看着像」的仓库（每个最多两次请求）。 */
const MAX_MARKER_PROBES = 24;

/**
 * 「看着不像」的仓库也验几个（只读标识文件，不读 manifest）。
 *
 * 为什么需要这一条：topics 有可能写不进去（企业实例、令牌权限不足），
 * 那种仓库名字上完全看不出来，只认名字就会漏掉。
 * 但也不能全账号遍历——几百个仓库就是几百次请求。所以只取最近更新的若干个。
 */
const MAX_BLIND_PROBES = 12;

/** 同时进行的请求数。 */
const CONCURRENCY = 4;

/** 简单并发池：按顺序跑完所有任务，最多同时 CONCURRENCY 个。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error: error.message };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/** 软件的几个名字（用于识别描述前缀里的标签）。 */
function labelSet(source) {
  return new Set(
    [source.id, source.label, source.shortLabel]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .map((value) => value.toLowerCase()),
  );
}

/** 仓库名/描述里出现这些词，才值得读一次标识文件确认。 */
function looksRelated(repo, sources) {
  const haystack = `${repo.name} ${repo.description} ${(repo.topics ?? []).join(' ')}`.toLowerCase();
  if (haystack.includes('dshwb')) return true;
  if (haystack.includes('跨电脑同步')) return true;
  for (const source of sources) {
    for (const token of [source.id, source.shortLabel, source.label]) {
      const needle = String(token ?? '').toLowerCase();
      if (needle.length < 3) continue;
      if (haystack.includes(needle)) return true;
    }
  }
  return false;
}

/** 从 topics 认软件（`dshwb-<id>`，建仓时写进去的）。 */
function sourceFromTopics(repo, knownIds) {
  for (const topic of repo.topics ?? []) {
    const match = /^dshwb-(.+)$/.exec(String(topic).toLowerCase().trim());
    if (!match) continue;
    const id = match[1];
    if (knownIds.has(id)) return id;
  }
  return undefined;
}

/** 从描述前缀认软件，比如 `[DeepSeek Harness] 跨电脑同步`。 */
function sourceFromDescription(repo, sources) {
  const text = String(repo.description ?? '').trim();
  const match = /^\[([^\]]+)\]/.exec(text);
  if (!match) return undefined;
  const label = match[1].trim().toLowerCase();
  const hit = sources.find((source) => labelSet(source).has(label));
  return hit?.id;
}

/**
 * 本机登记表：owner/repoName → 本地仓库。
 * 键统一小写，GitHub 的仓库名本身不区分大小写。
 */
function buildRegistry(registered = []) {
  const map = new Map();
  for (const repo of registered) {
    if (!repo?.owner || !repo?.repoName) continue;
    map.set(`${String(repo.owner).toLowerCase()}/${String(repo.repoName).toLowerCase()}`, repo);
  }
  return map;
}

/**
 * 扫描账号下的仓库，按软件归类。
 *
 * @param {object} options
 * @param {string} options.token
 * @param {object[]} options.sources  来自 describeSources()，含 id / label / shortLabel
 * @param {object[]} options.registered 本机已登记的仓库（含 owner / repoName / source）
 * @param {Function} [options.listFn]        注入用（测试）
 * @param {Function} [options.readMarkerFn]  注入用（测试）
 * @returns {Promise<object>}
 */
async function discoverRemoteRepos({
  token,
  sources,
  registered = [],
  listFn,
  readMarkerFn,
}) {
  if (!token) return { ok: false, error: '还没有登录 GitHub' };

  const list = listFn ?? listRepos;
  const readMarker = readMarkerFn ?? readRepoJsonFile;

  const listed = await list(token);
  if (!listed.ok) return { ok: false, error: listed.error };

  const knownIds = new Set(sources.map((source) => source.id));
  const registry = buildRegistry(registered);

  // ── 第一步：只花列表接口那一次请求
  const scored = listed.repos.map((repo) => {
    const key = `${String(repo.owner).toLowerCase()}/${String(repo.name).toLowerCase()}`;
    const local = registry.get(key);
    const byTopic = sourceFromTopics(repo, knownIds);
    const byDescription = byTopic ? undefined : sourceFromDescription(repo, sources);

    return {
      ...repo,
      registered: Boolean(local),
      localId: local?.id ?? '',
      localName: local?.name ?? '',
      localSource: local?.source ?? '',
      sourceId: local?.source || byTopic || byDescription || '',
      confidence: local?.source ? 'local' : byTopic ? 'topic' : byDescription ? 'description' : '',
      hasManifest: false,
      hasMarker: false,
      manifestSource: '',
      manifestName: '',
      manifestMachine: '',
      lastCommit: repo.updatedAt,
    };
  });

  // ── 第二步：确认归属。分两批，请求预算不一样：
  //    A. 名字/描述像同步仓库的：先读标识文件，没有再读老 manifest（最多两次）
  //    B. 看着不像、但可能只是 topics 没写进去的：只读标识文件（一次）
  // 两批都不看「本机没登记」：已登记只说明它是用户自己加的，
  // 不代表仓库里真有标识——而「仓库里真有标识」才是下一台机器要的。
  const related = scored.filter(
    (repo) =>
      !repo.sourceId &&
      !repo.archived &&
      looksRelated(repo, sources) &&
      (repo.topics ?? []).length < 100, // 防御性：别对异常数据发请求
  );
  const relatedSet = new Set(related);

  const blind = scored
    .filter((repo) => !repo.sourceId && !repo.archived && !relatedSet.has(repo))
    // 最近更新的更可能是还在用的同步仓库
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, MAX_BLIND_PROBES);

  const probes = related.slice(0, MAX_MARKER_PROBES);
  const blindProbes = blind;

  const [probeResults, blindResults] = await Promise.all([
    mapLimit(probes, CONCURRENCY, async (repo) => {
      // 先读新标识，没有再读老 manifest（更老的仓库只有 manifest）
      const marker = await readMarker(token, repo.owner, repo.name, MARKER_FILE);
      if (marker?.ok && marker.json) return { kind: 'marker', json: marker.json };

      const legacy = await readMarker(token, repo.owner, repo.name, LEGACY_MANIFEST);
      if (legacy?.ok && legacy.json) return { kind: 'legacy', json: legacy.json };

      return { kind: marker?.error || legacy?.error ? 'error' : 'none', error: marker?.error || legacy?.error };
    }),
    mapLimit(blindProbes, CONCURRENCY, async (repo) => {
      const marker = await readMarker(token, repo.owner, repo.name, MARKER_FILE);
      if (marker?.ok && marker.json) return { kind: 'marker', json: marker.json };
      return { kind: marker?.error ? 'error' : 'none', error: marker?.error };
    }),
  ]);

  const apply = (repo, result) => {
    if (!repo || !result || result.kind === 'error') return;

    if (result.kind === 'none') {
      if (looksRelated(repo, sources)) {
        // 名字像、内容却没有任何标识：宁可放进「未识别」让用户确认，
        // 也不按名字把它塞进某个软件（那正是上一版最糟糕的行为）。
        repo.identityHint = '名字像是同步仓库，但仓库里没有标识文件';
      }
      return;
    }

    const identity = parseIdentity(result.json, knownIds);
    if (!identity) return;

    repo.hasManifest = true;
    repo.hasMarker = result.kind === 'marker';
    repo.manifestSource = identity.source;
    repo.manifestName = identity.name;
    repo.manifestMachine = identity.machine;
    if (identity.lastActivity) repo.lastCommit = identity.lastActivity;

    if (identity.known) {
      repo.sourceId = identity.source;
      // 用户自己登记过的，保留 local —— 那是更强的证据
      if (repo.confidence !== 'local') {
        repo.confidence = result.kind === 'marker' ? 'marker' : 'legacy';
      }
    } else {
      // 是同步仓库，但那个软件本机没装
      repo.sourceId = identity.source;
      repo.confidence = 'marker-unknown';
    }
  };

  probeResults.forEach((result, index) => apply(probes[index], result));
  blindResults.forEach((result, index) => apply(blindProbes[index], result));

  // ── 第三步：分组
  const bySource = {};
  for (const source of sources) bySource[source.id] = [];

  const unknown = [];
  for (const repo of scored) {
    if (repo.sourceId && bySource[repo.sourceId]) bySource[repo.sourceId].push(repo);
    else unknown.push(repo);
  }

  // 已登记的排后面：用户更关心「GitHub 上有、本机还没加」的那些
  for (const group of Object.values(bySource)) {
    group.sort((a, b) => {
      if (a.registered !== b.registered) return a.registered ? 1 : -1;
      return String(b.lastCommit ?? '').localeCompare(String(a.lastCommit ?? ''));
    });
  }
  unknown.sort((a, b) => String(b.lastCommit ?? '').localeCompare(String(a.lastCommit ?? '')));

  const counts = {};
  for (const [id, group] of Object.entries(bySource)) {
    counts[id] = {
      total: group.length,
      registered: group.filter((repo) => repo.registered).length,
      joinable: group.filter((repo) => !repo.registered).length,
    };
  }

  return {
    ok: true,
    bySource,
    unknown,
    counts,
    total: listed.repos.length,
    truncated: Boolean(listed.truncated),
    probed: probes.length + blindProbes.length,
    /** 有多少仓库是靠仓库里的证据（标识/标签/描述/旧 manifest）认出来的 */
    identified: scored.filter((repo) => repo.confidence && repo.confidence !== 'local').length,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 认领一个仓库：把用户选定的软件写进仓库的标识文件与 topics。
 *
 * 「未识别」区里点「当作 XX 的仓库」走这里 —— 先补标识、再登记到本机。
 * 这样下次任何一台机器打开这一页，都能直接认出它，不用再人工点。
 */
async function claimRepo(token, { owner, repoName, sourceId, sourceLabel, machine, version }) {
  const { stampRepo } = await import('./identity.mjs');
  const stamped = await stampRepo(token, { owner, repoName, sourceId, sourceLabel, machine, version });
  if (!stamped.ok) return { ok: false, error: stamped.error ?? '标识写入失败', detail: stamped };
  return { ok: true, detail: stamped };
}

/**
 * 逐个确认账号下「看着像同步仓库」的仓库有没有标识，没有就补上。
 *
 * 用于「以前用旧版本建的仓库」：旧版本只写了 topics 和描述，
 * 换到没有 topics 的账号/企业实例上就认不出来。补一次标识以后就稳了。
 */
async function backfillMarkers(token, { sources, registered = [], machine, version }) {
  const { stampRepo } = await import('./identity.mjs');
  const labels = new Map(sources.map((source) => [source.id, source.label]));
  const results = [];

  for (const repo of registered) {
    if (!repo?.owner || !repo?.repoName || !repo.source) continue;
    // 已经有 topics 的先跳过：那是新版本建的，标识大概率也在
    const remote = await getRepo(token, repo.owner, repo.repoName);
    if (!remote.exists) {
      results.push({ repo: `${repo.owner}/${repo.repoName}`, ok: false, error: remote.error ?? '仓库不存在' });
      continue;
    }
    const hasTopic = (remote.topics ?? []).includes(`dshwb-${repo.source}`);
    const markerFile = remote.defaultBranch
      ? await readRepoJsonFile(token, repo.owner, repo.repoName, MARKER_FILE)
      : { ok: false, missing: true };

    if (hasTopic && markerFile.ok) {
      results.push({ repo: `${repo.owner}/${repo.repoName}`, ok: true, unchanged: true });
      continue;
    }

    const stamped = await stampRepo(token, {
      owner: repo.owner,
      repoName: repo.repoName,
      sourceId: repo.source,
      sourceLabel: labels.get(repo.source) ?? repo.source,
      machine,
      version,
    });
    results.push({
      repo: `${repo.owner}/${repo.repoName}`,
      ok: stamped.ok,
      error: stamped.ok ? undefined : stamped.error,
      topicsOk: Boolean(stamped.topics?.ok),
    });
  }

  return {
    ok: true,
    results,
    stamped: results.filter((item) => item.ok && !item.unchanged).length,
    failed: results.filter((item) => !item.ok).length,
  };
}

for (const __name of ["looksRelated","sourceFromTopics","sourceFromDescription","buildRegistry","discoverRemoteRepos","claimRepo","backfillMarkers"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
