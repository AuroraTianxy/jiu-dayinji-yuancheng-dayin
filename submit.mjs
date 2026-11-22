import {readFile} from 'node:fs/promises';
import {createPrintClient} from './print-client.mjs';

const [printerId, jobId, file] = process.argv.slice(2);
try {
  if (!printerId || !jobId || !file || process.argv.length !== 5) throw new Error('USAGE');
  const client = createPrintClient({url:process.env.REMOTE_PRINT_SERVER_URL, token:process.env.REMOTE_PRINT_ADMIN_TOKEN});
  const result = await client.enqueuePdf({printerId, jobId, pdf:await readFile(file)});
  console.log(JSON.stringify({created:result.created,job:result.job}));
} catch (error) {
  console.error(error.message === 'USAGE' ? '用法：node submit.mjs <打印点ID> <唯一任务ID> <PDF文件路径>' :
    'PRINT_SUBMIT_FAILED：检查配置/文件/队列；重试必须沿用原任务ID。');
  process.exitCode=1;
}
