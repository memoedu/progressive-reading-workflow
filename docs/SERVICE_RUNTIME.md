# 导入后端后台运行

服务入口为 `scripts/progressive-reading-app.mjs`，默认只监听 `127.0.0.1:37829`。先用 `npm run app` 验证前台启动；Windows 后台入口为 `scripts/run-local-ir-app.ps1`。

已有安装可能由计划任务 `Local IR Browser Highlight` 或 BotReading 启动。升级前查询实际监听进程和父进程，检查 broker 无活动任务，再沿用既有启动入口。不要同时启动多个守护。端口被占用时服务报错退出。

健康检查为 `GET /api/highlights/health`，应核对服务名、处理器版本、导入合同与 Cookie 状态。任务显示 Running 不足以证明服务可用；Cookie 快照可读也不等于网站登录有效。

## 在 Mac 执行浏览器正文加工

浏览器服务的启动环境设置 `PROGRESSIVE_READING_BROWSER_PREPROCESS_SSH_HOST` 后，标准正文加工请求可交给已经通过 SSH 主机密钥校验的 Mac。Mac 源码位于 `~/Agent/Projects/progressive-reading-workflow`，使用项目既有预处理和模型配置。Windows 负责网页抓取、授权、草稿状态、结果核验和发布。普通保存和原文导入保持本地。跨机请求传送预处理合同中的 Markdown、来源元数据与加工选项。浏览器、Cookie 和批注状态留在 Windows。连接失败后保留原请求与失败信息，恢复后使用原入口重试。

`scripts/repair-local-ir-task.ps1` 与 `scripts/reload-local-ir-app.ps1` 面向已有 Windows 计划任务；执行 `-Apply` 前先检查脚本参数和活动任务。脚本检查队列不代替确认用户是否正在编辑浏览器草稿。

本地运行记录和任务 XML 只保留在产物目录，不作为公开仓库的部署证明。安装和目录覆盖项见 [安装与兼容性](SETUP.md)。
