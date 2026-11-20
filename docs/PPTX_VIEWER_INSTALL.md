# 打开 .pptx 的查看器：本机安装记录

## 一、只读探查到的环境事实

- 平台：Windows（工作区 `C:\Users\User\hmCodex-local`）。
- `C:\Program Files`：无 Microsoft Office / PowerPoint、无 WPS Office、无 LibreOffice。
- `C:\Program Files (x86)`：同样无上述三者（只有 Microsoft、Google、Steam 等）。
- `C:\Users\User\AppData\Local\Programs`：只有开发工具（cursor、antigravity、Devin、DeepSeek Harness、orca、Token Monitor、waveterm、hcli）。
- `C:\Users\User\AppData\Local\Microsoft\WindowsApps`：存在 `Microsoft.DesktopAppInstaller_8wekyb3d8bbwe`，说明系统自带 App Installer，即 winget 前端可用。
- winget-pkgs 仓库中确认存在以下 manifest 路径：
  - `manifests/t/TheDocumentFoundation/LibreOffice` → 包 ID `TheDocumentFoundation.LibreOffice`
  - `manifests/k/Kingsoft/WPSOffice` → 包 ID `Kingsoft.WPSOffice`

结论：本机当前没有任何能打开 `.pptx` 的软件，需要安装。

## 二、为什么这一步要由用户执行

dda 本次会话的受控执行策略只批准了 `node`、`npm`、`npx`、`cargo`、`rustc`、`git`，不包含 `winget` 或 `msiexec`；软件安装还会写入系统目录并可能触发管理员授权，超出本会话已获批的权限范围。因此本次没有执行任何 winget 命令：软件安装未发生，未产生文件或注册表改动。下面给出的是可直接粘贴到你自己 PowerShell 窗口运行的命令，而不是由 dda 代跑。

## 三、推荐安装：LibreOffice（免费、无需账号，Impress 可读写 .pptx）

在普通 PowerShell 窗口执行：

```powershell
winget install --id TheDocumentFoundation.LibreOffice --source winget --accept-package-agreements --accept-source-agreements
```

安装后验证：

```powershell
winget list --id TheDocumentFoundation.LibreOffice
& "C:\Program Files\LibreOffice\program\soffice.exe" --version
```

打开某个文件：

```powershell
& "C:\Program Files\LibreOffice\program\soffice.exe" "D:\path\to\file.pptx"
```

## 四、备选：WPS Office（中文界面，需接受金山用户协议）

```powershell
winget install --id Kingsoft.WPSOffice --source winget --accept-package-agreements --accept-source-agreements
```

## 五、不确定包 ID 时的兜底

```powershell
winget search libreoffice
winget search wps
```

以搜索输出里的 `Id` 列替换上面的 `--id`。

## 六、尚未验证的事项

- winget 源在本机网络下能否直接拉取（未执行：`winget` 不在本会话批准的可执行文件清单内）。
- 安装是否真的完成（未执行安装命令，因此本机仍无可用 `.pptx` 查看器）。
- 安装完成后的 `.pptx` 文件关联，以及复杂排版动画的渲染保真度（LibreOffice Impress 与 PowerPoint 存在差异）。
