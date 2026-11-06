# mindustry-data-index

Mindustry 生态里「可自动化产生」的公共数据索引，由 GitHub Actions 定时抓取并自动提交，
供启动器/网站直接读 raw 文件，避免运行时直连 GitHub API（匿名限流、慢、看不到完整历史）。

当前包含三类数据：

| 数据集 | 产物 | 用途 | 更新频率 |
| --- | --- | --- | --- |
| 模组索引 | `index.json`、`releases/<owner>_<repo>.json` | 官方模组列表里每个模组的全部 release、预发布标识、逐 tag 的 `version`/`minGameVersion`、下载链接 | 每天一次 |
| 游戏版本列表 | `mindustry/versions.json` | 官方 Mindustry 全部正式版 + 最新 BE，字段与启动器 `remote/mindustry_versions.json` 快照兼容 | 约每 30 分钟一次 |
| 最小版本门禁 | `mindustry/mod-gate.json` | 每个游戏版本要求的最低模组版本（脚本模组 / Java 模组），与启动器 `remote/mmgvm.hjson` 同语义 | 约每 30 分钟一次 |

## 数据源

| 数据 | 地址 |
| --- | --- |
| 模组名单 | `https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json` |
| 模组 release 列表 | `https://api.github.com/repos/<owner>/<repo>/releases`（分页取全，含 prerelease/draft 标记） |
| 每个 tag 的模组元数据 | `https://raw.githubusercontent.com/<owner>/<repo>/<tag>/mod.hjson`（候选 `mod.json`、`assets/mod.hjson`、`assets/mod.json`） |
| 模组图标地址 | `https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/<owner>_<repo>`（只记录地址，不下载图标字节） |
| 游戏正式版列表 | `https://api.github.com/repos/Anuken/Mindustry/releases`（分页取全，当前约 200 条） |
| 最新 BE | `https://api.github.com/repos/Anuken/MindustryBuilds/releases?per_page=1` |
| 游戏源码门禁常量 | `https://raw.githubusercontent.com/Anuken/Mindustry/<tag>/core/src/mindustry/Vars.java`（候选路径 + tree API 兜底） |
| 门禁基线（147 之前） | `https://raw.githubusercontent.com/MDTCopper/launcher/main/remote/mmgvm.hjson` |

## 产物与 raw 地址

```
index.json                      # 全量模组索引（官方列表顺序，含下载量/体积统计）
releases/<owner>_<repo>.json    # 单个模组的全部 release + 逐 tag 元数据（只存数据）
summary.json                    # 下载量/体积总表（含全局合计，按下载量降序）
summary.csv                     # 同一份总表的 CSV（UTF-8 BOM，Excel 直接打开）
state/refresh.json              # 分页调度缓存（各模组第 1 页 ETag + 深层页最近抓取时间）
mindustry/versions.json         # Mindustry 可用版本列表（正式版 + 最新 BE）
mindustry/mod-gate.json         # 逐版本最小模组版本门禁 + 合并后的 rules
mindustry/heartbeat.json        # 每日心跳，仅用于保持仓库活跃（见下）
```

`releases/` 文件名把 repo 里的 `/` 换成 `_` 并保留大小写（如 `releases/Anuken_ExampleMod.json`）。
产物可直接按 raw 地址读取，例如：

- `https://raw.githubusercontent.com/<你的账号>/mindustry-data-index/main/index.json`
- `https://raw.githubusercontent.com/<你的账号>/mindustry-data-index/main/summary.json`
- `https://raw.githubusercontent.com/<你的账号>/mindustry-data-index/main/summary.csv`
- `https://raw.githubusercontent.com/<你的账号>/mindustry-data-index/main/releases/Anuken_ExampleMod.json`
- `https://raw.githubusercontent.com/<你的账号>/mindustry-data-index/main/mindustry/versions.json`
- `https://raw.githubusercontent.com/<你的账号>/mindustry-data-index/main/mindustry/mod-gate.json`

字段摘要（完整字段表见 [docs/schema.md](docs/schema.md)）：

