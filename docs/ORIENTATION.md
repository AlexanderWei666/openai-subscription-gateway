# 项目导览(Java 开发者视角)

> 你是写 Java 的,不需要学 TS。**TS 对你来说只是"类型标注写在变量后面的 Java"**。
> 本文只讲三件事:① 怎么让 VSCode 别吵 ② Java 概念怎么映射 ③ 项目结构和该看哪。
>
> 注:下表**行数是生成时点的近似值**(用于判断文件体量),会随提交变化;
> 结构性问题请以 `node scripts/doc-check.ts` 的输出为准。

---

## 一、先解决"VSCode 看起来太花哨"

你看到的"花哨"90% 是 **inlay hints(内联提示)**:灰字塞在代码中间显示参数名和推断类型
(形如 `model: "gpt-6-astra"` 里那个灰色 `model:`)。它们是**编辑器画的,不是代码里的字符**。
关掉即可(粘到 VSCode `settings.json`):

```jsonc
{
  // 主要噪音来源:内联类型/参数名提示
  "editor.inlayHints.enabled": "off",
  "typescript.inlayHints.parameterNames.enabled": "none",
  "typescript.inlayHints.variableTypes.enabled": false,
  "typescript.inlayHints.propertyDeclarationTypes.enabled": false,
  "typescript.inlayHints.functionLikeReturnTypes.enabled": false,
  "typescript.inlayHints.parameterTypes.enabled": false,
  "typescript.inlayHints.enumMemberValues.enabled": false,

  // 彩虹括号 + 缩进辅助线(第二噪音源)
  "editor.bracketPairColorization.enabled": false,
  "editor.guides.bracketPairs": false,
  "editor.guides.indentation": false,

  // 其他花哨项
  "editor.occurrencesHighlight": "off",
  "editor.renderWhitespace": "none",
  "editor.selectionHighlight": false
}
```

### 更狠的招:直接读编译产物

TS 编译后**类型全部消失**,`dist/*.js` 就是干干净净的 JavaScript——没有泛型、
没有 interface、没有 `: string`。对 Java 人来说,这相当于"看擦除泛型后的代码":

```bash
# 想快速看懂某个文件的真实逻辑,读它的编译产物
cat dist/upstream/codex.js
```

`.ts` 和 `.js` 的逻辑是**一一对应**的(编译不改逻辑),但 `.js` 少 30~40% 字符。

---

## 二、Java ↔ TS 概念对照(只列影响理解的部分)

| Java | 这里的写法 | 关键差异 |
|---|---|---|
| `interface Foo {}` | `interface Foo {}` | **TS 的 interface 运行时完全不存在**,不会编译出任何东西。只是"形状描述" |
| `class Foo` | 常用 `interface` + 普通函数 | 全项目只有 4 个业务类(`TokenManager`/`CredentialStore`/`ModelCatalog`/`CodexUpstream`)+ 5 个 Error 子类,其余都是普通函数 |
| `Map<String,Object>` | `Record<string, unknown>` | 键固定为 string 的 map |
| `List<String>` | `string[]` 或 `Array<string>` | |
| `Optional<T>` | `T \| null` / `T \| undefined` | **没有包装类**,直接用联合类型。`?.` 和 `??` 就是它的语法糖 |
| `@Nullable` / null 检查 | 编译器强制(null 检查在类型系统里) | `strict: true` 下,可能为 null 就必须先判断才能用,**编译期就拦住** |
| checked exception | **没有**,只有 `Error` | try/catch 可选,函数签名里不写 throws |
| `CompletableFuture<T>` | `Promise<T>` + `async/await` | 概念几乎一致;`await` ≈ `.get()` 但非阻塞 |
| Stream API | `.map()` / `.filter()` / `.find()` | 数组方法,用法接近 |
| `record` / Lombok `@Data` | 无 | TS 的 interface 不生成 getter/构造器,只是类型 |
| `final` | `const` / `readonly` | |
| 匿名内部类 | 箭头函数 `(x) => {...}` | 更短,`this` 行为不同(这里基本用不到) |
| Maven `pom.xml` | `package.json` | 项目**零 dependencies** |
| `javac` → `.class` | `tsc` → `dist/*.js` | |
| JVM 跑 jar | `node` 跑 js | 需要 Node ≥ 24 |
| Spring `@Autowired` | **没有依赖注入** | 手动传对象(`new ModelCatalog({...})`),`buildRuntime()` 一处组装 |
| Spring `@ControllerAdvice` | `api/errors.ts` | 统一异常 → HTTP 响应 |
| Spring Security OAuth2 | `auth/oauth.ts` | 手写的等价物(PKCE + 本地回调 + 刷新) |

### 最重要的一条认知

**TS 的类型在运行时 100% 消失**。所以别指望运行时校验(比如参数是否合法)由类型完成——
项目里所有校验都是手写的 `typeof x === "object" && x !== null` 这种判断。
Java 里泛型也是擦除的,但类、注解、反射都还在;TS 是全都没了。

---

## 三、项目结构汇报(带 Java 类比)

