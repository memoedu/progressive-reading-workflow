# 视频导入范围

单次视频导入支持 B 站和 YouTube，默认关闭图文模式。两种平台都可从 `/api/subscriptions/import-video` 或 `node subscription-workflow/cli.mjs import-video` 提交，并指定阅读区内的目标分类。B 站支持指定分 P，YouTube 按单条视频处理。显式传入 `output_type: "illustrated"` 或 `--output-type illustrated` 开启图文模式。

YouTube 优先使用原始字幕，通过现有 VTT 解析器进入标准书面化与导读流程。匿名访问遇到登录校验时，复用本机已有的 YouTube 登录快照重试。无可用字幕时保留明确失败或等待状态，ASR 不是默认降级路径。

B 站分 P、视频与合集订阅使用 `video-workflow/`。一次性纯文导入使用已核验的字幕和 `video-workflow/import-transcript.mjs` 的标准入口。可匿名播放的 B 站分 P 将原始字幕正文及加工稿登记到[公开资料库](SUBSCRIPTION_LIBRARY_SYNC.md)，已有同选项、同原稿版本可直接复用。字幕、截图、板书校订与多分 P 的证据规则见 [视频模块](../video-workflow/README.md)。

普通导入、原文直接导入与报表模式的区别见 [统一订阅](UNIFIED_SUBSCRIPTIONS.md)。视频不支持原文直接导入；报表筛选卡以完整字幕为输入，选中后再加工图文正文。

`scripts/import-youtube-subtitle-canary.mjs` 保留旧兼容处理器供历史测试；常规服务优先使用 `scripts/youtube-subtitle-import.mjs` 与标准预处理接口。旧 Canary 的通过记录不作为当前网站可访问或全部视频链路上线的证明。

实际订阅、已处理视频、失败样本、截图、字幕、模型响应与验收回执留在本机，不随源码发布。自动测试只验证合成材料；真实来源还需按当前登录态与站点返回核验。
