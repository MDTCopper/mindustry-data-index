# 数据 schema

数据文件分三组：

- 模组索引：仓库根目录的 `index.json` 与 `releases/<owner>/<repo>.json`（旧 flat 路径
  `releases/<owner>_<repo>.json` 已废弃，运行时自动迁移并删除）；
- Mindustry 版本列表：`mindustry/versions.json`；
- 最小版本门禁：`mindustry/mod-gate.json`；
- 另有一个维护用文件 `mindustry/heartbeat.json`（防 60 天无提交被暂停 schedule）。

模组索引两份文件的 `formatVersion` 当前均为 `1`；`mod-gate.json` 也有 `formatVersion`（当前 `1`）。
字段变化时递增并同步修改本文档。

约定：

- 时间为 ISO 8601 字符串（UTC，`Z` 结尾），例如 `2026-11-06T03:00:00.000Z`；`*FetchedAt` /
  `publishedAt` 保留 GitHub 原样的时间格式。
- `null` 表示「没有这个信息」，与空字符串、空数组区分。
- 官方列表字段（`version`、`minGameVersion`、`stars` 等）原样保留官方 `mods.json` 的类型与脏值，
  不做数字化清洗（官方数据里出现过 `"157.1，"` 这样的 `minGameVersion`）。
- 两种元数据扩展名（`mod.hjson` / `mod.json`）都按 HJSON 解析（两者都可能出现无引号 key、
  `#` / `//` 注释、`'''` 多行串）；严格解析失败会做一次「字符串内裸换行」宽松修复，仍失败再用正则
  兜底只取 `version` / `minGameVersion`，值原样保留字符串、不强转数字。

## index.json

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-11-06T03:00:00.000Z",
  "source": {
    "modsUrl": "https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json",
    "modCount": 991
  },
  "mods": [],
  "skipped": []
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | number | 固定 `1` |
| `generatedAt` | string | `index.json` 数据主体最近一次变化时间；内容未变时不刷新（与 per-mod 文件口径一致） |
| `source.modsUrl` | string | 官方模组列表地址 |
| `source.modCount` | number | 本次 `mods` 条目数；全量运行时等于官方列表模组数（当前约 991） |
| `mods` | array | 模组条目，顺序与官方 `mods.json` 一致 |
| `skipped` | array | 本次抓取失败的仓库，见下 |

### mods[] 条目

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `repo` | string | `owner/name`，来自官方列表，作为唯一键 |
| `internalName` | string | 模组内部名，来自官方列表 |
| `name` | string | 显示名，来自官方列表 |
| `author` | string | 作者，来自官方列表（可能含 Mindustry 颜色标记与换行） |
| `version` | string | 官方列表记录的当前版本，原样保留 |
| `minGameVersion` | string | 官方列表记录的最低游戏版本，原样保留（含脏值） |
| `lastUpdated` | string | 官方列表记录的更新时间 |
| `stars` | number | GitHub stars（官方列表值） |
| `hasIcon` | boolean \| null | 官方列表的图标标记；官方列表缺该字段时为 `null`（此时仍会给 `iconUrl`，由客户端决定是否试一次） |
| `hasScripts` / `hasJava` | boolean | 官方列表的脚本/Java 标记 |
| `iconUrl` | string \| null | 官方图标地址 `https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/<owner>_<repo>`（repo 的 `/` 换成 `_`，不带扩展名，与启动器 `githubModIconBase` 一致）。`hasIcon === false` 时为 `null`；只记地址，不下载图标字节 |
| `iconHash` | string \| null | 官方列表的 `iconHash` 原样保留（多数模组没有），供客户端按哈希做图标缓存 |
| `releasesPath` | string \| null | per-mod 文件相对路径（`releases/<owner>/<repo>.json`，owner/name 保留大小写）；`null` 表示尚未成功抓取过（见 `skipped`） |
| `releaseCount` | number | 该模组 release 条数（不含 draft）；抓取失败时保留旧值 |
| `totalDownloads` | number | 历史累计下载量：所有 release 的**首选资产** `downloadCount` 之和（首选资产口径见下；无首选资产按 0） |
| `allAssetsDownloads` | number | 所有 release 的全部资产 `downloadCount` 之和（完整口径，含非首选资产） |
| `latestDownloads` | number | 最新一条 release 首选资产的 `downloadCount`（没有首选资产为 0） |
| `latestSizeBytes` | number \| null | 最新一条 release 首选资产的 `size`（没有首选资产为 `null`） |
| `totalSizeBytes` | number \| null | 所有 release 首选资产 `size` 之和（历史版本总体积；一条首选资产都没有为 `null`） |
| `latestRelease` | object \| null | `releases` 首条（新→旧）的 `{ tag, name, prerelease, publishedAt, downloads, sizeBytes }`；无 release 或尚未抓取时为 `null` |
| `releaseDataUpdatedAt` | string \| null | per-mod 文件最近一次**内容变化**时间；文件内容未变时保持不变（不是每天刷新） |

