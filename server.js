const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_API_URL = process.env.CLAUDE_API_URL || 'https://api.lmuai.com/v1';
const OMBRE_BRAIN_URL = process.env.OMBRE_BRAIN_URL || 'https://ombre-brain-xiao.zeabur.app';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let ombreSessionId = null;
let ombreCallId = 0;

function parseSSEResponse(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.substring(6)); } catch (e) {}
    }
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function initOmbreSession() {
  try {
    const resp = await axios.post(OMBRE_BRAIN_URL + '/mcp', {
      jsonrpc: "2.0", method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ombre-chat", version: "1.0" } },
      id: ++ombreCallId
    }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' } });
    ombreSessionId = resp.headers['mcp-session-id'];
    await axios.post(OMBRE_BRAIN_URL + '/mcp', {
      jsonrpc: "2.0", method: "notifications/initialized"
    }, { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': ombreSessionId } });
    console.log('Ombre Brain connected');
    return true;
  } catch (err) {
    console.error('MCP init failed:', err.message);
    ombreSessionId = null;
    return false;
  }
}

async function callOmbreTool(toolName, args = {}) {
  if (!OMBRE_BRAIN_URL) return null;
  try {
    if (!ombreSessionId) { if (!await initOmbreSession()) return null; }
    const resp = await axios.post(OMBRE_BRAIN_URL + '/mcp', {
      jsonrpc: "2.0", method: "tools/call",
      params: { name: toolName, arguments: args },
      id: ++ombreCallId
    }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': ombreSessionId },
      transformResponse: [(data) => data]
    });
    const parsed = parseSSEResponse(resp.data);
    if (parsed && parsed.result && parsed.result.content) {
      return parsed.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    }
    return parsed ? JSON.stringify(parsed) : null;
  } catch (err) {
    console.error('MCP ' + toolName + ' failed:', err.message);
    ombreSessionId = null;
    return null;
  }
}

const HOLD_TOOL = {
  name: "hold",
  description: "存储一条记忆。记录值得记住的瞬间、感受或重要信息。tags逗号分隔,importance 1-10,feel=true写第一人称感受。",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "记忆内容" },
      tags: { type: "string", description: "标签逗号分隔" },
      importance: { type: "integer", description: "重要度1-10" },
      feel: { type: "boolean", description: "是否为第一人称感受" }
    },
    required: ["content"]
  }
};

app.get('/health', (req, res) => res.json({ status: 'ok', ombre: !!ombreSessionId }));

// === 会话管理 ===
app.get('/api/sessions', async (req, res) => {
  const { data, error } = await supabase.from('sessions').select('*').order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/sessions', async (req, res) => {
  const { data, error } = await supabase.from('sessions').insert({ name: req.body.name || '新对话' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/sessions/:id', async (req, res) => {
  const { data, error } = await supabase.from('sessions').update({ name: req.body.name, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/sessions/:id', async (req, res) => {
  const { error } = await supabase.from('sessions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// === 消息 ===
app.get('/api/messages/:sessionId', async (req, res) => {
  const { data, error } = await supabase.from('messages').select('*').eq('session_id', req.params.sessionId).eq('visible', true).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 这个是Bug2的修复——前端一直在调这个路由但之前不存在
app.post('/api/save-message', async (req, res) => {
  const { session_id, role, content, reasoning_content } = req.body;
  if (!session_id || !role) return res.status(400).json({ error: 'missing session_id or role' });
  const insert = { session_id, role, content: content || '' };
  if (reasoning_content) insert.reasoning_content = reasoning_content;
  const { error } = await supabase.from('messages').insert(insert);
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);
  res.json({ success: true });
});

// === 记忆 ===
app.get('/api/memory', async (req, res) => {
  const query = req.query.query || '';
  if (!query) return res.json({ memory: '' });
  const result = await callOmbreTool('breath', { query, max_results: 5 });
  res.json({ memory: result || '' });
});

app.post('/api/tool', async (req, res) => {
  const { name, input } = req.body;
  if (!name) return res.status(400).json({ error: 'missing tool name' });
  const result = await callOmbreTool(name, input || {});
  res.json({ result: result || 'done' });
});

// === 设置 ===
app.get('/api/settings', async (req, res) => {
  const { data, error } = await supabase.from('settings').select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/settings', async (req, res) => {
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('settings').update(updates).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// === 原始代理（前端直连用） ===
app.post('/api/raw-proxy', (req, res) => {
  const https = require('https');
  const body = JSON.stringify(req.body);
  const opts = {
    hostname: 'api.lmuai.com', port: 443, path: '/v1/messages', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' }
  };
  const proxyReq = https.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, 'Access-Control-Allow-Origin': '*' });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => { res.writeHead(502); res.end('error'); });
  proxyReq.write(body);
  proxyReq.end();
});

app.listen(port, () => console.log('Server running on port ' + port));