```
openai-subscription-gateway/
├── src/
│   ├── server.ts          5 条路由分发      ≈ DispatcherServlet / @RequestMapping
│   ├── config.ts          配置与常量        ≈ application.yml + @ConfigurationProperties
│   ├── log.ts             日志 + 密钥脱敏    ≈ 带脱敏的 Logger
│   ├── api/               ★ 对外 OpenAI 接口面(像 Controller 层)
│   │   ├── responses.ts       核心端点       ≈ @RestController 主方法
│   │   ├── chat-completions.ts 兼容端点      ≈ 格式转换的 Adapter
│   │   ├── models.ts          /v1/models    ≈ 一个只读查询接口
│   │   └── errors.ts          错误映射       ≈ @ControllerAdvice
│   ├── upstream/          ★ 上游适配层(像 Feign/WebClient 封装)
│   │   ├── codex.ts           私有协议+重试   ≈ 定制 header 的 HTTP client
│   │   ├── catalog.ts         模型目录缓存    ≈ @Cacheable 的配置服务
│   │   ├── sse.ts             SSE 切帧       ≈ 手写的行解析器
│   │   └── client-version.ts  版本探测        ≈ 启动时读环境/exec 的组件
│   ├── auth/              登录态(像 Security 模块)
│   │   ├── oauth.ts           PKCE+刷新单飞   ≈ OAuth2Client + RefreshTokenProvider
│   │   ├── store.ts           凭证读写+权限    ≈ 文件型 CredentialStore
│   │   ├── jwt.ts             JWT 解析        ≈ JwtDecoder(手写)
│   │   └── pkce.ts            PKCE 工具       ≈ 工具类
│   └── cli/index.ts       命令行入口         ≈ picocli / CommandLineRunner
├── tests/{unit,contract,live}/  单元 / HTTP 契约 / 真账号
├── docs/                  设计、上游契约、维护流程
└── scripts/probe-*.ts     上游探针(排查用)
```

**分层铁律**:Codex 私有细节(请求头 `originator`、`chatgpt-account-id`、参数怪癖)
只允许出现在 `upstream/` 和 `auth/`。`api/` 里出现这类字样就是 bug——
等价于"业务层不允许出现数据库方言"。

---

## 四、关键文件表(按"要不要读"排序)

| 文件 | 行数 | 职责 | 建议 |
|---|---|---|---|
| `src/server.ts` | 169 | 5 条路由分发、流式/非流式分叉、错误统一出口 | **必读** |
| `src/api/responses.ts` | 328 | 参数校验、挑字段、SSE 聚合与透传 | **必读** |
| `src/upstream/codex.ts` | 267 | 唯一伪装 Codex CLI 的地方、参数归一化、连接重试 | **必读** |
| `src/config.ts` | 106 | 全部可调项 | 必读(10 分钟) |
| `src/auth/oauth.ts` | 323 | PKCE 登录、刷新单飞、超时 | 要用到登录时才读 |
| `src/upstream/catalog.ts` | 213 | 三级回退 + 缓存保护 | 遇到"模型列表不对"再读 |
| `src/cli/index.ts` | 343 | 命令拼装 | 扫一眼 usage 即可 |
| `src/api/chat-completions.ts` | 500 | Chat↔Responses 格式互转 | **可跳过**(机械转换,最长但最简单) |
| `src/api/errors.ts` | 129 | 上游错误 → OpenAI 风格错误 | 用到再看 |
| `src/upstream/sse.ts` | 86 | SSE 切帧 + abort | 5 分钟扫完 |

---

## 五、三档时间预算的读法

**15 分钟(建立印象)**
1. `README.md` 的"是什么/不是什么/支持能力"三节;
2. `node dist/cli/index.js config` + `doctor` 各跑一次看输出;
3. `src/server.ts` 全文(169 行,一次读完)。

**1 小时(能改代码)**
1. 上面三件;
2. `docs/DESIGN.md`(为什么这么设计,尤其"非目标"清单);
3. `src/upstream/codex.ts` 的 `buildHeaders` + `normalizeForCodex` 两个函数;
4. `src/api/responses.ts` 的 `buildUpstreamBody`。

**半天(能独立维护)**
1. 上面全部;
2. `docs/UPSTREAM.md` 通读(**它是这个项目的核心资产**:所有"上游很怪"的实测记录都在这里);
3. `docs/MAINTENANCE.md` 的 18 步流程;
4. 跑 `pnpm test`,看 `tests/contract/` 里的用例怎么描述 HTTP 层行为。

---

## 六、Node 里 Java 没有的两个概念(只需知道存在)

1. **事件循环 + 单线程**:没有线程池。所有 IO 是异步的,`await` 挂起当前函数让出执行权。
   影响:代码里看不到线程,但**并发请求靠异步交错**处理。
2. **流(Stream)+ 背压**:SSE 是"边生成边推送"。`res.write()` 返回 false 表示
   下游没跟上(缓冲区满),要等 `drain` 事件。`src/api/responses.ts` 的
   `waitForDrain` 就是处理这个的——Java 里对应的概念大概是 Reactor 的 backpressure。
