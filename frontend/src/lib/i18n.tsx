"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";

export type Locale = "zh" | "en";

const translations = {
  // === Layout ===
  "layout.terminal": { zh: "终端", en: "Terminal" },
  "layout.aiAssistant": { zh: "AI 助手", en: "AI Assistant" },
  "layout.sshConnections": { zh: "SSH 连接 / 文件传输", en: "SSH / File Transfer" },
  "layout.settings": { zh: "设置", en: "Settings" },
  "layout.single": { zh: "单分区", en: "Single" },
  "layout.horizontal": { zh: "左右双列", en: "Side by Side" },
  "layout.vertical": { zh: "上下双行", en: "Top & Bottom" },
  "layout.grid": { zh: "田字格 2x2", en: "Grid 2x2" },

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

  // === Settings ===
  "settings.title": { zh: "设置", en: "Settings" },
  "settings.apiConfig": { zh: "API 配置", en: "API Configuration" },
  "settings.apiFormat": { zh: "API 格式", en: "API Format" },
  "settings.baseUrl": { zh: "Base URL", en: "Base URL" },
  "settings.apiKey": { zh: "API Key", en: "API Key" },
  "settings.openaiHelp": {
    zh: "OpenAI 兼容 API 地址（Ollama、Groq、OpenRouter 等）",
    en: "OpenAI-compatible API base URL (Ollama, Groq, OpenRouter, etc.)",
  },
  "settings.anthropicHelp": {
    zh: "Anthropic API 地址（通常无需修改）",
    en: "Anthropic API base URL (usually no change needed)",
  },
  "settings.fetching": { zh: "获取中...", en: "Fetching..." },
  "settings.autoFetch": { zh: "自动获取模型", en: "Auto-fetch models" },
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
  "ssh.privateKeyPath": { zh: "私钥路径", en: "Private key path" },
  "ssh.privateKeyPlaceholder": { zh: "例如 ~/.ssh/id_rsa", en: "e.g. ~/.ssh/id_rsa" },
  "ssh.color": { zh: "颜色", en: "Color" },
  "ssh.save": { zh: "保存", en: "Save" },
  "ssh.cancel": { zh: "取消", en: "Cancel" },
  "ssh.importFailed": { zh: "导入失败，请检查文件格式。", en: "Import failed. Check the file format." },

  // === AI Panel ===
  "ai.thinking": { zh: "思考中", en: "Thinking" },
  "ai.connected": { zh: "已连接", en: "Connected" },
  "ai.disconnected": { zh: "未连接", en: "Disconnected" },
  "ai.clear": { zh: "清空", en: "Clear" },
  "ai.chatMode": { zh: "Chat Mode", en: "Chat Mode" },
  "ai.craftMode": { zh: "Craft Mode", en: "Craft Mode" },
  "ai.chatLabel": { zh: "Chat", en: "Chat" },
  "ai.chatDesc": { zh: "General assistant for questions and advice", en: "General assistant for questions and advice" },
  "ai.craftLabel": { zh: "Craft", en: "Craft" },
  "ai.craftDesc": { zh: "Code writer with terminal access", en: "Code writer with terminal access" },
  "ai.placeholder": {
    zh: "输入消息... (Enter 发送, Shift+Enter 换行)",
    en: "Ask anything... (Enter to send, Shift+Enter for new line)",
  },
  "ai.waitingConnection": { zh: "等待连接...", en: "Waiting for connection..." },
  "ai.stop": { zh: "停止", en: "Stop" },
  "ai.send": { zh: "发送", en: "Send" },
  "ai.running": { zh: "执行中...", en: "Running..." },
  "ai.connectionFailed": { zh: "连接失败", en: "Connection failed" },

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