- `index.json`：官方列表字段（`repo`、`internalName`、`name`、`author`、`version`、`minGameVersion`、
  `lastUpdated`、`stars`、`hasIcon`、`hasScripts`、`hasJava`，原样保留类型与脏值）加上
  `iconUrl`、`iconHash`、`releasesPath`、`releaseCount`、`latestRelease`、`releaseDataUpdatedAt`，
  以及下载量/体积统计：`totalDownloads`（历史累计，按首选资产）、`allAssetsDownloads`（全部资产）、
  `latestDownloads`、`latestSizeBytes`、`totalSizeBytes`；`latestRelease` 里也带 `downloads`/`sizeBytes`。
  `skipped` 记录本次抓取失败的仓库。`iconUrl` 与启动器 `githubModIconBase` 一致
  （`icons/<owner>_<repo>`，`hasIcon === false` 时为 `null`），`iconHash` 原样保留官方值供客户端做缓存。
- `releases/*.json`：每条 release 有 `tag`、`name`、`prerelease`、`publishedAt`、`htmlUrl`、
  `modVersion`、`minGameVersion`、`metadataPath`、`metadataStatus`、`downloadUrl`、
  `sourceArchiveUrl`、`assets`。**首选资产口径与 `downloadUrl` 一致**：`hasJava` 取体积最大的 `.jar`，
  否则取体积最大的 `.zip`；没有对应资产时下载量按 0、体积为 `null`（`downloadUrl` 仍回落源码归档，
  启动器对「Java 模组没有 jar」是禁用下载、不给按钮）。
- `summary.json`：`totals`（`mods`/`releases`/`downloads`/`sizeBytes` 全局合计）+ `mods[]`
  （`repo`、`name`、`author`、`stars`、`releaseCount`、5 个统计字段、`latestTag`/`latestPrerelease`/
  `latestModVersion`/`latestMinGameVersion`、`iconUrl`），按 `totalDownloads` 降序（并列按 `stars`
  降序、`repo` 升序）；无 release / 无资产的模组也保留，数值为 0 或 `null`。
- `summary.csv`：与 `summary.json` 同列（不含 `totals`），UTF-8 **带 BOM**、CRLF 换行，逗号/引号/换行
  按 CSV 规则转义，可直接用 Excel 打开。
- `state/refresh.json`：只给增量调度用（`page1Etag` + `page1FetchedAt` + 深层页抓取时间），
  使用方不需要读取；它只在 ETag / 抓取时间变化时更新，每天是一次小 diff。
- `mindustry/versions.json`：`update_time`、`source`、`releases[]`（`name`/`tag_name`/`published_at`/
  `body`（空串）/`reactions.total_count`/`assets[]`）、`latest_be`（没有 `reactions` 键）、
  `etags`（增量缓存，使用方可忽略）。启动器 `MindustryReleaseListSnapshot.parse` 直接可读。
- `mindustry/mod-gate.json`：`rules[]`（`min` 含、`max` 不含，最后一条 `max` 为 `null`，与
  `remote/mmgvm.hjson` 同义）、`versions[]`（每个正式版标签的 `mod`/`java` 值与来源
  `game-source`/`baseline`）、`source.resolvedPaths`（实际读到的源码路径，便于追踪位置变化）。

## 和官方 mods.json / 启动器快照的关系

- **官方 `mods.json`**：谁能在游戏内下载（当前约 991 个模组的权威名单，数量会随时间变化），
  每个模组只有当前版本信息。本仓库只覆盖官方列表里的模组，不新增、不删减，补充历史 release 与逐 tag 元数据。
- **启动器 `remote/mindustry_versions.json`**：历史版本快照。本仓库的 `mindustry/versions.json`
  用同一套精简字段，可直接被 `MindustryReleaseListSnapshot.parse` 读取；额外多一个 `latest_be`
  与仅供增量用的 `etags`。
- **启动器 `remote/mmgvm.hjson`**：模组版本门禁基线。`mindustry/mod-gate.json` 的 `rules` 与它完全同义
  （生成结果的 rules 与当前 mmgvm 逐项一致），区别是门禁值优先从各版本官方源码提取（147 起源码里有
  `minModGameVersion`/`minJavaModGameVersion`），源码没有常量的老版本才回落到 mmgvm 基线。

## 更新节奏

- `.github/workflows/update-mods.yml`：每天 02:23 UTC 一次 + `workflow_dispatch` + `push`（仅脚本/依赖/
  自身 workflow 变化时），更新模组索引。
