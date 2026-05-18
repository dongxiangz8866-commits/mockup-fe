# 发布 / 部署指南

`mock-research` 是**纯前端 SPA**：`vite build` 产出静态 `dist/`，无后端，姿态/深度/头发的 AI 全在用户浏览器里跑。把 `dist/` 放到任意静态托管即可。

```bash
cd app
pnpm install
pnpm build        # 产物在 app/dist/
pnpm preview      # 本地预览生产包(默认 http://localhost:5174)
```

## 发布前必看（这个项目特有）

1. **图案/模特列表在生产是冻结的**。`/api/models`、`/api/patterns` 实时接口是 dev-only；生产读构建时烤进的 `__MODELS__/__PATTERNS__` 快照。**`pnpm build` 那一刻 `app/public/test-models`、`app/public/test-patterns` 里有什么，别人就看到什么**。换素材库 = 改这两个目录后重新 build。用户自己点「上传」临时换图在生产仍可用。

2. **`public/` 会被原样打包，当前 `dist/` ≈ 270MB**。Vite 把整个 `app/public/` 拷进 `dist/`，里面还含没用到的 `public/models/`(被隐藏的原图)、`public/mock-models/`、`sweatshirt.glb` 等。**强烈建议 build 前精简 `app/public/`**，只留 `test-models/`、`test-patterns/` 和真正引用的资源，否则部署体积和首屏都很重。

3. **运行时依赖外部 CDN**：姿态(MediaPipe)、深度(DAv2 / transformers.js)首次从 CDN 拉模型权重。目标用户网络要能访问这些 CDN，首次「解析模特图」会慢。

4. **浏览器要求**：需 WebGL2；深度最好有 WebGPU（否则退化到很慢的 WASM 单线程）。建议最新版 Chrome / Edge。

5. **路由**：用 `HashRouter`（`/#/`），**不需要任何 SPA 重写/fallback 规则**，任意子路径都能跑。

6. **跨源隔离（COOP/COEP）权衡**：onnxruntime 多线程 WASM 需要 `SharedArrayBuffer`，要设
   `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`。
   **但 `COEP:require-corp` 会拦截上面那些跨源 CDN 模型请求**（除非自托管权重或 CDN 回
   `Cross-Origin-Resource-Policy`），可能让所有人都分析失败。所以仓库里的配置**默认不开 COEP**
   （单线程，能用但慢）。只有在你把模型权重也自托管后，再放开 `netlify.toml` 里注释的那段。

## 各平台

仓库已带好配置，选一个：

| 平台 | 配置 | 操作 |
|---|---|---|
| **Netlify**（推荐） | `app/netlify.toml` | New site → 选仓库 → Base directory 填 `app` → Deploy。`_headers` 自动生效。 |
| **Vercel** | `app/vercel.json` | Import 仓库 → Root Directory 设为 `app` → Deploy。 |
| **Cloudflare Pages** | `app/public/_headers` | 连仓库 → Build cmd `pnpm build`、输出 `dist`、根目录 `app`。 |
| **GitHub Pages** | `.github/workflows/deploy-pages.yml` | 仓库 Settings → Pages → Source = GitHub Actions。push 到 `main` 或手动触发。已自动用仓库名设 `VITE_BASE`（项目页子路径），无需改 vite 配置。 |
| **任意静态服务器 / 对象存储** | — | 上传 `app/dist/` 全部内容；开 gzip/brotli + 缓存即可。 |

> 部署到**子路径**（如 GitHub Pages 项目页 `user.github.io/repo/`）必须设 `VITE_BASE=/repo/` 再 build——workflow 已自动处理；手动则 `VITE_BASE=/repo/ pnpm build`。根域名 / Netlify / Vercel 用默认 `/`。

## 缓存

`dist/assets/*` 是内容哈希文件 → `_headers` / `netlify.toml` / `vercel.json` 已设 1 年 immutable；其余 `no-cache`，重新部署即时生效。
