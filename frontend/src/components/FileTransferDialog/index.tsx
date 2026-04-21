"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "@/lib/axios";
import "./FileTransferDialog.css";

interface FileTransferDialogProps {
  open: boolean;
  connectionId: string;
  title: string;
  onClose: () => void;
}

interface RemoteFileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  modified_at: string | null;
  permissions: string;
}

interface RemoteDirectoryResponse {
  path: string;
  parent_path: string | null;
  items: RemoteFileItem[];
}

interface FileContentResponse {
  path: string;
  encoding: string;
  content: string;
  size: number;
}

interface TransferJob {
  id: string;
  direction: "upload" | "download";
  file_name: string;
  status: "pending" | "running" | "success" | "error";
  progress: number;
  bytes_transferred: number;
  total_bytes: number | null;
  error: string | null;
}

interface TransferProgressState {
  type: "upload" | "download";
  status: "running" | "success" | "error";
  fileName: string;
  progress: number;
  loaded: number;
  total: number | null;
  speed: number | null;
  message?: string;
  sequenceLabel?: string;
}

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; content: string; originalContent: string; encoding: string; size: number }
  | { status: "unsupported"; path: string; message: string }
  | { status: "error"; path: string; message: string };

interface ConfirmDialogState {
  title: string;
  description: string;
  items: string[];
  confirmLabel: string;
  tone: "primary" | "danger";
}

interface TransferTelemetry {
  loaded: number;
  time: number;
  speed: number | null;
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error && "response" in error) {
    return (error as { response?: { status?: number } }).response?.status;
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { detail?: string } } }).response;
    if (response?.data?.detail) {
      return response.data.detail;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "文件传输失败";
}

function formatBytes(size: number | null): string {
  if (size === null || Number.isNaN(size)) {
    return "--";
  }
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatSpeed(speed: number | null): string {
  if (!speed || !Number.isFinite(speed) || speed <= 0) {
    return "--/s";
  }
  return `${formatBytes(speed)}/s`;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  if (!path) {
    return [];
  }

  if (path === "/") {
    return [{ label: "/", path: "/" }];
  }

  const parts = path.split("/").filter(Boolean);
  const breadcrumbs = [{ label: "/", path: "/" }];
  let currentPath = "";

  parts.forEach((part) => {
    currentPath += `/${part}`;
    breadcrumbs.push({ label: part, path: currentPath });
  });

  return breadcrumbs;
}

function joinRemotePath(basePath: string, name: string): string {
  const cleanName = name.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleanName) {
    return basePath;
  }

  if (basePath === "/") {
    return `/${cleanName}`;
  }

  return `${basePath.replace(/\/+$/, "")}/${cleanName}`;
}

function getLocalFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const UpIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5" />
    <path d="M6 11l6-6 6 6" />
  </svg>
);

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 11a8 8 0 0 0-14.9-4" />
    <path d="M4 4v5h5" />
    <path d="M4 13a8 8 0 0 0 14.9 4" />
    <path d="M20 20v-5h-5" />
  </svg>
);

const UploadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 16V4" />
    <path d="M7 9l5-5 5 5" />
    <path d="M5 20h14" />
  </svg>
);

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v12" />
    <path d="M17 11l-5 5-5-5" />
    <path d="M5 20h14" />
  </svg>
);

const FolderAddIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    <path d="M12 10v6" />
    <path d="M9 13h6" />
  </svg>
);

const SaveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7a2 2 0 0 1 2-2h10l4 4v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" />
    <path d="M8 5v5h8" />
    <path d="M8 19v-5h8v5" />
  </svg>
);

const DeleteIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);

const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
    <path d="M14 2v5h5" />
  </svg>
);

