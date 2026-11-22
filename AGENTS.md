# 旧打印机远程打印接入指南

先看 [README](README.md) 的服务与打印点配置。服务接收 PDF，Windows 客户端主动领取并调用本机打印驱动。

## 接入现有系统

使用 [print-client.mjs](print-client.mjs) 的 `createPrintClient({ url, token })`。令牌由调用系统的后端读取。传给 `enqueuePdf({ jobId, printerId, pdf })` 的 `pdf` 是读取本地文件后得到的字节，最大 10 MiB。也可直接使用 [提交命令](submit.mjs)。

```js
import { readFile } from 'node:fs/promises';
import { createPrintClient } from './print-client.mjs';

const client = createPrintClient({
  url: process.env.REMOTE_PRINT_SERVER_URL,
  token: process.env.REMOTE_PRINT_ADMIN_TOKEN
});

const result = await client.enqueuePdf({
  jobId: 'demo-2026-01',
  printerId: 'office',
  pdf: await readFile('./generated-demo.pdf')
});
const { job } = await client.getJob(result.job.id);
console.log(job.status);
```

在命令行用 `node submit.mjs office demo-2026-01 ./generated-demo.pdf`，环境变量与上面一致。这条命令会创建可被客户端领取的任务。自动化测试用临时目录、本机回环地址和模拟驱动。

HTTP 接口如下。所有提交、查询与领取请求都使用对应的 Bearer 令牌。

| 方法及路径 | 调用者 | 内容 |
| --- | --- | --- |
| `POST /v1/jobs` | 提交端 | `{ id, printerId, sha256, pdfBase64 }`。新任务返回 201，同 ID 同 PDF 同打印点返回 200 |
| `GET /v1/jobs/{id}` | 提交端 | 返回 `{ job }`，其中 `status` 表示当前队列状态 |
| `POST /v1/agent/claim` | Windows 客户端 | `{ agentId }`，无任务时返回 204 |
| `POST /v1/agent/jobs/{id}/result` | Windows 客户端 | `{ agentId, status, errorCode? }`，回报驱动提交结果 |

重新提交同一次打印时，保存并沿用原来的任务 ID，避免打出重复页。用新 ID 代表操作者明确要求重打一份。若 `status` 为 `unknown`，先让使用者核对现场。示例用虚构文件和数据，提交令牌、领取令牌与待打印文件都留在使用者自己的运行环境。

实现入口见 [server.mjs](server.mjs) 与 [agent.mjs](agent.mjs)。运行 `npm test` 验证改动。
