功能: 重写 CLAUDE.md + 加 SessionEnd 自动 stash hook

总结:
- /init 把 CLAUDE.md 从「no source code yet」占位重写成反映当前 app/ 实际架构的文档：两路 HashRouter (/shading + /displace)、textureStore 全局态 + rAF-coalesced 通知、三层缓存模板（mem → localStorage → build）+ 版本号 bump 约定、pose-before-maps 不变量、ShaderMaterial 不自动 sRGB 解码等坑
- 新建 .claude/settings.json（项目共享，入 git），加 SessionEnd hook：读 .claude/session-summary.md，把工作区做成带 `[session-end YYYY-MM-DD_HH:MM] <功能行>` 标签的 git stash，再 apply 回来不丢现场；空文件不触发
- CLAUDE.md 末尾追加「Session end checkpoint」段落，告诉未来的 Claude 实例何时写 summary 文件 + 怎么从 stash 里捞历史

TODO:
- 验证 hook 真的能在 session 关闭时跑起来：打开一次 /hooks 让 watcher 重载，或直接关掉重开
- 工作区当前一长串「app/ 删除：…」未提交，跟本 session 改动无关（HEAD 里还在）—— 决定下是 `git restore -- app/` 回来还是真要删
- 想清楚 /clear 是否也算 session-end —— 如果是，会在中途意外 stash；可以加个「60 秒内已有同名 stash 就跳过」的去重