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

let memoryCache = '';
let memoryFetching = false;

function fetchMemoryAsync(query) {
  memoryFetching = true;
  callOmbreTool('breath', { query, max_results: 5 }).then(result => {
    if (result) memoryCache = result;
    memoryFetching = false;
  }).catch(() => { memoryFetching = false; });
}

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
  const { message, session_id, model, thinking } = req.body;
  if (!message || !session_id) return res.status(400).json({ error: 'missing' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const t0 = Date.now();
    await supabase.from('messages').insert({ session_id, role: 'user', content: message });
    await supabase.from('sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id);

    const { data: settings } = await supabase.from('settings').select('*').single();
    const maxRounds = settings ? settings.max_context_rounds : 20;
    const systemPrompt = settings ? settings.system_prompt : '';
    const maxTokens = settings ? settings.max_reply_tokens : 4096;

    const { data: history } = await supabase.from('messages').select('*').eq('session_id', session_id).eq('visible', true).order('created_at', { ascending: true });
    const recent = (history || []).slice(-(maxRounds * 2));

    console.log('db done:', Date.now() - t0, 'ms');
    const memories = memoryCache;
    fetchMemoryAsync(message);
    console.log('breath skipped, using cache:', Date.now() - t0, 'ms');
    let system = systemPrompt || '';
    if (memories) { system += '\n\n[相关记忆]\n' + memories; }

    const msgs = recent.map(m => ({ role: m.role, content: m.content }));
    const useModel = model || 'claude-opus-4-6';

    const apiBody = { model: useModel, max_tokens: thinking ? 16000 : maxTokens, stream: true, system, messages: msgs, tools: [HOLD_TOOL] };
    if (thinking) { apiBody.thinking = { type: 'enabled', budget_tokens: 5000 }; }

    console.log('calling claude:', Date.now() - t0, 'ms');
    const streamResp = await fetch(CLAUDE_API_URL + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
      body: JSON.stringify(apiBody)
    });

    if (!streamResp.ok) {
      const errText = await streamResp.text();
      res.write('event: error\ndata: ' + JSON.stringify({ error: errText }) + '\n\n');
      res.end(); return;
    }

    let fullReply = '', fullThinking = '';
    let toolCalls = [], currentToolInput = '', currentToolId = '', currentToolName = '', currentBlockType = '';
    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.substring(6).trim();
        if (d === '[DONE]') continue;
        let ev; try { ev = JSON.parse(d); } catch(e) { continue; }

        if (ev.type === 'content_block_start') {
          if (ev.content_block.type === 'thinking') currentBlockType = 'thinking';
          else if (ev.content_block.type === 'text') currentBlockType = 'text';
          else if (ev.content_block.type === 'tool_use') {
            currentBlockType = 'tool_use'; currentToolId = ev.content_block.id;
            currentToolName = ev.content_block.name; currentToolInput = '';
          }
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'thinking_delta') { fullThinking += ev.delta.thinking; res.write('event: thinking\ndata: ' + JSON.stringify({text:ev.delta.thinking}) + '\n\n'); }
          else if (ev.delta.type === 'text_delta') { fullReply += ev.delta.text; res.write('event: text\ndata: ' + JSON.stringify({text:ev.delta.text}) + '\n\n'); }
          else if (ev.delta.type === 'input_json_delta') { currentToolInput += ev.delta.partial_json; }
        } else if (ev.type === 'content_block_stop') {
          if (currentBlockType === 'tool_use') {
            let pi = {}; try { pi = JSON.parse(currentToolInput); } catch(e) {}
            toolCalls.push({ id: currentToolId, name: currentToolName, input: pi });
          }
          currentBlockType = '';
        }
      }
    }

    for (const tc of toolCalls) { if (tc.name === 'hold') await callOmbreTool('hold', tc.input); }

    if (toolCalls.length > 0 && !fullReply) {
      const toolResults = toolCalls.map(tc => ({ type: 'tool_result', tool_use_id: tc.id, content: 'done' }));
      const ac = [];
      if (fullThinking) ac.push({ type: 'thinking', thinking: fullThinking });
      for (const tc of toolCalls) ac.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      const fb = { model: useModel, max_tokens: thinking ? 16000 : maxTokens, stream: true, system, messages: [...msgs, {role:'assistant',content:ac}, {role:'user',content:toolResults}], tools: [HOLD_TOOL] };
      if (thinking) fb.thinking = { type: 'enabled', budget_tokens: 5000 };
      const fr = await fetch(CLAUDE_API_URL + '/messages', { method:'POST', headers:{'Content-Type':'application/json','x-api-key':CLAUDE_API_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31'}, body:JSON.stringify(fb) });
      if (fr.ok) {
        const r2 = fr.body.getReader(); let b2 = '';
        while (true) {
          const {done,value} = await r2.read(); if (done) break;
          b2 += decoder.decode(value,{stream:true}); const ls = b2.split('\n'); b2 = ls.pop();
          for (const l of ls) { if (!l.startsWith('data: ')) continue; const dd=l.substring(6).trim(); if(dd==='[DONE]')continue; let e2; try{e2=JSON.parse(dd);}catch(e){continue;}
            if(e2.type==='content_block_delta'){if(e2.delta.type==='thinking_delta'){fullThinking+=e2.delta.thinking;res.write('event: thinking\ndata: '+JSON.stringify({text:e2.delta.thinking})+'\n\n');}else if(e2.delta.type==='text_delta'){fullReply+=e2.delta.text;res.write('event: text\ndata: '+JSON.stringify({text:e2.delta.text})+'\n\n');}}
          }
        }
      }
    }

    await supabase.from('messages').insert({ session_id, role: 'assistant', content: fullReply, reasoning_content: fullThinking || null });
    res.write('event: done\ndata: {}\n\n');
    res.end();
  } catch (err) {
    console.error('Chat error:', err.message);
    res.write('event: error\ndata: ' + JSON.stringify({error:err.message}) + '\n\n');
    res.end();
  }
});

app.listen(port, () => console.log('Server running on port ' + port));
