const __imp0 = require('node:https');
const __imp1 = require('node:child_process');
const https = __imp0;
const { spawn } = __imp1;
/**
 * GitHub 相关操作：验证令牌、建仓、仓库属性、网络探测。
 *
 * 建仓时把能设的属性都暴露出来，而不是写死「私有 + auto_init」：
 *   private / description / homepage / branch / gitignore / license / topics
 */




const API_HOST = 'api.github.com';

function request(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
    });
    req.setTimeout(options.timeoutMs ?? 30000, () => req.destroy(new Error('请求超时')));
    req.on('error', (error) => resolve({ status: 0, error: error.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function api({ path, method = 'GET', token, body, accept }) {
  const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
  const headers = {
    'User-Agent': 'dshwb-sync',
    Accept: accept ?? 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `token ${token}`;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(payload.length);
  }
  return request({ host: API_HOST, path, method, headers, timeoutMs: 30000 }, payload);
}

/**
 * 设置仓库的 topics。
 *
 * 必须用专用接口 `PUT /repos/{owner}/{repo}/topics`：
 * 建仓时的 POST 会忽略 topics，PATCH 仓库也改不动（返回 200 但不生效）。
 * 而且这个接口要求旧的 mercy-preview Accept 头，否则同样静默失败。
 */
async function setTopics(token, owner, name, topics) {
  const names = Array.isArray(topics) ? topics.filter(Boolean) : [];
  if (names.length === 0) return { ok: true, topics: [] };

  const result = await api({
    path: `/repos/${owner}/${name}/topics`,
    method: 'PUT',
    token,
    body: { names },
    accept: 'application/vnd.github.mercy-preview+json',
  });
  if (result.status === 200 && Array.isArray(result.json?.names)) {
    return { ok: true, topics: result.json.names };
  }
  return { ok: false, error: result.error ?? `设置标签失败（${result.status}）` };
}

async function verifyToken(token) {
  const result = await api({ path: '/user', token });
  if (result.status === 401) return { ok: false, error: '令牌无效或已过期' };
  if (result.status !== 200 || !result.json) {
    return { ok: false, error: result.error ?? `GitHub 返回 ${result.status}` };
  }
  return {
    ok: true,
    login: result.json.login,
    name: result.json.name ?? '',
    avatar: result.json.avatar_url,
    scopes: String(result.headers['x-oauth-scopes'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

async function getRepo(token, owner, name) {
  const result = await api({ path: `/repos/${owner}/${name}`, token });
  if (result.status === 404) return { exists: false };
  if (result.status !== 200 || !result.json) return { exists: false, error: result.error ?? `返回 ${result.status}` };
  return {
    exists: true,
    private: Boolean(result.json.private),
    defaultBranch: result.json.default_branch,
    htmlUrl: result.json.html_url,
    description: result.json.description ?? '',
    size: result.json.size,
    topics: result.json.topics ?? [],
    updatedAt: result.json.updated_at,
    canPush: Boolean(result.json.permissions?.push),
  };
}

/** 把 API 的仓库对象收成界面用的小结构。 */
function shapeRepo(repo) {
  return {
    owner: repo.owner?.login ?? '',
    name: repo.name,
    fullName: repo.full_name,
    private: Boolean(repo.private),
    description: repo.description ?? '',
    defaultBranch: repo.default_branch ?? 'main',
    htmlUrl: repo.html_url,
    updatedAt: repo.updated_at,
    size: repo.size,
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    hasPush: Boolean(repo.permissions?.push),
    archived: Boolean(repo.archived),
  };
}

/** GitHub 返回的限流信息，拼成人话。 */
function rateLimitDetail(result) {
  const remaining = result.headers?.['x-ratelimit-remaining'];
  if (String(remaining) !== '0') return '';
  const reset = Number(result.headers?.['x-ratelimit-reset'] ?? 0);
  if (!reset) return '（接口限流，稍后再试）';
  const when = new Date(reset * 1000);
  const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `（接口限流，${clock} 之后恢复）`;
}

/**
 * 列出这个账号下能看到的全部仓库，方便「选已有仓库」而不是新建。
 *
 * 之前的实现只取第一页 100 个，而且默认口径不含组织仓库——
 * 换台机器时「我明明在 GitHub 上有仓库，这里却找不到」多半就是这个原因。
 * 现在翻页、带上组织仓库，并把是否还有更多页告诉界面。
 */
async function listRepos(token, { perPage = 100, maxPages = 5 } = {}) {
  const repos = [];
  let page = 1;
  let truncated = false;

  while (page <= maxPages) {
    const query =
      `/user/repos?per_page=${perPage}&page=${page}&sort=updated` +
      '&affiliation=owner,collaborator,organization_member&visibility=all';
    const result = await api({ path: query, token });

    if (result.status !== 200 || !Array.isArray(result.json)) {
      if (page > 1) break;
      const detail = result.error ?? (result.status === 401 ? '令牌无效或已过期' : `GitHub 返回 ${result.status}`);
      return { ok: false, error: detail + rateLimitDetail(result) };
    }

    repos.push(...result.json.map(shapeRepo));

    if (result.json.length < perPage) return { ok: true, repos, truncated: false };
    page += 1;
    if (page > maxPages) truncated = true;
  }

  return { ok: true, repos, truncated };
}

/**
 * 直接读仓库里的一个 JSON 文件（默认读 manifest.json）。
 *
 * 用 contents 接口的 raw 格式，不用克隆整个仓库——换机时那个仓库可能有几百 MB，
 * 为了认出「它属于哪个软件」去克隆一遍太贵。
 */
async function readRepoJsonFile(token, owner, name, file = 'manifest.json', ref) {
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const result = await api({
    path: `/repos/${owner}/${name}/contents/${file}${suffix}`,
    token,
    accept: 'application/vnd.github.raw+json',
  });

  if (result.status === 404) return { ok: false, missing: true };
  if (result.status === 403) return { ok: false, error: describeForbidden(result, { action: '读取仓库内容' }) };
  if (result.status !== 200) {
    return { ok: false, error: result.error ?? `GitHub 返回 ${result.status}` };
  }
  try {
    return { ok: true, json: JSON.parse(result.body) };
  } catch {
    return { ok: false, error: '文件不是合法 JSON' };
  }
}

/**
 * 读仓库里的一个文本文件，连内容指纹（sha）一起返回。
 *
 * 和 readRepoJsonFile 的分工：
 *   · readRepoJsonFile 只关心「能不能解析出 JSON」，用来认仓库归属；
 *   · 这里要 sha，因为改文件必须带 sha 才不会覆盖别人的提交。
 */
async function getFileText(token, owner, name, file, ref) {
  const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const result = await api({ path: `/repos/${owner}/${name}/contents/${file}${suffix}`, token });

  if (result.status === 404) return { ok: false, missing: true };
  if (result.status === 403) return { ok: false, error: describeForbidden(result, { action: '读取仓库内容' }) };
  if (result.status !== 200 || !result.json) {
    return { ok: false, error: result.error ?? `GitHub 返回 ${result.status}` };
  }

  const data = result.json;
  if (Array.isArray(data)) return { ok: false, error: '这是一个目录，不是文件' };
  const text =
    data.encoding === 'base64'
      ? Buffer.from(String(data.content ?? ''), 'base64').toString('utf8')
      : String(data.content ?? '');
  return { ok: true, text, sha: data.sha, size: data.size };
}

/**
 * 在仓库里新建 / 覆盖一个文本文件（一次 commit）。
 *
 * 空仓库（建仓时没勾 init、也没有任何提交）会被 GitHub 用 409 拒绝，
 * 这种情况要单独说清楚，否则用户只看到「写入失败」。
 */
async function putFileText(token, owner, name, file, text, options = {}) {
  const body = {
    message: options.message ?? `update ${file}`,
    content: Buffer.from(String(text ?? ''), 'utf8').toString('base64'),
  };
  if (options.sha) body.sha = options.sha;
  if (options.branch) body.branch = options.branch;

  const result = await api({ path: `/repos/${owner}/${name}/contents/${file}`, method: 'PUT', token, body });

  if (result.status === 200 || result.status === 201) {
    return { ok: true, created: result.status === 201, sha: result.json?.content?.sha };
  }
  if (result.status === 409) {
    return { ok: false, empty: true, conflict: true, error: '仓库还是空的（没有任何提交），先同步一次再写标识' };
  }
  if (result.status === 404) return { ok: false, error: '仓库不存在或令牌没有写权限' };
  if (result.status === 403) return { ok: false, error: describeForbidden(result, { action: '写入文件' }) };
  if (result.status === 422) {
    return { ok: false, error: result.json?.errors?.[0]?.message ?? '提交被拒绝（可能是默认分支还没建起来）' };
  }
  return { ok: false, error: result.error ?? `写入失败（${result.status}）` };
}

/**
 * 把 403 翻译成**能照着做**的提示。
 *
 * 403 至少有以下几种完全不同的原因，都报「返回 403」等于什么都没说：
 *   1. 限流（核心配额用完）        → 等 reset 时间，或用带令牌的请求
 *   2. 令牌缺 scope                → 重新生成令牌，勾上 repo
 *   3. 令牌被撤销 / SSO 未授权     → 去授权，或换令牌
 *   4. 组织策略禁止建库            → 换个所有者或改组织设置
 *   5. secondary rate limit        → 稍等再试
 *
 * 判断依据全在响应头与响应体里，GitHub 其实说得很清楚，
 * 只是我们之前没去读。
 */
function describeForbidden(result, { action = '操作', token } = {}) {
  const headers = result.headers ?? {};
  const body = result.json ?? {};
  const message = String(body.message ?? '');
  const remaining = String(headers['x-ratelimit-remaining'] ?? '');
  const resetAt = Number(headers['x-ratelimit-reset'] ?? 0);
  const accepted = String(headers['x-accepted-oauth-scopes'] ?? '');

  // 1) 配额用尽
  if (remaining === '0') {
    let when = '';
    if (resetAt) {
      const d = new Date(resetAt * 1000);
      when = `，${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 之后恢复`;
    }
    return `GitHub 接口限流了，现在${action}不了${when}。稍等一会儿再试。`;
  }

  // 2) 明确说了缺 scope
  if (/scopes?|permission|not accessible|resource not accessible/i.test(message)) {
    const need = accepted ? `（需要 ${accepted.split(',')[0].trim()} 权限）` : '';
    return (
      `令牌权限不够，没法${action}${need}。` +
      '到 GitHub → Settings → Developer settings → Personal access tokens 重新生成一个，' +
      '勾上 repo（如果是组织仓库，还需要该组织批准这个令牌）。'
    );
  }

  // 3) SSO：组织要求令牌先授权
  if (/sso|saml/i.test(message) || headers['x-github-sso']) {
    return `这个令牌还没通过组织的 SSO 授权，没法${action}。到 GitHub 令牌页面点 "Configure SSO" 授权一次。`;
  }

  // 4) 明确是二级限流
  if (/secondary rate limit|abuse detection/i.test(message)) {
    return `GitHub 判定请求过于频繁，暂时${action}不了。等一分钟再试。`;
  }

  // 5) 组织策略
  if (/organization|policy|restricted/i.test(message)) {
    return `组织策略不允许${action}：${message}`;
  }

  // 兜底：把 GitHub 原话带上，别再只给一个状态码
  const detail = message ? `：${message}` : '';
  const hint = token ? '' : '（当前没有带令牌，匿名请求无法建库）';
  return `GitHub 拒绝了${action}${detail}${hint}`;
}

/**
 * 建仓库。所有属性都可选，不传就用 GitHub 的默认值。
 * @param {string} token
 * @param {object} options
 * @param {string} options.name
 * @param {boolean} [options.private]
 * @param {string} [options.description]
 * @param {string} [options.homepage]
 * @param {boolean} [options.autoInit]
 * @param {string} [options.gitignoreTemplate]
 * @param {string} [options.licenseTemplate]
 * @param {string[]} [options.topics]
 * @param {boolean} [options.hasIssues]
 * @param {boolean} [options.hasWiki]
 * @param {boolean} [options.hasProjects]
 */
async function createRepo(token, options) {
  // 在描述前面加显式标识（如 `[DSH]`），并写 topics——
  // 这样在 GitHub 仓库列表里一眼能分清哪个是 DSH、哪个是 WorkBuddy
  const label = options.sourceLabel || options.source || '';
  const tag = label ? `[${label}] ` : '';

  const body = {
    name: options.name,
    private: options.private !== false,
    has_issues: options.hasIssues ?? false,
    has_wiki: options.hasWiki ?? false,
    has_projects: options.hasProjects ?? false,
    auto_init: options.autoInit !== false,
  };

  const description = options.description
    ? `${tag}${options.description}`
    : label
      ? `${tag}跨电脑同步 · ${label}`
      : undefined;
  if (description) body.description = description;

  if (options.homepage) body.homepage = options.homepage;
  if (options.gitignoreTemplate) body.gitignore_template = options.gitignoreTemplate;
  if (options.licenseTemplate) body.license_template = options.licenseTemplate;

  const topics = new Set(Array.isArray(options.topics) ? options.topics : []);
  topics.add('dshwb-sync');
  if (options.source) topics.add(`dshwb-${options.source}`);
  body.topics = [...topics];

  const result = await api({ path: '/user/repos', method: 'POST', token, body });

  if (result.status === 422) {
    const message = result.json?.errors?.[0]?.message ?? '同名仓库已存在';
    return { ok: false, error: message, exists: true };
  }

  // 403 有好几种完全不同的原因，不能都报「返回 403」让用户猜。
  // 之前就是这样：丢掉响应体后只剩一句 403，用户根本没法判断是
  // 令牌过期、缺 scope、被限流，还是组织策略不允许建库。
  if (result.status === 403) {
    return { ok: false, error: describeForbidden(result, { action: '创建仓库', token }), forbidden: true };
  }
  if (result.status === 401) {
    return {
      ok: false,
      error: '令牌无效或已过期。到「账号」页重新连接一次 GitHub。',
      unauthorized: true,
    };
  }

  if (result.status !== 201 || !result.json) {
    return { ok: false, error: result.error ?? `创建失败（GitHub 返回 ${result.status}）` };
  }

  const owner = result.json.owner.login;
  const name = result.json.name;

  // 建仓接口会忽略 topics，必须走专用接口补一次（详见 setTopics 注释）
  let appliedTopics = result.json.topics ?? [];
  if (body.topics.length > 0) {
    const stamped = await setTopics(token, owner, name, body.topics);
    if (stamped.ok) appliedTopics = stamped.topics;
  }

  return {
    ok: true,
    owner,
    name,
    fullName: result.json.full_name,
    defaultBranch: result.json.default_branch,
    htmlUrl: result.json.html_url,
    private: Boolean(result.json.private),
    topics: appliedTopics,
  };
}

/**
 * 建仓 + 立刻写身份标识。
 *
 * 分开写是故意的：仓库建出来就算成功，标识写不进去也要把仓库交还给用户
 * （否则会留下一个「建好了但用户以为没建成」的孤儿仓库）。
 * 标识失败的结果放在 marker 里，界面上提示「去补一次标识」。
 *
 * @param {string} token
 * @param {object} options 与 createRepo 相同，另需 sourceId / sourceLabel / machine / version
 */
async function createRepoWithMarker(token, options) {
  const created = await createRepo(token, options);
  if (!created.ok) return created;

  const { stampRepo } = await import('./identity.mjs');
  const marker = await stampRepo(token, {
    owner: created.owner,
    repoName: created.name,
    sourceId: options.source,
    sourceLabel: options.sourceLabel || options.source,
    machine: options.machine,
    version: options.version,
  });

  return {
    ...created,
    // 标识写成功后，GitHub 上的描述已经变成带前缀的版本，本地配置要跟着改，
    // 否则界面上显示的还是用户当初填的那串，看起来像没生效。
    description: marker.description?.value ?? created.description,
    marker: {
      ok: Boolean(marker.marker?.ok),
      error: marker.ok ? undefined : marker.error,
      topicsOk: Boolean(marker.topics?.ok),
      descriptionOk: Boolean(marker.description?.ok),
    },
  };
}

/** 修改已有仓库的属性。 */
async function updateRepo(token, owner, name, patch) {
  const body = {};
  const map = {
    private: 'private',
    description: 'description',
    homepage: 'homepage',
    hasIssues: 'has_issues',
    hasWiki: 'has_wiki',
    hasProjects: 'has_projects',
    defaultBranch: 'default_branch',
    archived: 'archived',
  };
  for (const [key, apiKey] of Object.entries(map)) {
    if (patch[key] !== undefined) body[apiKey] = patch[key];
  }

  const wantsTopics = Array.isArray(patch.topics);
  if (Object.keys(body).length === 0 && !wantsTopics) return { ok: true, unchanged: true };

  let result;
  if (Object.keys(body).length > 0) {
    result = await api({ path: `/repos/${owner}/${name}`, method: 'PATCH', token, body });
    if (result.status !== 200 || !result.json) {
      return { ok: false, error: result.error ?? `修改失败（GitHub 返回 ${result.status}）` };
    }
  }

  // topics 走专用接口：PATCH 仓库改不动它
  let topics = result?.json?.topics ?? [];
  let topicsError;
  if (wantsTopics) {
    const stamped = await setTopics(token, owner, name, patch.topics);
    if (stamped.ok) topics = stamped.topics;
    else topicsError = stamped.error;
  }

  return {
    ok: !topicsError,
    error: topicsError,
    private: result ? Boolean(result.json.private) : undefined,
    description: result ? (result.json.description ?? '') : undefined,
    htmlUrl: result?.json?.html_url,
    topics,
  };
}

/** 删除仓库（需要 delete_repo 权限，默认令牌没有）。 */
async function deleteRepo(token, owner, name) {
  const result = await api({ path: `/repos/${owner}/${name}`, method: 'DELETE', token });

  // 204 = 这次删掉了
  if (result.status === 204) return { ok: true, alreadyGone: false };

  /**
   * 404 有两种含义，但对调用方来说结果是同一个：仓库已经不在了。
   *
   * 真实故障：第一次删成功（204），但界面没刷新，用户再点一次删除，
   * 拿到 404，被当成「删除失败」，于是弹出「云端删除失败 → 只移除本机」，
   * 用户以为云端还在，实际早就没了。
   *
   * 所以 404 必须当「已经是想要的状态」处理，而不是失败。
   */
  if (result.status === 404) return { ok: true, alreadyGone: true };

  if (result.status === 403) return { ok: false, error: '令牌没有 delete_repo 权限' };
  return { ok: false, error: result.error ?? `删除失败（${result.status}）` };
}

/**
 * 探测哪条网络通道能连上 github.com。
 * 探测用 ls-remote 一个必然存在的公开仓库，最贴近真实上传时的路径。
 */
async function probeTransport(repoFullName = 'github/gitignore') {
  const candidates = ['', 'http://127.0.0.1:7890', 'http://127.0.0.1:7891', 'http://127.0.0.1:10809', 'http://127.0.0.1:1080'];

  const runOne = (proxy) =>
    new Promise((resolve) => {
      const args = [];
      if (proxy) args.push('-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`);
      else args.push('-c', 'http.proxy=', '-c', 'https.proxy=');
      args.push('-c', 'credential.helper=', 'ls-remote', `https://github.com/${repoFullName}.git`, 'HEAD');

      const started = Date.now();
      const child = spawn('git', args, {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ALL_PROXY: '', all_proxy: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ proxy, ok: false, ms: Date.now() - started, detail: '超时' });
      }, 20000);
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          proxy,
          ok: code === 0,
          ms: Date.now() - started,
          detail: code === 0 ? '' : String(stderr).split('\n')[0].slice(0, 120),
        });
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ proxy, ok: false, ms: Date.now() - started, detail: error.message });
      });
    });

  const results = [];
  for (const proxy of candidates) {
    const result = await runOne(proxy);
    results.push(result);
    if (result.ok) return { ok: true, proxy, ms: result.ms, results };
  }
  return { ok: false, proxy: '', results };
}

/** 常用 .gitignore 模板（GitHub 的模板名）。 */
const GITIGNORE_TEMPLATES = ['', 'Node', 'Python', 'macOS', 'Windows', 'VisualStudio', 'JetBrains'];

/** 常用许可证（GitHub 的 license key）。 */
const LICENSE_KEYS = ['', 'mit', 'apache-2.0', 'gpl-3.0', 'agpl-3.0', 'unlicense'];

for (const __name of ["api","setTopics","verifyToken","getRepo","listRepos","readRepoJsonFile","getFileText","putFileText","describeForbidden","createRepo","createRepoWithMarker","updateRepo","deleteRepo","probeTransport","GITIGNORE_TEMPLATES","LICENSE_KEYS"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
