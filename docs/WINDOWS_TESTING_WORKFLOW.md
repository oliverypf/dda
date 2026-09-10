# Windows 测试执行约定

## 默认规则

Windows Phase 1 的相互独立测试套件必须并行启动，以缩短反馈时间；不要因为等待一个慢套件而串行等待其他套件。每个套件仍须完整收集输出，任一套件失败时总命令返回非零。

统一入口（在 `desktop` 目录执行）：

```powershell
npm run test:all:parallel
```

该入口同时运行：

- runtime `npm test` / `npm run test:parallel`（Node test concurrency=6）；
- desktop Vitest `npm test`；
- TypeScript `npm exec -- tsc --noEmit`；
- Tauri Rust `cargo test --lib`。

不要把并行理解为共享状态可以同时写入：每个测试套件必须使用临时/隔离 store。默认 `hmcodex.db`、线程文件和安装目录不能被多个会改变它们的测试同时使用；发现共享状态时，应先为测试提供独立目录或降低该套件内部并发。

## UI 测试

UI 测试会启动并终止同一个安装版进程，并使用默认本地数据目录，因此 `test:ui:task`、`test:ui:disconnect` 和 `test:ui:streaming` 不能彼此并行。它们应在上述单元/静态/Rust 套件并行完成后按顺序执行；每个脚本内部的轮询和采样不应改回全量重渲染。

## 失败与报告

- 并行任务不得在首个失败后提前退出，必须等待其他任务结束并报告各自 exit code；
- 报告记录每个套件的开始/结束时间、耗时和结果；
- 需要确定性诊断时，可单独重跑失败套件，但最终发布验收仍需使用并行入口加对应 UI 回归。
- runtime 若必须定位并发相关问题，才显式使用 `npm run test:serial`；这不是默认验收路径。
