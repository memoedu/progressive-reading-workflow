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

## 知乎专栏发现

Windows 订阅数据目录的 `remote-zhihu-discovery.json` 可启用原定时知乎扫描的专栏发现阶段。它使用既有固定 SSH 主机密钥、别名 `mac-mini-tailscale` 和绑定的 Mac 用户主目录。Windows 原计划将当期作业送入原队列，原 worker 在锁内读取启用专栏和当前配置修订。

Mac 使用已运行的本机 Chrome 验证现有知乎账号并读取专栏页。它只打开和关闭自己的标签页，通过原有分页解析器生成稳定 ID、标题、时间和修订，记录页偏移、每页结果及总数提示。临时响应在 Mac 解析后删除。响应与当期、修订、来源及结果哈希绑定，正文和浏览器凭据留在原设备。

Windows 只接收完整的阶段回执，累计偏移不连续或缺少末页时使用 Windows 原发现路径。平台确实在末页结束但报告的总数与收录量有差异时，沿用原 `zhihu_column_count_discrepancy`。原作业的 `steps.scan.result.discovery` 记录实际执行端及回退原因。Windows 原游标、正文抓取、审核、归档和通知继续由原 worker 管理。单篇正文读取失败时，Windows 仍可从原专栏接口取同一 ID、同修订的正文。关闭绑定即可回到 Windows 发现，无需重建任务。

## B 站订阅发现

Windows 订阅数据目录的 `remote-video-discovery.json` 可启用原 08:00 视频任务的远端公开列表发现。原 worker 在视频锁内读取配置修订和已保存的合集 ID，通过固定主机密钥连接 `mac-mini-tailscale`。Mac 使用原 `discover` 读取公开合集和视频分 P。只有公开视频标识、合集约束和周期进入请求。

Windows 核验绑定当期、修订、来源及结果的哈希，再检查合集身份、`BV + CID`、分 P 顺序和完整性。原程序需要翻页时，回执包含连续页号、各页收录量与平台总数。SSH 失联、列表不完整或回执失配时，原 worker 在同一周期调用 Windows 的 `discover`。关闭绑定也回到同一路径。业务回执在 `steps.scan.result.discovery`。

Windows 保持唯一领取和游标写入，继续使用原字幕和截图入口、处理与发布账本。Mac 的列表调用使用公开接口和相同解析器。

## Mac 自主订阅发现

Mac 的两个只读 LaunchAgent 可分别于北京时间 07:00 和 08:00 封存知乎专栏和 B 站公开列表。登记表只包含启用的专栏、视频标识和 Windows 配置修订。Windows 保存来源后同步修订，原任务补跑时再尝试同步；相同修订不可替换为不同来源配置。

原绑定加上 `scheduledCapture: true` 后，Windows 只领取 Mac 已封存的同周期回执。Windows 原任务的错过补跑会从待领周期恢复原作业 ID。正在运行的 Mac 周期可短时等候，回执缺失、校验失败或合集与原 Windows 游标的合集号冲突时，使用 Windows 原发现。成功处理终态保存后向 Mac 确认原作业 ID 和封存哈希。重复领取或确认读回同一份证据。

安装入口为 `python3 subscription-workflow/configure-mac-discovery-stage.py <zhihu|bilibili>`。先发布初始登记表再安装。知乎使用 Mac 当前账号的 Chrome 会话，且 macOS 必须允许原生定时进程使用 Chrome 自动化。B 站公开发现无需浏览器或账号。现有 Windows 通知、审核、正文、游标和发布路径仍持有原业务状态。回退时关闭绑定中的 `scheduledCapture` 可恢复原即时跨机发现，关闭整个绑定可恢复 Windows 发现。可单独停用对应 Mac 采集标签，保留封存的周期文件。

## 日报和周报

候选输入位于 `<stage-home>/<cycle>/<kind>/input`，分为 `workspace`、`state`、`rss`、`video` 四个子目录，另以 `roots.json` 记录四个原 Windows 输入根。已有正文的正式传输由阅读同步负责。冻结输入排除 Local IR 与浏览器凭据。

`node subscription-workflow/remote-report-stage.mjs <stage-home> <daily|weekly> <cycle>` 复用报表渲染和活动汇总。计算前后验证冻结输入，产物包含哈希及业务完成状态。Windows 可用 `receive-report-candidate.ps1` 把候选和回执取回隔离目录，重复领取读回同一组文件。

候选回执的 `publishable: false` 标记正式门禁。应用到正式流程前需匹配 Windows 当前审核快照，并对账本、审核卡和档案的并发编辑做一致性校验。候选账本用于核对。

## 日报和长文周报的定期草稿

Windows 既有日、周报可启用订阅数据目录的 `remote-report-render.json`，其中 `enabled`、`host` 和 `home` 分别选择开关、固定 SSH 别名和 Mac 主目录。原生 Windows 任务仍使用原周期键，在原订阅 worker 锁内执行。

Mac 只计算阅读概述、价值、新增量、阅读成本与读法五个字段。请求不包含正文、手工笔记、勾选、账号凭据、审核账本或其路径。返回回执绑定该周期的请求和结果哈希。Windows 在继续写入前复核账本哈希和卡片快照，再按原规则合并、归档和通知。远端草稿无法读取或校验失败时，Windows 使用同一渲染函数回退。账本或卡片已变更时，该轮停止提交。候选选择和短文周报的正文仍由 Windows 处理。
