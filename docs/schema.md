# 数据 schema

仓库根目录的数据文件：`index.json` 与 `releases/<owner>_<repo>.json`。
两份文件的 `formatVersion` 当前均为 `1`，字段变化时递增并同步修改本文档。

约定：

- 时间为 ISO 8601 字符串（UTC，`Z` 结尾），例如 `2026-11-06T03:00:00.000Z`；`*FetchedAt` /
  `publishedAt` 保留 GitHub 原样的时间格式。
- `null` 表示「没有这个信息」，与空字符串、空数组区分。
- 官方列表字段（`version`、`minGameVersion`、`stars` 等）原样保留官方 `mods.json` 的类型与脏值，
  不做数字化清洗（官方数据里出现过 `"157.1，"` 这样的 `minGameVersion`）。

## index.json

```json
{
  "formatVersion": 1,
  "generatedAt": "2026-11-06T03:00:00.000Z",
  "source": {
    "modsUrl": "https://raw.githubusercontent.com/Anuken/MindustryMods/master/mods.json",
    "modCount": 990
  },
  "mods": [],
  "skipped": []
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | number | 固定 `1` |
| `generatedAt` | string | 本次生成时间；每天更新都会变化 |
| `source.modsUrl` | string | 官方模组列表地址 |
| `source.modCount` | number | 本次 `mods` 条目数；全量运行时等于官方列表模组数 |
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
| `hasIcon` / `hasScripts` / `hasJava` | boolean | 官方列表的图标/脚本/Java 标记 |
| `releasesPath` | string \| null | per-mod 文件相对路径（`releases/<owner>_<repo>.json`）；`null` 表示尚未成功抓取过（见 `skipped`） |
| `releaseCount` | number | 该模组 release 条数（不含 draft）；抓取失败时保留旧值 |
| `latestRelease` | object \| null | `releases` 首条（GitHub API 新→旧）的 `{ tag, name, prerelease, publishedAt }`；无 release 或尚未抓取时为 `null` |
| `releaseDataUpdatedAt` | string \| null | per-mod 文件最近一次**内容变化**时间；文件内容未变时保持不变（不是每天刷新） |

`description`、`iconHash`、官方列表里的 `releases` 映射等大字段不放进 `index.json`。

### skipped[]

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `repo` | string | 本次抓取失败的仓库 |
| `reason` | string | `http-404`、`http-451`、`http-5xx` 等 HTTP 状态，或 `network`、`rate-limit` |

抓取失败时保留旧 `releases/*.json` 与旧 `releaseCount` / `latestRelease`；若从未成功抓取过，
`releasesPath` 为 `null`、`releaseCount` 为 `0`、`latestRelease` 为 `null`。

## releases/<owner>_<repo>.json

```json
{
  "formatVersion": 1,
  "repo": "owner/repo",
  "generatedAt": "2026-11-06T03:00:00.000Z",
  "source": {
    "releasesEtag": "\"W/...\"",
    "releasesFetchedAt": "2026-11-06T03:00:00.000Z"
  },
  "releases": []
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `formatVersion` | number | 固定 `1` |
| `repo` | string | `owner/name` |
| `generatedAt` | string | 本文件最近一次**内容变化**时间，只有数据主体变化时才更新 |
| `source.releasesEtag` | string \| null | release 接口第一页的 ETag，下次带 `If-None-Match` 请求；`null` 表示没拿到，下次无条件请求 |
| `source.releasesFetchedAt` | string \| null | 最近一次实际抓到 release 内容的时间；**304 不更新**（304 整份文件不重写） |
| `releases` | array | 按 GitHub API 返回顺序（新→旧），不重排 |

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

| 值 | 含义 | 下次更新是否重试 |
| --- | --- | --- |
| `ok` | 命中了候选文件并解析成功（`version` / `minGameVersion` 可能为 `null`，表示文件里没写）；对字符串内未转义裸换行会先做一次宽松修复再解析 | 否，直接复用 |
| `missing` | 四个候选路径全部 404 | 否，直接复用 |
| `unparsed` | 命中文件但解析失败，或请求层重试后仍失败 | 是，作为「可重试」条目重新抓取 |

### downloadUrl 优先级

与 Copper Launcher 的模组下载口径一致：

1. `hasJava == true`：取该 release 资产中体积最大的 `.jar`；
2. `hasJava == false`：取体积最大的 `.zip`；
3. 没有对应后缀的资产：回退 `sourceArchiveUrl`（zip 模组多数没有 release 资产，必须靠源码归档）。

不跨后缀猜测（Java 模组没有 jar 时也给源码归档，交由使用方判断），`assets` 里仍保留全部资产供自行筛选。

### prerelease 语义

`prerelease` 只忠实反映 GitHub release 上的勾选状态，不参与 `latestRelease` 的挑选——
`latestRelease` 就是 `releases[0]`。使用方若只要正式版，自行过滤 `prerelease === false`。
