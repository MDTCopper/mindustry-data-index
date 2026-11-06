# mindustry-data-index

Mindustry 生态里「可自动化产生」的公共数据索引，由 GitHub Actions 定时抓取并自动提交，
供启动器/网站直接读 raw 文件，避免运行时直连 GitHub API（匿名限流、慢、看不到完整历史）。

当前包含四类数据：

| 数据集 | 产物 | 用途 | 更新频率 |
| --- | --- | --- | --- |
| 模组索引（官方） | `index.json`、`releases/<owner>/<repo>.json`、`summary.json/csv` | 官方模组列表里每个模组的全部 git tag、预发布标识、逐 tag 的 `version`/`minGameVersion`、下载链接、下载量/体积 | 最新 100 tag 每 2 小时；第 2 页每周；全量每月 |
| 模组索引（社区） | `community/index.json`、`community/releases/<owner>/<repo>.json`、`community/summary.json/csv` | GitHub `mindustry-mod` topic 扫描到的、不在官方列表里的社区模组（结构同官方，条目带 `source:"topic"`） | 同官方分档；发现/黑名单每天同步 |
| 游戏版本列表 | `mindustry/versions.json` | 官方 Mindustry 全部正式版 + 最新 BE，字段与启动器 `remote/mindustry_versions.json` 快照兼容 | 约每 30 分钟一次 |
| 最小版本门禁 | `mindustry/mod-gate.json`、`mindustry/java-gate.json` | 普通/脚本模组与 Java 模组**分开**的最低模组版本门禁，语义来自 mmgvm | 约每 30 分钟一次 |

## 数据源

| 数据 | 地址 |
| --- | --- |
| 模组名单（官方） | `https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json` |
| 社区模组发现 | GitHub 搜索 API：`mindustry-mod in:topics archived:false template:false pushed:2022-05-01..<end>`（按时间窗分区取全） |
| Anuken 黑名单源 | `https://raw.githubusercontent.com/Anuken/MindustryMods/master/src/modupdater/ModUpdater.java` |
| 模组 release 列表 | `https://api.github.com/repos/<owner>/<repo>/releases`（分页取全，含 prerelease/draft 标记） |
| 模组全部 git tag | `https://api.github.com/repos/<owner>/<repo>/tags`（分页取全；用于补全没有建 Release 的 tag） |
| 每个 tag 的模组元数据 | `https://raw.githubusercontent.com/<owner>/<repo>/<tag>/mod.hjson`（候选 `mod.json`、`assets/mod.hjson`、`assets/mod.json`） |
| 社区仓库元数据/图标 | 默认分支的 `mod.json`/`mod.hjson`（root 或 assets/）与 `icon.png`/`assets/icon.png` |
| 模组图标地址（官方） | `https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/<owner>_<repo>`（只记录地址，不下载图标字节） |
| 游戏正式版列表 | `https://api.github.com/repos/Anuken/Mindustry/releases`（分页取全，当前约 200 条） |
| 最新 BE | `https://api.github.com/repos/Anuken/MindustryBuilds/releases?per_page=1` |
| 游戏源码门禁常量 | `https://raw.githubusercontent.com/Anuken/Mindustry/<tag>/core/src/mindustry/Vars.java`（候选路径 + tree API 兜底） |
| 门禁基线（147 之前） | `https://raw.githubusercontent.com/MDTCopper/launcher/main/remote/mmgvm.hjson` |

## 产物与 raw 地址

