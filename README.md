# CodexCodeCheck

CodexCodeCheck 是一个吸附在 Codex 桌面端旁的半透明 Windows 代码窗口。它会展开项目文件树，自动打开最近修改的文件。可以自己逐个看差异，也可以让 Codex 审一遍，点审查意见跳到对应的行，再把意见复制回聊天。

## 怎么用

1. 打开 Codex 桌面端，再双击 `Launch.cmd`。第一次打开会准备 Electron，有可用的缓存就直接用。
2. 拖动标题栏靠近 Codex 的任一边缘，松手时会吸到内侧或外侧。左外侧可以留少量窗口在屏幕外。吸附位置和窗口大小会在下次启动时恢复。点「吸附」解除后可自由摆放。
3. 「文件」显示项目树，「改动」列出 Git 差异。工作区文件变化后，窗口会自动展开对应目录并打开文件。查看历史范围或运行审查时，自动跳转会等你回到工作区视图。

自动跟随使用 Codex 桌面端本地状态中的选中项目，需要能解析到唯一的本地项目根目录。会话使用独立 worktree 时，请用左上角的项目按钮选择该目录。手动选择后可点「跟随」恢复自动切换。

也可以从 PowerShell 直接打开指定仓库：

```powershell
.\Launch.cmd 'D:\path\to\repo'
```

需要 Windows x64 或 ARM64。查看 Git 差异需要 PATH 中可用的 Git。要运行 Codex 审查，还需要已登录且支持 `codex exec --output-schema` 的 Codex CLI。启动器会从 PATH 和 Codex 桌面安装目录查找 CLI，也可以用 `CODEX_REVIEW_CLI` 指定 `codex.exe` 的路径。

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

运行测试需要 Node.js 22 或更新版本。Git 读取在 `lib/git.cjs`，项目树和文件监听在 `lib/project-files.cjs`，窗口识别在 `lib/windows-dock.cjs`，界面在 `ui/`。

参考：[OpenAI 官方 Codex CLI 命令文档](https://learn.chatgpt.com/docs/cli/reference#codex-exec)。
