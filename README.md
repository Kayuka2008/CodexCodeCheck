# CodexCodeCheck

CodexCodeCheck 是一个可以和 Codex 并排打开的 Windows 小窗口。Codex 改完代码后，点「刷新」就能看到哪些文件变了。可以自己逐个看差异，也可以让 Codex 审一遍，点审查意见跳到对应的行，再把意见复制回聊天。

## 怎么用

1. 双击 `Launch.cmd`。第一次打开会准备 Electron，有可用的缓存就直接用。
2. 选中 Codex 正在改的 Git 仓库目录。如果 Codex 用的是独立 worktree，就选那个 worktree。窗口会记住上次选的目录。
3. 想边看边聊，可以打开「置顶」。每次改完代码，点「刷新」更新文件列表。

也可以从 PowerShell 直接打开指定仓库：

```powershell
.\Launch.cmd 'D:\path\to\repo'
```

需要 Windows x64 或 ARM64，以及 PATH 中可用的 Git。要运行 Codex 审查，还需要已登录且支持 `codex exec --output-schema` 的 Codex CLI。启动器会从 PATH 和 Codex 桌面安装目录查找 CLI，也可以用 `CODEX_REVIEW_CLI` 指定 `codex.exe` 的路径。

## 能看哪些改动

| 范围 | 查看及审查的改动 |
| --- | --- |
| 工作区 | 相对 `HEAD` 的净改动，以及未跟踪文件 |
| 未暂存 | 工作目录相对暂存区的改动 |
| 已暂存 | 暂存区相对 `HEAD` 的改动 |
| 对比分支 | 从共同祖先到当前 `HEAD` 的改动 |
| 指定提交 | 相对第一个父提交的改动，根提交与空树比较 |

本地查看差异可以离线使用。点「运行 Codex 审查」会把选中范围的 Git 差异交给 Codex CLI，并消耗 Codex 用量。审查可随时取消，每次最多处理 80 个文件和 128 KiB 差异。审查依据是差异里提供的上下文。

带行号的意见可以点开定位，也可以复制单条意见或整份报告。窗口按选定的 Git 目录工作，所有 Git 操作均为只读。

## 开发

```powershell
node --test
```

运行测试需要 Node.js 22 或更新版本。Git 读取在 `lib/git.cjs`，CLI 调用在 `lib/review.cjs`，界面在 `ui/`。

参考：[OpenAI 官方 Codex CLI 命令文档](https://learn.chatgpt.com/docs/cli/reference#codex-exec)。
