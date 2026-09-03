import { createServer } from 'node:http';

const page = `<!doctype html>
<html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UDトーク → OBS</title>
<style>body{margin:2rem auto;max-width:54rem;font-family:system-ui,sans-serif;line-height:1.6}textarea{box-sizing:border-box;width:100%;height:12rem;font:1.5rem/1.6 system-ui,sans-serif;padding:1rem}#status{color:#167a36}</style>
<h1>UDトーク → OBS</h1><p>この入力欄をクリックしてフォーカスしたままにしてください。UDトーク文字入力から入力された文章をOBSへ送ります。</p>
<textarea id="caption" autofocus aria-label="UDトーク文字入力用"></textarea><p id="status">待機中</p>
<script>
const field = document.querySelector('#caption'); const status = document.querySelector('#status'); let timer;
field.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(send, 350); });
field.addEventListener('blur', () => setTimeout(() => field.focus(), 0));
async function send() { const text = field.value.trim(); if (!text) return; field.value = '';
  try { const response = await fetch('/caption', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})}); if (!response.ok) throw new Error(); status.textContent = 'OBSへ送信: ' + text; }
  catch { status.textContent = '送信に失敗しました。ブリッジが起動中か確認してください。'; }
  field.focus();
}
field.focus();
</script></html>`;

export function startTextInputServer({ port, onText, log = console }) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/caption') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) request.destroy();
    });
    request.on('end', () => {
      try {
        const text = String(JSON.parse(body).text || '').trim();
        if (!text) throw new Error('text is empty');
        onText(text);
        response.writeHead(204).end();
      } catch {
        response.writeHead(400).end('Invalid caption');
      }
    });
  });
  server.on('error', (error) => {
    log.error(`UDトーク文字入力ページを開始できません: ${error.message}`);
  });
  server.listen(port, '0.0.0.0', () => log.info(`UDトーク文字入力ページ: http://localhost:${port}`));
  return server;
}
