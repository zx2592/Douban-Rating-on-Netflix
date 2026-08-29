# 豆瓣评分 for Netflix

一个 Chrome 扩展：在 Netflix 的影片封面和详情弹层旁就地显示对应的豆瓣评分，点击角标跳转豆瓣条目。交互形态参考 IMDb Ratings for Netflix。

第一版只支持 Netflix，Prime Video 留到下一阶段（架构上已经按「多站点适配器」拆好）。

## 安装（开发版）

```bash
npm install
npm run build
```

然后在 Chrome 打开 `chrome://extensions`，开启右上角的「开发者模式」，点「加载已解压的扩展程序」，选择项目下的 `dist` 目录。

开发时用 `npm run watch` 可以自动重建，改完在扩展页点一下刷新按钮即可。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 打包到 `dist/` |
| `npm run watch` | 监听源码变化持续重建 |
| `npm test` | 跑单测 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run check` | 类型检查 + 测试 + 构建，提交前跑这个 |
| `npm run icons` | 重新生成 `icons/` 下的 PNG 图标 |

## 它是怎么工作的

```
内容脚本 (Netflix 页面内)              background service worker
┌────────────────────────────┐        ┌──────────────────────────────┐
│ MutationObserver           │        │ RequestQueue                 │
│   发现新出现的影片卡片      │        │   串行 + 限速 + 指数退避      │
│ IntersectionObserver       │        │ DoubanClient                 │
│   只为进入视口的卡片查询    │──消息─→│   检索候选 → 取评分（含降级） │
│ badge                      │←──────│ matcher                      │
│   注入角标 / 复用时刷新     │        │   候选打分，不够可信就不显示  │
└────────────────────────────┘        │ RatingCache                  │
                                      │   storage.local，命中缓存 7 天│
                                      └──────────────────────────────┘
```

### 三个关键设计

**豆瓣没有公开 API。** 官方 API v2 早已停发 key，所以走的是豆瓣自己站内在用的接口：`subject_suggest` 拿候选条目，再用 `subject_abstract` 取该条目的评分，后者失效时降级为解析条目页 HTML。这些接口都没有任何契约保证，因此 `douban/parse.ts` 里所有解析都是「宽进严出」：字段缺失或类型不对就跳过这一条，绝不让整批结果崩掉。

**请求量必须压住，否则会被豆瓣按 IP 封。** 三道闸：只为进入视口的卡片发请求（首页一次能渲染几百张卡片，但用户只看得到十几张）；同一标题的并发查询去重（同一部片常同时出现在多个榜单里）；命中结果缓存 7 天、未命中缓存 12 小时。出网请求全部经由一个并发为 1、间隔 1.2 秒的队列，识别到 403/429 或豆瓣的验证页就进入指数退避。

**宁可不显示，也不显示错的分数。** 标题匹配走归一化（全半角、繁简、变音符号、标点、季数后缀）加候选打分，年份和类型作为消歧信号。有年份时阈值 70 分，没年份时收紧到 88 分 —— 列表卡片上通常拿不到年份，此时仅仅是「标题包含关系」不足以判定为同一部片。把「蝙蝠侠」配到「蝙蝠侠归来」比留空更糟。

## 目录结构

```
src/
├── shared/          三端共用：类型、消息协议、设置、文本归一化
├── background/      service worker
│   ├── douban/      豆瓣接口客户端与响应解析
│   ├── matcher.ts   候选打分与阈值判定
│   ├── queue.ts     限速队列与退避
│   ├── cache.ts     评分缓存
│   └── lookup.ts    缓存 → 检索 → 匹配 → 取分的编排
├── content/
│   ├── badge.ts     角标的注入与更新
│   └── netflix/     Netflix 适配器
│       ├── selectors.ts   所有 Netflix DOM 知识都在这个文件里
│       ├── extract.ts     卡片 / 弹层 → 查询条件
│       └── index.ts       观察器主循环
└── popup/           设置页
```

## Netflix 改版了怎么办

Netflix 是没有公开契约的商业站点，class 名会随改版变化。所有 DOM 知识都集中在 `src/content/netflix/selectors.ts`，每个位置都给了一组候选选择器并按顺序尝试，改版时通常只需要往对应数组里加一行。

内容脚本带了自检：打开页面 8 秒后若一张卡片都没找到，会在 Console 打出一条警告。想看详细日志，在 Netflix 页面的 Console 里执行 `localStorage.setItem('dbr:debug', '1')` 后刷新。

## 隐私

扩展只做两件涉及网络的事：把影片标题发给豆瓣做检索、取回评分。没有任何数据上报到第三方，评分缓存只存在浏览器本地的 `chrome.storage.local` 里。请求不携带 cookie（`credentials: 'omit'`）—— 带上用户的豆瓣登录态确实能提高成功率，但那等于让扩展以用户身份访问豆瓣，风险和收益不成正比。

权限只申请了三项：`storage`（存设置和缓存），以及 `www.douban.com` / `movie.douban.com` 两个域名的访问权。

## 已知限制

- 匹配依赖豆瓣的检索结果，冷门片、Netflix 独占的小语种内容可能查不到，此时列表页留空、详情页显示「未收录」。
- 繁简转换用的是一份覆盖影视标题高频字的精简表（见 `src/shared/text.ts`），不是完整的 OpenCC。缺字只会导致匹配不上，不会匹配错；需要时往表里加即可，单测会校验表的结构。
- 剧集按季匹配：查询没有指明季数时默认取第一季，因为用户在列表里看到的就是这部剧本身。
- 尚未支持 Prime Video。

## 开发注意

沙箱化的 CI 环境无法访问 `douban.com`，所以数据层的测试全部基于 fixture。真实接口的可用性需要在浏览器里手工验证 —— 这也是 `DoubanClient` 里保留降级链、`parse.ts` 里做容错解析的原因。
