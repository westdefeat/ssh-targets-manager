# SSH Targets Manager

SSH Targets Manager is a lightweight VS Code/Cursor extension for browsing, organizing, and opening SSH targets from your local SSH config. It keeps common remote-development actions close at hand: search hosts, group them, mark favorites, remember remote folders, and connect with one click.

## Features

- Reads hosts from `~/.ssh/config` and optional additional config paths.
- Filters hosts by alias, hostname, user, or remembered remote folder.
- Groups hosts automatically by IP subnet, with optional custom regex-based groups.
- Pins frequently used hosts in a Favorites section.
- Remembers recently opened remote folders per host.
- Opens SSH targets in the current window, a new window, or a terminal.
- Adds new SSH hosts through a simple form and can deploy a local public key when password access is available.
- Provides context-menu actions for copying hostnames, copying SSH commands, managing favorites, and removing hosts or folders.

## Why It Helps

SSH Targets Manager is designed for developers who switch between many machines. Instead of remembering host aliases, IP ranges, and project folders, you get a focused SSH dashboard inside the editor. It favors quick navigation, visible grouping, and low-friction remote access without replacing your standard SSH config.

## Configuration

The extension contributes these settings:

- `sshTargetsManager.sshConfigPaths`: additional SSH config file paths to read.
- `sshTargetsManager.customGroups`: custom group rules where each key is a display name and each value is a regex matched against host names or hostnames.
- `sshTargetsManager.autoGroupBySubnet`: enables automatic grouping by IP subnet when no custom groups are configured.

Example custom groups:

```json
{
  "Beijing": "192\\.168\\.9\\..*",
  "Wuhan": "192\\.168\\.49\\..*"
}
```

## Development

Install dependencies and compile:

```powershell
npm install
npm run compile
```

Package the extension:

```powershell
npm run package
```

Build and copy the compiled output into an installed extension directory:

```powershell
.\build.ps1
```

---

# SSH Targets Manager 中文说明

SSH Targets Manager 是一个轻量级 VS Code/Cursor 扩展，用于从本地 SSH 配置中浏览、整理并打开 SSH 目标。它把常用的远程开发操作放在编辑器侧边栏中：搜索主机、自动分组、收藏常用主机、记录远程目录，并支持一键连接。

## 特点

- 从 `~/.ssh/config` 和可选的额外配置文件读取主机。
- 可按别名、主机名、用户名或已记录的远程目录过滤。
- 支持按 IP 子网自动分组，也支持基于正则表达式的自定义分组。
- 可将常用主机固定到 Favorites 区域。
- 按主机记住最近使用的远程目录。
- 支持在当前窗口、新窗口或终端中打开 SSH 目标。
- 可通过表单新增 SSH 主机，并在提供密码时自动部署本地公钥。
- 提供右键菜单操作，用于复制主机名、复制 SSH 命令、管理收藏，以及移除主机或目录。

## 适用场景

这个扩展适合经常在多台远程机器之间切换的开发者。你不需要反复记忆主机别名、IP 段和项目目录，可以直接在编辑器中用一个清晰的 SSH 面板完成定位和连接，同时仍然保留标准 SSH config 作为数据来源。

## 配置

扩展提供以下设置：

- `sshTargetsManager.sshConfigPaths`：额外读取的 SSH config 文件路径。
- `sshTargetsManager.customGroups`：自定义分组规则，键为显示名称，值为匹配主机名或 HostName 的正则表达式。
- `sshTargetsManager.autoGroupBySubnet`：没有自定义分组时，是否按 IP 子网自动分组。
