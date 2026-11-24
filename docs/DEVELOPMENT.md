# 开发与本机运行

## 仓库与分支

正式源码仓库为 [Rowan-memoedu/progressive-reading-workflow](https://github.com/Rowan-memoedu/progressive-reading-workflow)，默认分支为 `main`。本地 `origin` 指向此地址，`main` 跟踪 `origin/main`。

```powershell
git status --short --branch
git remote -v
git pull --ff-only
```

开发分支合并后使用普通 `git push`。已有历史发生分歧时先检查来源和改动，不使用强推覆盖，也不把其他仓库的旧历史合回。恢复包、镜像及含私人材料的历史只能在隔离的私有恢复环境中使用。

## 安装和检查

Node.js 24 或更新版本：

```powershell
npm ci
npm test
```

浏览器扩展修改后运行 `npm run browser-highlight:check`；网页导入与规则修改分别运行 `npm run web-import:test`、`npm run import-rules:test`，涉及完整保存/发布时再运行对应的 `:e2e` 检查。

跨宿主交接需要单独取得 ObsidianLocalIR 源码，并将 `LOCAL_IR_OBSIDIAN_SOURCE` 指向该仓库目录；运行 `npm run document-core:adapters` 和 `npm run document-core:handoff`。其他可选依赖见 [安装与兼容性](SETUP.md)。

测试必须使用合成材料和独立目录，不把模型调用、真实订阅处理、取消点赞或 RemNote 写入混入普通回归。

## 本机配置与升级

源码路径和本地 GitHub 仓库身份不决定阅读资料位置。现有 `.local-ir/`、`imports/`、阅读区、队列、订阅数据目录与 Cookie 快照继续由各自配置和标记定位；普通更新不要迁移或重新初始化这些数据。

整站导入列表、详情和重试以已持久化的队列终态回执补齐尚未写完的任务视图。回执中的错误和候选快照可供用户查看，终态任务会释放同一来源的启动入口。

整站采集优先保留网页声明的同源 Markdown 正文，回执记录所用原稿地址和内容哈希。Markdown 地址不可用时沿用原网页正文，文章的来源身份仍使用原页面地址。

页面带站点登录导航时，只有已公开呈现的独立正文容器、与页面一致的标题和可见的正文或图文作品同时存在，并且没有访问限制标记，才继续处理该正文。登录页、锁定文章和脚本空壳继续保留失败回执。

超大 HTML 归档可以流式分离页面内嵌的图片和音视频 Base64 数据。正文、图注和原网页链接仍保留，回执记录完整响应的哈希、字节数和分离数量。分离的媒体可从原网页访问。

超大归档的样式表和启动脚本不占正文读取预算。原始响应哈希仍覆盖这些内容，公式和访问状态相关的结构化元数据继续保留。

生成的整站目录按路径片段编码本地链接，标题或文件夹中的井号和百分号仍指向原文件。

维护时可用 `reload-local-ir-app.ps1 -Apply -ResumeSiteDiscovery <实跑编号>` 重新加载同一个只读采集任务。此入口要求持久队列中只有一个活跃任务、编号一致，且尚未冻结正式入库清单或启动发布。重载后复用已采集的来源文件。

`PROGRESSIVE_READING_DATA_HOME`、`PROGRESSIVE_READING_ARTIFACT_HOME` 和各专用覆盖项适用于新安装及显式配置，既有 D 盘安装继续兼容原路径。不要把实际配置或私人阅读材料纳入公开提交。

本机服务通过原入口运行，默认只监听 `127.0.0.1:37829`。升级先检查活动请求，再按既有启动方式部署；不要额外启动第二个服务。检查 `/api/highlights/health` 的服务名、处理器版本和凭据状态，不能仅凭 Git 同步或任务 Running 宣称已部署。

## 发布前检查

检查暂存差异和新增文件，确认只有源码、合成测试、合同与使用文档。`.env`、实际订阅、阅读正文、批注、Cookie、模型响应、安装清单和运行回执保持忽略。保留第三方代码的来源、许可和锁定哈希。

现有全局开发治理检查器用于新建私有项目初始化；它要求 PRIVATE 的检查不能用于判定这个已明确公开的现有仓库是否应改回私有。本项目的开发检查使用上述源码测试和运行核验，维护其他项目的规则不受影响。
