# 原始 Markdown 备份

后台 URL 抓取拿到正文后，在翻译、导读和阅读加工前保留源 Markdown。备份沿用该条材料在阅读区内的分类与文件名。

将 [配置示例](../config/original-markdown-backup.example.json)复制到工作流数据根目录的 .local-ir/original-markdown-backup.json。在 repository 填写具有 main 分支的私有 GitHub 仓库，origins 填写确认可备份的 HTTPS 来源。配置缺失时功能关闭。运行账户使用本机 GitHub CLI 登录，权限须涵盖目标仓库的内容写入，并可执行 Gitleaks。

当前覆盖通过共享 URL 入口匿名抓取、且来源列入配置的网页，包括整站工具以现行采集器取得的网页正文。登录态抓取、浏览器当前页快照、订阅正文缓存、Git 仓库原始字节、字幕与本地文档提取还需各自的来源核验。

队列存放在 .local-ir/original-markdown-backup。仓库不可用时保留待同步原件，服务启动及运行期间会重试。凭据扫描命中的原件留在本机 held 目录。同路径同内容复用远端文件，内容不同则用带正文哈希的文件名创建备份。健康接口 /api/highlights/health 的 originalMarkdownBackup 返回队列、暂留和错误状态。