**首选资产口径**：与 `downloadUrl` 一致——`hasJava` 取体积最大的 `.jar`，否则取体积最大的 `.zip`；
没有对应后缀的资产时下载量按 0、体积为 `null`（`downloadUrl` 仍回落源码归档）。

`description`、官方列表里的 `releases` 映射等大字段不放进 `index.json`；`iconHash` 保留（450 条左右
有值，体积小且可用于缓存）。

### skipped[]

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `repo` | string | 本次抓取失败的仓库 |
| `reason` | string | `http-404`、`http-451`、`http-5xx` 等 HTTP 状态，或 `network`、`rate-limit` |

抓取失败时保留旧 `releases/<owner>/<repo>.json` 与旧 `releaseCount` / `latestRelease`；若从未成功抓取过，
`releasesPath` 为 `null`、`releaseCount` 为 `0`、`latestRelease` 为 `null`，统计字段为 0 / `null`。

## releases/<owner>/<repo>.json

**只存数据**：分页 ETag 与抓取时间在 `state/refresh.json`，这里不再放 `source`（旧格式文件里的
`source.releasesEtag` / `releasesFetchedAt` 读取时兼容忽略，不参与内容比较）。

路径按 repo 的 owner/name 分目录并保留大小写。**迁移**：旧 flat 路径 `releases/<owner>_<repo>.json`
已废弃；运行时优先读新路径，新路径不存在则读旧 flat 文件当缓存（`generatedAt`、`source`、分页 state
全部沿用），把内容写到新路径后删除旧文件，不会重新抓取（迁移首轮会重写文件位置，之后 0 变化）。
`validate` 发现旧 flat 文件会给「迁移未完成」警告。

```json
{
  "formatVersion": 1,
  "repo": "owner/repo",
  "generatedAt": "2026-11-06T03:00:00.000Z",
  "releases": []
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | number | 固定 `1` |
| `repo` | string | `owner/name` |
| `generatedAt` | string | 本文件最近一次**内容变化**时间，只有 `releases` 真的变化时才更新 |
| `releases` | array | 合并后的全部 release：抓到的页按 tag 覆盖缓存（下载量随之更新），没抓到的旧条目保留；按 `publishedAt` 降序、同一时间按 `tag` 升序 |

### releases[] 条目

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tag` | string | release 的 tag 名 |
| `name` | string | release 名称，先 trim 首尾空白；空则回退 `tag`（官方数据里有尾随空格） |
| `prerelease` | boolean | GitHub 的预发布标记，原样保留；`draft` release 已跳过 |
| `publishedAt` | string \| null | GitHub 的 `published_at` |
| `htmlUrl` | string | release 页面地址 |
| `modVersion` | string \| null | 该 tag 下 mod 元数据的 `version`；数字转字符串；缺失为 `null` |
| `minGameVersion` | string \| null | 该 tag 下 mod 元数据的 `minGameVersion`；数字转字符串，字符串原样（含脏值）；缺失为 `null` |
| `metadataPath` | string \| null | 实际命中的元数据路径：`mod.hjson` / `mod.json` / `assets/mod.hjson` / `assets/mod.json`；未命中为 `null` |
| `metadataStatus` | string | `ok` / `missing` / `unparsed`，见下 |
| `downloadUrl` | string | 推荐下载链接，规则见下 |
| `sourceArchiveUrl` | string | 源码归档 `https://github.com/<repo>/archive/refs/tags/<tag>.zip`，永远带 `tag` 的 URL 转义 |
| `assets` | array | release 资产全量，顺序与 API 一致：`{ name, size, downloadCount, downloadUrl }` |

