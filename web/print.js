const token = document.querySelector('#token');
const printer = document.querySelector('#printer');
const pdf = document.querySelector('#pdf');
const job = document.querySelector('#job');
const submit = document.querySelector('#submit');
const newJob = document.querySelector('#new');
const query = document.querySelector('#query');
const submitStatus = document.querySelector('#submit-status');
const jobStatus = document.querySelector('#job-status');

const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const statusText = {
  queued: '已排队，等待旧电脑领取',
  claimed: '旧电脑已领取，等待回执',
  submitted: '已交给 Windows 打印队列，请在现场确认出纸',
  unknown: '结果待确认，请核对打印机后再补打',
  failed: '客户端报告失败'
};
let pendingId;
let confirmed = false;

async function request(path, options = {}) {
  const credential = token.value.trim();
  if (!credential) throw new Error('请输入提交令牌。');
  let response;
  try {
    response = await fetch(path, {
      ...options,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }
    });
  } catch {
    throw new Error('连接未完成，请查询任务或用同一任务重试。');
  }
  if (response.status === 401) throw new Error('提交令牌无效。');
  if (response.status === 404) throw new Error('队列中暂无这个任务。');
  if (response.status === 409) throw new Error('这个任务 ID 已关联另一份文件或打印点。');
  if (!response.ok) throw new Error(`服务未受理请求（HTTP ${response.status}），请核对配置和任务状态。`);
  return response.json();
}

function describe(result) {
  return `${statusText[result.status] ?? '状态待确认'} · ${result.id}`;
}

submit.addEventListener('click', async () => {
  if (submit.disabled) return;
  submitStatus.textContent = '';
  const file = pdf.files?.[0];
  const printerId = printer.value.trim();
  if (!idPattern.test(printerId) || !file || file.size < 5 || file.size > 10 * 1024 * 1024) {
    submitStatus.textContent = '请填写有效的打印点 ID，并选择不超过 10 MiB 的 PDF。';
    return;
  }
  if (!token.value.trim()) {
    submitStatus.textContent = '请输入提交令牌。';
    return;
  }
  if (!globalThis.crypto?.subtle) {
    submitStatus.textContent = '请用 HTTPS 或本机地址打开提交页。';
    return;
  }
  submit.disabled = newJob.disabled = printer.disabled = pdf.disabled = true;
  try {
    pendingId ??= crypto.randomUUID();
    job.value = pendingId;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('请选择 PDF 文件。');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = Array.from(hash, value => value.toString(16).padStart(2, '0')).join('');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    const { job: result } = await request('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ id: pendingId, printerId, sha256, pdfBase64: btoa(binary) })
    });
    confirmed = true;
    submitStatus.textContent = describe(result);
  } catch (error) {
    submitStatus.textContent = `${error.message} 任务 ID：${pendingId ?? '待生成'}`;
  } finally {
    submit.disabled = confirmed;
    newJob.disabled = false;
  }
});

newJob.addEventListener('click', () => {
  pendingId = undefined;
  confirmed = false;
  submit.disabled = printer.disabled = pdf.disabled = false;
  newJob.disabled = true;
  pdf.value = '';
  submitStatus.textContent = '';
  pdf.focus();
});

query.addEventListener('click', async () => {
  const id = job.value.trim();
  if (!idPattern.test(id)) {
    jobStatus.textContent = '请输入有效的任务 ID。';
    return;
  }
  query.disabled = true;
  try {
    const { job: result } = await request(`/v1/jobs/${id}`);
    jobStatus.textContent = describe(result);
  } catch (error) {
    jobStatus.textContent = error.message;
  } finally {
    query.disabled = false;
  }
});