```
index.json                              # 全量官方模组索引（官方列表顺序，含下载量/体积/ tag 数统计）
releases/<owner>/<repo>.json            # 官方模组的全部 git tag（有 Release 的 + tag-only）+ 逐 tag 元数据
summary.json / summary.csv              # 官方下载量/体积总表
community/index.json                    # 社区模组索引（结构同官方，条目 source:"topic"）
community/releases/<owner>/<repo>.json  # 社区模组 per-mod 数据（与官方完全同构）
community/summary.json / .csv           # 社区总表（同官方结构）
state/refresh.json                      # 官方调度缓存（第 1/2 页/全量/ tag 列表最近抓取时间）
state/community-refresh.json            # 社区调度缓存（与官方同结构、独立）
state/blacklist.json                    # Anuken 黑名单同步缓存（含源码 hash / fetchedAt）
mindustry/versions.json                 # Mindustry 可用版本列表（正式版 + 最新 BE）
mindustry/mod-gate.json                 # 普通/脚本模组门禁（rules + 逐版本 value）
mindustry/java-gate.json                # Java 模组门禁（rules + 逐版本 value）
mindustry/heartbeat.json                # 每日心跳，仅用于保持仓库活跃（见下）
status.json                             # 每次运行后的健康状态（各数据集/API/validate 摘要）
changes.json                            # 滚动变更流（最近 500 条 mod/release/tag 变化）
heat/index.json                         # 热度表（官方+社区全量：多窗口指标/组件/倍率/惩罚/score/rank）
heat/summary.csv                        # 热度表扁平 CSV（UTF-8 BOM）
heat/history/{daily,weekly,monthly}/    # 下载/星标历史快照（daily 保留 7、weekly/monthly 各 6）
state/heat-commit-stats.json            # participation 52 周提交统计缓存（每周刷新）
state/repo-created.json                 # 仓库 created_at 永久缓存（新 mod 年龄用）
schema/*.json                           # 各数据文件的 JSON Schema（draft 2020-12，见 docs/schema.md）
```

per-mod 文件当前 `formatVersion` 为 **2**（schemaVersion）：v1 缺少 `compat`/`meta`/`commitSha`
等字段；运行时读到 v1 会用缓存数据本地重算并写回（不额外发 API），也可以先跑一次
`node src/main.js --migrate --out .` 一次性迁移全部旧文件。

per-mod 文件按 repo 的 `owner/name` 分目录，owner 与 name 原大小写保留（如
`releases/Anuken/ExampleMod.json`、`releases/mindustrytool/mindustrytoolmod.json`）。
旧版本的 flat 路径 `releases/<owner>_<repo>.json` 已废弃：运行时会优先读新路径，新路径不存在时
读旧 flat 文件当缓存（数据、`generatedAt`、分页 state 都沿用），**本轮把内容写到新路径后删除旧文件**，
不会触发重新抓取；迁移完成后 `releases/` 下只保留新结构。
产物可直接按 raw 地址读取，例如：

- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/index.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/summary.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/summary.csv`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/releases/Anuken/ExampleMod.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/mindustry/versions.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/mindustry/mod-gate.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/mindustry/java-gate.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/community/index.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/community/summary.csv`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/community/releases/Slava0135/reFine.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/status.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/changes.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/schema/index.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/heat/index.json`
- `https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/heat/summary.csv`

字段摘要（完整字段表见 [docs/schema.md](docs/schema.md)）：

- `index.json`：官方列表字段（`repo`、`internalName`、`name`、`author`、`version`、`minGameVersion`、
  `lastUpdated`、`stars`、`hasIcon`、`hasScripts`、`hasJava`，原样保留类型与脏值）加上
  `iconUrl`、`iconHash`、`releasesPath`、`releaseCount`（有 GitHub Release 的 tag 数）、`tagCount`
  （全部 git tag 数，含已删除留档）、`removedCount`（作者已删除的 tag 数）、`latestRelease`、
  `latestCompatible`（当前最新游戏版本下推荐的 tag，没有则为 `null`）、`compatRanges`（兼容区间段数）、
  `releaseDataUpdatedAt`，
  以及下载量/体积统计：`totalDownloads`（历史累计，按首选资产）、`allAssetsDownloads`（全部资产）、
  `latestDownloads`、`latestSizeBytes`、`totalSizeBytes`；`latestRelease` 是「最新的有 Release 且未被删除的条目」，
  并带 `downloads`/`sizeBytes`。`skipped` 记录本次抓取失败的仓库。`iconUrl` 与启动器
  `githubModIconBase` 一致（`icons/<owner>_<repo>`，`hasIcon === false` 时为 `null`），
  `iconHash` 原样保留官方值供客户端做缓存。
- `releases/<owner>/<repo>.json`：收录该仓库的**全部 git tag**。每条有 `tag`、`name`、`hasRelease`、
  `prerelease`、`publishedAt`、`htmlUrl`、`modVersion`、`minGameVersion`、`metadataPath`、
  `metadataStatus`、`downloadUrl`、`sourceArchiveUrl`、`assets`、`commitSha`、`archiveByCommitUrl`，
  以及删除留档字段 `removed`/`removedAt`（可选，仅被作者删除的条目出现）。
  - `hasRelease === true`：GitHub Release 条目，`prerelease`/`publishedAt` 来自 Release，资产按 release
    接口取；`downloadUrl` 用首选资产（`hasJava` 取体积最大的 `.jar`，否则 `.zip`），没有对应资产回落源码归档。
    启动器对「Java 模组没有 jar」是禁用下载、不给按钮。
  - `hasRelease === false`：只有 git tag、没有建 Release，此时 `prerelease`/`publishedAt` 为 `null`
    （无法判定），`assets` 为空，`downloadUrl` 就是源码归档地址，`htmlUrl` 指向 `tree/<tag>`。
    元数据（`modVersion`/`minGameVersion`）仍按 tag 抓取，抓不到为 `null`。
  - 排序：有 Release 的条目在前（`publishedAt` 降序、同时间 tag 升序），tag-only 条目在后
    （tag 名称自然降序，如 `v1.10` 在 `v1.9` 前）。
  - **首选资产口径**：与 `downloadUrl` 一致；没有对应资产时下载量按 0、体积为 `null`。
  - **tag 被作者删除**：条目不删，标 `removed: true` + `removedAt`（UTC ISO），`index.json` 的
    `removedCount` 记录数量，`tagCount` 仍是条目总数。只在「全量 tags / releases 刷新」（每月一次或
    `--no-cache`）时做缺失判定；只刷第 1/2 页时不能判定远处条目被删，绝不误标。上游重新出现的 tag
    会清掉 `removed`。每条同时记录 `commitSha`（tags API 的 `commit.sha`）与
    `archiveByCommitUrl = https://github.com/<repo>/archive/<sha>.zip`：tag 删除后只要 commit 未被
    GitHub GC，仍可 best-effort 下载源码归档；拿不到 sha 时为 `null`。
  - **`compat`（游戏版本 → 推荐 tag）**：按发布时间的从新到旧，为每个有 `minGameVersion` 的条目计算
    `gameVersion ∈ [minGameVersion, maxGameVersion)` 时推荐该 tag；上界取「该模组类型门禁值第一次超过
    该条目的 `minGameVersion` 的游戏版本」（普通/脚本读 `mod-gate.json`，Java 读 `java-gate.json`），
    且不盖过更新条目的最小版本；`maxGameVersion: null` 表示无上界。推荐优先 `hasRelease: true`；
    tag-only 只填补 release 未覆盖的区间（`hasRelease: false`，下载走归档）。没有 release /
    `minGameVersion` 的模组为 `[]`。相邻区间不重叠，若某个游戏版本没有任何兼容 release，允许出现空档。
- `summary.json`：`totals`（`mods`/`releases`/`downloads`/`sizeBytes` 全局合计，`releases` 只统计有 Release
  的条目）+ `mods[]`（`repo`、`name`、`author`、`stars`、`releaseCount`、`tagCount`、5 个统计字段、
  `latestTag`/`latestPrerelease`/`latestModVersion`/`latestMinGameVersion`、`iconUrl`、`releasesPath`），
  按 `totalDownloads` 降序（并列按 `stars` 降序、`repo` 升序）；下载量/体积只按 Release 资产算，
  tag-only 条目不受影响（0/null）；无 Release / 无资产的模组也保留。
- `summary.csv`：与 `summary.json` 同列（不含 `totals`；`tagCount` 紧跟 `releaseCount`，
  `releasesPath` 为最后一列），UTF-8 **带 BOM**、CRLF 换行，逗号/引号/换行按 CSV 规则转义，可直接用 Excel 打开。
- `state/refresh.json`：只给增量调度用（`page1Etag` + `page1FetchedAt`（2h）/ `page2FetchedAt`（7d）/
  `fullFetchedAt`（30d）/ `tagsFetchedAt`），使用方不需要读取；它只在 ETag / 抓取时间变化时更新，每天是一次小 diff。
- `mindustry/versions.json`：`update_time`、`source`、`releases[]`（`name`/`tag_name`/`published_at`/
  `body`（空串）/`reactions.total_count`/`assets[]`）、`latest_be`（没有 `reactions` 键）、
  `etags`（增量缓存，使用方可忽略）。启动器 `MindustryReleaseListSnapshot.parse` 直接可读。
- `mindustry/mod-gate.json`（普通/脚本模组）与 `mindustry/java-gate.json`（Java 模组）：两份独立文件，
  字段相同：`gate`（`"mod"` / `"java"`）、`source.constants`（各自只含 `minModGameVersion` /
  `minJavaModGameVersion`）、`rules[]`（`min` 含、`max` 不含，最后一条 `max` 为 `null`，`value` 是该范围
  要求的最低模组主版本）、`versions[]`（每个正式版标签的 `value` 与来源 `game-source`/`baseline`）。
  启动器接入时按模组类型分别读对应文件，不要混用两列。

