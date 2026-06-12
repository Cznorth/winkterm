"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";

export type Locale = "zh" | "en";

const translations = {
  // === Layout ===
  "layout.terminal": { zh: "终端", en: "Terminal" },
  "layout.aiAssistant": { zh: "AI 助手", en: "AI Assistant" },
  "layout.chatShort": { zh: "对话", en: "Chat" },
  "layout.sshConnections": { zh: "SSH 连接 / 文件传输", en: "SSH / File Transfer" },
  "layout.sshShort": { zh: "SSH", en: "SSH" },
  "layout.settings": { zh: "设置", en: "Settings" },
  "layout.navigation": { zh: "主导航", en: "Main navigation" },
  "layout.single": { zh: "单分区", en: "Single" },
  "layout.horizontal": { zh: "左右双列", en: "Side by Side" },
  "layout.vertical": { zh: "上下双行", en: "Top & Bottom" },
  "layout.grid": { zh: "田字格 2x2", en: "Grid 2x2" },
  "layout.closeAiPanel": { zh: "关闭 AI 面板", en: "Close AI panel" },

  // === TitleBar ===
  "titlebar.close": { zh: "关闭", en: "Close" },
  "titlebar.minimize": { zh: "最小化", en: "Minimize" },
  "titlebar.maximize": { zh: "最大化", en: "Maximize" },
  "titlebar.restore": { zh: "还原", en: "Restore" },

  // === TabBar ===
  "tabbar.close": { zh: "关闭", en: "Close" },
  "tabbar.newTerminal": { zh: "新建终端", en: "New Terminal" },
  "tabbar.localTerminal": { zh: "本地终端", en: "Local Terminal" },
  "tabbar.sshConnection": { zh: "SSH 连接", en: "SSH Connection" },
  "tabbar.switchTab": { zh: "切换标签页", en: "Switch tab" },
  "tabbar.tabs": { zh: "标签页", en: "Tabs" },

  // === Terminal (mobile keys) ===
  "terminal.mobileKeys": { zh: "终端操作键", en: "Terminal keys" },
  "terminal.moreKeys": { zh: "更多符号", en: "More symbols" },
  "terminal.keyUp": { zh: "上方向键", en: "Up arrow" },
  "terminal.keyDown": { zh: "下方向键", en: "Down arrow" },
  "terminal.keyLeft": { zh: "左方向键", en: "Left arrow" },
  "terminal.keyRight": { zh: "右方向键", en: "Right arrow" },
  "terminal.keyTabAlt": { zh: "Tab", en: "Tab" },

  // === Settings ===
  "settings.title": { zh: "设置", en: "Settings" },
  "settings.agentDocs": { zh: "AI 指令与记忆", en: "AI Instructions & Memory" },
  "settings.agentsMd": { zh: "操作指令 (agents.md)", en: "Instructions (agents.md)" },
  "settings.agentsMdHelp": {
    zh: "AI 每轮都会遵循这里的自定义指令。",
    en: "The AI follows these custom instructions on every turn.",
  },
  "settings.memoryMd": { zh: "长期记忆 (memory.md)", en: "Long-term Memory (memory.md)" },
  "settings.memoryMdHelp": {
    zh: "AI 自动维护的记忆，你也可以手动编辑。",
    en: "Maintained automatically by the AI; you can also edit it manually.",
  },
  "settings.saveDoc": { zh: "保存", en: "Save" },
  "settings.docSaved": { zh: "已保存", en: "Saved" },
  "settings.apiConfig": { zh: "API 配置", en: "API Configuration" },
  "settings.apiFormat": { zh: "API 格式", en: "API Format" },
  "settings.baseUrl": { zh: "Base URL", en: "Base URL" },
  "settings.apiKey": { zh: "API Key", en: "API Key" },
  "settings.openaiHelp": {
    zh: "OpenAI 兼容 API 地址（Ollama、Groq、OpenRouter 等）。通常需要包含 /v1，末尾不要加 /",
    en: "OpenAI-compatible API base URL (Ollama, Groq, OpenRouter, etc.). Usually needs /v1, no trailing /",
  },
  "settings.anthropicHelp": {
    zh: "Anthropic API 地址（通常无需修改）。需要包含 /v1，末尾不要加 /",
    en: "Anthropic API base URL (usually no change needed). Needs /v1, no trailing /",
  },
  "settings.fetching": { zh: "获取中...", en: "Fetching..." },
  "settings.autoFetch": { zh: "自动获取模型", en: "Auto-fetch models" },
  "settings.streamTest": { zh: "流式测试", en: "Stream test" },
  "settings.streamTesting": { zh: "测试中...", en: "Testing..." },
  "settings.streamTestNeedModel": {
    zh: "请先选择或添加模型后再测试",
    en: "Select or add a model before testing",
  },
  "settings.streamTestFailed": { zh: "流式测试失败", en: "Stream test failed" },
  "settings.streamTestSuccess": { zh: "流式连接正常", en: "Streaming OK" },
  "settings.streamTestStop": { zh: "停止", en: "Stop" },
  "settings.noModelsReturned": {
    zh: "未返回模型列表，请检查 Base URL 和 API Key。",
    en: "No models returned. Check your Base URL and API Key.",
  },
  "settings.fetchFailed": { zh: "获取模型列表失败", en: "Failed to fetch model list" },
  "settings.modelConfig": { zh: "模型配置", en: "Model Configuration" },
  "settings.activeModel": { zh: "当前模型", en: "Active Model" },
  "settings.selectModel": { zh: "选择模型", en: "Select a model" },
  "settings.configuredModels": { zh: "已配置模型", en: "Configured Models" },
  "settings.noModels": { zh: "暂无模型", en: "No models configured" },
  "settings.noModelsHint": {
    zh: '点击上方"自动获取模型"或手动添加',
    en: 'Click "Auto-fetch models" above or add one manually',
  },
  "settings.addManually": { zh: "手动添加模型", en: "Add Model Manually" },
  "settings.modelId": { zh: "模型 ID", en: "Model ID" },
  "settings.displayName": { zh: "显示名称（可选）", en: "Display name (optional)" },
  "settings.addModel": { zh: "添加模型", en: "Add model" },
  "settings.removeModel": { zh: "移除模型", en: "Remove model" },
  "settings.saved": { zh: "设置已保存", en: "Settings saved" },
  "settings.saving": { zh: "保存中...", en: "Saving..." },
  "settings.save": { zh: "保存设置", en: "Save Settings" },
  "settings.language": { zh: "语言", en: "Language" },
  "settings.langZh": { zh: "中文", en: "Chinese" },
  "settings.langEn": { zh: "English", en: "English" },
  "settings.agentAccess": { zh: "外部 Agent 接入", en: "External Agent Access" },
  "settings.agentApiToken": { zh: "接口鉴权 Token", en: "API Token" },
  "settings.agentApiTokenHelp": {
    zh: "外部 agent 调用接口所需的 token。留空则外部接口关闭。修改后需点击下方「保存设置」。",
    en: "Token required for external agent API calls. Leave empty to disable the API. Click \"Save Settings\" below after changes.",
  },
  "settings.agentApiTokenGenerate": { zh: "随机生成", en: "Generate" },
  "settings.copy": { zh: "复制", en: "Copy" },
  "settings.copied": { zh: "已复制", en: "Copied" },
  "settings.agentAccessDesc": {
    zh: "复制下面的 prompt 发给你的外部 agent，它会按指引自助安装 WinkTerm 远程操作能力。",
    en: "Copy the prompt below and send it to your external agent; it will self-install WinkTerm remote-control capability.",
  },
  "settings.agentAccessPrompt": {
    zh: "根据下面的指导安装这个 skill：",
    en: "Install this skill by following the guide at: ",
  },
  "settings.agentAccessOpen": { zh: "打开安装指导", en: "Open install guide" },
  "settings.agentAccessCopy": { zh: "复制 prompt", en: "Copy prompt" },
  "settings.agentAccessCopied": { zh: "已复制", en: "Copied" },

  // === VNC ===
  "vnc.connect": { zh: "VNC 连接", en: "VNC Connect" },
  "vnc.connectTo": { zh: "VNC 连接到 ", en: "VNC Connect to " },
  "vnc.port": { zh: "VNC 端口", en: "VNC Port" },
  "vnc.password": { zh: "VNC 密码", en: "VNC Password" },
  "vnc.passwordPlaceholder": { zh: "留空使用已保存", en: "Leave blank to use saved" },
  "vnc.passwordPlaceholderNew": { zh: "VNC 密码", en: "VNC password" },
  "vnc.passwordPlaceholderEdit": { zh: "留空保持不变", en: "Leave blank to keep unchanged" },
  "vnc.save": { zh: "保存", en: "Save" },
  "vnc.settings": { zh: "VNC", en: "VNC" },
  "vnc.connecting": { zh: "VNC 连接中...", en: "Connecting VNC..." },
  "vnc.disconnected": { zh: "VNC 已断开", en: "VNC Disconnected" },
  "vnc.reconnect": { zh: "重新连接", en: "Reconnect" },
  "vnc.authFailed": { zh: "VNC 认证失败", en: "VNC authentication failed" },
  "vnc.passwordRequired": {
    zh: "需要 VNC 密码。请在 SSH 连接列表的 VNC 对话框中输入并保存密码后重试。",
    en: "VNC password required. Enter and save it in the SSH connection VNC dialog, then retry.",
  },
  "vnc.connectionFailed": { zh: "VNC 连接失败", en: "VNC connection failed" },
  "vnc.layoutNotReady": {
    zh: "VNC 视图尚未就绪，请稍后重试",
    en: "VNC view is not ready yet. Please retry shortly.",
  },
  "vnc.tunnelFailed": {
    zh: "无法建立 SSH 隧道到 VNC 端口，请检查端口与远程 VNC 服务",
    en: "Failed to open SSH tunnel to the VNC port. Check the port and remote VNC service.",
  },

  // === SSH ===
  "ssh.title": { zh: "SSH 连接", en: "SSH Connections" },
  "ssh.subtitle": { zh: "连接支持文件传输", en: "Connections support file transfer" },
  "ssh.more": { zh: "更多", en: "More" },
  "ssh.newConnection": { zh: "新建连接", en: "New connection" },
  "ssh.fileTransfer": { zh: "文件传输", en: "File transfer" },
  "ssh.importConnections": { zh: "导入连接", en: "Import connections" },
  "ssh.noConnections": { zh: "暂无 SSH 连接", en: "No SSH connections" },
  "ssh.noConnectionsHint": {
    zh: '点击"更多">"新建连接"添加',
    en: 'Click "More" > "New connection" to add one',
  },
  "ssh.openFileTransfer": { zh: "打开文件传输", en: "Open file transfer" },
  "ssh.connect": { zh: "连接", en: "Connect" },
  "ssh.edit": { zh: "编辑", en: "Edit" },
  "ssh.delete": { zh: "删除", en: "Delete" },
  "ssh.editConnection": { zh: "编辑连接", en: "Edit Connection" },
  "ssh.newConnectionTitle": { zh: "新建连接", en: "New Connection" },
  "ssh.close": { zh: "关闭", en: "Close" },
  "ssh.name": { zh: "名称", en: "Name" },
  "ssh.namePlaceholder": { zh: "服务器名称（可选）", en: "Server name (optional)" },
  "ssh.host": { zh: "主机 *", en: "Host *" },
  "ssh.hostPlaceholder": { zh: "IP 或域名", en: "IP or domain" },
  "ssh.port": { zh: "端口", en: "Port" },
  "ssh.username": { zh: "用户名 *", en: "Username *" },
  "ssh.usernamePlaceholder": { zh: "用户名", en: "Username" },
  "ssh.authType": { zh: "认证方式", en: "Auth type" },
  "ssh.password": { zh: "密码", en: "Password" },
  "ssh.key": { zh: "密钥", en: "Key" },
  "ssh.passwordPlaceholderEdit": { zh: "留空保持不变", en: "Leave blank to keep unchanged" },
  "ssh.showPassword": { zh: "显示密码", en: "Show password" },
  "ssh.hidePassword": { zh: "隐藏密码", en: "Hide password" },
  "ssh.privateKeyPath": { zh: "私钥路径", en: "Private key path" },
  "ssh.privateKeyPlaceholder": { zh: "例如 ~/.ssh/id_rsa", en: "e.g. ~/.ssh/id_rsa" },
  "ssh.color": { zh: "颜色", en: "Color" },
  "ssh.save": { zh: "保存", en: "Save" },
  "ssh.cancel": { zh: "取消", en: "Cancel" },
  "ssh.importFailed": { zh: "导入失败，请检查文件格式。", en: "Import failed. Check the file format." },
  "ssh.runbook": { zh: "运维手册", en: "Runbook" },
  "ssh.runbookTitle": { zh: "运维手册", en: "Ops Runbook" },
  "ssh.runbookPlaceholder": {
    zh: "记录该服务器的运维知识：服务部署、重启命令、注意事项……（支持 Markdown，AI 可读写）",
    en: "Server ops notes: deployment, restart commands, gotchas… (Markdown; the AI can read & edit)",
  },
  "ssh.runbookSaved": { zh: "已保存", en: "Saved" },
  "ssh.runbookSaveFailed": { zh: "保存失败", en: "Save failed" },

  // === AI Panel ===
  "ai.thinking": { zh: "思考中", en: "Thinking" },
  "ai.connected": { zh: "已连接", en: "Connected" },
  "ai.disconnected": { zh: "未连接", en: "Disconnected" },
  "ai.chatMode": { zh: "Chat Mode", en: "Chat Mode" },
  "ai.craftMode": { zh: "Craft Mode", en: "Craft Mode" },
  "ai.chatLabel": { zh: "Chat", en: "Chat" },
  "ai.chatDesc": { zh: "General assistant for questions and advice", en: "General assistant for questions and advice" },
  "ai.craftLabel": { zh: "Craft", en: "Craft" },
  "ai.craftDesc": { zh: "Code writer with terminal access", en: "Code writer with terminal access" },
  "ai.askMode": { zh: "Ask Mode", en: "Ask Mode" },
  "ai.askLabel": { zh: "Ask", en: "Ask" },
  "ai.askDesc": {
    zh: "Same tools as Craft, but every command needs your approval before it runs",
    en: "Same tools as Craft, but every command needs your approval before it runs",
  },
  "ai.approval.title": { zh: "需要确认：AI 请求执行工具", en: "Approval required: the AI wants to run a tool" },
  "ai.approval.approve": { zh: "批准", en: "Approve" },
  "ai.approval.deny": { zh: "拒绝", en: "Deny" },
  "ai.placeholder": {
    zh: "输入消息... (Enter 发送, Shift+Enter 换行)",
    en: "Ask anything... (Enter to send, Shift+Enter for new line)",
  },
  "ai.waitingConnection": { zh: "等待连接...", en: "Waiting for connection..." },
  "ai.stop": { zh: "停止", en: "Stop" },
  "ai.send": { zh: "发送", en: "Send" },
  "ai.queue.interrupt": { zh: "打断当前回答并立即发送", en: "Interrupt and send now" },
  "ai.queue.remove": { zh: "从队列中移除", en: "Remove from queue" },
  "ai.running": { zh: "执行中...", en: "Running..." },
  "ai.connectionFailed": { zh: "连接失败", en: "Connection failed" },
  "ai.conversation": { zh: "对话", en: "Chat" },
  "ai.newConversation": { zh: "新建对话", en: "New conversation" },
  "ai.regenerateTitle": { zh: "重新生成标题", en: "Regenerate title" },

  // === File Transfer ===
  "ft.title": { zh: "远程文件管理器", en: "Remote File Manager" },
  "ft.close": { zh: "关闭", en: "Close" },
  "ft.parentDir": { zh: "返回上级目录", en: "Go to parent directory" },
  "ft.parent": { zh: "上级", en: "Parent" },
  "ft.refreshDir": { zh: "刷新目录", en: "Refresh directory" },
  "ft.refresh": { zh: "刷新", en: "Refresh" },
  "ft.uploadHere": { zh: "上传到当前目录", en: "Upload to current directory" },
  "ft.upload": { zh: "上传", en: "Upload" },
  "ft.downloadSelected": { zh: "下载选中文件", en: "Download selected files" },
  "ft.download": { zh: "下载", en: "Download" },
  "ft.deleteSelected": { zh: "删除选中项目", en: "Delete selected items" },
  "ft.delete": { zh: "删除", en: "Delete" },
  "ft.newFolder": { zh: "新建文件夹", en: "New Folder" },
  "ft.saving": { zh: "保存中...", en: "Saving..." },
  "ft.save": { zh: "保存", en: "Save" },
  "ft.currentLocation": { zh: "当前位置", en: "Current location" },
  "ft.enterFolderName": { zh: "输入新文件夹名称", en: "Enter new folder name" },
  "ft.creating": { zh: "创建中...", en: "Creating..." },
  "ft.create": { zh: "创建", en: "Create" },
  "ft.cancel": { zh: "取消", en: "Cancel" },
  "ft.confirmReplace": { zh: "确认替换文件", en: "Confirm file replacement" },
  "ft.replaceHint": {
    zh: "以下文件在当前目录已存在，继续上传会覆盖远端同名文件。",
    en: "The following files already exist. Uploading will overwrite them.",
  },
  "ft.replaceAndUpload": { zh: "替换并上传", en: "Replace and upload" },
  "ft.enterFolderNamePrompt": { zh: "请输入文件夹名称", en: "Please enter folder name" },
  "ft.folderNameNoSlash": { zh: "文件夹名称不能包含 /", en: "Folder name cannot contain /" },
  "ft.confirmDelete": { zh: "确认删除", en: "Confirm deletion" },
  "ft.deleteHint": {
    zh: "删除后无法恢复，目录会递归删除其中的全部内容。",
    en: "Cannot be recovered. Directories are deleted recursively.",
  },
  "ft.folderCreated": { zh: "已创建文件夹", en: "Folder created" },
  "ft.uploadCompleted": { zh: "上传完成", en: "Upload completed" },
  "ft.savedTo": { zh: "已保存到", en: "Saved to" },
  "ft.downloaded": { zh: "已下载", en: "Downloaded" },
  "ft.startedDownloading": { zh: "已开始下载", en: "Started downloading" },
  "ft.deleted": { zh: "已删除", en: "Deleted" },
  "ft.saved": { zh: "已保存", en: "Saved" },
  "ft.multipleSelected": { zh: "已选择多个项目", en: "Multiple items selected" },
  "ft.multipleSelectedHint": {
    zh: "可批量下载或删除。文本预览和编辑仅在单选文件时可用。",
    en: "Batch download/delete available. Preview and edit only for single file selection.",
  },
  "ft.selectFileHint": { zh: "选择一个文件查看详情", en: "Select a file to view details" },
  "ft.selectFileDesc": {
    zh: "支持 Ctrl/Shift 多选，文本文件会在这里直接预览和编辑。",
    en: "Ctrl/Shift multi-select supported. Text files can be previewed and edited here.",
  },
  "ft.folderSelected": { zh: "当前选中的是文件夹", en: "A folder is selected" },
  "ft.folderSelectedDesc": {
    zh: "双击进入目录，或拖拽文件到左侧列表上传到这个目录。",
    en: "Double-click to enter, or drag files to the list to upload to this folder.",
  },
  "ft.loadingText": { zh: "正在载入文本内容...", en: "Loading text content..." },
  "ft.cannotEditOnline": { zh: "无法在线编辑", en: "Cannot edit online" },
  "ft.previewFailed": { zh: "预览失败", en: "Preview failed" },
  "ft.colName": { zh: "名称", en: "Name" },
  "ft.colModified": { zh: "修改时间", en: "Modified" },
  "ft.colSize": { zh: "大小", en: "Size" },
  "ft.colPermissions": { zh: "权限", en: "Permissions" },
  "ft.readingDir": { zh: "正在读取远端目录...", en: "Reading remote directory..." },
  "ft.emptyDir": { zh: "当前目录为空", en: "Current directory is empty" },
  "ft.dragUpload": { zh: "拖拽文件到这里上传", en: "Drag files here to upload" },
  "ft.previewAndEdit": { zh: "预览与编辑", en: "Preview & Edit" },
  "ft.itemsSelected": { zh: "项已选", en: "selected" },
  "ft.noFileSelected": { zh: "未选择文件", en: "No files selected" },
  "ft.unsaved": { zh: "未保存", en: "Unsaved" },
  "ft.type": { zh: "类型", en: "Type" },
  "ft.size": { zh: "大小", en: "Size" },
  "ft.path": { zh: "路径", en: "Path" },
  "ft.multiple": { zh: "多选", en: "Multiple" },
  "ft.directory": { zh: "目录", en: "Directory" },
  "ft.file": { zh: "文件", en: "File" },
  "ft.items": { zh: "个项目", en: "items" },
  "ft.folder": { zh: "文件夹", en: "Folder" },
  "ft.transferFailed": { zh: "文件传输失败", en: "File transfer failed" },
  "ft.filesUploaded": { zh: "个文件上传", en: "files uploaded" },
  "ft.filesDownloaded": { zh: "个文件", en: "files" },
  "ft.encoding": { zh: "编码", en: "Encoding" },
  "ft.textSize": { zh: "文本大小", en: "Text size" },

  // === Auth Gate ===
  "auth.setupTitle": { zh: "设置访问密钥", en: "Set Access Key" },
  "auth.setupDesc": {
    zh: "首次远程访问需设置一个访问密钥。之后所有远程访问都需要此密钥。",
    en: "First-time remote access requires setting an access key. All future remote access will need this key.",
  },
  "auth.loginTitle": { zh: "需要访问密钥", en: "Access Key Required" },
  "auth.loginDesc": {
    zh: "此 WinkTerm 已开启远程访问鉴权，请输入访问密钥。",
    en: "This WinkTerm requires authentication for remote access. Enter the access key.",
  },
  "auth.keyLabel": { zh: "访问密钥", en: "Access Key" },
  "auth.keyPlaceholder": { zh: "至少 4 个字符", en: "At least 4 characters" },
  "auth.confirmLabel": { zh: "确认密钥", en: "Confirm Key" },
  "auth.confirmPlaceholder": { zh: "再次输入密钥", en: "Re-enter the key" },
  "auth.submitSetup": { zh: "设置并进入", en: "Set and Continue" },
  "auth.submitLogin": { zh: "进入", en: "Continue" },
  "auth.errKeyShort": { zh: "密钥至少 4 个字符", en: "Key must be at least 4 characters" },
  "auth.errMismatch": { zh: "两次输入的密钥不一致", en: "The keys do not match" },
  "auth.errWrongKey": { zh: "访问密钥错误", en: "Incorrect access key" },
  "auth.errNetwork": { zh: "无法连接到服务", en: "Cannot connect to the server" },
  "auth.retry": { zh: "重试", en: "Retry" },
  "auth.serverTitle": { zh: "连接服务器", en: "Connect to Server" },
  "auth.serverDesc": {
    zh: "输入 WinkTerm 后端地址（建议使用 https/wss）。",
    en: "Enter the WinkTerm backend address (https/wss recommended).",
  },
  "auth.serverLabel": { zh: "服务器地址", en: "Server URL" },
  "auth.serverPlaceholder": { zh: "https://host:8000", en: "https://host:8000" },
  "auth.submitServer": { zh: "连接", en: "Connect" },
  "auth.changeServer": { zh: "更换服务器", en: "Change Server" },
  "auth.errBadUrl": { zh: "请输入有效的服务器地址", en: "Enter a valid server URL" },

  // === Settings: Web Access ===
  "settings.webAccess": { zh: "Web 远程访问", en: "Web Remote Access" },
  "settings.webAccessKey": { zh: "访问密钥", en: "Access Key" },
  "settings.webAccessKeyHelp": {
    zh: "远程浏览器访问所需的密钥。本机桌面客户端始终免鉴权。未设置时，首次远程访问会要求设置密钥。修改后需点击下方「保存设置」。",
    en: "Key required for remote browser access. The local desktop client never needs it. When unset, the first remote visit will prompt to set one. Click \"Save Settings\" below after changes.",
  },
  "settings.appearance": { zh: "外观", en: "Appearance" },
  "settings.theme": { zh: "主题", en: "Theme" },
  "settings.themeSystem": { zh: "跟随系统", en: "System" },
  "settings.themeDark": { zh: "深色", en: "Dark" },
  "settings.themeLight": { zh: "浅色", en: "Light" },
  "settings.exportConfig": { zh: "导出配置文件", en: "Export Config" },
  "settings.exportConfigHelp": {
    zh: "下载包含所有配置（含密钥明文）的 JSON 文件，请妥善保管。",
    en: "Download a JSON file with all settings including plaintext secrets. Keep it safe.",
  },
  "settings.about": { zh: "关于", en: "About" },
  "settings.githubProject": { zh: "GitHub 项目", en: "GitHub Repository" },
  "settings.githubProjectHelp": {
    zh: "查看源码、提交 Issue 或获取最新版本。",
    en: "View source code, report issues, or get the latest release.",
  },
} as const;

type TranslationKey = keyof typeof translations;

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextType>({
  locale: "en",
  setLocale: () => {},
  t: (key) => key,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const saved = localStorage.getItem("winkterm-language") as Locale | null;
    if (saved && (saved === "zh" || saved === "en")) {
      setLocaleState(saved);
    }
  }, []);

  const setLocale = useCallback((lang: Locale) => {
    setLocaleState(lang);
    localStorage.setItem("winkterm-language", lang);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => {
      const entry = translations[key];
      if (!entry) return key;
      return entry[locale] || entry["en"] || key;
    },
    [locale]
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
