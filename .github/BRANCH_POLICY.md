# Branch and build policy / 分支与构建规则

## 中文

- GitHub Actions 自动触发只允许 `push` 到 `main` 或 `production`，且必须命中各工作流的路径过滤。
- 不使用 `pull_request`、`pull_request_target`、评论、标签、定时、`workflow_run` 或 `workflow_dispatch` 触发，避免开发分支与 PR 重复跑检查，也避免手动选择其他分支绕过规则。已有运行可以在 GitHub 重新运行。
- `tmctl` 检查覆盖 CLI、Worker、数据库及其工作流；E2E 只覆盖应用/测试及其工作流，不因纯 CLI 或文档改动启动；SMTP 镜像仅在其目录改动时构建。
- 每个工作流按分支隔离并发，连续推送自动取消同一分支的旧运行。生产分支尚无 CLI 时，不提前引入 CLI 工作流或应用代码。
- 旧工作流保留在 `.github/disabled-workflows/` 作为不可执行参考；不要直接移回或用上游同步覆盖这套规则。
- 两个 Git 连接的 Cloudflare Pages 项目（`temp-mail-865455-git`、`temp-mail-865455-telegram-git`）保持 `production` 为生产分支；预览使用 `custom` 白名单，仅包含 `main`，排除列表为空。
- 要进行预览，先把改动合并/推进到 `main`；仅推送 feature 分支或创建 PR 不产生预览。保留仓库所有者直推 `main` 的能力，不强制 PR-only。
- Pages 用 `.github/*` 排除 CI 目录（单个 `*` 已匹配跨目录路径，勿套用 GitHub 的 `**` 语法）；Worker Builds 用 `.github/**`。两者均排除 `CHANGELOG.md`、`CHANGELOG_EN.md`，其余路径保留原有规则；仅改 CI/更新日志时跳过构建。Pages 的空提交、20 个及以上提交或 3000 个及以上文件变更会绕过路径过滤；无代码部署测试不要使用空提交。
- Worker Builds 仍只允许 `production`。Pages 预览不等于后端/数据库隔离，可能仍连接生产 API。
- Cloudflare 分支/路径限制是账户端配置；克隆仓库或恢复工作流文件不会自动恢复这些限制。应回读 `source.config` 和 Workers Builds trigger 验证。
- Pages 会为已跳过的推送留下 `queued/idle` 的记录；必须检查 `is_skipped=true`、`skip_reason` 和各阶段未开始，不能误判成排队构建。

## English

- Actions run only on relevant-path `push` events to `main` and `production`.
- PRs, comments, tags, schedules, chained workflows and manual dispatch are intentionally disabled. Existing permitted runs can be rerun in GitHub.
- CLI checks cover the CLI, Worker and database. E2E checks cover application/test paths, not CLI-only/docs-only changes. SMTP images build only for changes under their own directory.
- Concurrency is scoped by workflow/branch and cancels superseded runs. Do not bring CLI/application changes into production solely to change CI rules.
- Archived workflows in `.github/disabled-workflows/` are reference-only. Do not reactivate them or overwrite branch restrictions during upstream synchronization.
- Both connected Pages projects use `production` for production and a custom preview allowlist of exactly `main`, with no preview exclusions.
- Merge/promote changes to `main` before previewing; feature pushes and PR creation do not produce previews. Owner direct pushes to `main` remain possible; this is not a mandatory-PR policy.
- Pages exclude `.github/*` (a single star matches nested paths; do not apply GitHub double-star syntax); Worker Builds exclude `.github/**`. Both exclude `CHANGELOG.md` and `CHANGELOG_EN.md`. Normal CI/changelog-only pushes skip builds; Pages bypass path checks for zero-file pushes, 20+ commits or 3000+ changed files. Do not test path filters with an empty commit.
- Worker Builds remain production-only. Frontend previews may still call the production API and are not isolated backend/database environments.
- Cloudflare settings live in the account and must be verified separately by reading Pages source config and the Worker build trigger.
- Skipped Pages pushes can leave queued/idle records. Inspect `is_skipped`, `skip_reason` and unset stage timestamps before treating them as queued builds.