- `.github/workflows/update-mindustry.yml`：约每 30 分钟一次（cron `7,37 * * * *`，即每小时 :07 / :37，
  避开整点高峰）+ `workflow_dispatch` + `push`，更新版本列表与门禁。GitHub 的 `schedule` 可能延迟几分钟
  到十几分钟，整点高负载时甚至会被丢弃，所以不要把频率理解成严格定时。
- 两个工作流共用一个 concurrency 组（`data-update`），不会同时提交；有实质变化才 commit + push
  （`index.json` / per-mod 文件 / versions / gate 都只比较数据主体，未变化不重写）。
- **Actions 权限**：`update-*` 工作流里声明了 `permissions: contents: write`。如果仓库的
  Settings → Actions → General → Workflow permissions 选的是只读（Read repository contents），
  声明会被降级、push 会失败；需要改成「Read and write permissions」或给 Workflow 单独授权。
- **每日心跳**：GitHub 在仓库 60 天没有任何提交时会暂停 `schedule`。版本/门禁数据可能长期无变化，
  所以 `update-mindustry.yml` 在没有数据变化、且 `mindustry/heartbeat.json` 里的日期不是今天时，
  会更新心跳并提交一次（最多每天 1 次）；有数据变化时顺带刷新心跳。心跳文件损坏 / 读不到
  `lastCheck` 时用文件 mtime 的日期兜底，避免变成每 30 分钟提交一次。模组索引每天基本都有变化，
  两个工作流合起来足够让仓库保持活跃。

## 本地运行

```bash
npm ci
npm test                              # 离线单元测试
npm run validate -- --dir .           # 校验产物
node src/main.js --datasets mods --out .                 # 全量更新模组索引（需要 GITHUB_TOKEN）
node src/main.js --datasets versions,gate --out .        # 更新版本列表与门禁
```

本地验证建议：

```bash
# 模组索引只跑官方列表里的少数仓库
node src/main.js --out tmp/live --repos "annguyen2k8/mindustrypackloader,cardillan/mlogassertions" \
  --threads 2 --raw-threads 2 --verbose

# 版本列表只抓第一页（省 API 配额），门禁用本地启动器快照当输入（只走 raw）
node src/main.js --out tmp/versions --datasets versions --versions-pages 1 --verbose
node src/main.js --out tmp/gate --datasets gate \
  --versions-file "C:/Users/ASUS/Desktop/copper_launcher/remote/mindustry_versions.json" --verbose
```

参数（`--help` 可看完整说明）：

| 参数 | 说明 |
| --- | --- |
| `--datasets <列表>` | 要更新的数据集，逗号分隔：`mods,versions,gate`，默认 `mods` |
| `--out <目录>` | 产物目录，默认 `.` |
| `--token <token>` | GitHub token，默认读环境变量 `GITHUB_TOKEN` |
| `--repos a/b,c/d` | 只跑指定仓库（仅 `mods`，本地验证） |
| `--limit <n>` | 最多处理 n 个模组（仅 `mods`） |
| `--threads <n>` | 同时处理的仓库数，默认 8 |
| `--raw-threads <n>` | raw.githubusercontent 并发数，默认 16 |
| `--versions-pages <n>` | 只抓版本列表前 n 页（仅本地验证，正式运行不要用） |
| `--versions-file <路径>` | 门禁用本地版本快照当输入（仅 `gate`） |
| `--no-cache` | 忽略旧产物与 `state/refresh.json`，全量重抓（所有页都抓、不复用旧元数据） |
| `--keep-missing-files` | 不删除官方列表中已消失模组的 `releases/*.json` |
| `--dry-run` | 只抓取与计算，不写文件 |
| `--verbose` | 输出增量细节（304、新抓/复用元数据、请求统计） |

## 按 tag 新旧分档刷新

GitHub releases API 每页最多 100 条、按新→旧返回。越老的 tag 下载频率越低，但 `downloadCount` 仍会缓慢
变化（体积与元数据不会变），所以按页分档刷新，用更少的请求覆盖全部历史：

| 页 | 覆盖的 release | 刷新周期 |
| --- | --- | --- |
| 第 1 页 | 最近 100 条 | 每天 |
| 第 2 页 | 101–200 条 | 每 7 天 |
| 第 3 页 | 201–300 条 | 每 30 天 |
| 第 4 页起 | 301 条以后 | 每 90 天（3 个月全量覆盖一轮） |

