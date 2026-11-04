# wb-sync · 跨电脑同步（WorkBuddy 扩展）

在两台电脑之间接续 **DeepSeek Harness** 和 **WorkBuddy** 的工作。
逐项勾选工作区 / 对话，传到你自己的私有 GitHub 仓库。数据不经过任何第三方服务。

> **能同步两个软件。** 这个扩展虽然装在 WorkBuddy 里，但它内置了
> DSH 和 WorkBuddy 两个数据源，两边的对话都能传 / 都能收。
> 同一套引擎还有 [DSH 插件](https://github.com/lingrenjie7-star/dsh-sync)
> 和 [桌面客户端](https://github.com/lingrenjie7-star/desktop-sync)。

## 能同步什么

| 软件 | 同步内容 | 落到哪里 | 在哪个界面看 |
|---|---|---|---|
| **DeepSeek Harness** | 工作区、对话、设置、技能 | `~/.dsh/` | DSH 左侧栏 |
| **WorkBuddy** | 项目、对话、记忆文件 | `~/.workbuddy/` | WorkBuddy 左侧栏 |

两边的数据分开存放，各回各家 —— 同步过来的 DSH 对话出现在 **DSH** 的
左侧栏，WorkBuddy 的出现在 **WorkBuddy** 的左侧栏。

## 安装

### 第一步：找到 WorkBuddy 的安装目录

WorkBuddy 装在哪里因人而异，常见的两种：

```
C:\Users\<你的用户名>\AppData\Local\Programs\WorkBuddy
D:\Program Files\WorkBuddy
E:\AITools\WorkBuddy
```

不确定的话，用这两种办法找：

- **任务管理器** → 找到 `WorkBuddy` 进程 → 右键 → **打开文件所在的位置**
- 或右键桌面上的 WorkBuddy 快捷方式 → **打开文件所在的位置**

下面把安装目录记作 `<WorkBuddy 安装目录>`。

### 第二步：把 `dshwb-sync` 目录放进扩展目录

扩展目录的完整路径是：

```
<WorkBuddy 安装目录>\resources\app.asar.unpacked\resources\extensions\dshwb-sync\
```

举例，如果你的 WorkBuddy 装在 `E:\AITools\WorkBuddy`，那就放成：

```
E:\AITools\WorkBuddy\resources\app.asar.unpacked\resources\extensions\dshwb-sync\
```

放好后目录长这样（`extension.json` 必须直接在 `dshwb-sync\` 下面一层）：

```
...\extensions\dshwb-sync\
    extension.json          ← 清单，必须有
    distribution.json       ← 权限/进程策略声明，必须有
    assets\icon.svg
    server\index.cjs         ← 服务端半边
    server\lib\...
    ui\assets\remoteEntry.js ← 界面半边
```

> 那个 `resources\app.asar.unpacked\resources\extensions\` 目录里本来就有一批
> WorkBuddy 自带扩展（`edge-sync`、`global-search`、`library` 等），
> 结构和你放的这份一样，可以对照着看。

### 第三步：完全退出并重启 WorkBuddy

**注意**：要**彻底退出**——包括右下角托盘图标也要退出（任务管理器里确认没有 `WorkBuddy` 进程），
然后重新打开。只关窗口不算重启，扩展不会重新加载。

### 如果没生效

1. 确认路径里没有多套一层，比如
   `...\extensions\dshwb-sync\dshwb-sync\extension.json` 就是错的
2. 确认 `extension.json` 第一行的 `"id"` 是 `dshwb-sync`
3. 看 WorkBuddy 的日志：`<WorkBuddy 安装目录>\debug.log` 或 `%USERPROFILE%\.workbuddy\logs\`
4. Windows 上如果往 `Program Files` 里复制提示没权限，用管理员身份打开资源管理器再复制

扩展由两部分组成，`extension.json` 声明了它们：

```json
{
  "ui":      { "entry": { "url": "./ui/assets/remoteEntry.js" } },
  "service": { "entry": "./server/index.cjs", "process": "fork" }
}
```

## 怎么用

1. 打开「跨电脑同步」面板
2. **账号** 页粘贴一个有 `repo` 权限的 GitHub 令牌
3. **仓库** 页点「＋ 给这个软件新建仓库」（或「加入已有仓库」）
4. **同步** 页勾选工作区，点「↑ 上传到 GitHub」

另一台电脑：装同一个扩展 → 连 GitHub → 仓库页**自动认出**同步仓库
（靠仓库里的 `dshwb-sync.json` 标识）→ 点「↓ 从 GitHub 下载」。

## 同步后对话为什么能出现在左侧栏

两个软件的机制不一样，这是最容易踩坑的地方：

| | DSH | WorkBuddy |
|---|---|---|
| 界面数据源 | `~/.dsh/storages/workspace.json` | `~/.workbuddy/workbuddy.db`（sqlite） |
| 只放文件够不够 | 不够，要写 json | **不够，要写 sqlite 表** |

DSH 侧还有一层：「勾了工作区就带上它的对话」需要一张「对话 → 工作区」索引。
这张索引**同时来自本机和远端仓库** —— 新机器本机是空的，只看本机会把
远端来的对话当成「未勾选」跳过，表现为工作区同步过来了但里面是空的。

⚠️ 目标机器上**必须先运行过一次 WorkBuddy**（让 `workbuddy.db` 存在），
否则 WorkBuddy 那边的对话列表补不上，会给出明确提示。

## 仓库标识

建仓时会在仓库根写 `dshwb-sync.json`：

```json
{
  "schema": "dshwb-sync/marker@1",
  "repo": {
    "source": "workbuddy",
    "sourceLabel": "WorkBuddy",
    "owner": "you",
    "repoName": "wb-sync-data"
  }
}
```

发现仓库时只读这个文件就能确定归属，**不靠名字猜**。

## 相关仓库

- [dsh-sync](https://github.com/lingrenjie7-star/dsh-sync) — 同一功能的 DSH 插件版
- [desktop-sync](https://github.com/lingrenjie7-star/desktop-sync) — 桌面客户端（绿色版免安装，令牌用系统加密）

## 已知限制

- 令牌以明文保存在 `~/.dshwb-sync/credentials.json`（扩展进程拿不到系统加密存储）
- 不做后台自动同步，永远由你点按钮触发
- DSH 侧要求目标机器配置过「工作区根目录」，否则路径映射会失败
  （对话照样同步，但点开会找不到原始目录）

## 许可证

[MIT](LICENSE)
