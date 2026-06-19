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
const CLAUDE_API_URL = process.env.CLAUDE_API_URL || 'https://api.lmuai.ai/v1';
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

app.get('/api/messages/:sessionId', async (req, res) => {
  const { data, error } = await supabase.from('messages').select('*').eq('session_id', req.params.sessionId).eq('visible', true).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

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

app.post('/api/chat', async (req, res) => {
  const { message, session_id, model } = req.body;
  if (!message || !session_id) return res.status(400).json({ error: 'missing message or session_id' });

  try {
    await supabase.from('messages').insert({ session_id, role: 'user', content: message });
    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    const { data: settings } = await supabase.from('settings').select('*').single();
    const maxRounds = settings ? settings.max_context_rounds : 20;
    const systemPrompt = settings ? settings.system_prompt : '';
    const maxTokens = settings ? settings.max_reply_tokens : 4096;

    const { data: history } = await supabase.from('messages').select('*').eq('session_id', session_id).eq('visible', true).order('created_at', { ascending: true });
    const recent = (history || []).slice(-(maxRounds * 2));

    const memories = await callOmbreTool('breath', { query: message, max_results: 5 });

    let system = systemPrompt || '';
    if (memories) { system += '\n\n[相关记忆]\n' + memories; }

    const messages = recent.map(m => ({ role: m.role, content: m.content }));

    const useModel = model || 'claude-opus-4-6';
    const apiResp = await axios.post(CLAUDE_API_URL + '/messages', {
      model: useModel,
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 10000 },
      system: system,
      messages: messages,
      tools: [HOLD_TOOL]
    }, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      timeout: 120000
    });

    let reply = '';
    let thinking = '';
    const toolCalls = [];

    for (const block of apiResp.data.content) {
      if (block.type === 'text') reply += block.text;
      if (block.type === 'thinking') thinking += block.thinking;
      if (block.type === 'tool_use') toolCalls.push(block);
    }

    for (const tc of toolCalls) {
      if (tc.name === 'hold') {
        await callOmbreTool('hold', tc.input);
      }
    }

    if (toolCalls.length > 0 && !reply) {
      const toolResults = toolCalls.map(tc => ({ type: 'tool_result', tool_use_id: tc.id, content: 'done' }));
      const followUp = await axios.post(CLAUDE_API_URL + '/messages', {
        model: useModel, max_tokens: 16000, thinking: { type: "enabled", budget_tokens: 10000 }, system: system,
        messages: [...messages, { role: 'assistant', content: apiResp.data.content }, { role: 'user', content: toolResults }],
        tools: [HOLD_TOOL]
      }, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        timeout: 120000
      });
      for (const block of followUp.data.content) {
        if (block.type === 'text') reply += block.text;
        if (block.type === 'thinking') thinking += block.thinking;
      }
    }

    await supabase.from('messages').insert({ session_id, role: 'assistant', content: reply, reasoning_content: thinking || null });

    res.json({ reply, thinking: thinking || null, model: useModel });
  } catch (err) {
    console.error('Chat error:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: err.response ? JSON.stringify(err.response.data) : err.message });
  }
});

app.listen(port, () => console.log('Server running on port ' + port));
