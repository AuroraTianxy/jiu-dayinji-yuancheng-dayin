import {createHash} from 'node:crypto';
import {validId, MAX_PDF_BYTES} from './queue.mjs';

export function serverUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('HTTPS_PRINT_SERVER_REQUIRED');
  return url.origin;
}
/** Backend only. Never pass this admin token to browser/mobile code. */
export function createPrintClient({url, token, fetchImpl = fetch}) {
  const base = serverUrl(url);
  if (typeof token !== 'string' || token.length < 32) throw new Error('INVALID_ADMIN_TOKEN');
  const request = async (path, init = {}) => {
    let response;
    try { response = await fetchImpl(base + path, {...init, redirect:'error', signal:AbortSignal.timeout(20_000),
      headers:{'content-type':'application/json', authorization:`Bearer ${token}`}}); }
    catch { throw new Error('PRINT_QUEUE_UNAVAILABLE_RETRY_SAME_JOB_ID'); }
    if (!response.ok) {
      // Do not reflect remote content (or PDF/credentials) in an application log.
      if (response.status === 409) throw new Error('PRINT_JOB_IDEMPOTENCY_CONFLICT');
      throw new Error(`PRINT_QUEUE_HTTP_${response.status}`);
    }
    return response.json();
  };
  return {
    async enqueuePdf({jobId, printerId, pdf}) {
      if (!validId(jobId) || !validId(printerId) || !(pdf instanceof Uint8Array) || pdf.byteLength < 5 ||
          pdf.byteLength > MAX_PDF_BYTES || Buffer.from(pdf).subarray(0,5).toString() !== '%PDF-') throw new Error('INVALID_PRINT_JOB');
      return request('/v1/jobs', {method:'POST', body:JSON.stringify({id:jobId, printerId,
        sha256:createHash('sha256').update(pdf).digest('hex'), pdfBase64:Buffer.from(pdf).toString('base64')})});
    },
    async getJob(jobId) { if (!validId(jobId)) throw new Error('INVALID_JOB_ID'); return request(`/v1/jobs/${jobId}`); },
  };
}
