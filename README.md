# mindustry-data-index

Mindustry 生态的公共数据索引：由 GitHub Actions 定时抓取并自动提交，启动器/网站直接读 raw 文件，
不需要运行时直连 GitHub API。字段细节与完整示例见 [docs/schema.md](docs/schema.md)。

## 数据集

| 数据集 | 产物 | 更新 |
| --- | --- | --- |
| 官方模组索引 | `index.json`（默认）、`index-full.json`（全量）、`releases/<owner>/<repo>.json`、`summary.json/csv` | 最新 100 tag 每 2h；第 2 页每周；全量每月 |
| 社区模组索引 | `community/index.json`、`community/index-full.json`、`community/releases/...`、`community/summary.*` | 同官方；topic 发现/黑名单每天 |
| 游戏版本 | `mindustry/versions.json`、`mindustry/recommended-java.json` | 约 30 分钟 |
| 版本门禁 | `mindustry/mod-gate.json`、`mindustry/java-gate.json` | 约 30 分钟 |
| 设置适配 | `mindustry/setting-adapter/index.json`、`current.json`、`changes.json` | 随版本列表（约 30 分钟） |
| 依赖图 | `dependencies.json` | 随模组/社区刷新 |
| 额外统计（可选） | `stats/index.json`、`stats/<owner>/<repo>.json` | 手动/单独任务；不进主列表 |

模组来源：官方 `Anuken/MindustryMods` 的 `mods.json` 只提供 repo 列表；社区用 GitHub topic
`mindustry-mod` 发现（排除官方列表与 Anuken 黑名单）。名称/作者/版本/`minGameVersion` 等来自
各 tag 的 `mod.hjson`/`mod.json`（按游戏源码顺序，不读 `assets/`）。

## raw 地址

```
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/index.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/index-full.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/summary.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/community/index.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/community/index-full.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/mindustry/versions.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/mindustry/recommended-java.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/mindustry/mod-gate.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/mindustry/java-gate.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/status.json
https://raw.githubusercontent.com/MDTCopper/mindustry-data-index/main/changes.json
```

per-mod 文件：`releases/<owner>/<repo>.json`（≤200 个版本）或
`releases/<owner>/<repo>/page-N.json`（>200 个版本）；社区加 `community/` 前缀。

## 数据模型要点

### index

每条模组字段：`repo`、`name`/`namePlain`、`author`/`authorPlain`、`descriptionPlain`、
`modType`（`java`/`js`/`json`）、`version`、`minGameVersion`、`gameVersionRanges`、
`stars`、`iconUrl`/`iconHash`、`releasesPath`、`pages`、`releaseCount`、`tagCount`（非 Java）、
`releaseUpdatedAt`、`commitUpdatedAt`、`totalDownloads`、`allAssetsDownloads`、`score`、`ranks`。

- **默认列表 vs 全量**：`index.json` 只含 `score.recommendVisible=true`；全量在 `index-full.json`。
- **`score`**（6 字段）：`downloadsScore`、`starsScore`、`updateScore`、`penaltyScore`、
  `newModMultiplier`、`recommendVisible`。**总分不落盘**，客户端可用这些组件分按自己的权重计算。
  非 Java 的版本/tag 活动不计入 `updateScore`，改由提交承担 0.8（`NON_JAVA_COMMIT_UPDATE_WEIGHT`）。
- **`ranks`**：`recommended`（默认排序）、`heat`、`updated`、`downloads`、`stars`、`newest`，
  都是官方+社区合并后的**全局**名次（不是各文件内 1..N；默认列表过滤后序号会有跳号）。
  列表顶层有 `sortOptions` 与 `defaultSort="recommended"`。
- 推荐权重在 `src/heat.js` 的 `RECOMMEND_WEIGHTS`：下载 0.25 / 星标 0.3 / 更新 0.3 /
  6 小时时间桶随机 0.3 / 新 mod 加成 0.325 / 长期不更新扣分 0.4。
  `heat` 是旧热度权重预设；`updated`/`downloads`/`stars`/`newest` 是单一字段排序。
- **Copper 原生模组**：用 `copper.mod.json`/`copper.mod.hjson`；index 条目带 `copper: true`，`modType` 为 `java`。
- **`gameVersionRanges`**：实际游戏版本闭区间（如 `[{from:"154",to:"160.7"}]`），按 `minGameVersion`
  与各版本门禁计算；可有多个不连续段。

### per-mod release 文件

`formatVersion:3`，字段 `repo`、`generatedAt`、`modType`、`versions[]`（可选 `meta`）。
每条 version：`tag`、`kind`（`release`/`tag`/`source`）、`modVersion`、`minGameVersion`、
`gameVersionRanges`、`releasedAt`、`committedAt`、`downloadUrl`、`sha256`（Release 首选资产）、
`sizeBytes`/`downloadCount`、`prerelease`（仅 true）、`removed`/`removedAt`。
null 字段不写；没有 `minGameVersion` 的条目丢弃。