## 和官方 mods.json / 启动器快照的关系

- **官方 `mods.json`**：谁能在游戏内下载（当前约 992 个模组的权威名单，数量会随时间变化），
  每个模组只有当前版本信息。本仓库只覆盖官方列表里的模组，不新增、不删减，补充历史 release 与逐 tag 元数据。
- **启动器 `remote/mindustry_versions.json`**：历史版本快照。本仓库的 `mindustry/versions.json`
  用同一套精简字段，可直接被 `MindustryReleaseListSnapshot.parse` 读取；额外多一个 `latest_be`
  与仅供增量用的 `etags`。
- **启动器 `remote/mmgvm.hjson`**：模组版本门禁基线。`mindustry/mod-gate.json` / `java-gate.json` 的
  `rules` 分别与 mmgvm 的 `mod` / `java` 字段同义（生成结果逐项一致），区别是门禁值优先从各版本官方源码
  提取（147 起源码里有 `minModGameVersion`/`minJavaModGameVersion`），源码没有常量的老版本才回落到基线。
  两种类型的门禁是分开的：普通/脚本模组读 `mod-gate.json`，Java 模组读 `java-gate.json`。

## 社区模组（topic 扫描）

官方 `mods.json` 之外的社区模组用 GitHub topic 扫描发现，产物放在 `community/`，结构与官方完全同构
（`community/index.json` + `community/releases/<owner>/<repo>.json` + `community/summary.json/csv`，
条目额外带 `source:"topic"`，`releasesPath` 为 `community/releases/...`）：

- **发现查询**：`mindustry-mod in:topics archived:false template:false pushed:2022-05-01..<end>`，
  `sort=updated`、`per_page=100`；搜索 API 单查询最多 1000 条，脚本先看 `total_count`，
  超过 1000 就把 pushed 时间窗继续二分（从 2022-05 起按半年预切），分页取全后按 `full_name` 小写去重。
- **Anuken 黑名单同步**：每天抓一次
  `Anuken/MindustryMods/src/modupdater/ModUpdater.java`，用正则抽取
  `nameBlacklist`（full_name 前缀、忽略大小写）、`blacklist`（repo 精确、忽略大小写）、
  `globalBlacklist`（Base64 解码后的正则，作用于 mod 名称/描述）；解析结果缓存到
  `state/blacklist.json`（含源码 hash + fetchedAt）。源码格式变化/拉取失败时沿用缓存并 warning，不阻断运行。
- **收录标准**（与 Anuken 一致）：不在官方 `mods.json`；非 archived / 非 template；
  默认分支 root 或 `assets/` 有可解析的 `mod.json`/`mod.hjson`；`minGameVersion >= 136`；
  `hideBrowser: true` 排除；命中任意黑名单排除。
- **条目字段**：`name`/`author`/`version`/`minGameVersion`/`description` 取仓库 mod 元数据；
  `stars`/`lastUpdated` 取搜索结果的 star 数与 updated_at；`hasJava`/`hasScripts` 用元数据近似
  （有 `main` 且无 `scripts` 记 Java，有 `scripts` 记脚本）；`iconUrl` 仅在默认分支
  `icon.png` 或 `assets/icon.png` 实际命中（raw 200）时给出，否则 `null`。
- **刷新**：与官方同分档（最新 100 tag 每 2 小时、第 2 页每周、每月全量），使用独立的
  `state/community-refresh.json`；官方先跑、社区后跑共享 API 配额，不足时同样优雅停止并在下次续跑。
- 工作流 `update-mods.yml` 跑 `--datasets mods,community`，提交 `community/`、`state/community-refresh.json`
  与 `state/blacklist.json`。本地验证可用
  `--community-limit` / `--community-search-windows` / `--community-max-candidates` 控制规模（搜索配额很小）。

## 健康状态 / 变更流 / JSON Schema

- **`status.json`**：每次运行后都会更新（运行日志性质，即使数据没变也写）。包含
  `datasets.{official,community,versions,gate}` 的 `updatedAt`/`modCount`/`releaseCount`/`skipped[]`、
  本次运行的 `api.{requests,remaining,resetAt}`、以及 `validate.{errors,warnings,presentFiles}` 摘要。
  只运行部分数据集时，其它数据集沿用上一份 status。
