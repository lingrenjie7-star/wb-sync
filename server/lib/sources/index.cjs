const __imp0 = require('./dsh.cjs');
const __imp1 = require('./workbuddy.cjs');
const __imp2 = require('./generic.cjs');
const { dshSource } = __imp0;
const { workbuddySource } = __imp1;
const { createGenericSource } = __imp2;
/**
 * 数据源注册表。
 *
 * 内置 DSH 与 WorkBuddy；其它软件用通用目录数据源按配置动态创建。
 */





/** 内置适配器。 */
const BUILTIN_SOURCES = [dshSource, workbuddySource];

/** 常见软件的建议目录，用于「添加数据源」时的预设。 */
const SOURCE_PRESETS = [
  {
    id: 'codex',
    label: 'Codex',
    icon: '◇',
    description: 'OpenAI Codex CLI 的会话与配置',
    defaultPath: '~/.codex',
    homeKey: 'codex',
  },
  {
    id: 'claudecode',
    label: 'Claude Code',
    icon: '✳',
    description: 'Claude Code 的会话与配置',
    defaultPath: '~/.claude',
    homeKey: 'claude',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    icon: '▷',
    description: 'Cursor 的配置与会话记录',
    defaultPath: '~/.cursor',
    homeKey: 'cursor',
  },
  {
    id: 'aider',
    label: 'Aider',
    icon: '△',
    description: 'Aider 的会话历史',
    defaultPath: '~/.aider',
    homeKey: 'aider',
  },
  {
    id: 'custom',
    label: '自定义目录',
    icon: '▣',
    description: '任何把数据放在一个目录里的软件',
    defaultPath: '',
    homeKey: '',
  },
];

/**
 * 按配置构造出所有启用中的数据源。
 * @param {object} config
 * @returns {object[]} 适配器实例
 */
function buildSources(config) {
  const sources = [...BUILTIN_SOURCES];

  for (const custom of config.customSources ?? []) {
    if (!custom || !custom.id || !custom.homeKey) continue;
    if (custom.enabled === false) continue;
    sources.push(
      createGenericSource({
        id: custom.id,
        label: custom.label ?? custom.id,
        description: custom.description ?? '自定义目录',
        icon: custom.icon ?? '▣',
        homeKey: custom.homeKey,
      }),
    );
  }

  return sources;
}

/** 给界面用的静态清单。 */
function describeSources(config) {
  return buildSources(config).map((source) => ({
    id: source.id,
    label: source.label,
    shortLabel: source.meta?.shortLabel ?? source.label,
    description: source.meta?.description ?? '',
    icon: source.icon,
    generic: Boolean(source.meta?.generic),
    tier: source.meta?.tier,
  }));
}

for (const __name of ["buildSources","describeSources","BUILTIN_SOURCES","SOURCE_PRESETS"]) {
  Object.defineProperty(module.exports, __name, {
    enumerable: true, configurable: true,
    get() { return eval(__name); },
  });
}
