# Repository collaboration

- 代码提交、PR 合并、同步与共享边界遵守 [CONTRIBUTING.md](CONTRIBUTING.md)。历史任务授权、私人账号及生产数据权限不随源码共享转移给其他成员或 Agent。

This repository is intentionally public. Its canonical development remote is
`https://github.com/memoedu/progressive-reading-workflow.git`, with `main`
as the default branch. Keep normal development and upstream tracking on that
repository. Do not change its visibility as part of routine maintenance.

## Preserve local data

- Read the current Git status before editing and preserve unrelated changes.
- Commit reusable source, contracts, synthetic tests and product documentation.
- Keep reading materials out of this source repository. For every import,
  repair, backfill or directory update, verify and sync eligible originals,
  generated reading Markdown and portable directories to the
  [shared reading library](docs/SUBSCRIPTION_LIBRARY_SYNC.md). Read back the
  shared commit before closing the task. Keep reader-edited versions,
  annotations, private subscriptions, credentials and runtime evidence local.
- Respect `.gitignore`; do not force-add ignored data or restore old private
  history into this repository. Never push mirrors or recovery bundles here.
- Product prompts are source. Actual input materials, model responses and local
  acceptance receipts are runtime data and must remain local.

## Compatibility and validation

- Preserve existing local configuration, storage markers and legacy readers.
  Portable path overrides must not silently move an existing installation.
- Use the existing shared import, preprocessing and publication interfaces.
- Source taxonomy may exist only beside archive entries or in public tag indexes. Verify all memberships before treating exclusive flat tags as categories; preserve overlapping tags and reuse existing bodies when repairing folders. See `docs/WEB_IMPORT_PAGE.md`.
- When updating directories for previously imported sites, use the source directory workflow in `docs/DEVELOPMENT.md`. Preserve author order, hierarchy and overlapping memberships. Resolve local articles from on-disk source URLs and verified aliases, use Obsidian new-tab links for usable local targets, and keep other source links on the web. Label inferred topics and preserve reader-edited indexes, bodies and reading state. Keep installation-specific site plans local.
- Use isolated synthetic fixtures for tests. Do not import into the real reading
  library, change scheduled tasks or write to RemNote as a side effect of tests.
- Run `npm test` for changes to shared logic. Browser/import changes also need
  their relevant checks from `docs/DEVELOPMENT.md`.
- A passing test is not evidence that a running host has reloaded. Verify the
  actual health endpoint and deployment separately when deploying changes.

See [development guidance](docs/DEVELOPMENT.md) for setup and checks.