- **`changes.json`**：滚动变更流，新变更在前，最多 500 条；记录
  `mod-added`/`mod-updated`（`mod-updated` 只在 name/version/minGameVersion/latestRelease tag 等关键字段变化时记，stars 不记）、
  `release-added`/`tag-removed`/`release-removed`（官方与社区都记）。首次建立时只写初始快照
  （批量 `mod-added`，由 500 条上限截断）。
- **`schema/*.json`**：`index.json`、`releases/*.json`、`community/index.json`、`community/releases/*.json`、
  两份 summary、`mindustry/versions.json`、两份 gate、`state/*.json`、`status.json`、`changes.json`
  的 JSON Schema（draft 2020-12），见 [schema/](schema/)。字段细节见 [docs/schema.md](docs/schema.md)；
  测试会校验 schema 是合法 JSON 且关键 required 字段齐全。

## 元数据补全与纯文本字段

- 官方 index 条目透传 `iosCompatible`/`legacyCompatible`；per-mod 文件新增 `meta`（取最新 tag 的
  `mod.json`/`mod.hjson`）：`{dependencies, hidden, legacyCompatible, main, hasScripts, hasJava}`，
  拿不到元数据时为 `null`。**`hasJava`/`hasScripts` 校正规则**：`meta.main` 存在且没有 `scripts` →
  `hasJava: true`，有 `scripts` → `hasScripts: true`；拿不到 meta 时保持官方列表原值。
- index（官方+社区）每条新增 `namePlain`/`authorPlain`/`descriptionPlain`：去掉 Mindustry 富文本颜色标记
  （`[red]`、`[#00ff00]`、`[]` 等）、换行与多余空白；普通英文方括号（如 `[Mod]`）不会被误删。
  `summary.json/csv` 增加 `namePlain` 列（紧跟 `name`）便于搜索。

## 热度表（heat/）

`heat/index.json` 对官方+社区**全量**模组计算热度（v2 公式），字段与算法：

- **存量分（总下载、总星标各一套）**：`share = value / Σ同指标`；`share < maxShare×1e-4` 直接记 0（小到可忽略）；
  `mag = sqrt(min(1, share/maxShare))`；`stockScore = 0.8×mag + 0.2×百分位(value)`。占比为主、sqrt 柔化，
  百分位只做少量修正（避免纯百分位让存量末端没有差距）。
- **变化分**：每个窗口（1d/7d/30d/180d）先 signed log1p 再跨全量百分位；**窗口全 0 时该窗口记 0**
  （不再白拿平均名次）。窗口权重：下载变化 `.45/.30/.20/.05`、星标变化 `.20/.45/.30/.05`；
  `下载量 = 0.6×存量分(下载) + 0.4×下载变化分`；`星标量 = 0.6×存量分(星标) + 0.4×星标变化分`。
- **更新量（递减收益）**：release 活动 = `Σ 7d0.15/30d0.35/90d0.25/180d0.25 × log1p(窗口 release 数)`，
  提交活动同理（participation 聚合到 7/30/90/180 天），各自按全量最大值归一化到 0~1；
  `更新量 = 0.7×release 活动 + 0.3×提交活动`。少量提交拿较多分，大量提交每个后续提交收益更小。
- `总分 = (下载量×0.40 + 星标量×0.50 + 更新量×0.10) × 新mod倍率 − 长期未更新惩罚×0.3`。
  **分数不裁剪**，可 >1 或 <0，输出保留 4 位小数；`rank` 按分数降序唯一排名（同分 repo 升序）。
- **新 mod 倍率**：180 天内 `1 + 0.325×exp(-age/30)`（30d≈1.12、60d≈1.04、90d≈1.016，之后 clamp 1）；
  年龄优先取 `created_at`（缓存 `state/repo-created.json`，一次抓取永久复用），拿不到用最早 release 时间。
- **非 Java 且没有 release 资产下载量**（`hasJava === false && totalDownloads === 0`，即 JSON/JS 走 main
  分支、没有可统计资产）的模组：下载项视为**缺失**而不是 0 分——移除下载 0.40 权重，剩余
  `(星标×0.5 + 更新×0.1) / 0.6` 按比例重归一，再乘倍率并扣惩罚；条目写 `downloadsMissing: true` 与
  `effectiveWeights {downloads:0, stars:0.8333, update:0.1667}`。Java 模组不受此规则影响（无下载数据仍按
  正常权重、下载 0 分）。下载原始字段与组件分保留，便于核对。
