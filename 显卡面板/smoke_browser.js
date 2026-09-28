const { spawn } = require('child_process');
const http = require('http');
const { chromium } = require('C:/Users/LQL/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

async function main() {
  const engine = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({data:[{id:'qwen',owned_by:'vllm',max_model_len:163840}]}));
    }
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', 'text/plain');
      return res.end('vllm:num_requests_running{engine="0"} 2\n' +
        'vllm:num_requests_waiting{engine="0"} 1\n' +
        'vllm:kv_cache_usage_perc{engine="0"} 0.375\n' +
        'vllm:generation_tokens_total{engine="0"} 100\n');
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      setTimeout(() => res.end('data: {"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n'), 1500);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => engine.listen(19999, '127.0.0.1', resolve));
  const python = 'C:/Users/LQL/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  const child = spawn(python, ['-B', 'gpu_panel_unified.py', '18981'], {
    cwd: __dirname,
    env: { ...process.env, LLM_URL: 'http://127.0.0.1:19999',
      LLM_PROXY_PORT: '18982', LLM_PROXY_HOST: '127.0.0.1',
      LLM_PROBE_INTERVAL: '0', CSV_INTERVAL: '0',
      PANEL_HOST: '127.0.0.1' },
    windowsHide: true,
  });
  let browser;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch('http://127.0.0.1:18981/api/health');
        if (response.ok) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:18981/', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('llm_title').textContent === 'vLLM 推理');
    const state = await page.locator('#ov_state').textContent();
    const requests = await page.locator('#ov_slots').textContent();
    const chips = await page.locator('#llama_chips').textContent();
    if (errors.length) throw new Error(errors.join('\n'));
    if (!requests.includes('2') || !requests.includes('1 排队') || !chips.includes('37.5%')) {
      throw new Error('Native metrics missing: ' + JSON.stringify({requests,chips}));
    }
    console.log('Browser first frame:', state, '|', requests, '| KV 37.5%');
    const start = Date.now();
    const response = await fetch('http://127.0.0.1:18982/v1/chat/completions', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'qwen',stream:true,messages:[{role:'user',content:'hi'}]})
    });
    const first = await response.body.getReader().read();
    const firstMs = Date.now() - start;
    if (!new TextDecoder().decode(first.value || new Uint8Array()).includes('hello') || firstMs > 800) {
      throw new Error('SSE first chunk delayed: ' + firstMs + ' ms');
    }
    console.log('Proxy SSE first chunk:', firstMs, 'ms');
  } finally {
    if (browser) await browser.close();
    child.kill();
    engine.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
