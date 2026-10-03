/** Bearer 鉴权的 SSE；事件仅触发 REST 补读，不直接改会话事实。 */
(function exposeRealtime() {
  function decoder(onFrame) {
    let buffer = '', lines = [];
    return chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) throw new Error('实时帧过大');
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        if (line) { lines.push(line); continue; }
        const data = lines.filter(row => row.startsWith('data:')).map(row => row.slice(5).replace(/^ /, '')).join('\n');
        lines = [];
        if (!data) continue;
        let frame;
        try { frame = JSON.parse(data); } catch { continue; }
        if (typeof frame?.event_type === 'string' && typeof frame?.event_id === 'string' && frame.data) onFrame(frame);
      }
    };
  }

  function subscribe(api, onFrame, onState) {
    let stopped = false, controller, retry, watchdog, rotation, attempt = 0, reconnect = false;
    async function connect() {
      if (stopped) return;
      controller = new AbortController();
      watchdog = setTimeout(() => controller.abort(), 45000);
      let reader;
      onState('connecting');
      try {
        const response = await api.realtimeResponse(controller.signal, reconnect);
        if (stopped) return;
        if ([401, 403].includes(response.status)) {
          if (response.status === 401) api.clearToken();
          stopped = true; onState('unauthorized'); return;
        }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('实时连接失败');
        reconnect = true;
        clearTimeout(watchdog);
        let lastSeen = Date.now();
        const accept = decoder(frame => { lastSeen = Date.now(); attempt = 0; onFrame(frame); });
        watchdog = setInterval(() => { if (Date.now() - lastSeen > 45000) controller.abort(); }, 5000);
        // 定期重新鉴权，避免长期连接继续使用已失效的权限。
        rotation = setTimeout(() => controller.abort(), 5 * 60 * 1000);
        onState('connected');
        reader = response.body.getReader();
        const utf8 = new TextDecoder();
        while (!stopped) {
          const part = await reader.read();
          if (part.done) break;
          accept(utf8.decode(part.value, { stream: true }));
        }
      } catch (error) {
        if (!stopped) console.warn('实时连接中断，等待重连', error.message);
      } finally {
        clearTimeout(watchdog); clearInterval(watchdog); clearTimeout(rotation);
        await reader?.cancel().catch(() => {});
        controller.abort();
        if (!stopped) {
          onState('reconnecting');
          retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)));
        }
      }
    }
    void connect();
    return () => { stopped = true; clearTimeout(retry); clearInterval(watchdog); clearTimeout(rotation); controller?.abort(); };
  }
  window.KefuRealtime = Object.freeze({ decoder, subscribe });
})();