- **长期未更新惩罚**：超过 360 天未 release / 无提交各按 `1-exp(-overrun/180)` 饱和，按 `7:3` 合成（0~1），
  总分中再乘 `0.3` 扣减。
- **提交数**：`GET /repos/{repo}/stats/participation`（52 周），每周刷新一次缓存到
  `state/heat-commit-stats.json`（官方+社区约 1500 次/周；配额不足沿用旧缓存，下次续抓）；
  按周粒度近似聚合到 7/30/90/180 天窗口。
- `heat/index.json` 每条保留各窗口原始值，并新增 `stockShare`/`stockMag`/`stockScore`（下载/星标各一份）、
  `releaseActivityRaw`/`commitActivityRaw`、`releaseActivity`/`commitActivity`，便于核对公式。
- **历史快照**：`heat/history/daily/YYYY-MM-DD.json`、`weekly/YYYY-Www.json`、`monthly/YYYY-MM.json`，
  每份只存 `{formatVersion, generatedAt, mods:{repo:{stars,totalDownloads}}}`；保留 daily 7 / weekly 6 /
  monthly 6 份，超出删除。快照从上线后开始积累，1d 变化下一轮可用，7d/30d/180d 需等对应历史积累（缺失按 0）。
- 本地验证：`node src/main.js --datasets heat --out tmp/heat --heat-max-api 0`（完全离线，只用缓存与历史；
  用 `--heat-max-api 2` 可限制 API 次数）。

## 更新节奏

- `.github/workflows/update-mods.yml`：每 2 小时一次（cron `17 */2 * * *`）+ `workflow_dispatch` + `push`
  （仅脚本/依赖/自身 workflow 变化时），更新模组索引。刷新分档由 `state/refresh.json` 控制：
  **最新 100 tag（releases/tags 第 1 页）每 2 小时、第 2 页每周、全量（所有页）每月**。
  **API 配额不足时**（运行中剩余 ≤5 或遇到限流）：停止本次的新请求、保留已抓结果、正常退出（exit 0），
  日志会写「本次未处理 N 个，下次继续」；下次运行按「最近抓取时间升序」排队，优先补上次没跑到的模组，
  全量刷新也会按模组粒度分次续跑（每个模组完成才推进 `fullFetchedAt`）。
- `.github/workflows/update-mindustry.yml`：约每 30 分钟一次（cron `7,37 * * * *`，即每小时 :07 / :37，
  避开整点高峰）+ `workflow_dispatch` + `push`，更新版本列表与门禁。GitHub 的 `schedule` 可能延迟几分钟
  到十几分钟，整点高负载时甚至会被丢弃，所以不要把频率理解成严格定时。
- 两个工作流共用一个 concurrency 组（`data-update`），不会同时提交；有实质变化才 commit + push
  （`index.json` / per-mod 文件 / versions / 两份 gate / summary 都只比较数据主体，未变化不重写）。
- **Actions 权限**：`update-*` 工作流里声明了 `permissions: contents: write`。如果仓库的
  Settings → Actions → General → Workflow permissions 选的是只读（Read repository contents），
  声明会被降级、push 会失败；需要改成「Read and write permissions」或给 Workflow 单独授权。
- **每日心跳**：GitHub 在仓库 60 天没有任何提交时会暂停 `schedule`。版本/门禁数据可能长期无变化，
  所以 `update-mindustry.yml` 在没有数据变化、且 `mindustry/heartbeat.json` 里的日期不是今天时，
  会更新心跳并提交一次（最多每天 1 次）；有数据变化时顺带刷新心跳。心跳文件损坏 / 读不到
  `lastCheck` 时用文件 mtime 的日期兜底，避免变成每 30 分钟提交一次。模组索引每 2 小时基本都有变化，
  两个工作流合起来足够让仓库保持活跃。

## 本地运行