### metadataStatus 语义

| 值 | 含义 | 何时会重新抓取 |
| --- | --- | --- |
| `ok` | 命中了候选文件并解析成功（`version` / `minGameVersion` 可能为 `null`，表示文件里没写）；对字符串内未转义裸换行会先做一次宽松修复再解析 | 不重抓，直接复用 |
| `missing` | 四个候选路径全部 404 | 不重抓，直接复用 |
| `unparsed` | 命中文件但解析失败，或请求层重试后仍失败 | 只在该仓库 release 列表变化（第一页 ETag 变化、进入 200 路径）或 `--no-cache` 时重抓；releases 第一页 304 时整份文件复用、不会重试任何元数据 |

### downloadUrl 优先级

与 Copper Launcher 模组下载页的选资产口径一致：

1. `hasJava == true`：取该 release 资产中体积最大的 `.jar`；
2. `hasJava == false`：取体积最大的 `.zip`；
3. 没有对应后缀的资产：回落 `sourceArchiveUrl`（zip 模组多数没有 release 资产，必须靠源码归档）。

不跨后缀猜测。注意启动器对「Java 模组但没有提供 `.jar` 资产」的情况是禁用下载（不显示下载按钮）；
本仓库仍给出源码归档地址，使用方需自行判断该 release 是否可安装。`assets` 里保留全部资产供自行筛选。

### prerelease 语义

`prerelease` 只忠实反映 GitHub release 上的勾选状态，不参与 `latestRelease` 的挑选——
`latestRelease` 就是 `releases[0]`。使用方若只要正式版，自行过滤 `prerelease === false`。

## summary.json

