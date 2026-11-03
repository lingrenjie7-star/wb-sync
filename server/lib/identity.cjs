const __imp0 = require('./github.cjs');
const { getFileText, getRepo, putFileText, setTopics, updateRepo } = __imp0;
/**
 * 仓库身份标识：让「这个仓库属于哪个软件」变成仓库里的事实，而不是靠名字猜。
 *
 * 为什么不能再靠名字猜：
 *   账号里叫 dsh、dsh1、dsh-notes 的仓库可能一堆，名字像不像同步仓库
 *   只有仓库主人自己知道。按名字归类一旦猜错，用户会把它「加入本机」，
 *   后果是把 DSH 的对话写进了别人的项目仓库。
 *
 * 所以改成「建仓时就写标识，之后只认标识」。三层，从便宜到贵：
 *   1. topics：`dshwb-sync` + `dshwb-<软件 id>`（列表接口免费带回来，零额外请求）
 *   2. 描述前缀：`[软件名] …`（同样来自列表接口）
 *   3. 仓库根目录的 dshwb-sync.json（换机、重装之后读它就知道归属）
 *
 * 第 3 层是这次新增的关键：
 *   · 建仓成功立刻写进去 —— 哪怕一次都没同步过，别的机器也能认出它；
 *   · 同步时 manifest.json 里本来就记着 source，作为老仓库的兼容来源；
 *   · 网页端建的仓库没有标识，界面会把它列在「未识别」里，点一下就能补。
 */



/** 身份标识文件（建仓/补标识时写）。 */
const MARKER_FILE = 'dshwb-sync.json';

/** 老仓库的兼容来源：同步时引擎会写 manifest.json，里面也记着 source。 */
const LEGACY_MANIFEST = 'manifest.json';

const MARKER_SCHEMA = 'dshwb-sync/marker@1';

/** 拼一份标识文件的内容。 */
function buildMarker({ sourceId, sourceLabel, owner, repoName, machine, version, createdAt }) {
  return {
    schema: MARKER_SCHEMA,
    app: '跨电脑同步',
    // 这一段和 manifest.json 的 repo 段保持同形，
    // 这样「读标识」只有一套解析逻辑，不会因为文件不同而走岔。
    repo: {
      name: `${sourceLabel || sourceId} 同步`,
      source: sourceId,
      sourceLabel: sourceLabel || sourceId,
      owner,
      repoName,
    },
    createdBy: {
      machine: machine ?? '',
      at: createdAt ?? new Date().toISOString(),
      tool: version ?? '',
    },
    note: '这个文件说明仓库属于哪个软件。别的机器靠它认出仓库，请勿删除。',
  };
}

/**
 * 从标识文件（或老的 manifest.json）里解析归属。
 *
 * @param {object} json 文件内容
 * @param {Set<string>} knownIds 本机认识的软件 id
 * @returns {{source: string, sourceLabel: string, name: string, known: boolean,
 *            machine: string, lastActivity: string, schema: string} | undefined}
 */
function parseIdentity(json, knownIds = new Set()) {
  if (!json || typeof json !== 'object') return undefined;
  const declared = json.repo?.source;
  if (typeof declared !== 'string' || declared.trim().length === 0) return undefined;

  const machines = json.machines && typeof json.machines === 'object' ? json.machines : {};
  const stamps = Object.values(machines)
    .map((item) => item?.lastExportAt)
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort();

  const createdBy = json.createdBy ?? {};
  const machine =
    (typeof createdBy.machine === 'string' && createdBy.machine) ||
    Object.keys(machines).pop() ||
    '';

  return {
    source: declared,
    sourceLabel: typeof json.repo?.sourceLabel === 'string' ? json.repo.sourceLabel : '',
    name: typeof json.repo?.name === 'string' ? json.repo.name : '',
    known: knownIds.has(declared),
    machine,
    lastActivity: stamps.length > 0 ? stamps[stamps.length - 1] : (createdBy.at ?? ''),
    schema: typeof json.schema === 'string' ? json.schema : '',
  };
}