```bash
npm ci
npm test                              # 离线单元测试
npm run validate -- --dir .           # 校验产物
node src/main.js --datasets mods --out .                 # 全量更新模组索引（需要 GITHUB_TOKEN）
node src/main.js --datasets mods,community --out .       # 官方 + 社区（社区需要搜索配额）
node src/main.js --datasets versions,gate --out .        # 更新版本列表与门禁
node src/main.js --datasets heat --out .                  # 单独重算热度表
node src/main.js --migrate --out .                        # 本地 schemaVersion 1→2 迁移（0 API）
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

# 社区发现只搜第一个时间窗、最多探测 6 个候选、只处理 3 个（搜索匿名配额只有 10/min）
node src/main.js --out tmp/community --datasets community \
  --community-search-windows 1 --community-max-candidates 6 --community-limit 3 --verbose
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
| `--keep-missing-files` | 不删除官方列表中已消失模组的 `releases/<owner>/<repo>.json` |
| `--dry-run` | 只抓取与计算，不写文件 |
| `--verbose` | 输出增量细节（304、新抓/复用元数据、请求统计） |

## 刷新频率（2 小时 / 每周 / 每月全量）

GitHub releases / tags API 每页最多 100 条、按新→旧返回。越老的 tag 下载频率越低，但 `downloadCount` 仍会
缓慢变化（体积与元数据不会变），所以按页分档刷新，用更少的请求覆盖全部历史：

| 频率 | 覆盖范围 | 抓取内容 |
| --- | --- | --- |
| 每 2 小时 | 最新 100 个 tag | releases 第 1 页 + tags 第 1 页 |
| 每周 | 第 2 页（101–200） | releases 第 2 页 + tags 第 2 页 |
| 每月 | 全量 | 所有 releases 页 + 所有 tags 页 |

- 分档参数集中在 `src/refresh-state.js` 的 `REFRESH_TIERS`（`page1FetchedAt` / `page2FetchedAt` /
  `fullFetchedAt` / `tagsFetchedAt`），到期判断可注入当前时间测试。
- 每轮只抓「到期的页」：第 1 页带 `If-None-Match` 条件请求，304 就只更新调度时间；深层页到期才抓。
  抓到的页按 tag 合并覆盖缓存（下载量随之更新），没抓的旧条目原样保留、元数据不重抓，合并后按
  `publishedAt` 降序（同时间按 tag 升序）。
- **全部 git tag** 跟随同一分档：tags 第 1 页每 2 小时、第 2 页每周、第 3 页起每月；把没有 Release 的 tag
  补成 tag-only 条目。全量刷新时按完整 tag 列表重建 tag-only（删掉已不存在的 tag）。
- **缓存与数据分离**：per-mod 文件只存数据，只有数据真的变化才重写；ETag 与各 tier 的抓取时间存在
  `state/refresh.json`。即使 ETag 频繁变化，也不会把 991 个 release 文件全部重写。
- **API 不足时优雅续跑**：运行中剩余配额 ≤5 或遇到限流（`RateLimitError`）时，停止发起新的请求、
  保留已抓结果并正常退出（exit 0），日志写「本次未处理 N 个，下次继续」。下次运行按「最近抓取时间升序」
  排队，优先补上次没跑到的模组（也适用于每月全量：按模组粒度分次续跑，已完成的才推进 `fullFetchedAt`）。
- 首次运行无缓存 / `--no-cache` 时全量抓所有 releases 页与 tag 列表；单页/ tag 列表抓取失败保留旧数据、
  该模组记入 `index.skipped`，不影响其它模组，退出码仍为 0。

## 增量机制

- **模组索引**：按上面的分档刷新读 releases、抓全部 git tag；只有抓到的页/ tag 里出现旧文件
  没有的 tag、或旧条目 `metadataStatus != ok` 时，才去读这些 tag 的 `mod.hjson`。
  per-mod 文件、`index.json`、`summary.json`、`summary.csv` 都只在数据主体变化时重写
  （`generatedAt` 只在内容变化时更新）。
- **统计与总表**：每轮都基于合并后的完整 releases 重新算下载量/体积；数值没变就不重写总表。
- **版本列表**：正式版第一页与 BE 各带旧 ETag；304 就复用旧数据。第一页 200 且里面全是已知 release 时
  只把第一页与本地其余合并（不翻后面页）；只有出现未知 release id（或本地还没有列表）才翻页重建完整列表
  （当前约 3 页）。`releases`/`latest_be` 没变时不重写文件（`update_time` 只在内容变化时更新）。
- **门禁**：拆成 `mod-gate.json` 与 `java-gate.json` 两份。旧合并文件会自动迁移（读取旧版本里的
  `mod`/`java` 列作缓存）；`source=game-source` 的版本不重复抓源码，只有新版本才扫描
  （候选路径全 404 且上一个版本有常量时，才额外用 1 次 tree API 找移动后的文件）。两份文件各自比较
  `rules`/`versions`/`source`，没变时不重写。
- 单个模组抓取失败不终止整体：保留旧产物、记入 `index.skipped`、退出码仍为 0；官方列表拉取失败退出码 1。
  `versions` 的正式版列表拉取失败退出码 1；BE 拉取失败只警告并沿用旧值。

## 限制

- 只覆盖官方模组列表内的模组；列表里被移除的模组，其 `releases/<owner>/<repo>.json` 会在下次全量运行中删除。
- **路径迁移**：per-mod 文件已从 `releases/<owner>_<repo>.json` 改为 `releases/<owner>/<repo>.json`。
  首次运行会读取旧 flat 文件当缓存、写入新路径并删除旧文件（不重新抓取）；之后只走新路径，
  `validate` 若发现旧 flat 文件会给出「迁移未完成」警告。
- **全部 git tag**：收录仓库里的所有 git tag，而不只是建了 GitHub Release 的；没有 Release 的 tag 也
  会出现在数据里（`hasRelease: false`、`prerelease`/`publishedAt` 为 `null`、下载地址用源码归档）。
  例：`oscillatorium/alef-null` 有 15 个 git tag、其中 5 个建了 Release，会得到 15 条
  （5 条 `hasRelease=true` + 10 条 `false`）。tag-only 条目的 mod 元数据同样会尽量抓取，抓不到为 `null`。
  官方列表里有不少模组 0 tag / 0 release，这类模组照样有 per-mod 文件（`releases: []`、`tagCount: 0`）。
- **同一 tag 后来补建 Release**：以 Release 数据覆盖旧的 tag-only 条目（下载量/资产/时间随之补上）。
- **特殊 tag**：取 raw 元数据时优先对整个 tag 做 URL 编码（CJK、`+`、含 `/` 的 tag 实测可取），
  失败再回退原样 tag 与 `refs/tags/<tag>` 形态。
- `mod.hjson` 取不到时 `modVersion` / `minGameVersion` 为 `null`，`metadataStatus` 说明原因。
- 门禁只覆盖 `v<数字>[.<数字>]` 形态的正式版；147 之前源码里没有 `minModGameVersion` /
  `minJavaModGameVersion`，这些版本的门禁值来自启动器 mmgvm 基线。门禁值以官方源码为准，源码位置变化时
  靠候选路径与 tree 兜底，仍找不到则回落到基线。普通/脚本模组读 `mod-gate.json`，Java 模组读
  `java-gate.json`，两份的 `value` 不要混用。
- **社区模组**：只收录 topic 扫描发现且符合 Anuken 收录标准的仓库；需要 `mod.json`/`mod.hjson`
  可解析（否则排除）；`minGameVersion` 按数字前缀比较（需 ≥136）；`hasJava`/`hasScripts` 是近似值；
  图标只在 `icon.png`/`assets/icon.png` 实际存在时提供。搜索 API 有独立限流（带 token 30/min、
  匿名 10/min），发现阶段已节流；单查询 1000 条上限用 pushed 时间窗二分规避。黑名单每天同步一次，
  源格式变化时沿用旧缓存，最长可能滞后约 1 天。
- **删除留档 / compat 的时效**：删除判定只在每月全量刷新（或 `--no-cache`）时做，平时不误标；
  `commitSha` 兜底依赖 GitHub 尚未 GC 该 commit（best-effort，不是永久保证）；`compat` 由发布时的
  releases、门禁与版本列表预计算，门禁/游戏版本更新后要等下一次模组刷新（2h/周/月分档）才会重算。
- 受 GitHub API 限流约束：Actions 里用 `GITHUB_TOKEN`（每小时 5000 次）；本地匿名只有每小时 60 次，
  全量跑模组索引务必带上 token。配额剩余 ≤5 时本次运行会优雅停止（保留已抓结果、exit 0），下次按
  最久未刷新优先继续；单次运行内等待重置超过 15 分钟时相关仓库记为 `rate-limit` 跳过。
- `--repos` / `--limit` / `--community-*` / `--versions-*` 属于本地验证模式，不要拿子集产物覆盖正式数据。
- 数据是公开信息，但受抓取节奏限制不保证实时：模组最新 100 tag 每 2 小时、其余历史按周/月，版本/门禁约每 30 分钟一次。
