# 订阅阶段交接

RSS 纯采集可以由另一台设备执行。现有 Windows 任务和原周期 ID 继续承载后续导入、人工勾选、状态落账和通知。

## RSS

1. 源端调用 `node subscription-workflow/remote-feed-stage.mjs run <stage-home> <registry.json>`。订阅配置提供启用状态、修订号、RSS 来源 ID 和 URL。周期按 Asia/Shanghai 计算，完整结果与回执保留在源端。
2. Windows 通过 `receive-rss-capture.ps1` 先核验 Mac 业务回执和原订阅配置，再将快照原子写入 `remote-rss/<cycle>/capture.json`。使用已有固定主机密钥。已存在的结果先读回。没有快照的周期仍由本地采集。
3. 原任务消费 XML 时继续走现有扫描器。Windows 作业的 `steps.scan.result.remoteCapture.sha256` 记录实际消费的哈希。GitHub 站点请求、正文获取和审核继续由原流程管理。
4. Windows 作业完成后，以 `-Acknowledge` 回送同一周期的工作流 ID 和哈希。重复调用先读回已有确认。提交结果未知时，重跑只会读回或补写同一回执。

回退时先停源端日历触发，再对照已采集和已消费周期。Windows 可对后续没有捕获文件的周期继续采集。已验证的文件可以保留为原始输入。

## 日报和周报

候选输入位于 `<stage-home>/<cycle>/<kind>/input`，分为 `workspace`、`state`、`rss`、`video` 四个子目录，另以 `roots.json` 记录四个原 Windows 输入根。已有正文的正式传输由阅读同步负责。冻结输入排除 Local IR 与浏览器凭据。

`node subscription-workflow/remote-report-stage.mjs <stage-home> <daily|weekly> <cycle>` 复用报表渲染和活动汇总。计算前后验证冻结输入，产物包含哈希及业务完成状态。Windows 可用 `receive-report-candidate.ps1` 把候选和回执取回隔离目录，重复领取读回同一组文件。

候选回执的 `publishable: false` 标记正式门禁。应用到正式流程前需匹配 Windows 当前审核快照，并对账本、审核卡和档案的并发编辑做一致性校验。候选账本用于核对。