- 分档参数集中在 `src/refresh-state.js` 的 `REFRESH_TIERS`，便于以后调整。
- 每轮只抓「到期的页」：第 1 页带 `If-None-Match` 条件请求，304 就只更新调度时间；深层页到期才抓。
  抓到的页按 tag 合并覆盖缓存（下载量随之更新），没抓的旧条目原样保留、元数据不重抓，合并后按
  `publishedAt` 降序（同时间按 tag 升序）。
- **缓存与数据分离**：per-mod 文件只存 `releases` 数据，只有数据真的变化才重写；ETag 与各页抓取时间
  存在 `state/refresh.json`。这样即使 GitHub 的 ETag 天天变，也不会把 991 个 release 文件全部重写，
  每天最多产生一次很小的 `state/refresh.json` diff。
- 首次运行无缓存 / `--no-cache` 时全量抓所有页；单页抓取失败保留该页旧数据、该模组记入 `index.skipped`，
  不影响其它模组，退出码仍为 0。

## 增量机制

- **模组索引**：按上面的分档刷新读 releases；只有抓到的页里出现旧文件没有的 tag、或旧条目
  `metadataStatus != ok` 时，才去读这些 tag 的 `mod.hjson`。per-mod 文件、`index.json`、`summary.json`、
  `summary.csv` 都只在数据主体变化时重写（`generatedAt` 只在内容变化时更新）。
- **统计与总表**：每轮都基于合并后的完整 releases 重新算下载量/体积；数值没变就不重写总表。
- **版本列表**：正式版第一页与 BE 各带旧 ETag；304 就复用旧数据。第一页 200 且里面全是已知 release 时
  只把第一页与本地其余合并（不翻后面页）；只有出现未知 release id（或本地还没有列表）才翻页重建完整列表
  （当前约 3 页）。`releases`/`latest_be` 没变时不重写文件（`update_time` 只在内容变化时更新）。
- **门禁**：上一份 `mod-gate.json` 里 `source=game-source` 的版本不重复抓源码，只有新版本才扫描
  （候选路径全 404 且上一个版本有常量时，才额外用 1 次 tree API 找移动后的文件）。`rules`/`versions`/`source`
  没变时不重写文件。
- 单个模组抓取失败不终止整体：保留旧产物、记入 `index.skipped`、退出码仍为 0；官方列表拉取失败退出码 1。
  `versions` 的正式版列表拉取失败退出码 1；BE 拉取失败只警告并沿用旧值。

## 限制

- 只覆盖官方模组列表内的模组；列表里被移除的模组，其 `releases/*.json` 会在下次全量运行中删除。
- **tag ≠ release**：只收录 GitHub 上有 release 的 tag，仓库里没有建 release 的 tag 不会出现。
  官方列表里有不少模组 0 tag / 0 release，这类模组照样有 per-mod 文件（`releases: []`、`releaseCount: 0`）。
- **特殊 tag**：取 raw 元数据时优先对整个 tag 做 URL 编码（CJK、`+`、含 `/` 的 tag 实测可取），
  失败再回退原样 tag 与 `refs/tags/<tag>` 形态。
- `mod.hjson` 取不到时 `modVersion` / `minGameVersion` 为 `null`，`metadataStatus` 说明原因。
- 门禁只覆盖 `v<数字>[.<数字>]` 形态的正式版；147 之前源码里没有 `minModGameVersion` /
  `minJavaModGameVersion`，这些版本的门禁值来自启动器 mmgvm 基线。门禁值以官方源码为准，源码位置变化时
  靠候选路径与 tree 兜底，仍找不到则回落到基线。
- 受 GitHub API 限流约束：Actions 里用 `GITHUB_TOKEN`（每小时 5000 次）；本地匿名只有每小时 60 次，
  全量跑模组索引务必带上 token。配额剩余 ≤5 时脚本会等到重置，重置时间超过 15 分钟时相关仓库记为
  `rate-limit` 跳过（下次重试）。
- `--repos` / `--limit` / `--versions-pages` / `--versions-file` 属于本地验证模式，不要拿子集产物覆盖正式数据。
- 数据是公开信息，但受抓取节奏限制不保证实时：模组索引每天一次，版本/门禁约每 30 分钟一次。
