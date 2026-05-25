# TODO

## 待修 Bug

### PowerShell prompt 截断 (PS D:\Cz...) — 已修(2026-05-26,待验证)
**两类 root cause**:
1. **初次 spawn**: 前端 fit 早期会以瞬时小 cols 触发 sendResize,backend 立即用此值 spawn pty → PSReadLine 在小宽度画 prompt → 截断。
2. **tab 切换回 local**: 本地 terminal 被切到 SSH tab 后 display:none → useTerminal 的 ResizeObserver 看到容器 width=0 → 50ms 后 fitAddon.fit() 在 0-dim 容器上跑 → xterm.cols 被算成异常小值。切回 local 时 xterm 仍残留小 cols,即使 pty cols 正确,xterm 渲染仍按小 cols → 显示截断。

**Fix**:
- `backend/terminal/ws_handler.py` debounce spawn:resize 事件稳定 250ms 后才用最终 cols spawn;cols<20 或 rows<5 异常 size 丢弃;重连(pty 已活)走原 replay 路径。
- `frontend/.../useTerminal.ts` 容器小于 100x50 时跳过 fit:`handleResize` 和 `fit()` 都加 guard,xterm.cols 不再被 0-dim 容器算坏;fit 结果 cols<20 或 rows<5 时不发 sendResize。

**待验证**: 启动 local tab → 开 SSH tab → 切回 local,prompt 完整。

## 待优化

- [ ] 外部 agent token 启用时设置页加红字提醒"持有者可操控用户实时 shell"
- [ ] `/api/agent/events/stream` 事件注入侧边栏 chat 时间线,显示外部 agent 操作历史
- [ ] 前端 reload 时调用 `GET /api/sessions` 重建标签栏(目前依赖 localStorage,后端重启时会有错位)
- [ ] `wait_until_idle` 的 prompt 检测加 PowerShell `> ` 兼容(目前只匹配 `$ # > %`)