下载量与体积总表：由 `index.json` 的统计字段聚合，按 `totalDownloads` 降序（并列按 `stars` 降序、
`repo` 升序）。无 release / 无资产的模组也会出现，数值为 0 或 `null`。

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-11-06T03:00:00.000Z",
  "totals": { "mods": 991, "releases": 5218, "downloads": 4893625, "sizeBytes": 21575732426 },
  "mods": [
    {
      "repo": "sk7725/betamindy",
      "name": "BetaMindy",
      "author": "sk7725",
      "stars": 375,
      "releaseCount": 51,
      "totalDownloads": 534141,
      "allAssetsDownloads": 534783,
      "latestDownloads": 21918,
      "latestSizeBytes": 18277217,
      "totalSizeBytes": 238987571,
      "latestTag": "v2.01",
      "latestPrerelease": false,
      "latestModVersion": "2.0-159",
      "latestMinGameVersion": "159",
      "iconUrl": "https://raw.githubusercontent.com/Anuken/MindustryMods/master/icons/sk7725_betamindy",
      "releasesPath": "releases/sk7725/betamindy.json"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | number | 固定 `1` |
| `generatedAt` | string | 本文件最近一次**内容变化**时间；未变化不刷新 |
| `totals.mods` | number | 模组数（= `index.mods` 数量） |
| `totals.releases` | number | 所有模组 `releaseCount` 之和 |
| `totals.downloads` | number | 所有模组 `totalDownloads` 之和 |
| `totals.sizeBytes` | number | 所有模组 `totalSizeBytes` 之和（`null` 按 0 计） |
| `mods[].repo` 等 | string | `repo`/`name`/`author`/`latestTag`/`latestModVersion`/`latestMinGameVersion`/`iconUrl`/`releasesPath`，无值时为 `null` |
| `mods[].stars` / 统计字段 | number \| null | 与 index 条目同名字段一致；`latestSizeBytes`/`totalSizeBytes` 可为 `null` |
| `mods[].latestPrerelease` | boolean \| null | 最新 release 的预发布标记 |

## summary.csv

与 `summary.json` 的 `mods[]` 同列（不含 `totals`），列顺序：

`repo,name,author,stars,releaseCount,totalDownloads,allAssetsDownloads,latestDownloads,latestSizeBytes,totalSizeBytes,latestTag,latestPrerelease,latestModVersion,latestMinGameVersion,iconUrl,releasesPath`

- UTF-8 **带 BOM**（Excel 直接打开中文不乱码），CRLF 换行；
- 逗号、双引号、换行按 CSV 规则转义（字段加引号、内部 `"` 写成 `""`）；
- `null` 输出为空字段，布尔输出 `true`/`false`。

## state/refresh.json

分页调度缓存，只给增量刷新用，使用方不需要读取：

```json
{
  "formatVersion": 1,
  "updatedAt": "2026-11-06T03:00:00.000Z",
  "mods": {
    "mindustrytool/mindustrytoolmod": {
      "page1Etag": "\"W/...\"",
      "page1FetchedAt": "2026-11-06T03:00:00.000Z",
      "pages": { "2": "2026-11-01T03:00:00.000Z" }
    }
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | number | 固定 `1` |
| `updatedAt` | string | 文件最近一次写入时间 |
| `mods.<repo>.page1Etag` | string \| null | 第 1 页 `If-None-Match` 用 |
| `mods.<repo>.page1FetchedAt` | string \| null | 第 1 页最近一次抓取时间（每天一次判断） |
| `mods.<repo>.pages.<n>` | string | 第 n 页（n≥2）最近一次抓取时间（7/30/90 天到期判断） |

### 按 tag 新旧分档刷新

分档常量在 `src/refresh-state.js` 的 `REFRESH_TIERS`：第 1 页每天、第 2 页每 7 天、第 3 页每 30 天、
第 4 页起每 90 天。每轮按 `fetchedAt` 判断到期页，第 1 页带旧 ETag 条件请求；抓到的页按 tag 覆盖缓存，
没抓到的旧条目保留；合并后按 `publishedAt` 降序（同时间按 tag 升序）。

per-mod 文件与调度状态分离：ETag 每天变也不会重写 `releases/<owner>/<repo>.json`，只有 `releases` 数据真的变化
（下载量/体积/元数据）才重写；调度时间变化只改 `state/refresh.json`。`--no-cache` 会忽略 state 与旧文件，
全量抓所有页。

## mindustry/versions.json

Mindustry 可用版本列表，形状兼容启动器 `remote/mindustry_versions.json`：启动器的
`MindustryReleaseListSnapshot.parse` 只读 `releases` 数组，`MindustryRelease.fromGithubJson`
读每条 release 的字段。`latest_be` 与 `etags` 是本仓库额外加的字段（启动器忽略）。

```json
{
  "update_time": "2026-11-06T03:00:00Z",
  "source": "https://api.github.com/repos/Anuken/Mindustry/releases",
  "releases": [],
  "latest_be": null,
  "etags": { "releases": "\"W/...\"", "latestBe": "\"W/...\"" }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `update_time` | string | 本文件最近一次**内容变化**时间；没变化时不刷新（避免每 30 分钟都产生提交） |
| `source` | string | 固定为官方正式版 release 接口地址 |
| `releases` | array | 正式版 release，按 GitHub API 返回顺序（新→旧），已做精简 |
| `latest_be` | object \| null | `MindustryBuilds` 最新一条 BE release；没有取到过为 `null` |
| `etags` | object | 仅供增量请求用：`releases`（正式版第一页 ETag）、`latestBe`（BE 的 ETag）；使用方忽略即可 |

### releases[] / latest_be 条目

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string \| null | GitHub release 名，**原样保留**（官方数据里有尾随空格，启动器解析时自己 trim） |
| `tag_name` | string | 正式版形如 `v160.7`；BE 是 build 号本身 |
| `published_at` | string \| null | 发布时间 |
| `body` | string | 固定空串（列表不展示更新日志） |
| `reactions` | object | **仅 `releases[]` 有**：`{ "total_count": number }`。启动器用 `reactions == null` 识别 BE |
| `assets` | array | `{ name, size, download_count, browser_download_url }` 四个字段 |

`latest_be` 没有 `reactions` 键（启动器据此判定 BE）。`name` / `tag_name` / `published_at` 原样保留
GitHub 的值。

### 更新与增量

- 常规每轮只请求正式版第一页（`per_page=100`，带上次的 ETag）+ BE（`per_page=1`），共 2 次 API。
- 第一页 304 → 复用整份 `releases`；第一页 200 且里面全是已知 release → 用「第一页 + 本地其余」
  拼回完整列表；出现未知 release id（或本地还没有列表）→ 才翻后续页重建完整列表（当前约 3 页）。
- `releases` / `latest_be` 没变时不重写文件；`update_time` 只在内容变化时更新。
- 不把 304 当免费：每轮固定只发上述 2 次 API，避免匿名/低配额下被打爆。

## mindustry/mod-gate.json

最小模组版本门禁：每个游戏版本要求的最低模组版本（`mod` = 普通/脚本模组，`java` = Java 模组）。
`rules` 与启动器 `remote/mmgvm.hjson` 同语义，且生成结果与当前 mmgvm 逐项一致。

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-11-06T03:00:00.000Z",
  "source": {
    "repo": "Anuken/Mindustry",
    "baseline": "https://raw.githubusercontent.com/MDTCopper/launcher/main/remote/mmgvm.hjson",
    "constants": ["minModGameVersion", "minJavaModGameVersion"],
    "resolvedPaths": ["core/src/mindustry/Vars.java"]
  },
  "rules": [{ "min": 97, "max": 105, "mod": 97, "java": 97, "source": "baseline" }],
  "versions": [{ "tag": "v147", "version": 147, "mod": 136, "java": 147, "source": "game-source" }]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | number | 固定 `1` |
| `generatedAt` | string | 本文件最近一次**内容变化**时间 |
| `source.repo` | string | 固定 `Anuken/Mindustry` |
| `source.baseline` | string | 基线 mmgvm 地址（147 之前源码没有常量时用它的 rules） |
| `source.constants` | string[] | 从源码提取的常量名 |
| `source.resolvedPaths` | string[] | 实际命中过常量的源码路径，代码位置变化时用它追踪 |
| `rules` | array | 合并后的门禁区间 |
| `versions` | array | 逐版本明细（只含 `v<数字>[.<数字>]` 正式版，从 97 开始） |

### rules[] 语义

- `min` 含、`max` 不含；最后一条 `max` 为 `null`（无上限）；连续且 `(mod, java)` 相同的版本已合并，
  相邻两条的 `mod`/`java` 一定不同。第一条 `min` 固定为 `97`（与 mmgvm 口径一致）。
- `source`：`game-source`（该区间的版本都从官方源码提取到常量）、`baseline`（都来自 mmgvm 基线）、
  `mixed`（区间里两种来源都有，正常数据不会出现，仅在基线/源码交替时兜底）。

### versions[] 语义

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tag` | string | 形如 `v147` / `v154.2` |
| `version` | number | tag 里的数字，升序且不重复 |
| `mod` | number | 该版本游戏要求的最低普通模组版本 |
| `java` | number | 该版本游戏要求的最低 Java 模组版本 |
| `source` | string | `game-source` / `baseline` |

147 之前的版本源码里没有 `minModGameVersion` / `minJavaModGameVersion`，这些版本的 `mod`/`java`
直接走 mmgvm 基线查询（`min <= version < max` 命中），**不逐版本尝试源码候选路径**
（代码里 `GATE_SOURCE_CONSTANT_SINCE = 147`；依据是逐 tag 实测 v105/v136/v146 等老版本均无这两个常量，
v147 首次出现）。147 起从 `core/src/mindustry/Vars.java` 提取（候选路径还包括
`core/src/mindustry/core/Vars.java` 等，候选全 404 且上一版本有常量时才用 1 次 tree API 找移动后的
`Vars.java` / `Version.java`）；`source.resolvedPaths` 记录实际命中的路径。

### 更新与增量

- 上一份 `mod-gate.json` 里 `source=game-source` 的版本不重复抓源码；只有新版本才扫描。
- `source=baseline` 的老版本也缓存：每轮按最新 mmgvm 规则本地重算（不抓源码），基线变化时只影响这些版本。
  稳态每轮只有 1 次 raw 请求（拉 mmgvm 基线）+ 0 次 API。
- `versions` / `rules` / `source` 没变时不重写文件。

## mindustry/heartbeat.json

GitHub 在仓库 60 天没有任何提交时会暂停 `schedule`。版本/门禁数据可能长期无变化，所以
`update-mindustry.yml` 在没有数据变化、且心跳日期不是今天时会写一次心跳并提交：

```json
{ "lastCheck": "2026-11-06T03:00:00Z" }
```

属于维护用文件，使用方不需要读取。有数据变化时心跳随当次数据提交一起刷新。
