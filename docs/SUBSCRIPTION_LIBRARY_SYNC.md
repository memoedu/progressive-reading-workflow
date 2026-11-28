# 订阅共享资料库

链接导入、RSS 自动导入、RSS 日报周报和知乎文本在获取正文前按规范化来源地址查公开资料库。链接队列同时查原稿和同处理选项的加工稿，一次索引查询确定需要复用、加工或补传的版本。命中时从固定 Git 提交下载并核对 SHA-256。本地已有正文也进入同一步骤，缺失的共享版本从原导入材料恢复。RSS 订阅发现仍读取其配置的 feed。

订阅页的「共享资料库」默认开启。关闭后，新材料走本机导入，已有的公开原稿备份队列暂停写入。已登录的订阅用户由服务器代写主分支，匿名投稿由同一服务器代提 PR。已发表材料可以直接匿名复用。待合并的订阅条目有 PR 链接，队列会继续检查主分支。手工链接导入也会尝试同步公开 RSS 目录内的条目，投稿待审时可继续本机导入并保留 PR 回执。

`index/articles/` 按来源地址索引原稿和加工版本。同步服务通过 GitHub Contents API 按选定的提交读取。快进写入遇到并发时重新核对索引。匿名投稿分支按来源生成，重复投稿复用同一 PR。[公开订阅索引](https://github.com/memoedu/progressive-reading-library/blob/main/index/subscriptions.json)只记录公开来源地址。Thoughts Memo 译文的索引保留上游许可证、固定提交、目录及 Git blob 哈希。

标准导入将可公开的原稿与加工 Markdown 分开存储。来源索引记录原稿和成品的 SHA-256，以及正文整理、翻译、导读等处理选项的指纹。有当前处理器和提示版本的成品时优先复用，其次查找处理选项完全相同的已验证历史成品。用户提供过原稿字节时，还必须匹配对应原稿的 SHA-256。

浏览器、Obsidian、导入管理、整站、RSS 自动入库共用链接队列。普通链接、整页快照、订阅阅读、视频纯文字幕和标准 Markdown 发布共用 GitHub 同步步骤。新增入口沿用阅读稿发布器，提交来源和产物即可。同步由来源证据、加工选项和校验结果决定。

原稿落盘和生成稿落盘各自产生持久上传事件。事件保存源 URL、原稿和生成稿的固定字节及处理选项。上传程序只消费这些事件，先查 GitHub 索引，再补齐缺失版本，以从固定 Git 提交回读并校验为完成。生成事件适用于各种抓取与加工方式，包括登录抓取。阅读者后续编辑和个人批注由本地文档单独保存。写入使用现有账号，并由同步服务检查传输格式和凭据泄漏。

来源核验后遇到暂时写入失败，本机会保留一次可重试的发布记录并继续导入。现有后台任务按记录重试，复用原稿、成品和加工选项。原导入请求的查询会返回最新同步结果。命令行或批次可使用回执中的 `sync_id` 查询 `GET /api/import-center/shared-publications/:id`。

读取本机已生成的文件来补事件时，核对原导入的原稿快照与生成稿 SHA-256。在同一事件中按实际产物回读原稿和加工稿。阅读者改动过的稿件、个人批注、自由文本加工要求、配图模式和本机运行包留在本机。

整站导入、修复、批量回补和目录更新的交付也包括共享库回读。先查共享仓库已有的原稿、加工稿及上游固定版本索引，复用已同步的文件。其余符合来源、版本和隐私核验的文件按现有发布流程同步。用户手改过的文件版本不参与发布，同一来源已核验的原稿和其他未编辑版本仍可独立核验。回执记录实际同步或复用的版本和需要留在本机的具体原因。

原站目录可在资料库的对应分类下发布可移植 Markdown。`site-import/shared-directories.mjs` 从生成回执核对本地目录的 SHA-256，用调用方核验过的资料库正文路径替换 Obsidian 链接。尚无共享正文的条目保留公开来源地址。确认共享版的目录和正文链接均可从已合并的提交读取。

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

将[来源配置示例](../config/shared-library-server-sources.example.json)的字段合并到服务器配置。`public_rss` 声明公开 feed、可接受的文章域名和分类目录。`public_materials` 的每条记录包含 `url`、`extension`、`sha256` 和 `bytes`，并可用 `article_url` 关联文章索引及加工版本。仅登记已验证的匿名原件下载地址，单件不超过 25 MiB。

新安装默认连接 Memo Edu 共享资料库的 HTTPS 服务。使用自建服务时，可将 [配置示例](../config/subscription-library-sync.example.json)保存到工作流数据根目录的 `.local-ir/subscription-library-sync.json` 并修改地址。使用账号时通过订阅页登录，会话绑定所配置的 HTTPS 地址。

缺少服务器写入配置时，健康接口的 write_available 返回 false。此时可校验现有索引和匿名下载，实际新材料发布待写入配置就绪后启用。
