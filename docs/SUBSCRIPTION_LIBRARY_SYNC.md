# 订阅共享资料库

Ben Kuhn RSS 试点通过公开资料库复用原文。订阅发现文章后，先按规范化来源地址查仓库索引。命中时从固定 Git 提交下载正文、核对 SHA-256，再交给既有阅读加工流程。新增原文由同步服务抓取，并在正文和来源索引都提交后返回版本。

订阅页的「共享资料库」默认开启。关闭后，新材料走本机导入。已登录的订阅用户由服务器代写主分支，匿名投稿由同一服务器代提 PR。已发表材料可以直接匿名复用。待合并条目有 PR 链接，队列会继续检查主分支。

索引位于 index/articles，文件名使用规范化 URL 的 SHA-256。每条记录包含 URL、标题、原文相对路径和正文哈希。提交主分支时保留快进更新，并发写入会重新核对最新索引。匿名投稿分支按来源生成，重复提交复用同一 PR。

## 服务器配置

独立同步进程在 127.0.0.1:43182 运行，经 HTTPS 路由访问。部署文件见 [systemd 单元](../subscription-workflow/deploy/shared-library.service) 和 [nginx 片段](../subscription-workflow/deploy/shared-library.nginx.conf)。源文件和依赖从已验证的 Git 提交构建。生产配置由 systemd LoadCredential 读取，路径为 /etc/progressive-reading-sync/config.json。

服务器配置字段包括 port、trust_proxy、gitleaks、accounts、session_secret、private_email_sha256 以及 github。github 包含 appId、installationId、keyPath。将 GitHub App 安装到公开资料库并授权 Contents 和 Pull requests 的写入。私钥作为 systemd 独立凭据提供，keyPath 指向该凭据文件。账号记录的 salt 和 hash 由 createSharedAccount 函数生成。移除或替换账号记录后，重启同步进程使对应会话失效。trust_proxy 只用于由已配置 nginx 覆盖 X-Real-IP 的回环部署。

客户端将 [配置示例](../config/subscription-library-sync.example.json)保存到工作流数据根目录的 .local-ir/subscription-library-sync.json。使用账号时通过订阅页登录，会话绑定所配置的 HTTPS endpoint。

缺少服务器写入配置时，健康接口的 write_available 返回 false。此时可校验现有索引和匿名下载，实际新材料发布待写入配置就绪后启用。
