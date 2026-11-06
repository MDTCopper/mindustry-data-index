# mindustry-mods-index

Mindustry 模组下载的补充数据仓库：以官方模组列表
[`Anuken/MindustryMods/mods.json`](https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json)
为唯一来源，为其中的每个模组补齐**全部 release、预发布标识、模组版本与最低游戏版本、下载链接**，
由 GitHub Actions 每天增量更新并自动提交。

## 和官方 mods.json 的分工

- **官方 `mods.json`**：谁能在游戏内下载（990 个模组的权威名单），附带 `version`、`minGameVersion`、
  `stars`、`hasJava` 等少量字段，每个模组只有一份「当前版本」信息。
- **本仓库**：只覆盖官方列表里的模组，不新增、不删减模组；补充官方列表没有的历史 release 与
  逐 tag 元数据，供启动器/网站免去运行时直连 GitHub API（匿名限流、慢、看不到完整历史）。

## 数据源

| 数据 | 地址 |
| --- | --- |
| 模组名单 | `https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json` |
| release 列表 | `https://api.github.com/repos/<owner>/<repo>/releases`（分页取全，含 prerelease/draft 标记） |
| 每个 tag 的元数据 | `https://raw.githubusercontent.com/<owner>/<repo>/<tag>/mod.hjson`（候选 `mod.json`、`assets/mod.hjson`、`assets/mod.json`） |

## 产物

仓库根目录：

```
index.json                     # 全量模组索引（官方列表顺序）
releases/<owner>_<repo>.json   # 单个模组的全部 release + 逐 tag 元数据
```

`releases/` 文件名把 repo 里的 `/` 换成 `_`，保留大小写，与官方图标命名一致，例如
`releases/Anuken_ExampleMod.json`。产物可以直接按 raw 地址读取，例如
`https://raw.githubusercontent.com/<你的账号>/mindustry-mods-index/main/releases/Anuken_ExampleMod.json`。

字段摘要（完整字段表见 [docs/schema.md](docs/schema.md)）：

- `index.json`：`repo`、`internalName`、`name`、`author`、`version`、`minGameVersion`、
  `lastUpdated`、`stars`、`hasIcon`、`hasScripts`、`hasJava`，加上 `releasesPath`、`releaseCount`、
  `latestRelease`、`releaseDataUpdatedAt`；`skipped` 记录本次抓取失败的仓库。
- `releases/*.json`：每条 release 有 `tag`、`name`、`prerelease`、`publishedAt`、`htmlUrl`、
  `modVersion`、`minGameVersion`、`metadataPath`、`metadataStatus`、`downloadUrl`、
  `sourceArchiveUrl`、`assets`。`downloadUrl` 的挑选规则与 Copper Launcher 一致：`hasJava` 取体积最大的
  `.jar` 资产，否则取体积最大的 `.zip` 资产，没有对应资产时回退 `sourceArchiveUrl`。

## 更新节奏

`.github/workflows/update.yml` 每天 02:23 UTC（北京时间 10:23）跑一次，也支持手动
`workflow_dispatch`；改动 `src/**`、`package.json`、`package-lock.json` 或该 workflow 本身会额外触发一次。
有变化时以 `[auto-update]` 提交并推送，无变化不产生提交。

## 本地运行

```bash
npm ci
npm test                         # 离线单元测试
node src/main.js --out .         # 全量更新（需要 GITHUB_TOKEN，否则匿名配额很快耗尽）
node src/validate.js --dir .     # 校验产物
```

本地验证建议只跑官方列表里的少数模组

```bash
node src/main.js --out tmp/live --repos "annguyen2k8/mindustrypackloader,cardillan/mlogassertions" --threads 2 --raw-threads 2 --verbose
node src/validate.js --dir tmp/live
```

参数（`--help` 可看完整说明）：

| 参数 | 说明 |
| --- | --- |
| `--out <目录>` | 产物目录，默认 `.` |
| `--token <token>` | GitHub token，默认读环境变量 `GITHUB_TOKEN` |
| `--repos a/b,c/d` | 只跑指定仓库（本地验证）；此模式不清理其它文件，`index.json` 只含这些条目 |
| `--limit <n>` | 最多处理 n 个模组（官方列表顺序） |
| `--threads <n>` | 同时处理的仓库数，默认 8 |
| `--raw-threads <n>` | raw.githubusercontent 并发数，默认 16 |
| `--no-cache` | 忽略旧产物全量重抓（不使用 ETag、不复用旧元数据） |
| `--keep-missing-files` | 不删除官方列表中已消失模组的 `releases/*.json` |
| `--dry-run` | 只抓取与计算，不写文件 |
| `--verbose` | 输出增量细节（304、新抓/复用元数据、请求统计） |

## 增量机制

- 启动时读旧 `index.json` 与对应 `releases/*.json` 作为缓存。
- 每个仓库先请求 release 第一页并带上旧文件里的 `If-None-Match` ETag：**304** 则整个 release 数组原样
  复用、不再发后续请求；**200** 则按 Link/不足一页继续翻页，最多 100 页。
- 只有**新 tag**（旧文件里没有，或旧条目 `metadataStatus != ok`）才去读该 tag 的 `mod.hjson`；
  旧条目直接复用 `modVersion` / `minGameVersion` / `metadataPath` / `metadataStatus`。
- 单个模组的 `releases/*.json` 只有在 `releases` 数组、`repo` 或 `source` 变化时才重写并更新
  `generatedAt`，避免每天产生全量 diff；`index.json` 的 `generatedAt` 每天更新属正常现象。
- 单个仓库失败不会终止整体：保留旧产物、记入 `index.skipped`、退出码仍为 0；官方列表拉取失败时退出码 1。

## 限制

- 只覆盖官方列表内的模组；列表里被移除的模组，其 `releases/*.json` 会在下次全量运行中删除。
- **tag ≠ release**：只收录 GitHub 上有 release 的 tag，仓库里没有建 release 的 tag 不会出现。
- `mod.hjson` 取不到时 `modVersion` / `minGameVersion` 为 `null`，`metadataStatus` 说明原因。
- 受 GitHub API 限流约束：Actions 里用 `GITHUB_TOKEN`（每小时 5000 次），本地匿名只有每小时 60 次，
  全量运行请务必带上 token。配额剩余 ≤5 时脚本会等到重置；重置时间超过 15 分钟时不再干等，
  相关仓库记为 `rate-limit` 跳过（下次更新重试），不会让单次运行无限挂起。
- `--repos` / `--limit` 属于子集模式：不清理 `releases/` 里的其它文件，`index.json` 只含本次处理的条目，
  不要拿子集产物覆盖正式数据。
- 数据是公开信息，但不保证实时：release 与 tag 元数据以每天一次的抓取为准。
