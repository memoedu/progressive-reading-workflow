# 订阅阶段交接

RSS 纯采集可以由另一台设备执行。现有 Windows 任务和原周期 ID 继续承载后续导入、人工勾选、状态落账和通知。

## RSS

1. 源端调用 `node subscription-workflow/remote-feed-stage.mjs run <stage-home> <registry.json>`。订阅配置提供启用状态、修订号、RSS 来源 ID 和 URL。周期按 Asia/Shanghai 计算，完整结果与回执保留在源端。
2. Windows 通过 `receive-rss-capture.ps1` 先核验 Mac 业务回执和原订阅配置，再将快照原子写入 `remote-rss/<cycle>/capture.json`。使用已有固定主机密钥。已存在的结果先读回。没有快照的周期仍由本地采集。
3. 原任务消费 XML 时继续走现有扫描器。Windows 作业的 `steps.scan.result.remoteCapture.sha256` 记录实际消费的哈希。GitHub 站点请求、正文获取和审核继续由原流程管理。
4. Windows 作业完成后，以 `-Acknowledge` 回送同一周期的工作流 ID 和哈希。重复调用先读回已有确认。提交结果未知时，重跑只会读回或补写同一回执。

回退时先停源端日历触发，再对照已采集和已消费周期。Windows 可对后续没有捕获文件的周期继续采集。已验证的文件可以保留为原始输入。

Windows 订阅页面保存或删除来源、CLI 激活订阅后，沿现有 `remote-rss-binding.json` 把启用状态、配置修订和启用 RSS 的 ID、URL 发送到 Mac 原注册表。原配置先提交，SSH 使用固定主机密钥。Mac 在注册表锁内按修订号原子写入，重复版本必须具有相同投影，更旧的版本被拒绝。投影不含其他类型来源、账号或报表数据。

SSH 失败时，下一次原配置保存或原 RSS 领取会读取 Windows 已保存的最新配置并重试。Mac 已冻结的周期输入保持原样。如果接收时才追回新配置，旧版捕获仍按原规则校验，无法使用时由 Windows 本轮采集。只读对账用 `node subscription-workflow/rss-registry-sync.mjs <Windows订阅数据目录> verify`，返回两端一致的修订、源数及投影哈希。

## 日报和周报

候选输入位于 `<stage-home>/<cycle>/<kind>/input`，分为 `workspace`、`state`、`rss`、`video` 四个子目录，另以 `roots.json` 记录四个原 Windows 输入根。已有正文的正式传输由阅读同步负责。冻结输入排除 Local IR 与浏览器凭据。

`node subscription-workflow/remote-report-stage.mjs <stage-home> <daily|weekly> <cycle>` 复用报表渲染和活动汇总。计算前后验证冻结输入，产物包含哈希及业务完成状态。Windows 可用 `receive-report-candidate.ps1` 把候选和回执取回隔离目录，重复领取读回同一组文件。

候选回执的 `publishable: false` 标记正式门禁。应用到正式流程前需匹配 Windows 当前审核快照，并对账本、审核卡和档案的并发编辑做一致性校验。候选账本用于核对。

## 日报和长文周报的定期草稿

Windows 既有日、周报可启用订阅数据目录的 `remote-report-render.json`，其中 `enabled`、`host` 和 `home` 分别选择开关、固定 SSH 别名和 Mac 主目录。原生 Windows 任务仍使用原周期键，在原订阅 worker 锁内执行。

Mac 只计算阅读概述、价值、新增量、阅读成本与读法五个字段。请求不包含正文、手工笔记、勾选、账号凭据、审核账本或其路径。返回回执绑定该周期的请求和结果哈希。Windows 在继续写入前复核账本哈希和卡片快照，再按原规则合并、归档和通知。远端草稿无法读取或校验失败时，Windows 使用同一渲染函数回退。账本或卡片已变更时，该轮停止提交。候选选择和短文周报的正文仍由 Windows 处理。