/**
 * 给仓库补标识：写 dshwb-sync.json + topics + 描述前缀。
 *
 * 三件事都做，是因为它们的可靠性不一样：
 *   · 文件最可靠，但要多一次读取（发现仓库时才会读）；
 *   · topics 免费带在列表接口里，但有的账号/令牌会改不动；
 *   · 描述前缀纯给人看，顺手写上。
 * 任何一项失败都不影响其它项，返回值里逐项报告。
 */
async function stampRepo(token, options) {
  const {
    owner,
    repoName,
    sourceId,
    sourceLabel = '',
    machine = '',
    version = '',
    description,
  } = options ?? {};
  if (!token) return { ok: false, error: '还没有登录 GitHub' };
  if (!owner || !repoName) return { ok: false, error: '缺少 owner / repoName' };
  if (!sourceId) return { ok: false, error: '缺少软件标识' };

  const label = sourceLabel || sourceId;
  const result = { ok: true, owner, repoName, source: sourceId, marker: {}, topics: {}, description: {} };

  // ── 1. 身份标识文件
  const text = JSON.stringify(buildMarker({ sourceId, sourceLabel: label, owner, repoName, machine, version }), null, 2) + '\n';
  const existing = await getFileText(token, owner, repoName, MARKER_FILE);
  if (existing.ok && String(existing.text ?? '').trim() === text.trim()) {
    result.marker = { ok: true, unchanged: true };
  } else if (!existing.ok && !existing.missing) {
    result.marker = { ok: false, error: existing.error ?? '读取标识文件失败' };
  } else {
    const put = await putFileText(token, owner, repoName, MARKER_FILE, text, {
      message: `chore: mark as ${label} sync repo`,
      sha: existing.sha,
    });
    result.marker = put.ok ? { ok: true, created: Boolean(put.created) } : { ok: false, error: put.error };
  }

  // ── 2. topics（`PUT topics` 会整组覆盖，所以必须先读出来再合并）
  const remote = await getRepo(token, owner, repoName);
  result.remote = remote;
  if (remote.exists) {
    const current = Array.isArray(remote.topics) ? remote.topics : [];
    const wanted = [...new Set([...current, 'dshwb-sync', `dshwb-${sourceId}`])];
    if (wanted.length === current.length && wanted.every((item) => current.includes(item))) {
      result.topics = { ok: true, unchanged: true, names: current };
    } else {
      const stamped = await setTopics(token, owner, repoName, wanted);
      result.topics = stamped.ok
        ? { ok: true, names: stamped.topics }
        : { ok: false, error: stamped.error };
    }

    // ── 3. 描述前缀（只替换「开头那个方括号标签」，不动后面的正文）
    const currentDescription = String(remote.description ?? '');
    const nextDescription = withLabel(currentDescription, label);
    if (nextDescription !== currentDescription) {
      const patched = await updateRepo(token, owner, repoName, { description: nextDescription });
      result.description = patched.ok
        ? { ok: true, value: nextDescription }
        : { ok: false, error: patched.error };
    } else {
      result.description = { ok: true, unchanged: true, value: currentDescription };
    }
  } else {
    result.topics = { ok: false, error: remote.error ?? '读不到仓库属性' };
    result.description = { ok: false, error: remote.error ?? '读不到仓库属性' };
  }

  if (description && !result.description.value) result.description.value = description;

  // 只有标识文件写成功才算真的打上了标识：
  // 它才是换机之后唯一还能读到的证据（topics 可能改不动）。
  result.ok = Boolean(result.marker.ok);
  if (!result.ok) result.error = result.marker.error ?? '标识文件写入失败';
  return result;
}

/** 给描述加上 `[软件名] ` 前缀；已经带标签就替换掉开头那一个。 */
function withLabel(description, label) {
  const tag = `[${label}]`;
  const text = String(description ?? '').trim();
  if (text.length === 0) return `${tag} 跨电脑同步 · ${label}`;
  if (text.startsWith(tag)) return text;

  // 开头本来就是 `[...]`（可能是别的软件写的、也可能是旧名字）→ 换掉它
  const match = /^\[([^\]]{1,40})\]\s*/.exec(text);
  if (match) return `${tag} ${text.slice(match[0].length).trim()}`;
  return `${tag} ${text}`;
}

for (const __name of ["buildMarker","parseIdentity","stampRepo","withLabel","MARKER_FILE","LEGACY_MANIFEST","MARKER_SCHEMA"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
