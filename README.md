# CodexCodeCheck

CodexCodeCheck 是一个吸附在 Codex 桌面端旁的半透明 Windows 代码窗口。它会展开项目文件树，自动打开最近修改的文件。可以自己逐个看差异，也可以让 Codex 审一遍，点审查意见跳到对应的行，再把意见复制回聊天。

## 怎么用

1. 从 GitHub Releases 下载适合电脑架构的压缩包并解压，打开 Codex 桌面端，再双击文件夹里的 `CodexCodeCheck.exe`。移动程序时请保留整个 `CodexCodeCheck` 文件夹。
2. 默认贴住 Codex 右侧，外侧空间不足时临时贴在同一边的内侧，空间恢复后自动回到外侧。拖动标题栏远离边缘可以脱离，拖回内外侧边缘可重新吸附；设置里也可直接选吸附位置。
3. 「设置」中的「随 Codex 启动」默认关闭，启用后会在 Windows 登录后监听 Codex，窗口出现时打开审查台。「自动调整大小」新安装默认开启，使侧栏与 Codex 的上下边缘对齐；升级保留已有开关。Codex 最小化或切到其他应用时，预览一起隐藏，返回 Codex 时恢复。
4. 「文件」显示项目树和带语法高亮的源码，「改动」显示 Git 差异。工作区变化后会打开最近修改的文件。源码支持 `Ctrl+F` 搜索和 `Ctrl+G` 跳行。
5. 双击标题栏可收起为贴边胶囊，单击胶囊恢复文件、滚动位置和窗口宽度。胶囊沿边拖动，横向拉开约 60 DIP 后成为自由悬浮球，拖回内外边缘可吸附。新修改仅显示一个静态小点。也可用全局快捷键 `Ctrl+Shift+空格` 展开或收起。
6. 用 `Ctrl+P` 按文件名快速打开，支持 `文件名:行号`。点源码标题旁的锁定按钮暂停自动跳转，有改动时点「查看最新改动」恢复跟随。

自动跟随使用 Codex 桌面端本地状态中的选中项目，需要能解析到唯一的本地项目根目录。会话使用独立 worktree 时，请用左上角的项目按钮选择该目录。手动选择后可点「跟随」恢复自动切换。

开发时也可以从 PowerShell 打开指定仓库：

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
npm.cmd run build
```

运行测试需要 Node.js 22 或更新版本。Git 读取在 `lib/git.cjs`，项目树和文件监听在 `lib/project-files.cjs`，窗口识别在 `lib/windows-dock.cjs`，界面在 `ui/`。

窗口跟随使用 Windows 窗口事件，24ms 合并移动事件，并保留低频兜底检查；最小化时保持同一个 Codex 窗口标识。几何测试覆盖内外侧回退与跨屏坐标。用缓存的 Electron 运行 `scripts/verify-companion.cjs` 可在独立临时配置中验证真实 BrowserWindow 的收起、拖动、脱离、恢复与层级逻辑，测试窗口保持隐藏。

参考：[OpenAI 官方 Codex CLI 命令文档](https://learn.chatgpt.com/docs/cli/reference#codex-exec)。
