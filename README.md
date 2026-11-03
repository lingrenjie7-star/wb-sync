# 跨电脑同步 · WorkBuddy 扩展

在两台电脑之间接续 **WorkBuddy** 的工作。逐项勾选工作区 / 对话，
传到你自己的私有 GitHub 仓库。数据不经过任何第三方服务。

> 这是「跨电脑同步」的 WorkBuddy 一侧。同一套引擎还有
> [DSH 插件](https://github.com/lingrenjie7-star/dsh-sync) 和
> [桌面客户端](https://github.com/lingrenjie7-star/desktop-sync)。

## 安装

1. 下载本仓库，得到一个 `dshwb-sync` 目录
2. 在 WorkBuddy 里打开扩展目录，把整个目录放进去
3. 重启 WorkBuddy

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

另一台电脑：装同一个扩展 → 连 GitHub → 仓库页自动认出同步仓库
（靠仓库里的 `dshwb-sync.json` 标识）→ 点「↓ 从 GitHub 下载」。

## WorkBuddy 的对话为什么能出现在左侧栏

WorkBuddy 界面的会话列表读的是 `~/.workbuddy/workbuddy.db`（sqlite），
**不是文件目录**。所以同步做两件事：

1. 把对话文件写进 `~/.workbuddy/projects/<slug>/<id>.jsonl`
2. 往 `workbuddy.db` 的 `sessions` 和 `workspaces` 表插入索引行

只做第一步的话，文件在位但界面不显示 —— 这是最容易踩的坑。

⚠️ 目标机器上**必须先运行过一次 WorkBuddy**，让 `workbuddy.db` 存在。
否则会提示「本机还没运行过 WorkBuddy，先启动一次它再同步」。

## 仓库标识

建仓时会在仓库根写 `dshwb-sync.json`：

```json
{
  "schema": "dshwb-sync/marker@1",
  "repo": {
    "source": "workbuddy",
    "sourceLabel": "WorkBuddy",
    "owner": "you",
    "repoName": "wb-sync"
  }
}
```

发现仓库时只读这个文件就能确定归属，**不靠名字猜**。

## 已知限制

- 令牌以明文保存在 `~/.dshwb-sync/credentials.json`（扩展进程拿不到系统加密存储）
- 不做后台自动同步，永远由你点按钮触发

## 许可证

[MIT](LICENSE)
