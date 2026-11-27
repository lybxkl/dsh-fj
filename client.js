/**
 * 格式匠论文助手 · Client 半片（单文件、零构建）
 *
 * 只做加法：插件页给一张连接卡，对话里给三类工具卡（状态行、套版方案、提交检查）。
 * 颜色一律走宿主主题令牌，不写死十六进制；数据只从同源接口 /geshijiang/api 读。
 *
 * 卡片只能显示与发请求，不能调用 MCP 工具：按钮要么走本插件的同源接口（打开格式匠、导出诊断），
 * 要么把下一步交回对话（套版由模型带着令牌直接建分支）。不做点了没反应的按钮。
 */
(function () {
  var MODULE_ID = '@local/geshijiang-assistant';
  var API = '/geshijiang/api';

  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: function factory(require) {
      var React = require('react');
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var useRef = React.useRef;

      /* ------------------------------------------------------------------ *
       * 数据
       * ------------------------------------------------------------------ */

      /**
       * 读插件状态。
       *
       * 以前失败只把计数加一，界面上永远停在「正在读取」——一个 404 看起来和
       * 「宿主忙」完全一样，排障时没有任何线索。现在把失败原因带出来，页面渲染
       * 时直接显示，并给一个「重试」按钮。
       */
      function useGeshijiangState(active) {
        var pair = useState(null);
        var state = pair[0];
        var setState = pair[1];
        var errPair = useState('');
        var error = errPair[0];
        var setError = errPair[1];
        // 重试令牌：加一就重跑下面的 effect（清掉退避、立刻再问一次）。
        var retryPair = useState(0);
        var retryToken = retryPair[0];
        var setRetryToken = retryPair[1];
        var alive = useRef(true);
        useEffect(function () {
          alive.current = true;
          if (!active) return function () { alive.current = false; };
          var timer = null;
          var inFlight = false;
          var failures = 0;
          var ticks = 0;

          function visible() {
            // 页面切到后台就别再问了：插件页看不见时刷新没人看，也白占本机资源。
            try {
              return typeof document === 'undefined' || document.visibilityState !== 'hidden';
            } catch (error) {
              return true;
            }
          }

          function tick() {
            ticks += 1;
            if (!alive.current || inFlight) return;
            if (!visible()) return;
            // 连续失败三次以后降到每三拍问一次（8 秒 → 24 秒），别在断线时空转。
            if (failures >= 3 && ticks % 3 !== 0) return;
            inFlight = true;
            requestJson('/state')
              .then(function (body) {
                if (!alive.current) return;
                failures = 0;
                setError('');
                if (body && body.state) setState(body.state);
              })
              .catch(function (failure) {
                if (!alive.current) return;
                failures += 1;
                var reason = describeError(failure);
                setError(reason);
                // 每 10 次记一条就够：轮询失败会一直重复，日志刷屏反而没人看。
                if (failures === 1 || failures % 10 === 0) {
                  try { console.warn('[geshijiang] 读取插件状态失败：' + reason); } catch (e) { /* 没 console 的环境忽略 */ }
                }
              })
              .then(function () { inFlight = false; });
          }

          tick();
          timer = setInterval(tick, 8000);

          function onVisibility() {
            if (visible() && alive.current) {
              failures = 0;
              tick();
            }
          }
          try {
            document.addEventListener('visibilitychange', onVisibility);
          } catch (error) {
            /* 没有 document 的环境不需要监听 */
          }
          return function () {
            alive.current = false;
            if (timer) clearInterval(timer);
            try {
              document.removeEventListener('visibilitychange', onVisibility);
            } catch (error) {
              /* ignore */
            }
          };
        }, [active, retryToken]);
        return {
          state: state,
          error: error,
          setState: setState,
          retry: function () { setRetryToken(retryToken + 1); },
        };
      }

      /** 把失败翻译成用户能读懂、排障时也用得上的一句话。 */
      function describeError(error) {
        if (!error) return '未知原因';
        if (error.name === 'AbortError') return '请求超时：宿主 10 秒内没有响应';
        var message = String(error.message || error);
        return error.status ? 'HTTP ' + error.status + '（' + API + '/state）：' + message : message;
      }

      /**
       * 同源请求。带 10 秒上限：宿主忙或者接口卡住时，按钮必须能回到可点状态，
       * 不能让一次 fetch 把按钮永久禁用（那看起来就是「卡死」）。
       */
      function requestJson(action, options, timeoutMs) {
        var limit = Number(timeoutMs) || 10000;
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = setTimeout(function () { if (controller) controller.abort(); }, limit);
        var init = {
          method: (options && options.method) || 'GET',
          headers: { accept: 'application/json' },
        };
        if (controller) init.signal = controller.signal;
        if (init.method !== 'GET') {
          init.headers = { accept: 'application/json', 'content-type': 'application/json' };
          init.body = JSON.stringify((options && options.body) || {});
        }
        return fetch(API + action, init).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            var value = body || {};
            // 404/500 不能当成「空状态」：把它变成一条带状态码的错误，页面才有话可说。
            if (!res.ok) {
              var failure = new Error(value.error || ('接口返回 ' + res.status));
              failure.status = res.status;
              throw failure;
            }
            return value;
          });
        }).then(
          function (body) { clearTimeout(timer); return body; },
          function (error) {
            clearTimeout(timer);
            throw error;
          },
        );
      }

      function post(action, payload) {
        return requestJson(action, { method: 'POST', body: payload || {} });
      }

      /* ------------------------------------------------------------------ *
       * 工具结果
       * ------------------------------------------------------------------ */

      function textOf(block) {
        var content = block && block.content;
        if (!Array.isArray(content)) return '';
        return content
          .filter(function (item) { return item && item.type === 'text' && typeof item.text === 'string'; })
          .map(function (item) { return item.text; })
          .join('\n');
      }

      /** MCP 结果常把结构化内容塞在文本块里；解析不了就当纯文本读，不假装有结构。 */
      function parseJson(text) {
        var trimmed = String(text || '').trim();
        if (!trimmed) return null;
        var candidates = [trimmed];
        var start = trimmed.indexOf('{');
        var end = trimmed.lastIndexOf('}');
        if (start > 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
        for (var i = 0; i < candidates.length; i += 1) {
          try {
            var value = JSON.parse(candidates[i]);
            if (value && typeof value === 'object') return value.result && typeof value.result === 'object' ? value.result : value;
          } catch (error) {
            /* 换下一个候选 */
          }
        }
        return null;
      }

      /**
       * MCP 工具结果外面还有一层信封 `{ data, status, summary, trace, warnings }`：
       * 卡片要读的是 `data` 里那一份。少了这层拆包，套版卡会显示「未解析」、
       * 检查卡会显示 0 条——真机上就是这么翻车的。
       */
      function unwrap(value) {
        if (value && typeof value === 'object' && value.data && typeof value.data === 'object') return value.data;
        return value;
      }

      /** 结果块可能很大：同一段文本只解析一次，别让重绘（比如切筛选）反复解析。 */
      function useParsedResult(phase, text) {
        var cache = useRef({ text: null, value: null });
        if (cache.current.text !== text) cache.current = { text: text, value: parseJson(text) };
        return phase === 'result' ? cache.current.value : null;
      }

      function pick(object, paths) {
        for (var i = 0; i < paths.length; i += 1) {
          var cursor = object;
          var parts = paths[i].split('.');
          var found = true;
          for (var j = 0; j < parts.length; j += 1) {
            if (cursor == null || typeof cursor !== 'object') { found = false; break; }
            cursor = cursor[parts[j]];
          }
          if (found && cursor !== undefined && cursor !== null && cursor !== '') return cursor;
        }
        return undefined;
      }

      function shorten(value, max) {
        var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
        return text.length > max ? text.slice(0, max) + '…' : text;
      }

      /** 复制到剪贴板：拿不到权限就返回 false，由调用方显示失败文案，不假装成功。 */
      function copyText(value) {
        try {
          var clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
          if (clipboard && typeof clipboard.writeText === 'function') {
            return clipboard.writeText(String(value)).then(
              function () { return true; },
              function () { return false; },
            );
          }
        } catch (error) {
          /* 走降级分支 */
        }
        return Promise.resolve(false);
      }

      /* ------------------------------------------------------------------ *
       * 视觉
       * ------------------------------------------------------------------ */

      var CSS = [
        '.geshijiang{--geshijiang-line:var(--dsw-alias-border-l1,rgba(128,128,128,.28));',
        '  --geshijiang-bg:var(--dsw-alias-bg-layer-1,transparent);',
        '  --geshijiang-ink:var(--dsw-alias-label-primary,currentColor);',
        '  --geshijiang-ink2:var(--dsw-alias-label-secondary,currentColor);',
        '  --geshijiang-ok:var(--dsw-alias-state-success-primary,#3f9d6f);',
        '  --geshijiang-warn:var(--dsw-alias-state-warn-primary,#b9882f);',
        '  --geshijiang-err:var(--dsw-alias-state-error-primary,#c85858);',
        '  --geshijiang-brand:var(--dsw-alias-brand-primary,#5b7cfa);',
        '  color:var(--geshijiang-ink);font-size:13px;line-height:1.55;}',
        '.geshijiang *{box-sizing:border-box;}',
        '.geshijiang-card{background:var(--geshijiang-bg);border:.5px solid var(--geshijiang-line);border-radius:12px;overflow:hidden;}',
        '.geshijiang-head{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:.5px solid var(--geshijiang-line);}',
        '.geshijiang-title{font-size:13px;font-weight:600;}',
        '.geshijiang-right{margin-left:auto;font-size:12px;color:var(--geshijiang-ink2);text-align:right;}',
        '.geshijiang-body{padding:0 14px;}',
        '.geshijiang-group{padding:11px 0;border-top:.5px solid var(--geshijiang-line);}',
        '.geshijiang-group:first-child{border-top:none;}',
        '.geshijiang-k{font-size:12px;color:var(--geshijiang-ink2);}',
        '.geshijiang-v{margin-top:3px;font-size:13px;}',
        '.geshijiang-meta{margin-top:2px;font-size:12px;color:var(--geshijiang-ink2);}',
        '.geshijiang-foot{display:flex;align-items:center;gap:8px;padding:11px 14px;border-top:.5px solid var(--geshijiang-line);}',
        '.geshijiang-grow{flex:1;}',
        '.geshijiang-btn{height:30px;padding:0 12px;border-radius:8px;font-size:12.5px;font-family:inherit;',
        '  border:.5px solid var(--geshijiang-line);background:transparent;color:var(--geshijiang-ink);cursor:pointer;}',
        '.geshijiang-btn:hover{background:var(--geshijiang-line);}',
        '.geshijiang-btn:disabled{opacity:.55;cursor:default;}',
        '.geshijiang-btn-primary{background:var(--geshijiang-brand);border-color:transparent;color:#fff;}',
        '.geshijiang-btn-primary:hover{filter:brightness(1.06);background:var(--geshijiang-brand);}',
        '.geshijiang-btn-text{border-color:transparent;color:var(--geshijiang-ink2);padding:0 4px;}',
        '.geshijiang-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;',
        '  border:.5px solid var(--geshijiang-line);font-size:12px;color:var(--geshijiang-ink2);white-space:nowrap;}',
        '.geshijiang-chip-ok{color:var(--geshijiang-ok);}',
        '.geshijiang-chip-warn{color:var(--geshijiang-warn);}',
        '.geshijiang-chip-err{color:var(--geshijiang-err);}',
        '.geshijiang-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;}',
        '.geshijiang-err{margin:10px 0 0;padding:9px 11px;border-radius:8px;border:.5px solid var(--geshijiang-line);',
        '  background:color-mix(in srgb,var(--geshijiang-ink) 6%,transparent);font-family:ui-monospace,Consolas,monospace;',
        '  font-size:12px;color:var(--geshijiang-ink2);word-break:break-all;}',
        '.geshijiang-stats{display:flex;border-bottom:.5px solid var(--geshijiang-line);}',
        '.geshijiang-stat{flex:1;padding:12px 14px;border-right:.5px solid var(--geshijiang-line);}',
        '.geshijiang-stat:last-child{border-right:none;}',
        '.geshijiang-stat b{display:block;font-size:19px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;}',
        '.geshijiang-stat span{font-size:12px;color:var(--geshijiang-ink2);}',
        '.geshijiang-row{display:flex;align-items:flex-start;gap:8px;padding:9px 14px;border-top:.5px solid var(--geshijiang-line);font-size:12.5px;}',
        '.geshijiang-row:first-child{border-top:none;}',
        '.geshijiang-row .geshijiang-k{margin:0;flex:none;}',
        '.geshijiang-row .geshijiang-right{font-size:12px;word-break:break-all;}',
        '.geshijiang-empty{padding:12px 14px;font-size:12.5px;color:var(--geshijiang-ink2);}',
        '.geshijiang-text{padding:11px 14px;font-size:12.5px;color:var(--geshijiang-ink2);white-space:pre-wrap;word-break:break-word;}',
        '.geshijiang-srow{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--geshijiang-ink2);padding:2px 0;}',
        '.geshijiang-finding{padding:10px 14px;border-top:.5px solid var(--geshijiang-line);}',
        '.geshijiang-finding:first-child{border-top:none;}',
        '.geshijiang-finding-head{display:flex;align-items:center;gap:8px;}',
        '.geshijiang-finding-msg{font-size:12.5px;color:var(--geshijiang-ink);flex:1;min-width:0;}',
        '.geshijiang-finding-meta{margin-top:4px;font-size:12px;color:var(--geshijiang-ink2);}',
        '.geshijiang-note{padding:10px 14px;font-size:12px;color:var(--geshijiang-ink2);border-top:.5px solid var(--geshijiang-line);}',
        '.geshijiang-page{max-width:720px;}',
        '.geshijiang-lead{padding:12px 14px;font-size:12.5px;color:var(--geshijiang-ink2);}',
        '.geshijiang-step{display:flex;gap:10px;padding:10px 14px;border-top:.5px solid var(--geshijiang-line);}',
        '.geshijiang-step:first-child{border-top:none;}',
        '.geshijiang-step-no{width:18px;height:18px;border-radius:50%;flex:none;display:flex;align-items:center;',
        '  justify-content:center;font-size:11px;color:var(--geshijiang-ink2);border:.5px solid var(--geshijiang-line);}',
        '.geshijiang-step-no.is-done{color:var(--geshijiang-ok);border-color:currentColor;}',
        '.geshijiang-step-body{flex:1;min-width:0;}',
        '.geshijiang-step-title{font-size:12.5px;}',
        '.geshijiang-step-hint{margin-top:3px;font-size:12px;color:var(--geshijiang-ink2);}',
        '.geshijiang-list{margin:0;padding:0 14px 12px 30px;}',
        '.geshijiang-list li{padding:3px 0;font-size:12.5px;color:var(--geshijiang-ink2);}',
        '.geshijiang-details{margin-top:6px;}',
        '.geshijiang-details>summary{cursor:pointer;font-size:12px;color:var(--geshijiang-ink2);}',
        '.geshijiang-details>summary:hover{color:var(--geshijiang-ink);}',
        '.geshijiang-details ul{margin:6px 0 0;padding:0 0 0 16px;max-height:190px;overflow:auto;}',
        '.geshijiang-details li{padding:2px 0;font-size:12px;color:var(--geshijiang-ink2);word-break:break-all;}',
        '.geshijiang-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:var(--geshijiang-ink2);}',
        '.geshijiang-name{color:var(--geshijiang-ink);}',
      ].join('');

      function Style() {
        return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
      }

      /**
       * 状态还没读到时显示的东西。
       *
       * 没有失败原因就是「正在读取」；有原因就把原文和重试按钮一起给出来——
       * 以前这里只会一直转，读不到接口和读得慢在界面上分不出来。
       */
      function StatusPlaceholder(props) {
        var root = props && props.page ? 'geshijiang geshijiang-page' : 'geshijiang';
        if (!props || !props.error) {
          return h('div', { className: root }, h(Style), h('div', { className: 'geshijiang-empty' }, '正在读取格式匠状态'));
        }
        return h('div', { className: root }, h(Style),
          h('div', { className: 'geshijiang-empty' }, '读不到格式匠状态：' + props.error),
          h('div', { className: 'geshijiang-meta' },
            '插件页接口 ' + API + '/state 没有返回。先看 设置 → 内置插件 里这一项的状态与错误；'
            + '刚装好或刚改过插件时需要重启 DSH。'),
          h('div', { className: 'geshijiang-foot' },
            h('button', { className: 'geshijiang-btn geshijiang-btn-primary', onClick: props.onRetry }, '重试'),
            h('span', { className: 'geshijiang-grow' }),
            h('span', { className: 'geshijiang-meta' }, '在对话里输入 /geshijiang 诊断 可看到装配失败原因')),
        );
      }

      function toneClass(tone) {
        if (tone === 'ok') return 'geshijiang-chip geshijiang-chip-ok';
        if (tone === 'warn') return 'geshijiang-chip geshijiang-chip-warn';
        if (tone === 'error') return 'geshijiang-chip geshijiang-chip-err';
        return 'geshijiang-chip';
      }

      function row(label, value, key) {
        return h('div', { key: key || label, className: 'geshijiang-row' },
          h('span', { className: 'geshijiang-k' }, label),
          h('span', { className: 'geshijiang-right' }, value),
        );
      }

      /* ------------------------------------------------------------------ *
       * 插件页
       * ------------------------------------------------------------------ */

      function shortPath(value) {
        var text = String(value || '');
        return text.length > 46 ? text.slice(0, 22) + '…' + text.slice(-22) : text;
      }

      /**
       * 断开时该等还是该动手。
       *
       * 宿主自己的重试优先（有 nextRetryAtMs 就照它说）；宿主放弃之后，
       * 插件还会按退避重挂三次，把这个进度讲清楚，用户就不用反复点按钮。
       */
      function autoHint(state) {
        var server = (state && state.server) || {};
        var auto = (state && state.auto) || {};
        if (state && state.geshijiang && state.geshijiang.updating) return '格式匠正在安装更新，装完会自动重连';
        if (server.state !== 'failed' || !auto.enabled) return '';
        if (auto.exhausted) return '自动重连已停止，处理完格式匠那边的问题后点「重新连接」';
        if (!auto.nextAtMs) return '即将自动重连';
        var remain = Number(auto.nextAtMs) - Date.now();
        var nth = (Number(auto.attempts) || 0) + 1;
        if (!Number.isFinite(remain) || remain <= 0) return '即将自动重连（第 ' + nth + ' 次）';
        return '约 ' + Math.max(1, Math.round(remain / 1000)) + ' 秒后自动重连（第 ' + nth + ' 次）';
      }

      function retryHint(server) {
        var at = Number(server && server.nextRetryAtMs) || 0;
        if (!at) return '';
        var remain = at - Date.now();
        if (!Number.isFinite(remain) || remain <= 0) return '即将重试';
        // 文案写「约」：这个数字是渲染时算的，卡片不会秒级重绘，别承诺精确倒计时。
        return '约 ' + Math.max(1, Math.round(remain / 1000)) + ' 秒后重试';
      }

      /**
       * 预设那一份写回来的桥接状态。
       *
       * 这个面板在别的会话里也要能答「格式匠到底通没通」，所以除了状态本身还要带时间：
       * 十分钟前的「已连接」不是现在的事实，说清楚比说漂亮重要。
       */
      function presetBridgeText(bridge) {
        var when = describeAge(bridge && bridge.at);
        var state = bridge && bridge.state;
        if (state === 'connected') {
          return '「格式匠」预设里已连接：' + ((bridge.toolCount || 0) + ' 个工具可用') + '（' + when + '）';
        }
        if (state === 'failed') {
          return '「格式匠」预设里的桥接连不上：' + (bridge.lastError || '没有给出原因') + '（' + when + '）；先打开格式匠，再在那个会话里重开。';
        }
        if (state === 'closed') {
          return '「格式匠」预设那一份已关闭（' + when + '）。新建会话时选这个预设即可重新加载。';
        }
        return '「格式匠」预设那一份正在连接（' + when + '）。';
      }

      function describeAge(at) {
        var seconds = Math.max(0, Math.round((Date.now() - (Number(at) || 0)) / 1000));
        if (!at) return '时间未知';
        if (seconds < 60) return '刚刚';
        var minutes = Math.round(seconds / 60);
        if (minutes < 60) return minutes + ' 分钟前';
        return Math.round(minutes / 60) + ' 小时前';
      }

      /** 连接卡与设置页共用同一套动作：打开、重连、复制诊断信息。 */
      function useConnectionActions(setState) {
        var busy = useState('');
        var copied = useState('');
        var noticePair = useState('');
        var api = {
          pending: busy[0],
          copyState: copied[0],
          notice: noticePair[0],
          diagnosticsHint: '',
        };
        var setPending = busy[1];
        var setCopyState = copied[1];
        var setNotice = noticePair[1];

        api.run = function (action) {
          setPending(action);
          setNotice('');
          post(action, { restart: true })
            .then(function (body) {
              if (body && body.state) setState(body.state);
              if (body && body.ok === false && body.error) setNotice(body.error);
            })
            .catch(function (error) {
              // 超时或网络失败都要把按钮放回可点状态，不能让一次请求把它永久禁用。
              setNotice(error && error.name === 'AbortError'
                ? '宿主没有在 10 秒内响应，稍后再试'
                : '请求没有完成，稍后再试');
            })
            .then(function () { setPending(''); });
        };

        api.refreshCatalog = function () {
          setPending('catalog');
          setNotice('');
          // 30 秒：清单要等格式匠那边连一次网关，比普通动作慢。
          requestJson('/catalog', { method: 'POST', body: {} }, 30000)
            .then(function (body) {
              if (body && body.state) setState(body.state);
              if (body && body.ok === false && body.error) setNotice(body.error);
            })
            .catch(function (error) {
              setNotice(error && error.name === 'AbortError'
                ? '读取能力清单超时，稍后再试'
                : '读取能力清单失败，稍后再试');
            })
            .then(function () { setPending(''); });
        };

        api.copyDiagnostics = function () {
          requestJson('/diagnostics')
            .then(function (body) { return copyText(body && body.text ? body.text : ''); })
            .then(function (done) { setCopyState(done ? '已复制' : '复制失败，请手动截图'); })
            .catch(function () { setCopyState('读取诊断信息超时，请用 /geshijiang 诊断'); });
        };

        return api;
      }

      /**
       * 连接后拿到的东西。
       *
       * 与格式匠「测试连接」面板同一口径：四类各给一个数字，再按类别展开清单。
       * 读不到时说明原因（旧版本没有清单接口、网关拒绝、超时），不把「没读到」
       * 画成「一个都没有」。
       */
      function CatalogBlock(props) {
        var catalog = props.catalog;
        var busy = props.busy === true;
        var onRefresh = props.onRefresh;

        var head = h('div', { key: 'head', className: 'geshijiang-head' },
          h('span', { className: 'geshijiang-k' }, '连接后获得'),
          h('button', {
            className: 'geshijiang-btn geshijiang-btn-text',
            disabled: busy,
            onClick: onRefresh,
          }, busy ? '读取中' : '刷新'),
        );

        if (!catalog) {
          return h('div', { className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' }, head,
            h('div', { className: 'geshijiang-meta' }, '还没有读取清单；连上之后会自动读一次。')));
        }
        if (catalog.error) {
          return h('div', { className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' }, head,
            h('div', { className: 'geshijiang-err' }, catalog.error),
            h('div', { className: 'geshijiang-meta' }, '旧版本的格式匠还没有这个清单接口；升级后这里会列工具、资源与提示词。')));
        }

        var data = catalog.data || {};
        var groups = [
          { key: 'tools', label: '工具', items: (data.tools || []).map(function (item) { return { name: item.name, note: item.description }; }) },
          { key: 'res', label: '固定资源', items: (data.resources || []).map(function (item) { return { name: item.name || item.uri, note: item.uri }; }) },
          { key: 'tpl', label: '资源模板', items: (data.resourceTemplates || []).map(function (item) { return { name: item.name || item.uriTemplate, note: item.uriTemplate }; }) },
          { key: 'prompt', label: '提示词', items: (data.prompts || []).map(function (item) { return { name: item.name, note: item.description }; }) },
        ];

        var stats = groups.map(function (group) { return row(group.label, String(group.items.length), group.key); });
        var details = groups.filter(function (group) { return group.items.length > 0; }).map(function (group) {
          var shown = group.items.slice(0, 30);
          return h('details', { key: group.key, className: 'geshijiang-details' },
            h('summary', null, group.label + ' ' + group.items.length + ' 项'),
            h('ul', null, shown.map(function (item, index) {
              return h('li', { key: index },
                h('span', { className: 'geshijiang-name' }, item.name || '未命名'),
                item.note ? h('span', null, '　' + item.note) : null);
            })),
            group.items.length > shown.length
              ? h('div', { className: 'geshijiang-meta' }, '另有 ' + (group.items.length - shown.length) + ' 项')
              : null,
          );
        });

        var server = data.server || {};
        var meta = (server.name || server.version)
          ? '服务 ' + [server.name, server.version].filter(Boolean).join(' ')
          : '服务信息未返回';
        if (data.protocolVersion) meta += '，协议 ' + data.protocolVersion;
        if (data.truncated) meta += '，清单已截断';

        return h('div', { className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' },
          head,
          h('div', null, stats),
          h('div', { className: 'geshijiang-meta' }, meta),
          details.length ? h('div', null, details) : h('div', { className: 'geshijiang-meta' }, '网关没有暴露资源或提示词。'),
        ));
      }

      function ConnectionCard() {
        var source = useGeshijiangState(true);
        var state = source.state;
        var setState = source.setState;
        var actions = useConnectionActions(setState);
        var pending = actions.pending;
        var copyState = actions.copyState;
        var notice = actions.notice;
        var run = actions.run;
        var copyDiagnostics = actions.copyDiagnostics;

        if (!state) {
          return h(StatusPlaceholder, { error: source.error, onRetry: source.retry });
        }

        var f = state.geshijiang || {};
        var server = state.server || {};
        var hints = state.hints || [];
        // 预设作用域下「未挂载」是配置结果，不是故障：别把它画成待修的红条。
        var presetScope = state.mountScope === 'preset';
        // mountScope: off 同理：用户故意不挂桥接，红色「需要修复」会把配置选择说成故障。
        var offScope = state.mountScope === 'off';
        var presetBridge = state.presetBridge || null;
        var broken = !presetScope && !offScope && (state.tone === 'error' || server.state === 'failed' || server.state === 'unmounted');
        var waiting = retryHint(server) || autoHint(state);

        var capabilities = [
          row('工具', server.state === 'connected'
            ? server.toolCount + ' 个可用'
            : (presetScope
              ? (presetBridge && presetBridge.state === 'connected'
                ? presetBridge.toolCount + ' 个可用（预设里）'
                : '由「格式匠」预设提供')
              : '暂不可用'), 'tools'),
          row('写入', f.safeWrite ? '已开启' : '未开启', 'write'),
          row('连接方式', 'stdio 桥接', 'bridge'),
        ];
        if (f.port) {
          // 连上时端口一定在听；没连上时补一句事实，别让人以为「有端口号就是起来了」。
          var portText = String(f.port)
            + (f.listening === false ? '（未监听）' : f.listening === true ? '（正在监听）' : '');
          capabilities.push(row('本机端口', portText, 'port'));
        }

        var versions = [
          row('程序', f.executable ? shortPath(f.executable) : '未找到', 'exe'),
          row('安装', f.installationId
            ? f.installationId + (f.installationKind && f.installationKind !== 'configured' ? '（' + f.installationKind + '）' : '')
            : '未找到', 'ins'),
          row('数据目录', f.dataDir ? shortPath(f.dataDir) : '未找到', 'dir'),
          row('插件版本', state.pluginVersion || '未知', 'ver'),
        ];

        var children = [
          h('div', { key: 'head', className: 'geshijiang-head' },
            h('span', { className: toneClass(state.tone) }, h('span', { className: 'geshijiang-dot' }), state.label),
            h('span', { className: 'geshijiang-right' }, state.detail || ''),
          ),
        ];

        if (hints.length) {
          children.push(h('div', { key: 'hints', className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' },
            hints.map(function (hint, index) { return h('div', { key: index, className: 'geshijiang-text' }, hint); }),
          )));
        }

        if (notice) {
          children.push(h('div', { key: 'notice', className: 'geshijiang-note' }, notice));
        }

        if (presetScope) {
          children.push(h('div', { key: 'scope', className: 'geshijiang-note' }, presetBridge
            ? presetBridgeText(presetBridge)
            : '桥接由「格式匠」预设提供：新建会话时选这个预设，格式匠的工具才会加载；其他预设的会话不加载它们。'));
        } else if (offScope) {
          children.push(h('div', { key: 'scope', className: 'geshijiang-note' }, '桥接在插件配置里关着（mountScope: off）：格式匠工具需要在别处自己配 mcp 客户端；宿主工具（附件、会话）不受影响。'));
        }

        if (broken) {
          children.push(h('div', { key: 'repair', className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' },
            h('div', { className: 'geshijiang-k' }, server.lastError ? '最近一次错误' : '状态'),
            server.lastError
              ? h('div', { className: 'geshijiang-err' }, server.lastError)
              : h('div', { className: 'geshijiang-text' }, '桥接没有挂上，按下面的按钮重新连接。'),
            waiting ? h('div', { className: 'geshijiang-meta' }, waiting) : null,
            state.paused ? h('div', { className: 'geshijiang-meta' }, '已手动断开；需要恢复时点「重新连接」') : null,
            h('div', { className: 'geshijiang-meta' }, '打开格式匠后会自动重连，不需要重新配置。'),
          )));
        }

        children.push(h('div', { key: 'cap', className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' }, capabilities)));
        if (server.state === 'connected' || state.catalog) {
          children.push(h('div', { key: 'catalog' }, h(CatalogBlock, {
            catalog: state.catalog,
            busy: pending === 'catalog',
            onRefresh: actions.refreshCatalog,
          })));
        }
        children.push(h('div', { key: 'foot', className: 'geshijiang-foot' },
          h('button', {
            className: 'geshijiang-btn geshijiang-btn-primary',
            disabled: pending === '/open' || !f.executable,
            onClick: function () { run('/open'); },
          }, '打开格式匠'),
          presetScope || offScope ? null : h('button', {
            className: 'geshijiang-btn',
            disabled: pending === '/connect',
            onClick: function () { run('/connect'); },
          }, '重新连接'),
          presetScope ? null : (server.state === 'connected'
            ? h('button', {
              className: 'geshijiang-btn geshijiang-btn-text',
              disabled: pending === '/disconnect',
              onClick: function () { run('/disconnect'); },
            }, '断开连接')
            : null),
          h('span', { className: 'geshijiang-grow' }),
          h('button', {
            className: 'geshijiang-btn geshijiang-btn-text',
            onClick: copyDiagnostics,
          }, copyState || '复制诊断信息'),
        ));

        return h('div', { className: 'geshijiang' },
          h(Style),
          h('div', { className: 'geshijiang-card' }, children),
          h('div', { className: 'geshijiang', style: { marginTop: 18 } },
            h('div', { className: 'geshijiang-k', style: { marginBottom: 6 } }, '本机信息'),
            h('div', { className: 'geshijiang-card' }, h('div', { className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' }, versions))),
          ),
        );
      }

      /** 插件页的入场：summary 只回一行；page 才画卡片。 */
      function ConnectionPage(props) {
        var view = props && props.view;
        if (view === 'summary') {
          return h('span', { className: 'geshijiang-k' }, '格式匠接入');
        }
        return h(ConnectionCard);
      }

      /* ------------------------------------------------------------------ *
       * 对话里的工具卡
       * ------------------------------------------------------------------ */

      function ToolShell(props) {
        return h('div', { className: 'geshijiang', style: { margin: '6px 0' } },
          h(Style),
          h('div', { className: 'geshijiang-card' }, props.children),
        );
      }

      /** 状态类工具：一行说清结果，不占版面。 */
      function statusRow(toolName) {
        return function StatusRow(props) {
          var phase = (props && props.phase) || '';
          var text = phase === 'result' ? textOf(props.block).replace(/\s+/g, ' ').trim() : '';
          var label = toolName === 'geshijiang_open' ? '打开格式匠'
            : toolName === 'geshijiang_connect' ? '重新连接格式匠'
              : toolName === 'geshijiang_diagnostics' ? '格式匠诊断' : '格式匠状态';
          return h('div', { className: 'geshijiang' },
            h(Style),
            h('div', { className: 'geshijiang-srow' },
              h('span', { className: 'geshijiang-dot', style: { color: 'var(--geshijiang-ok)' } }),
              h('span', null, label),
              h('span', { style: { marginLeft: 'auto', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: text },
                phase === 'result' ? (text.length > 80 ? text.slice(0, 80) + '…' : text || '完成') : '执行中'),
            ),
          );
        };
      }

      /* ------------------------------ 套版方案 ------------------------------ */

      var VERDICT = {
        pass: { label: '可套用', tone: 'ok' },
        warn: { label: '有冲突', tone: 'warn' },
        block: { label: '已阻断', tone: 'error' },
        legacy_fallback: { label: '旧路径', tone: 'warn' },
      };

      function verdictOf(plan) {
        return VERDICT[String((plan && plan.verdict) || '').toLowerCase()] || { label: '未判定', tone: 'idle' };
      }

      function sumValues(map) {
        if (!map || typeof map !== 'object') return 0;
        return Object.keys(map).reduce(function (total, key) {
          var value = Number(map[key]);
          return total + (Number.isFinite(value) ? value : 0);
        }, 0);
      }

      var PROTECTED_LABELS = {
        sections: '节',
        special_sections: '特殊节',
        tables: '表格',
        images: '图片',
        equations: '公式',
      };

      function protectedText(map) {
        if (!map || typeof map !== 'object') return '';
        return Object.keys(map)
          .filter(function (key) { return Number(map[key]) > 0; })
          .map(function (key) { return (PROTECTED_LABELS[key] || key) + ' ' + map[key]; })
          .join('，');
      }

      function PlanCard(props) {
        var phase = (props && props.phase) || '';
        var text = phase === 'result' ? textOf(props.block) : '';
        var parsed = useParsedResult(phase, text);
        var data = parsed ? unwrap(parsed) : null;
        var plan = data && data.plan && typeof data.plan === 'object' ? data.plan : null;

        if (phase !== 'result') {
          return h(ToolShell, null,
            h('div', { className: 'geshijiang-head' }, h('span', { className: 'geshijiang-title' }, '套版方案'), h('span', { className: 'geshijiang-right' }, '正在预览')));
        }
        if (!plan) {
          return h(ToolShell, null,
            h('div', { className: 'geshijiang-head' }, h('span', { className: 'geshijiang-title' }, '套版方案'), h('span', { className: toneClass('warn') }, '未解析')),
            h('div', { className: 'geshijiang-text' }, shorten(text, 600) || '格式匠没有返回内容'),
          );
        }

        var verdict = verdictOf(plan);
        var token = data.confirmation_token || '';
        var ttl = Number(data.confirmation_expires_in_seconds) || 0;
        var conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : [];
        var steps = Array.isArray(plan.steps) ? plan.steps : [];
        var protectedFacts = protectedText(plan.protected_facts);
        var paragraphTotal = sumValues(plan.paragraph_summary);
        var cleanup = plan.cleanup_preview;

        var rows = [];
        if (paragraphTotal) rows.push(row('影响段落', paragraphTotal + ' 段', 'para'));
        if (steps.length) rows.push(row('版式项', steps.length + ' 项', 'steps'));
        if (conflicts.length) rows.push(row('冲突', conflicts.length + ' 项', 'conf'));
        if (protectedFacts) rows.push(row('受保护内容', protectedFacts, 'prot'));
        if (cleanup && Number(cleanup.paragraphs || 0) + Number(cleanup.components || 0) + Number(cleanup.notes || 0) + Number(cleanup.captions || 0) + Number(cleanup.empty_paragraphs || 0) > 0) {
          var total = ['paragraphs', 'components', 'notes', 'captions', 'empty_paragraphs']
            .reduce(function (sum, key) { return sum + (Number(cleanup[key]) || 0); }, 0);
          rows.push(row('清理', '会删除 ' + total + ' 处', 'cleanup'));
        }

        var children = [
          h('div', { key: 'head', className: 'geshijiang-head' },
            h('span', { className: 'geshijiang-title' }, '套版方案'),
            h('span', { className: toneClass(verdict.tone) }, h('span', { className: 'geshijiang-dot' }), verdict.label),
            h('span', { className: 'geshijiang-right' }, token
              ? (ttl ? Math.round(ttl / 60) + ' 分钟内有效' : '待确认')
              : '未签发确认令牌'),
          ),
          rows.length
            ? h('div', { key: 'rows', className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' }, rows))
            : h('div', { key: 'rows', className: 'geshijiang-text' }, '计划里没有统计字段，按下方原文核对'),
        ];

        if (steps.length) {
          children.push(h('div', { key: 'steps', className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' },
            h('div', { className: 'geshijiang-k', style: { marginBottom: 4 } }, '将套用的规则'),
            steps.slice(0, 4).map(function (step, index) {
              var detail = [step.rule, step.target].filter(Boolean).join(' ');
              var count = Number(step.affected_count) > 0 ? '影响 ' + step.affected_count + ' 处' : '';
              return h('div', { key: index, className: 'geshijiang-meta' },
                shorten(detail || step.module || '规则', 60) + (count ? '，' + count : ''));
            }),
            steps.length > 4 ? h('div', { className: 'geshijiang-meta' }, '另有 ' + (steps.length - 4) + ' 项') : null,
          )));
        }

        if (conflicts.length) {
          children.push(h('div', { key: 'conf', className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' },
            h('div', { className: 'geshijiang-k', style: { marginBottom: 4 } }, '冲突'),
            conflicts.slice(0, 3).map(function (conflict, index) {
              return h('div', { key: index, className: 'geshijiang-meta' }, shorten(conflict.message || conflict.code || '未说明', 90));
            }),
            conflicts.length > 3 ? h('div', { className: 'geshijiang-meta' }, '另有 ' + (conflicts.length - 3) + ' 项') : null,
          )));
        }

        children.push(h('div', { key: 'note', className: 'geshijiang-note' }, token
          ? '模型会带着这个令牌直接创建分支版本。分支不会覆盖源文件，也不切换当前版本。'
          : '没有可用令牌，本次不能套用。'));

        return h(ToolShell, null, children);
      }

      /* ------------------------------ 提交检查 ------------------------------ */

      function severityMeta(severity) {
        var key = String(severity || '').toLowerCase();
        // 格式匠真实返回里 error / fail / fatal 都会出现，缺 fail 会让一条真错误被算进「其他」。
        if (key === 'error' || key === 'fail' || key === 'fatal' || key === 'blocker' || key === 'block') {
          return { key: 'error', label: '错误', tone: 'error' };
        }
        if (key === 'warning' || key === 'warn') return { key: 'warning', label: '警告', tone: 'warn' };
        if (key === 'info' || key === 'notice' || key === 'pass') return { key: 'info', label: '提示', tone: 'idle' };
        return { key: 'other', label: key || '其他', tone: 'idle' };
      }

      function countFindings(findings) {
        var counts = { error: 0, warning: 0, info: 0, other: 0 };
        findings.forEach(function (finding) { counts[severityMeta(finding && finding.severity).key] += 1; });
        return counts;
      }

      /** 一条问题的定位：证据里的来源、段落序号与原文摘录；没有证据就留空，不补页码。 */
      function locationOf(finding) {
        var evidence = Array.isArray(finding && finding.evidence) ? finding.evidence : [];
        var parts = [];
        for (var i = 0; i < evidence.length && parts.length < 2; i += 1) {
          var ref = evidence[i] || {};
          var head = [ref.source, ref.paragraph_index !== undefined && ref.paragraph_index !== null ? '段落 ' + ref.paragraph_index : '']
            .filter(Boolean).join('，');
          var quote = ref.quote ? shorten(ref.quote, 36) : '';
          var piece = [head, quote].filter(Boolean).join('：');
          if (piece) parts.push(piece);
        }
        return parts.join(' / ');
      }

      function DiagnosticCard(props) {
        var phase = (props && props.phase) || '';
        var text = phase === 'result' ? textOf(props.block) : '';
        var parsed = useParsedResult(phase, text);
        var data = parsed ? unwrap(parsed) : null;
        var onlyErrorsPair = useState(false);
        var onlyErrors = onlyErrorsPair[0];
        var setOnlyErrors = onlyErrorsPair[1];
        var copiedPair = useState('');
        var copied = copiedPair[0];
        var setCopied = copiedPair[1];
        var openPair = useState('');
        var opening = openPair[0];
        var setOpening = openPair[1];
        var notePair = useState('');
        var note = notePair[0];
        var setNote = notePair[1];

        if (phase !== 'result') {
          return h(ToolShell, null,
            h('div', { className: 'geshijiang-head' }, h('span', { className: 'geshijiang-title' }, '提交检查'), h('span', { className: 'geshijiang-right' }, '正在运行')));
        }
        if (!data) {
          return h(ToolShell, null,
            h('div', { className: 'geshijiang-head' }, h('span', { className: 'geshijiang-title' }, '提交检查'), h('span', { className: toneClass('warn') }, '未解析')),
            h('div', { className: 'geshijiang-text' }, shorten(text, 600) || '格式匠没有返回内容'),
          );
        }

        // run_paper_diagnostic 把问题放在 run.findings 里；list_findings 把它放在顶层 items 里。
        var run = data.run && typeof data.run === 'object' ? data.run : null;
        var findings = Array.isArray(run && run.findings) ? run.findings : (Array.isArray(data.items) ? data.items : []);
        var counts = countFindings(findings);
        var runId = (run && run.id) || data.run_id || '';
        var status = (run && run.status) || data.status || '';
        var paper = run && run.paper_name ? String(run.paper_name) : '';
        var versionNo = run && run.version_no ? 'v' + run.version_no : '';
        var sourceChanged = Boolean(run && run.source_changed);
        var shown = onlyErrors && counts.error
          ? findings.filter(function (finding) { return severityMeta(finding && finding.severity).key === 'error'; })
          : findings;

        var children = [
          h('div', { key: 'head', className: 'geshijiang-head' },
            h('span', { className: 'geshijiang-title' }, '提交检查'),
            h('span', { className: toneClass(counts.error ? 'error' : counts.warning ? 'warn' : 'ok') },
              h('span', { className: 'geshijiang-dot' }), status ? String(status) : '完成'),
            h('span', { className: 'geshijiang-right' }, [paper, versionNo].filter(Boolean).join(' ') || (runId ? '运行 ' + runId : '')),
          ),
          h('div', { key: 'stats', className: 'geshijiang-stats' },
            stat(counts.error, '错误', 'var(--geshijiang-err)'),
            stat(counts.warning, '警告', 'var(--geshijiang-warn)'),
            stat(counts.info, '提示', 'var(--geshijiang-ink2)'),
            // 未知 severity 不能悄悄消失：出现时才补第四栏，让人知道还有没归类的条目。
            counts.other ? stat(counts.other, '其他', 'var(--geshijiang-ink2)') : null,
          ),
        ];

        if (!findings.length) {
          children.push(h('div', { key: 'empty', className: 'geshijiang-text' }, '这次检查没有返回问题记录。报告是否完整要看运行状态，不要据此宣布论文合格。'));
        } else {
          if (counts.error) {
            children.push(h('div', { key: 'filter', className: 'geshijiang-foot', style: { borderTop: 'none', paddingTop: 8, paddingBottom: 8 } },
              h('button', {
                className: onlyErrors ? 'geshijiang-btn geshijiang-btn-primary' : 'geshijiang-btn',
                onClick: function () { setOnlyErrors(!onlyErrors); },
              }, onlyErrors ? '显示全部' : '只看错误'),
              h('span', { className: 'geshijiang-grow' }),
              h('span', { className: 'geshijiang-k' }, onlyErrors ? '错误 ' + counts.error + ' 条' : '共 ' + findings.length + ' 条'),
            ));
          }
          var list = shown.slice(0, 8).map(function (finding, index) {
            var meta = severityMeta(finding && finding.severity);
            var location = locationOf(finding);
            return h('div', { key: index, className: 'geshijiang-finding' },
              h('div', { className: 'geshijiang-finding-head' },
                h('span', { className: toneClass(meta.tone === 'idle' ? '' : meta.tone) }, h('span', { className: 'geshijiang-dot' }), meta.label),
                h('span', { className: 'geshijiang-finding-msg' }, shorten((finding && finding.message) || '未说明', 120)),
              ),
              location ? h('div', { className: 'geshijiang-finding-meta' }, location) : null,
            );
          });
          children.push(h('div', { key: 'list', className: 'geshijiang-body' }, list));
          if (shown.length > 8) {
            children.push(h('div', { key: 'more', className: 'geshijiang-note' }, '另有 ' + (shown.length - 8) + ' 条，完整清单见报告或让模型调用 list_findings。'));
          }
          if (sourceChanged) {
            children.push(h('div', { key: 'stale', className: 'geshijiang-note' }, '源文件在这次检查之后又变过，这份报告不能当作当前文件的结论，需要重跑。'));
          }
        }

        if (note) {
          children.push(h('div', { key: 'opennote', className: 'geshijiang-note' }, note));
        }

        children.push(h('div', { key: 'foot', className: 'geshijiang-foot' },
          h('button', {
            className: 'geshijiang-btn',
            disabled: opening === 'open',
            onClick: function () {
              setOpening('open');
              setNote('');
              post('/open', {})
                .then(function (body) {
                  if (body && body.ok === false) setNote('打开格式匠失败：' + (body.error || '未知原因'));
                })
                .catch(function (error) {
                  setNote(error && error.name === 'AbortError'
                    ? '打开请求超时，请手动启动格式匠'
                    : '打开请求没有完成，请手动启动格式匠');
                })
                .then(function () { setOpening(''); });
            },
          }, '在格式匠中查看报告'),
          h('button', {
            className: 'geshijiang-btn',
            disabled: !runId,
            onClick: function () {
              copyText(String(runId)).then(function (done) { setCopied(done ? '已复制运行 ID' : '复制失败'); });
            },
          }, copied || '复制运行 ID'),
          h('span', { className: 'geshijiang-grow' }),
          h('span', { className: 'geshijiang-k' }, runId ? '报告按运行 ID 查找' : ''),
        ));

        return h(ToolShell, null, children);
      }

      function stat(value, label, color) {
        return h('div', { key: label, className: 'geshijiang-stat' },
          h('b', { style: { color: color } }, String(value)),
          h('span', null, label),
        );
      }

      /* ------------------------------------------------------------------ *
       * 设置页（设置 → 格式匠）
       * ------------------------------------------------------------------ */

      function Step(props) {
        return h('div', { className: 'geshijiang-step' },
          h('span', { className: props.done ? 'geshijiang-step-no is-done' : 'geshijiang-step-no' }, props.done ? '✓' : String(props.index)),
          h('div', { className: 'geshijiang-step-body' },
            h('div', { className: 'geshijiang-step-title' }, props.title),
            props.hint ? h('div', { className: 'geshijiang-step-hint' }, props.hint) : null,
          ),
        );
      }

      /**
       * 设置页：用户从设置侧栏进来能自己走完接入，不需要翻聊天记录。
       *
       * 三步按「格式匠侧 → DSH 侧 → 连接」排，每步都给出当前状态与下一步该点哪里；
       * 动作与插件页共用同一套 useConnectionActions，行为不会两处不一致。
       */
      function SettingsPanel() {
        var source = useGeshijiangState(true);
        var state = source.state;
        var setState = source.setState;
        var actions = useConnectionActions(setState);

        if (!state) {
          return h(StatusPlaceholder, { error: source.error, onRetry: source.retry, page: true });
        }

        var f = state.geshijiang || {};
        var server = state.server || {};
        var connected = server.state === 'connected';
        // 桥接交给预设时，「连没连上」这件事不在这个面板里：本会话没选那个预设就看不到工具，
        // 面板只陈述事实，不给「重新连接」这种按了也没用的按钮。
        var presetScope = state.mountScope === 'preset';
        var offScope = state.mountScope === 'off';
        var presetBridge = state.presetBridge || null;
        var mcpReady = f.mcpEnabled === true;
        var installReady = Boolean(f.installationId);
        // 随附预设挂的是官方 mcp 客户端，不写插件自己的交接记录：第三步不能因此一直
        // 停在「未完成」。机器这三步（MCP 开启、安装就绪、宿主通道可用）齐了就算就绪，
        // 剩下的只是去预设会话里用——`usable` 由宿主算好，面板不重复推导一遍。
        var presetReady = presetScope && !presetBridge && Boolean(state.usable);
        // 配置说「已开启」与端口真的在听是两件事：后者才是桥接能不能起来的前提。
        // listening 为 null 表示还没探到，这时不要凭空加一句「未监听」吓人。
        var silent = mcpReady && f.listening === false;

        var steps = [
          h(Step, {
            key: 'step1',
            index: 1,
            done: mcpReady,
            title: mcpReady
              ? (silent ? '格式匠的 MCP 服务已开启（当前未监听）' : '格式匠的 MCP 服务已开启')
              : '打开格式匠的 MCP 服务',
            hint: mcpReady
              ? (silent
                ? ('本机端口 ' + f.port + ' 没有监听：格式匠没在运行，或它的服务还没起来。点「打开格式匠」等它完全启动。')
                : ('本机端口 ' + f.port))
              : '格式匠 → 设置 → MCP →「本机服务」里打开「启用 MCP 本机服务」，再点「保存并应用」。',
          }),
          h(Step, {
            key: 'step2',
            index: 2,
            done: installReady,
            title: installReady ? '这条会话用的本机安装已就绪' : '在格式匠里建一条本机接入',
            hint: installReady
              ? (f.installationId + '（' + (f.installationKind || '本机客户端') + '）')
              : '格式匠 → 设置 → MCP → 点右上「连接外部助手」→「连接哪个助手」选「DeepSeek Harness」→「执行方式」选「信任所选服务」→ 应用。',
          }),
          h(Step, {
            key: 'step3',
            index: 3,
            done: presetScope
              ? Boolean((presetBridge && presetBridge.state === 'connected') || presetReady)
              : (offScope ? false : connected),
            title: presetScope
              ? (presetBridge && presetBridge.state === 'connected'
                ? ('「格式匠」预设里已连接，' + (presetBridge.toolCount || 0) + ' 个工具可用')
                : presetReady
                  ? '本机已就绪，在「格式匠」预设的会话里使用'
                  : '在「格式匠」预设的会话里使用')
              : offScope
                ? '桥接已关闭（插件配置选的）'
                : (connected ? ('已连接，' + server.toolCount + ' 个工具可用') : '把桥接连上'),
            hint: presetScope
              ? (presetBridge
                ? presetBridgeText(presetBridge)
                : '桥接挂在「格式匠」预设上：新建会话时选这个预设，格式匠的工具才会加载；其他预设的会话不加载它们，省下每轮的开销。宿主工具（附件、会话）不经过桥接，随时能用。')
              : offScope
                ? '插件配置 mountScope: off：格式匠工具需要在别处配 mcp 客户端；宿主工具（附件、会话）不受影响。'
                : (connected
                ? '下面几个按钮只在排障时才用。'
                : state.paused
                  ? '已手动断开；点「重新连接」恢复。'
                  : ((server.lastError ? server.lastError + '。' : '')
                    + (autoHint(state) || '点下面的「重新连接」。格式匠没在运行就先点「打开格式匠」。'))),
          }),
        ];

        var info = [
          row('程序', shortPath(f.executable) || '未找到', 'exe'),
          row('安装', f.installationId || '未找到', 'ins'),
          row('数据目录', shortPath(f.dataDir) || '未找到', 'data'),
          row('连接方式', 'stdio 桥接', 'bridge'),
        ];

        return h('div', { className: 'geshijiang geshijiang-page' },
          h(Style),
          h('div', { className: 'geshijiang-card' },
            h('div', { className: 'geshijiang-head' },
              h('span', { className: 'geshijiang-title' }, '格式匠论文助手'),
              h('span', { className: toneClass(state.tone) }, h('span', { className: 'geshijiang-dot' }), state.label),
              h('span', { className: 'geshijiang-right' }, state.pluginVersion ? 'v' + state.pluginVersion : ''),
            ),
            h('div', { className: 'geshijiang-lead' }, presetScope
              ? '这里管格式匠本身：程序、数据目录、本机接入与 MCP 服务。格式匠的工具挂在「格式匠」预设上，新建会话时选那个预设就会加载。'
              : offScope
                ? '这里管格式匠本身：程序、数据目录、本机接入与 MCP 服务。桥接在插件配置里关着（mountScope: off），格式匠工具需要在别处自己配。'
                : '把本机格式匠的论文工具接进对话：套版、提交检查、资料与页码取证。下面三步走完就能用。'),
            h('div', { className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' }, steps)),
            connected || state.catalog
              ? h(CatalogBlock, {
                catalog: state.catalog,
                busy: actions.pending === 'catalog',
                onRefresh: actions.refreshCatalog,
              })
              : null,
            h('div', { className: 'geshijiang-foot' },
              h('button', {
                className: 'geshijiang-btn geshijiang-btn-primary',
                disabled: actions.pending === '/open' || !f.executable,
                onClick: function () { actions.run('/open'); },
              }, '打开格式匠'),
              presetScope || offScope ? null : h('button', {
                className: 'geshijiang-btn',
                disabled: actions.pending === '/connect',
                onClick: function () { actions.run('/connect'); },
              }, '重新连接'),
              presetScope || offScope ? null : (connected
                ? h('button', {
                  className: 'geshijiang-btn geshijiang-btn-text',
                  disabled: actions.pending === '/disconnect',
                  onClick: function () { actions.run('/disconnect'); },
                }, '断开连接')
                : null),
              h('span', { className: 'geshijiang-grow' }),
              h('button', { className: 'geshijiang-btn geshijiang-btn-text', onClick: actions.copyDiagnostics }, actions.copyState || '复制诊断信息'),
            ),
            actions.notice ? h('div', { className: 'geshijiang-note' }, actions.notice) : null,
          ),
          h('div', { style: { marginTop: 18 } },
            h('div', { className: 'geshijiang-k', style: { marginBottom: 6 } }, '在对话里怎么用'),
            h('div', { className: 'geshijiang-card' }, h('ul', { className: 'geshijiang-list' },
              h('li', { key: 'u1' }, '套版：说「用××模板套一下第 12 版」，方案卡出来后会直接建分支，不覆盖源文件。'),
              h('li', { key: 'u2' }, '提交检查：说「跑一遍提交检查，按学位论文方案」，卡片里可以只看错误。'),
              h('li', { key: 'u3' }, '取证：问「这句引文出自哪篇文献、哪一页」。'),
              h('li', { key: 'u4' }, '排障：输入 /geshijiang 诊断，复制出来的信息不含令牌。'),
            )),
          ),
          h('div', { style: { marginTop: 18 } },
            h('div', { className: 'geshijiang-k', style: { marginBottom: 6 } }, '本机信息'),
            h('div', { className: 'geshijiang-card' }, h('div', { className: 'geshijiang-body' }, h('div', { className: 'geshijiang-group' }, info))),
          ),
        );
      }

      /**
       * 设置侧栏图标。
       *
       * 契约：`settings.section.icon` 的注册 id 必须等于对应分节的 id；
       * 宿主按 { size, active } 调这个函数并直接渲染返回的元素，所以这里不能有 hook。
       * 图形是一只纸页加两行正文，和「文档 + 版式」这件事对得上，也避开了齿轮那套通用图标。
       */
      function GeshijiangIcon(props) {
        var size = (props && props.size) || 16;
        var stroke = (props && props.active) ? 1.7 : 1.4;
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
          h('path', { d: 'M9.6 1.8H5.3c-.6 0-1.1.5-1.1 1.1v10.2c0 .6.5 1.1 1.1 1.1h5.4c.6 0 1.1-.5 1.1-1.1V4.3L9.6 1.8Z' }),
          h('path', { d: 'M9.6 1.8v2.5h2.4' }),
          h('path', { d: 'M6 8.1h4M6 10.6h2.6' }),
        );
      }

      /**
       * 设置页入口。
       *
       * 宿主渲染槽位时是「调用组件函数、拿回一个元素」，不是把组件挂进 React 树里，
       * 所以在槽位函数里直接写 hooks 会报 Invalid hook call、整页空白。这里保持一个
       * 无 hook 的薄壳，hooks 等 React 真正渲染 SettingsPanel 时才执行——插件页的
       * ConnectionPage 用的是同一种写法。
       */
      function SettingsPage() {
        return h(SettingsPanel);
      }

      /* ------------------------------------------------------------------ *
       * 注册
       * ------------------------------------------------------------------ */

      function apply(ctx) {
        ctx.effect(function () {
          var offs = [];
          offs.push(ctx.slots.inject('plugins.bundle.config', function () {
            return ctx.slots.register({ name: 'plugins.bundle.config', key: MODULE_ID }, ConnectionPage);
          }));
          // 设置侧栏入口：插件详情页不好找，设置里给一个同名管理页。
          offs.push(ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({ name: 'settings.section', id: 'geshijiang', order: 26, label: '格式匠' }, SettingsPage);
          }));
          // 侧栏图标按分节 id 匹配，没有这条就退回宿主的通用齿轮。
          offs.push(ctx.slots.inject('settings.section.icon', function () {
            return ctx.slots.register({ name: 'settings.section.icon', id: 'geshijiang', order: 26, label: '格式匠' }, GeshijiangIcon);
          }));
          ['geshijiang_status', 'geshijiang_connect', 'geshijiang_open', 'geshijiang_diagnostics']
            .forEach(function (toolName) {
              offs.push(ctx.slots.inject('tool.call.toolview', function () {
                return ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, statusRow(toolName));
              }));
            });
          offs.push(ctx.slots.inject('tool.call.toolview', function () {
            return ctx.slots.register({ name: 'tool.call.toolview', key: 'mcp__geshijiang__preview_layout_plan' }, PlanCard);
          }));
          // 诊断结果与问题清单是同一份数据的不同入口，用同一张卡，避免两套渲染各说各话。
          ['mcp__geshijiang__run_paper_diagnostic', 'mcp__geshijiang__list_findings']
            .forEach(function (toolName) {
              offs.push(ctx.slots.inject('tool.call.toolview', function () {
                return ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, DiagnosticCard);
              }));
            });
          return function () {
            offs.forEach(function (off) { if (typeof off === 'function') off(); });
          };
        }, 'geshijiang: slots');
      }

      return { inject: ['slots'], apply: apply };
    },
  });
})();


