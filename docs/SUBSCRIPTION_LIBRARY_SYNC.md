# 订阅共享资料库

链接导入、RSS 自动导入、RSS 日报周报和知乎文本在获取正文前按规范化来源地址查公开资料库。命中时从固定 Git 提交下载并核对 SHA-256。新增公开 RSS 原稿由同步服务在当前公开 feed 中确认后独立读取。公众号和已登记的公开网页须通过匿名正文复查。B 站标准纯文稿须关联可匿名播放的精确分 P。YouTube 纯文稿由本机匿名核对作者频道搜索结果中的精确视频 ID。

订阅页的「共享资料库」默认开启。关闭后，新材料走本机导入，已有的公开原稿备份队列暂停写入。已登录的订阅用户由服务器代写主分支，匿名投稿由同一服务器代提 PR。已发表材料可以直接匿名复用。待合并的订阅条目有 PR 链接，队列会继续检查主分支。手工链接导入也会尝试同步公开 RSS 目录内的条目，投稿待审时可继续本机导入并保留 PR 回执。

`index/articles/` 按来源地址索引原稿和加工版本。同步服务通过 GitHub Contents API 按选定的提交读取。快进写入遇到并发时重新核对索引。匿名投稿分支按来源生成，重复投稿复用同一 PR。[公开订阅索引](https://github.com/memoedu/progressive-reading-library/blob/main/index/subscriptions.json)只记录公开来源地址。Thoughts Memo 译文的索引保留上游许可证、固定提交、目录及 Git blob 哈希。

标准导入将可公开的原稿与加工 Markdown 分开存储。来源索引记录原稿和成品的 SHA-256，以及正文整理、翻译、导读等处理选项的指纹。有当前处理器和提示版本的成品时优先复用，其次查找处理选项完全相同的已验证历史成品。用户提供过原稿字节时，还必须匹配对应原稿的 SHA-256。

浏览器、Obsidian、导入管理、整站、RSS 自动入库共用链接队列。普通链接、整页快照、订阅阅读、视频纯文字幕和标准 Markdown 发布共用 GitHub 同步步骤。新增入口沿用阅读稿发布器，提交来源和产物即可。同步由来源证据、加工选项和校验结果决定。

公开原稿在取得后就可提交同步。加工稿先保存到阅读区，随后以正式文件的 SHA-256 核对实际写入的 Markdown 并提交同步。导入入口、导入状态和质量警告不影响已生成产物的同步。原文导入只有原稿产物。同步以从 GitHub 固定提交回读并校验为完成。登录来源、私人加工要求、个人批注、已有文档修订和须携带本地素材的版本留在本机。已从公开库核验并复用的版本保留原提交回执。

来源核验后遇到暂时写入失败，本机会保留一次可重试的发布记录并继续导入。现有后台任务按记录重试，复用原稿、成品和加工选项。原导入请求的查询会返回最新同步结果。命令行或批次可使用回执中的 `sync_id` 查询 `GET /api/import-center/shared-publications/:id`。

读取本机已生成的文件来同步时，先核对文件和生成回执的 SHA-256。历史回补须能核对公开原稿、生成结果和未编辑的记录。阅读者改动过的稿件、个人批注、自由文本加工要求、配图模式和本机运行包留在本机。

通过 `download-shared-reading` 指定来源与当时的处理选项文件即可直接复用完整加工稿。原有 `download-shared-version` 可继续下载此前单独登记的译文或导读。

```powershell
node subscription-workflow/cli.mjs download-shared-reading --url '<来源链接>' --options '<处理选项.json>' --output '<新文件.md>'
```

```powershell
node subscription-workflow/cli.mjs download-shared-version --url '<原稿链接>' --kind translation --output '<新文件.md>'
```

`index/materials/` 按 SHA-256 索引原始 PDF、EPUB、DOCX 和 TXT。服务器根据已核验的公开地址、字节数和 SHA-256 重新下载原件，再将文件存入 `原材料/<格式>/`。没有公开来源凭据的本机原件留在本机。同步命令从资料库下载并核验原材料，已有输出文件按原样保留。

```powershell
node subscription-workflow/cli.mjs sync-shared-material --sha256 '<原件哈希>' --output '<新文件.pdf>'
```

## 服务器配置

独立同步进程在 127.0.0.1:43182 运行，经 HTTPS 路由访问。部署文件见 [systemd 单元](../subscription-workflow/deploy/shared-library.service) 和 [nginx 片段](../subscription-workflow/deploy/shared-library.nginx.conf)。源文件和依赖从已验证的 Git 提交构建。生产配置由 systemd LoadCredential 读取，路径为 /etc/progressive-reading-sync/config.json。

服务器配置字段包括 `port`、`trust_proxy`、`gitleaks`、`accounts`、`session_secret`、`private_email_sha256` 和 `github`。`github` 包含 `appId`、`installationId`、`keyPath`。将 GitHub App 安装到公开资料库并授予 Contents 和 Pull requests 写权限。私钥通过 systemd 独立凭据提供。账号记录的 salt 和 hash 由 `createSharedAccount` 生成。移除或替换账号后，重启同步进程使对应会话失效。`trust_proxy` 只用于由 nginx 覆盖 X-Real-IP 的回环部署。

无法直连 YouTube 的服务可对已授权执行匿名来源核验的本机发布账号设置 `trusted_public_source_publisher: true`。服务将账号提交的公开频道证据与规范化视频 ID、原稿 SHA-256 逐项匹配。该权限仅用于 YouTube 来源核验。

将[来源配置示例](../config/shared-library-server-sources.example.json)的字段合并到服务器配置。`public_rss` 声明公开 feed、可接受的文章域名和分类目录。`public_materials` 的每条记录包含 `url`、`extension`、`sha256` 和 `bytes`，并可用 `article_url` 关联文章索引及加工版本。仅登记已验证的匿名原件下载地址，单件不超过 25 MiB。

新安装默认连接 Memo Edu 共享资料库的 HTTPS 服务。使用自建服务时，可将 [配置示例](../config/subscription-library-sync.example.json)保存到工作流数据根目录的 `.local-ir/subscription-library-sync.json` 并修改地址。使用账号时通过订阅页登录，会话绑定所配置的 HTTPS 地址。

缺少服务器写入配置时，健康接口的 write_available 返回 false。此时可校验现有索引和匿名下载，实际新材料发布待写入配置就绪后启用。

`public_web_origins` 可覆盖内置的公开网页域名。同步服务只使用匿名请求和同一正文转换器复核材料。