export default function FileTransferDialog({
  open,
  connectionId,
  title,
  onClose,
}: FileTransferDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const confirmActionRef = useRef<(() => void) | null>(null);
  const telemetryRef = useRef<TransferTelemetry | null>(null);
  const isDesktop = typeof window !== "undefined" && !!window.pywebview?.api;

  const [directory, setDirectory] = useState<RemoteDirectoryResponse | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [showFolderCreator, setShowFolderCreator] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "idle" });
  const [savingPreview, setSavingPreview] = useState(false);
  const [transferProgress, setTransferProgress] = useState<TransferProgressState | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  const currentPath = directory?.path ?? "";
  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);
  const activeItem = useMemo(() => {
    if (!directory || selectedPaths.length === 0) {
      return null;
    }
    if (activePath) {
      const match = directory.items.find((item) => item.path === activePath);
      if (match && selectedPaths.includes(match.path)) {
        return match;
      }
    }
    const fallbackPath = selectedPaths[selectedPaths.length - 1];
    return directory.items.find((item) => item.path === fallbackPath) ?? null;
  }, [activePath, directory, selectedPaths]);
  const selectedItems = useMemo(() => {
    if (!directory || selectedPaths.length === 0) {
      return [];
    }
    const selectedSet = new Set(selectedPaths);
    return directory.items.filter((item) => selectedSet.has(item.path));
  }, [directory, selectedPaths]);
  const selectedFiles = useMemo(
    () => selectedItems.filter((item) => !item.is_dir),
    [selectedItems]
  );
  const singleSelectedItem = selectedItems.length === 1 ? selectedItems[0] : null;
  const previewFile = singleSelectedItem && !singleSelectedItem.is_dir ? singleSelectedItem : null;
  const previewDirty = previewState.status === "ready" && previewState.content !== previewState.originalContent;
  const selectedSummary = selectedItems.length === 0
    ? directory
      ? `${directory.items.length} 个项目`
      : ""
    : selectedItems.length === 1
      ? `${singleSelectedItem?.is_dir ? "文件夹" : "文件"} · ${singleSelectedItem?.path}`
      : `${selectedItems.length} 项已选 · ${selectedFiles.length} 个文件`;

  const busy = loading || creatingFolder || savingPreview || transferProgress?.status === "running";

  const openConfirmDialog = useCallback((dialog: ConfirmDialogState, action: () => void) => {
    confirmActionRef.current = action;
    setConfirmDialog(dialog);
  }, []);

  const closeConfirmDialog = useCallback(() => {
    confirmActionRef.current = null;
    setConfirmDialog(null);
  }, []);

  const resetTransferTelemetry = useCallback((loaded: number = 0) => {
    telemetryRef.current = {
      loaded,
      time: performance.now(),
      speed: null,
    };
  }, []);

  const updateTransferProgress = useCallback((next: Omit<TransferProgressState, "speed">) => {
    let speed = telemetryRef.current?.speed ?? null;

    if (next.status === "running") {
      const now = performance.now();
      const previous = telemetryRef.current;

      if (!previous || next.loaded < previous.loaded) {
        telemetryRef.current = { loaded: next.loaded, time: now, speed: null };
        speed = null;
      } else {
        const deltaBytes = next.loaded - previous.loaded;
        const deltaMs = now - previous.time;
        if (deltaMs >= 180) {
          const instantSpeed = deltaMs > 0 ? deltaBytes / (deltaMs / 1000) : 0;
          speed = previous.speed === null
            ? instantSpeed
            : previous.speed * 0.55 + instantSpeed * 0.45;
          telemetryRef.current = { loaded: next.loaded, time: now, speed };
        }
      }
    } else {
      speed = telemetryRef.current?.speed ?? null;
      telemetryRef.current = null;
    }

    setTransferProgress({
      ...next,
      speed,
    });
  }, []);

  const loadDirectory = useCallback(async (
    path?: string,
    options?: { preserveSelectedPaths?: string[]; activePath?: string | null }
  ) => {
    setLoading(true);

    try {
      const response = await axios.get<RemoteDirectoryResponse>(
        `/api/ssh/connections/${connectionId}/files`,
        { params: path ? { path } : {} }
      );

      setDirectory(response.data);

      const nextSelectedPaths = options?.preserveSelectedPaths
        ? response.data.items
            .map((item) => item.path)
            .filter((itemPath) => options.preserveSelectedPaths?.includes(itemPath))
        : [];

      setSelectedPaths(nextSelectedPaths);
      setActivePath(
        options?.activePath && nextSelectedPaths.includes(options.activePath)
          ? options.activePath
          : nextSelectedPaths[nextSelectedPaths.length - 1] ?? null
      );
      setAnchorPath(nextSelectedPaths[nextSelectedPaths.length - 1] ?? null);
    } catch (error) {
      setStatus({ type: "error", message: getErrorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  const refreshCurrentDirectory = useCallback(async (options?: { preserveSelection?: boolean }) => {
    if (!currentPath) {
      return;
    }
    await loadDirectory(currentPath, options?.preserveSelection
      ? { preserveSelectedPaths: selectedPaths, activePath }
      : undefined
    );
  }, [activePath, currentPath, loadDirectory, selectedPaths]);

  const getOverwriteConflicts = useCallback((fileNames: string[]) => {
    if (!directory) {
      return [];
    }

    const remoteFileNames = new Set(
      directory.items
        .filter((item) => !item.is_dir)
        .map((item) => item.name)
    );

    return Array.from(new Set(fileNames.filter((name) => remoteFileNames.has(name))));
  }, [directory]);

  const confirmOverwriteIfNeeded = useCallback((
    fileNames: string[],
    action: (overwriteNames: Set<string>) => void
  ) => {
    const conflicts = getOverwriteConflicts(fileNames);
    if (conflicts.length === 0) {
      action(new Set());
      return;
    }

    openConfirmDialog({
      title: "确认替换文件",
      description: "以下文件在当前目录已存在，继续上传会覆盖远端同名文件。",
      items: conflicts,
      confirmLabel: "替换并上传",
      tone: "primary",
    }, () => action(new Set(conflicts)));
  }, [getOverwriteConflicts, openConfirmDialog]);

  const pollTransferJob = useCallback(async (
    jobId: string,
    type: "upload" | "download",
    sequenceLabel?: string
  ): Promise<TransferJob> => {
    while (true) {
      const response = await axios.get<{ job: TransferJob }>(
        `/api/ssh/connections/${connectionId}/transfer/jobs/${jobId}`
      );
      const job = response.data.job;

      updateTransferProgress({
        type,
        status: job.status === "error" ? "error" : job.status === "success" ? "success" : "running",
        fileName: job.file_name,
        progress: job.progress,
        loaded: job.bytes_transferred,
        total: job.total_bytes,
        message: job.error ?? undefined,
        sequenceLabel,
      });

      if (job.status === "success") {
        return job;
      }

      if (job.status === "error") {
        throw new Error(job.error || "文件传输失败");
      }

      await delay(250);
    }
  }, [connectionId, updateTransferProgress]);

  useEffect(() => {
    if (!open) {
      setDirectory(null);
      setSelectedPaths([]);
      setActivePath(null);
      setAnchorPath(null);
      setStatus(null);
      setLoading(false);
      setCreatingFolder(false);
      setShowFolderCreator(false);
      setNewFolderName("");
      setPreviewState({ status: "idle" });
      setSavingPreview(false);
      setTransferProgress(null);
      setIsDragActive(false);
      setConfirmDialog(null);
      dragDepthRef.current = 0;
      telemetryRef.current = null;
      confirmActionRef.current = null;
      return;
    }

    setStatus(null);
    void loadDirectory();
  }, [connectionId, loadDirectory, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (confirmDialog) {
          closeConfirmDialog();
          return;
        }
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeConfirmDialog, confirmDialog, onClose, open]);

  useEffect(() => {
    if (!open || !previewFile) {
      setPreviewState({ status: "idle" });
      return;
    }

    let cancelled = false;
    setPreviewState({ status: "loading", path: previewFile.path });

    axios.get<FileContentResponse>(
      `/api/ssh/connections/${connectionId}/files/content`,
      { params: { path: previewFile.path } }
    ).then((response) => {
      if (cancelled) {
        return;
      }

      setPreviewState({
        status: "ready",
        path: response.data.path,
        content: response.data.content,
        originalContent: response.data.content,
        encoding: response.data.encoding,
        size: response.data.size,
      });
    }).catch((error) => {
      if (cancelled) {
        return;
      }

      const message = getErrorMessage(error);
      const httpStatus = getHttpStatus(error);
      if (httpStatus === 400) {
        setPreviewState({
          status: "unsupported",
          path: previewFile.path,
          message,
        });
      } else {
        setPreviewState({
          status: "error",
          path: previewFile.path,
          message,
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [connectionId, open, previewFile]);

  if (!open) {
    return null;
  }

  const handleRowClick = (event: React.MouseEvent<HTMLDivElement>, item: RemoteFileItem) => {
    if (!directory) {
      return;
    }

    const itemPaths = directory.items.map((entry) => entry.path);
    const clickedIndex = itemPaths.indexOf(item.path);

    if (event.shiftKey && anchorPath) {
      const anchorIndex = itemPaths.indexOf(anchorPath);
      if (anchorIndex !== -1 && clickedIndex !== -1) {
        const [start, end] = anchorIndex < clickedIndex
          ? [anchorIndex, clickedIndex]
          : [clickedIndex, anchorIndex];
        const rangePaths = itemPaths.slice(start, end + 1);
        setSelectedPaths(rangePaths);
        setActivePath(item.path);
        return;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      const isSelected = selectedPaths.includes(item.path);
      const nextSelectedPaths = isSelected
        ? selectedPaths.filter((path) => path !== item.path)
        : [...selectedPaths, item.path];

      setSelectedPaths(nextSelectedPaths);
      setActivePath(
        isSelected
          ? (nextSelectedPaths[nextSelectedPaths.length - 1] ?? null)
          : item.path
      );
      setAnchorPath(item.path);
      return;
    }

    setSelectedPaths([item.path]);
    setActivePath(item.path);
    setAnchorPath(item.path);
  };

  const handleRefresh = () => {
    if (!loading) {
      void refreshCurrentDirectory({ preserveSelection: true });
    }
  };

  const handleNavigate = (path: string) => {
    setStatus(null);
    void loadDirectory(path);
  };

  const runBrowserUpload = async (
    file: File,
    index: number,
    totalCount: number,
    overwriteNames: Set<string>
  ) => {
    const sequenceLabel = totalCount > 1 ? `${index + 1}/${totalCount}` : undefined;
    resetTransferTelemetry(0);
    updateTransferProgress({
      type: "upload",
      status: "running",
      fileName: file.name,
      progress: 0,
      loaded: 0,
      total: file.size || null,
      sequenceLabel,
    });

    const formData = new FormData();
    formData.append("file", file);
    formData.append("remote_path", currentPath);
    formData.append("overwrite", overwriteNames.has(file.name) ? "true" : "false");

    await axios.post(
      `/api/ssh/connections/${connectionId}/transfer/upload`,
      formData,
      {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 0,
        onUploadProgress: (event) => {
          const total = event.total ?? file.size ?? null;
          const progress = total ? Math.min(100, (event.loaded / total) * 100) : 0;

          updateTransferProgress({
            type: "upload",
            status: "running",
            fileName: file.name,
            progress,
            loaded: event.loaded,
            total,
            sequenceLabel,
          });
        },
      }
    );

    updateTransferProgress({
      type: "upload",
      status: "success",
      fileName: file.name,
      progress: 100,
      loaded: file.size,
      total: file.size,
      sequenceLabel,
    });
  };

  const handleUploadFiles = async (files: File[]) => {
    if (!currentPath || files.length === 0) {
      return;
    }

    confirmOverwriteIfNeeded(files.map((file) => file.name), (overwriteNames) => {
      void (async () => {
        setStatus(null);

        try {
          for (const [index, file] of files.entries()) {
            await runBrowserUpload(file, index, files.length, overwriteNames);
          }

          await refreshCurrentDirectory({ preserveSelection: true });
          updateTransferProgress({
            type: "upload",
            status: "success",
            fileName: files[files.length - 1].name,
            progress: 100,
            loaded: files[files.length - 1].size,
            total: files[files.length - 1].size,
            message: files.length > 1 ? `已完成 ${files.length} 个文件上传` : "上传完成",
            sequenceLabel: files.length > 1 ? `${files.length}/${files.length}` : undefined,
          });
          setStatus({
            type: "success",
            message: files.length > 1 ? `已上传 ${files.length} 个文件到 ${currentPath}` : `已上传 ${files[0].name}`,
          });
        } catch (error) {
          setTransferProgress((current) => current ? {
            ...current,
            status: "error",
            message: getErrorMessage(error),
          } : null);
          setStatus({ type: "error", message: getErrorMessage(error) });
        }
      })();
    });
  };

  const handleDesktopUploadPaths = async (localPaths: string[]) => {
    if (!currentPath || localPaths.length === 0) {
      return;
    }

    confirmOverwriteIfNeeded(localPaths.map(getLocalFileName), (overwriteNames) => {
      void (async () => {
        setStatus(null);

        try {
          for (const [index, localPath] of localPaths.entries()) {
            const fileName = getLocalFileName(localPath);
            const sequenceLabel = localPaths.length > 1 ? `${index + 1}/${localPaths.length}` : undefined;
            resetTransferTelemetry(0);
            updateTransferProgress({
              type: "upload",
              status: "running",
              fileName,
              progress: 0,
              loaded: 0,
              total: null,
              sequenceLabel,
            });

            const startResponse = await axios.post<{ job: TransferJob }>(
              `/api/ssh/connections/${connectionId}/transfer/jobs/upload-local`,
              {
                local_path: localPath,
                remote_path: currentPath,
                overwrite: overwriteNames.has(fileName),
              }
            );

            await pollTransferJob(startResponse.data.job.id, "upload", sequenceLabel);
          }

          await refreshCurrentDirectory({ preserveSelection: true });
          setStatus({
            type: "success",
            message: localPaths.length > 1 ? `已上传 ${localPaths.length} 个文件到 ${currentPath}` : `已上传 ${getLocalFileName(localPaths[0])}`,
          });
        } catch (error) {
          setTransferProgress((current) => current ? {
            ...current,
            status: "error",
            message: getErrorMessage(error),
          } : null);
          setStatus({ type: "error", message: getErrorMessage(error) });
        }
      })();
    });
  };

  const handleUploadClick = async () => {
    if (!currentPath || busy) {
      return;
    }

    if (isDesktop) {
      let localPaths: string[] | null = null;

      if (typeof window.pywebview?.api?.pick_files === "function") {
        localPaths = await window.pywebview.api.pick_files();
      } else if (typeof window.pywebview?.api?.pick_file === "function") {
        const singlePath = await window.pywebview.api.pick_file();
        localPaths = singlePath ? [singlePath] : null;
      }

      if (!localPaths || localPaths.length === 0) {
        return;
      }

      await handleDesktopUploadPaths(localPaths);
      return;
    }

    fileInputRef.current?.click();
  };

  const handleBrowserFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.target.files || []);
    event.target.value = "";
    if (nextFiles.length === 0) {
      return;
    }
    void handleUploadFiles(nextFiles);
  };

  const handleDownload = async () => {
    if (selectedFiles.length === 0) {
      return;
    }

    setStatus(null);

    try {
      if (isDesktop) {
        let targetFolder: string | null = null;

        if (selectedFiles.length === 1) {
          const localPath = await window.pywebview?.api?.pick_save_file?.(selectedFiles[0].name);
          if (!localPath) {
            return;
          }

          resetTransferTelemetry(0);
          updateTransferProgress({
            type: "download",
            status: "running",
            fileName: selectedFiles[0].name,
            progress: 0,
            loaded: 0,
            total: selectedFiles[0].size,
            sequenceLabel: undefined,
          });

          const startResponse = await axios.post<{ job: TransferJob }>(
            `/api/ssh/connections/${connectionId}/transfer/jobs/download-local`,
            {
              remote_path: selectedFiles[0].path,
              local_path: localPath,
            }
          );

          await pollTransferJob(startResponse.data.job.id, "download");
          setStatus({
            type: "success",
            message: `已保存到 ${localPath}`,
          });
          return;
        }

        targetFolder = await window.pywebview?.api?.pick_folder?.() || null;
        if (!targetFolder) {
          return;
        }

        for (const [index, file] of selectedFiles.entries()) {
          const sequenceLabel = `${index + 1}/${selectedFiles.length}`;
          resetTransferTelemetry(0);
          updateTransferProgress({
            type: "download",
            status: "running",
            fileName: file.name,
            progress: 0,
            loaded: 0,
            total: file.size,
            sequenceLabel,
          });

          const localPath = `${targetFolder.replace(/[\\/]+$/, "")}\\${file.name}`;
          const startResponse = await axios.post<{ job: TransferJob }>(
            `/api/ssh/connections/${connectionId}/transfer/jobs/download-local`,
            {
              remote_path: file.path,
              local_path: localPath,
            }
          );

          await pollTransferJob(startResponse.data.job.id, "download", sequenceLabel);
        }

        setStatus({
          type: "success",
          message: `已下载 ${selectedFiles.length} 个文件到 ${targetFolder}`,
        });
        return;
      }

      for (const [index, file] of selectedFiles.entries()) {
        const sequenceLabel = selectedFiles.length > 1 ? `${index + 1}/${selectedFiles.length}` : undefined;
        resetTransferTelemetry(0);
        updateTransferProgress({
          type: "download",
          status: "running",
          fileName: file.name,
          progress: 0,
          loaded: 0,
          total: file.size,
          sequenceLabel,
        });

        const response = await axios.get(
          `/api/ssh/connections/${connectionId}/transfer/download`,
          {
            params: { remote_path: file.path },
            responseType: "blob",
            timeout: 0,
            onDownloadProgress: (event) => {
              const total = event.total ?? file.size ?? null;
              const progress = total ? Math.min(100, (event.loaded / total) * 100) : 0;

              updateTransferProgress({
                type: "download",
                status: "running",
                fileName: file.name,
                progress,
                loaded: event.loaded,
                total,
                sequenceLabel,
              });
            },
          }
        );

        const blobUrl = window.URL.createObjectURL(response.data);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(blobUrl);

        updateTransferProgress({
          type: "download",
          status: "success",
          fileName: file.name,
          progress: 100,
          loaded: file.size ?? 0,
          total: file.size,
          sequenceLabel,
        });
      }

      setStatus({
        type: "success",
        message: selectedFiles.length > 1 ? `已开始下载 ${selectedFiles.length} 个文件` : `已开始下载 ${selectedFiles[0].name}`,
      });
    } catch (error) {
      setTransferProgress((current) => current ? {
        ...current,
        status: "error",
        message: getErrorMessage(error),
      } : null);
      setStatus({ type: "error", message: getErrorMessage(error) });
    }
  };

  const handleDelete = () => {
    if (selectedItems.length === 0) {
      return;
    }

    const paths = selectedItems.map((item) => item.path);
    openConfirmDialog({
      title: "确认删除",
      description: "删除后无法恢复，目录会递归删除其中的全部内容。",
      items: selectedItems.map((item) => item.name),
      confirmLabel: `删除 ${selectedItems.length} 项`,
      tone: "danger",
    }, () => {
      void (async () => {
        setStatus(null);

        try {
          await axios.delete(`/api/ssh/connections/${connectionId}/paths`, {
            data: { paths },
          });

          setSelectedPaths([]);
          setActivePath(null);
          setAnchorPath(null);
          setPreviewState({ status: "idle" });
          await refreshCurrentDirectory();
          setStatus({
            type: "success",
            message: selectedItems.length > 1 ? `已删除 ${selectedItems.length} 项` : `已删除 ${selectedItems[0].name}`,
          });
        } catch (error) {
          setStatus({ type: "error", message: getErrorMessage(error) });
        }
      })();
    });
  };

  const handleCreateFolder = async () => {
    const folderName = newFolderName.trim();
    if (!folderName) {
      setStatus({ type: "error", message: "请输入文件夹名称" });
      return;
    }

    if (folderName.includes("/")) {
      setStatus({ type: "error", message: "文件夹名称不能包含 /" });
      return;
    }

    setCreatingFolder(true);
    setStatus(null);

    try {
      const response = await axios.post(
        `/api/ssh/connections/${connectionId}/directories`,
        { path: joinRemotePath(currentPath, folderName) }
      );

      setNewFolderName("");
      setShowFolderCreator(false);
      await refreshCurrentDirectory({ preserveSelection: true });
      setStatus({
        type: "success",
        message: `已创建文件夹 ${response.data.path}`,
      });
    } catch (error) {
      setStatus({ type: "error", message: getErrorMessage(error) });
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleSavePreview = async () => {
    if (previewState.status !== "ready" || !previewDirty) {
      return;
    }

    setSavingPreview(true);
    setStatus(null);

    try {
      await axios.put(
        `/api/ssh/connections/${connectionId}/files/content`,
        {
          path: previewState.path,
          content: previewState.content,
          encoding: previewState.encoding,
        }
      );

      setPreviewState({
        ...previewState,
        originalContent: previewState.content,
      });
      await refreshCurrentDirectory({ preserveSelection: true });
      setStatus({
        type: "success",
        message: `已保存 ${previewState.path}`,
      });
    } catch (error) {
      setStatus({ type: "error", message: getErrorMessage(error) });
    } finally {
      setSavingPreview(false);
    }
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    dragDepthRef.current += 1;
    if (Array.from(event.dataTransfer.types).includes("Files")) {
      setIsDragActive(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragActive(false);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragActive(false);

    if (busy) {
      return;
    }

    const files = Array.from(event.dataTransfer.files || []);
    if (files.length === 0) {
      return;
    }

    void handleUploadFiles(files);
  };

  const renderPreviewBody = () => {
    if (selectedItems.length > 1) {
      return (
        <div className="file-transfer-preview-placeholder">
          <strong>已选择多个项目</strong>
          <span>可批量下载或删除。文本预览和编辑仅在单选文件时可用。</span>
        </div>
      );
    }

    if (!singleSelectedItem) {
      return (
        <div className="file-transfer-preview-placeholder">
          <strong>选择一个文件查看详情</strong>
          <span>支持 Ctrl/Shift 多选，文本文件会在这里直接预览和编辑。</span>
        </div>
      );
    }

    if (singleSelectedItem.is_dir) {
      return (
        <div className="file-transfer-preview-placeholder">
          <strong>当前选中的是文件夹</strong>
          <span>双击进入目录，或拖拽文件到左侧列表上传到这个目录。</span>
        </div>
      );
    }

    if (previewState.status === "loading") {
      return <div className="file-transfer-preview-placeholder">正在载入文本内容...</div>;
    }

    if (previewState.status === "unsupported") {
      return (
        <div className="file-transfer-preview-placeholder">
          <strong>无法在线编辑</strong>
          <span>{previewState.message}</span>
        </div>
      );
    }

    if (previewState.status === "error") {
      return (
        <div className="file-transfer-preview-placeholder error">
          <strong>预览失败</strong>
          <span>{previewState.message}</span>
        </div>
      );
    }

    if (previewState.status !== "ready") {
      return null;
    }

    return (
      <textarea
        className="file-transfer-editor"
        value={previewState.content}
        onChange={(event) => {
          setPreviewState({
            ...previewState,
            content: event.target.value,
          });
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void handleSavePreview();
          }
        }}
        spellCheck={false}
      />
    );
  };

  return (
    <div className="file-transfer-overlay" onClick={onClose}>
      <div className="file-transfer-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="file-transfer-header">
          <div>
            <div className="file-transfer-title">远程文件管理器</div>
            <div className="file-transfer-subtitle">{title}</div>
          </div>
          <button className="file-transfer-close" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="file-transfer-toolbar">
          <button
            className="file-transfer-tool"
            onClick={() => directory?.parent_path && handleNavigate(directory.parent_path)}
            disabled={!directory?.parent_path || busy}
            title="返回上级目录"
          >
            <UpIcon />
            <span>上级</span>
          </button>

          <button
            className="file-transfer-tool"
            onClick={handleRefresh}
            disabled={!currentPath || busy}
            title="刷新目录"
          >
            <RefreshIcon />
            <span>刷新</span>
          </button>

          <button
            className="file-transfer-tool primary"
            onClick={() => void handleUploadClick()}
            disabled={!currentPath || busy}
            title="上传到当前目录"
          >
            <UploadIcon />
            <span>上传</span>
          </button>

          <button
            className="file-transfer-tool"
            onClick={() => void handleDownload()}
            disabled={selectedFiles.length === 0 || busy}
            title="下载选中文件"
          >
            <DownloadIcon />
            <span>{selectedFiles.length > 1 ? `下载 ${selectedFiles.length} 项` : "下载"}</span>
          </button>

          <button
            className="file-transfer-tool danger"
            onClick={handleDelete}
            disabled={selectedItems.length === 0 || busy}
            title="删除选中项目"
          >
            <DeleteIcon />
            <span>{selectedItems.length > 1 ? `删除 ${selectedItems.length} 项` : "删除"}</span>
          </button>

          <button
            className={`file-transfer-tool ${showFolderCreator ? "active" : ""}`}
            onClick={() => {
              setStatus(null);
              setShowFolderCreator((value) => !value);
            }}
            disabled={!currentPath || busy}
            title="新建文件夹"
          >
            <FolderAddIcon />
            <span>新建文件夹</span>
          </button>

          {previewState.status === "ready" && (
            <button
              className="file-transfer-tool"
              onClick={() => void handleSavePreview()}
              disabled={!previewDirty || savingPreview || busy}
              title="保存当前文本"
            >
              <SaveIcon />
              <span>{savingPreview ? "保存中..." : "保存"}</span>
            </button>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleBrowserFileChange}
          />
        </div>

        <div className="file-transfer-pathbar">
          <div className="file-transfer-pathlabel">当前位置</div>
          <div className="file-transfer-breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <div key={crumb.path} className="file-transfer-crumb-wrap">
                <button
                  className={`file-transfer-crumb ${index === breadcrumbs.length - 1 ? "active" : ""}`}
                  onClick={() => handleNavigate(crumb.path)}
                >
                  {crumb.label}
                </button>
                {index < breadcrumbs.length - 1 && <span className="file-transfer-crumb-sep">/</span>}
              </div>
            ))}
          </div>
        </div>

        {showFolderCreator && (
          <div className="file-transfer-createbar">
            <input
              className="file-transfer-create-input"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder="输入新文件夹名称"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleCreateFolder();
                }
                if (event.key === "Escape") {
                  setShowFolderCreator(false);
                  setNewFolderName("");
                }
              }}
            />
            <button
              className="file-transfer-create-btn confirm"
              onClick={() => void handleCreateFolder()}
              disabled={creatingFolder}
            >
              {creatingFolder ? "创建中..." : "创建"}
            </button>
            <button
              className="file-transfer-create-btn"
              onClick={() => {
                setShowFolderCreator(false);
                setNewFolderName("");
              }}
              disabled={creatingFolder}
            >
              取消
            </button>
          </div>
        )}

        {transferProgress && (
          <div className={`file-transfer-progress ${transferProgress.status}`}>
            <div className="file-transfer-progress-top">
              <div className="file-transfer-progress-title">
                <span>{transferProgress.type === "upload" ? "上传" : "下载"}</span>
                {transferProgress.sequenceLabel && (
                  <span className="file-transfer-progress-badge">{transferProgress.sequenceLabel}</span>
                )}
                <strong>{transferProgress.fileName}</strong>
              </div>
              <div className="file-transfer-progress-meta">
                <span>{Math.round(transferProgress.progress)}%</span>
                {transferProgress.total !== null && (
                  <span>{formatBytes(transferProgress.loaded)} / {formatBytes(transferProgress.total)}</span>
                )}
                <span>{formatSpeed(transferProgress.speed)}</span>
              </div>
            </div>
            <div className="file-transfer-progress-track">
              <div
                className="file-transfer-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, transferProgress.progress))}%` }}
              />
            </div>
            {transferProgress.message && (
              <div className="file-transfer-progress-message">{transferProgress.message}</div>
            )}
          </div>
        )}

        <div className="file-transfer-content">
          <div
            className={`file-transfer-browser-panel ${isDragActive ? "dragging" : ""}`}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <div className="file-transfer-table-head">
              <div>名称</div>
              <div>修改时间</div>
              <div>大小</div>
              <div>权限</div>
            </div>

            <div className="file-transfer-table-body">
              {loading && (
                <div className="file-transfer-state">正在读取远端目录...</div>
              )}

              {!loading && directory && directory.items.length === 0 && (
                <div className="file-transfer-state">当前目录为空</div>
              )}

              {!loading && directory && directory.items.map((item) => (
                <div
                  key={item.path}
                  className={`file-transfer-row ${selectedPaths.includes(item.path) ? "selected" : ""}`}
                  onClick={(event) => handleRowClick(event, item)}
                  onDoubleClick={() => {
                    if (item.is_dir) {
                      handleNavigate(item.path);
                    }
                  }}
                >
                  <div className="file-transfer-name">
                    <span className={`file-transfer-icon ${item.is_dir ? "folder" : "file"}`}>
                      {item.is_dir ? <FolderIcon /> : <FileIcon />}
                    </span>
                    <span className="file-transfer-name-text">{item.name}</span>
                  </div>
                  <div>{formatDate(item.modified_at)}</div>
                  <div>{item.is_dir ? "--" : formatBytes(item.size)}</div>
                  <div className="file-transfer-permissions">{item.permissions}</div>
                </div>
              ))}
            </div>

            {isDragActive && (
              <div className="file-transfer-dropzone">
                <UploadIcon />
                <strong>拖拽文件到这里上传</strong>
                <span>{currentPath || "/"}</span>
              </div>
            )}
          </div>

          <aside className="file-transfer-inspector">
            <div className="file-transfer-inspector-header">
              <div>
                <div className="file-transfer-inspector-title">预览与编辑</div>
                <div className="file-transfer-inspector-subtitle">
                  {selectedItems.length > 1
                    ? `${selectedItems.length} 项已选`
                    : activeItem
                      ? activeItem.name
                      : "未选择文件"}
                </div>
              </div>
              {previewDirty && <span className="file-transfer-dirty-badge">未保存</span>}
            </div>

            <div className="file-transfer-meta-grid">
              <div className="file-transfer-meta-item">
                <span>类型</span>
                <strong>
                  {selectedItems.length > 1
                    ? "多选"
                    : activeItem
                      ? activeItem.is_dir ? "目录" : "文件"
                      : "--"}
                </strong>
              </div>
              <div className="file-transfer-meta-item">
                <span>大小</span>
                <strong>
                  {selectedItems.length > 1
                    ? formatBytes(selectedFiles.reduce((sum, file) => sum + (file.size ?? 0), 0))
                    : activeItem?.is_dir
                      ? "--"
                      : formatBytes(activeItem?.size ?? null)}
                </strong>
              </div>
              <div className="file-transfer-meta-item full">
                <span>路径</span>
                <strong title={selectedItems.length > 1 ? selectedSummary : activeItem?.path || currentPath}>
                  {selectedItems.length > 1 ? selectedSummary : activeItem?.path || currentPath || "--"}
                </strong>
              </div>
              {previewState.status === "ready" && (
                <>
                  <div className="file-transfer-meta-item">
                    <span>编码</span>
                    <strong>{previewState.encoding}</strong>
                  </div>
                  <div className="file-transfer-meta-item">
                    <span>文本大小</span>
                    <strong>{formatBytes(previewState.size)}</strong>
                  </div>
                </>
              )}
            </div>

            <div className="file-transfer-preview-shell">
              {renderPreviewBody()}
            </div>
          </aside>
        </div>

        <div className="file-transfer-footer">
          <div className="file-transfer-selection">{selectedSummary}</div>
          {status && (
            <div className={`file-transfer-status ${status.type}`}>
              {status.message}
            </div>
          )}
        </div>

        {confirmDialog && (
          <div className="file-transfer-confirm-overlay">
            <div className="file-transfer-confirm">
              <div className="file-transfer-confirm-title">{confirmDialog.title}</div>
              <div className="file-transfer-confirm-desc">{confirmDialog.description}</div>
              <div className="file-transfer-confirm-list">
                {confirmDialog.items.map((item) => (
                  <div key={item} className="file-transfer-confirm-item">{item}</div>
                ))}
              </div>
              <div className="file-transfer-confirm-actions">
                <button className="file-transfer-confirm-btn" onClick={closeConfirmDialog}>
                  取消
                </button>
                <button
                  className={`file-transfer-confirm-btn ${confirmDialog.tone}`}
                  onClick={() => {
                    const action = confirmActionRef.current;
                    closeConfirmDialog();
                    action?.();
                  }}
                >
                  {confirmDialog.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