版本列表 = 有资产的 Release + 非 Java 的 tag-only；Java 的 tag-only 不进列表。
非 Java 可以不打 tag：一个可用版本都没有时，从默认分支读 root 元数据并生成一条
`kind:"source"` 版本（`tag` 是分支名，下载地址是该分支的源码归档），这样源码可用的脚本/json mod
不会消失；Java mod 没有资源则忽略。
>200 个版本时分页：每页 200、最多 5 页（1000，更老丢弃），index 的 `pages` 给出每页
`count` 与 `gameVersionRanges`，客户端可按游戏版本先选页再拉。

### 版本与门禁

- `mindustry/versions.json`：全部正式版 + 最新 BE，字段兼容启动器 `MindustryReleaseListSnapshot`；
  资产 `sha256` 为**可选**：GitHub API 只对新上传资产提供 digest，老资产/源码归档没有就不写。
  最新 BE 会自动跳过没有 jar 产物的失败 build。
- `mindustry/recommended-java.json`：游戏主版本号（jar 内 `number`）→ 推荐 Java 大版本规则 +
  Copper 加载器最低 Java；启动器不用再硬编码。
- `mindustry/setting-adapter/`：跟随最新 Mindustry 版本，从 `SettingsMenuDialog.java` +
  `bundle.properties` / `bundle_zh_CN.properties` 生成完整设置表；每项带 `name`/`description`
  的 `en` 与 `zh_CN` 译文，版本更新时在 `changes.json` 追加一次 diff。
- 门禁拆成两份：普通/脚本模组读 `mod-gate.json`，Java 模组读 `java-gate.json`；
  每条规则 `min` 含、`max` 不含，最后一条 `max=null`，`value` 是该范围要求的最低模组主版本。
  147 之前源码没有门禁常量，回落到 mmgvm 基线。

### 其他产物

- `summary.json/csv`：全量总表，按总下载量降序；带 `rank`（热度名次）与 `recommendVisible`。
- `status.json`：每次运行的各数据集状态、API 配额与 validate 摘要。
- `changes.json`：最近 500 条变更流。
- `state/*`：调度/缓存（`refresh.json`、`repo-stats.json`、黑名单、提交统计等），使用方可忽略。
- `heat/history/*`：下载/星标历史快照（daily 7、weekly 6、monthly 6）。
- `schema/*.json`：JSON Schema（draft 2020-12）。

## 刷新与配额

- `update-mods.yml`：每 2 小时（`:17`）+ dispatch/push，跑 `--datasets mods,community,heat`。
- `update-mindustry.yml`：每小时 `:07`/`:37`，更新版本列表与门禁；无数据变化时每天提交一次心跳，
  避免仓库 60 天无提交导致 schedule 暂停。
- 刷新分档：releases/tags 第 1 页每 2h、第 2 页每周、其余每月；每页带 ETag，304 只更新调度时间。
- API 配额不足（剩余 ≤5 或限流）：停止新请求、保留已抓结果、exit 0，下次按最久未刷新优先续跑。
- 两个 workflow 共用 concurrency 组，不会同时提交；有实质变化才 commit。

## 本地运行

```bash
npm ci
npm test                                  # 离线单测
npm run validate -- --dir .               # 校验产物
node src/main.js --datasets mods --out .                  # 官方索引（需要 GITHUB_TOKEN）
node src/main.js --datasets mods,community,heat --out .   # 官方+社区+热度
node src/main.js --datasets versions,gate --out .
node src/main.js --datasets heat --out . --heat-max-api 0 # 离线只算热度（看排序效果最快）
node src/main.js --datasets stats --out . --stats-limit 20  # 额外统计（语言/内容量，先小批量）
node src/main.js --migrate --out .        # 旧数据迁移
```

常用参数：`--out`、`--token`、`--threads`、`--raw-threads`、`--no-cache`、`--dry-run`、`--verbose`；
本地验证可用 `--repos a/b,c/d`、`--limit`、`--versions-pages`、`--community-*`，
不要用子集产物覆盖正式数据。

## 限制

- 官方列表里被移除的模组，其 release 文件会在后续刷新中删除；社区只收录符合 Anuken 标准的 topic 仓库。
- 删除/归档判定只在全量刷新（或 `--no-cache`）时做，平时不误标。
- 数据不保证实时：最新 100 tag 每 2 小时，历史按周/月；版本/门禁约 30 分钟。
- 额外统计 `stats/*` 需要按最新 tag 拉源码树与 bundle，成本较高，默认不在定时 workflow 里，按需跑。
- 本地匿名 API 只有 60 次/小时，全量跑务必带 token。
- 客户端过滤「只看活跃」用 `score.recommendVisible`（沿用 heat 权重 + `MIN_SCORE` 判定）；
  `ranks.recommended` 只决定推荐顺序，不参与隐藏；老 mod 不会因为停更被直接隐藏。
