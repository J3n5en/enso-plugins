/* eslint-disable */
// 侧栏看板的中文界面。
//
// AGY 的原版 app.js / hive.js / index.html 一律不改（见 README 的对齐清单），
// 界面文字在运行时按字典替换：
//   · TEXT  精确匹配整段文字（含 title / aria-label / placeholder / alt 属性）
//   · RULES 带变量的句子（"3 posts"、"Working for @alpha" 之类），按顺序全局替换
// 只翻译「外壳」：pre/code/textarea/.raw/.msg-body 里的内容是用户或 agent 写的，
// 一律不动；替换结果不会再命中英文键，所以反复触发是幂等的。
(() => {
  'use strict';

  const TEXT = {
    // ── 页签 / 标题
    'Swarm': '蜂群',
    'Swarm views': '蜂群视图',
    'Overview': '总览',
    'Board': '看板',
    'Members': '成员',
    'Graph': '关系图',
    'Raw': '原始数据',
    'Untitled swarm': '未命名蜂群',
    'Looking for this conversation\'s swarm…': '正在查找本会话的蜂群…',
    'Watching for a swarm': '等待蜂群出现',
    'No swarm in this conversation': '本会话还没有蜂群',
    'Open this pane from a conversation to see its swarm. Swarms started there appear here automatically; start one with':
      '在会话里打开这个面板才能看到它的蜂群。那边起的蜂群会自动出现在这里；起一个用',
    'Swarms started in this conversation appear here automatically, with their board, members and @mention graph. Start one with':
      '本会话里起的蜂群会自动出现在这里，连同看板、成员和 @ 提及关系图。起一个用',
    'Updates automatically': '自动刷新',
    'Live': '实时',
    'Reconnecting': '重新连接中',
    'Lost contact with the swarm sidecar; retrying': '和蜂群后台失去联系，正在重试',
    'Loading…': '加载中…',

    // ── 总览
    'overview · from the narrator\'s notes': '总览 · 来自讲解员的笔记',
    'Narrator\'s page': '讲解员页面',
    'Narrator view (AI-generated)': '讲解员视图（AI 生成）',
    'Open coordinator chat': '打开协调者会话',
    'Want this view different? Tell the coordinator.': '想换个看法？跟协调者说一声。',
    'The narrator is updating the overview': '讲解员正在更新总览',
    'The narrator is waiting for new board posts': '讲解员在等新的看板消息',
    'The narrator was killed; the overview no longer updates': '讲解员已结束，总览不再更新',
    'No narrator in this swarm. Ask the coordinator to add one.': '这个蜂群还没有讲解员，让协调者加一个。',
    'The narrator hasn\'t published an overview yet.': '讲解员还没发布总览。',
    'The narrator\'s view.json is over 64 KB, so it isn\'t shown.':
      '讲解员的 view.json 超过 64 KB，所以没有显示。',
    'no view.html yet': '还没有 view.html',
    'view.html is over 64 KB': 'view.html 超过 64 KB',
    'loading the narrator view': '正在加载讲解员视图',
    'stale': '已过期',
    'Click a link in the view to open it.': '点视图里的链接可以打开。',
    'Opening files needs the app.': '打开文件需要在应用里操作。',
    'The coordinator asked. Answer it in its chat.': '协调者在问你，去它的会话里回。',
    'System alerts': '系统提示',
    'The narrator\'s last step failed:': '讲解员的最后一步失败了：',

    // ── 看板
    'Search': '搜索',
    'Search posts': '搜索消息',
    'Filters': '筛选',
    'Filters (active)': '筛选（已启用）',
    'Filter by poster': '按发送者筛选',
    'Filter by recipient': '按接收者筛选',
    'Filter by channel': '按频道筛选',
    'Filter by worker': '按 worker 筛选',
    'Show posts by one member': '只看某个成员发的消息',
    'Show posts that call on one member': '只看叫到某个成员的消息',
    'Show posts in one channel': '只看某个频道里的消息',
    'Show or hide each member\'s posts': '选择显示哪些成员的消息',
    'Keep the newest post in view': '始终显示最新一条',
    'From anyone': '来自任何人',
    'To anyone': '发给任何人',
    'To no one': '没叫任何人',
    'To @all': '发给 @all',
    'All channels': '全部频道',
    'Channels': '频道',
    'Follow': '跟随',
    'Latest': '最新',
    'Show everything and follow live': '显示全部并跟随实时',
    'No posts yet': '还没有消息',
    'Not on the roster': '不在名册里',
    'not on roster': '不在名册',
    'Click to hide from the board': '点击从看板隐藏',
    'Hidden from the board; click to show': '已从看板隐藏，点击显示',
    'Show more': '展开',
    'Show less': '收起',
    'Could not load earlier posts': '无法加载更早的消息',
    'main: the whole swarm reads it': 'main：全群都能看到',
    'Copied': '已复制',
    'Copy': '复制',
    'Copy failed': '复制失败',
    'Copy to clipboard': '复制到剪贴板',

    // ── 成员
    'The team': '团队',
    'Team': '团队',
    'Coordinator': '协调者',
    'Coordinator ·': '协调者 ·',
    'Search members': '搜索成员',
    'Goal': '目标',
    'Threads': '线程',
    'Tasks': '任务',
    'Task': '任务',
    'Progress': '进度',
    'Planned next': '接下来',
    'In progress': '进行中',
    'Done': '完成',
    'Blocked': '受阻',
    'Stuck': '卡住',
    'Needs you': '需要你',
    'Running': '运行中',
    'Resting': '休息中',
    'Retired': '已归档',
    'Standing by': '待命',
    'Not started': '未开始',
    'Moving': '移动中',
    'Now': '现在',
    'Latest action': '最近动作',
    'Thinking': '思考中',
    'Compare with now': '和现在对比',
    'Hide compare': '收起对比',
    'Open full timeline': '打开完整时间线',
    'no tasks': '没有任务',
    'Nothing planned': '暂无计划',
    'Nothing running': '暂无运行',
    'Nothing blocked': '无受阻',
    'Nothing stuck': '无卡住',
    'Nothing waiting': '无等待',
    'Nothing needs you': '没有需要你的',
    'Where each worker is, by thread': '按线程看每个 worker 在哪',
    'Your swarm is starting': '蜂群正在启动',
    'One goal': '一个目标',
    'The coordinator splits it into tasks.': '协调者把它拆成几件事。',
    'Many workers': '多个 worker',
    'Each takes a task, and they run in parallel.': '各自领一件，同时干。',
    'One board': '一块看板',
    'Updates land here. You step in only when asked.': '进展都落在这里，只在被叫到时才需要你出手。',
    'Waiting for the first update': '等第一条更新',
    'tasks done': '个任务完成',
    'Coordinator · Working': '协调者 · 工作中',
    // 成员的实时动作（插件写进 transcript 的 toolSummary）
    'Waiting for posts': '在等新消息',
    'Reading the board': '正在读看板',
    'Posting to the board': '正在发到看板',
    '+{n} more': '还有 {n} 个',

    // ── 状态
    'Working': '工作中',
    'Waiting': '等待中',
    'Killed': '已结束',
    'Active': '进行中',
    'Active: mid-turn (thinking, running a tool, or waiting on the model)':
      '进行中：这一轮还没结束（思考、调用工具或等模型）',
    'Waiting: turn ended, asleep on the board until a post wakes it':
      '等待中：这一轮已结束，在板上睡着，等一条消息唤醒',
    'Killed: removed from the swarm': '已结束：已从蜂群移除',
    'Tasks done': '已完成的任务',
    'Message just sent': '刚发出的消息',
    'Waiting on': '等待',

    // ── 关系图
    'Replay': '回放',
    'Jump to start': '跳到开头',
    'Previous post': '上一条',
    'Previous post (←)': '上一条（←）',
    'Next post': '下一条',
    'Next post (→)': '下一条（→）',
    'Play replay': '播放回放',
    'Pause replay': '暂停回放',
    'Play / pause replay (space)': '播放 / 暂停回放（空格）',
    'Replay position': '回放进度',
    'Replay pacing': '回放节奏',
    'Replay speed': '回放速度',
    'Scrub through board posts': '拖动浏览看板消息',
    'Even pacing': '均匀间隔',
    'Real-time gaps': '按真实间隔',
    'Graph view': '图形视图',
    'Hive': '蜂巢',
    'Mentions': '提及',
    'Threads as cells, with each worker where it works': '线程画成格子，worker 待在干活的位置',
    'Who @mentions whom': '谁 @ 了谁',
    'Hide inactive': '隐藏不活跃',
    'Hide killed and inactive members from the graph': '在图上隐藏已结束和不活跃的成员',
    'Expand @all': '展开 @all',
    'Draw @all as an edge to every member': '把 @all 画成连到每个成员的线',
    'Export GIF': '导出 GIF',
    'Export graph replay as an animated GIF': '把关系图回放导出成 GIF 动画',
    'Exporting…': '导出中…',
    'Exported swarm graph replay': '导出的蜂群关系图回放',
    'Nothing to export yet.': '还没有可导出的内容。',
    'Could not export GIF.': 'GIF 导出失败。',
    'Could not download GIF from embedded pane.': '无法从内嵌面板下载 GIF。',
    'Frames': '帧',
    'Zoom': '缩放',
    'Zoom in': '放大',
    'Zoom out': '缩小',
    'Fit the whole swarm': '适应整群',
    'Home': '首帧',
    'End': '结尾',
    'Next': '下一条',
    'Open in new tab': '在新标签页打开',
    'Close': '关闭',
    'Close preview': '关闭预览',
    'Right-click image to save, or open in a new tab.': '右键图片可以保存，或在新标签页打开。',
    '@mention, width = count': '@提及，宽度＝次数',
    'via @all': '经 @all 发出',
    'posted with no mention': '没有 @ 任何人的消息',
    '@all posts, drawn by Expand @all': '@all 消息（由「展开 @all」画出）',
    'earlier post': '更早的消息',

    // ── 原始数据
    'File': '文件',
    'All': '全部',
    'All workers': '全部 worker',
    'Other': '其他',
    'Error': '错误',
    'New': '新',
    'Canvas 2D context unavailable': '画布不可用',
    'Remote': '远程',
    'Open': '打开',
    'system:': '系统：',
    'updating': '更新中',
    'watching': '观察中',
    'stopped': '已停止',
    'That link isn\'t allowed here.': '这个页面里不允许打开该链接。',
    'The narrator\'s view.json isn\'t valid JSON yet.': '讲解员的 view.json 还不是合法 JSON。',
    'another machine': '另一台机器',
    'its machine': '它所在的机器',
  };

  // 带变量的句子；顺序有意义（长句在前）。
  const RULES = [
    [/^Retry loading (\d+) earlier posts?$/, '重新加载 $1 条更早的消息'],
    [/^Show (\d+) earlier posts? \((\d+) older\)$/, '显示 $1 条更早的消息（共 $2 条更旧）'],
    [/^Loading (\d+) earlier posts?\.$/, '正在加载 $1 条更早的消息。'],
    [/^(\d+) earlier posts could not be loaded\.$/, '$1 条更早的消息加载失败。'],
    [/(\d+) earlier posts?/g, '$1 条更早的消息'],
    [/(\d+) posts since the view was updated/g, '更新后又有 $1 条消息'],
    [/^Swarm start · (\d+) members?$/, '蜂群开始 · $1 名成员'],
    [/^(\d+) posts? · (\d+) members?$/, '$1 条消息 · $2 名成员'],
    [/^(\d+) of (\d+) tasks? done$/, '$1/$2 个任务完成'],
    [/^(.+) over ([0-9smh. ]+)$/, '$1，历时 $2'],
    [/^over ([0-9smh. ]+)$/, '历时 $1'],
    [/^(\d+) of (\d+) done$/, '$1/$2 完成'],
    [/^(\d+) of (\d+)$/, '$1 / $2'],
    [/(\d+) bees?$/, '$1 只蜂'],
    [/^(\d+) threads? open$/, '$1 个线程进行中'],
    [/(\d+) posts?/g, '$1 条消息'],
    [/(\d+) members?/g, '$1 名成员'],
    [/(\d+) frames?/g, '$1 帧'],
    [/(\d+) lines?/g, '$1 行'],
    [/(\d+) steps?/g, '$1 步'],
    [/(\d+) unread/g, '$1 条未读'],
    [/(\d+) workers?/g, '$1 个 worker'],
    [/^(\d+) stuck$/, '$1 个卡住'],
    [/^(\d+) waiting on @/, '$1 个在等 @'],
    [/^Working for @(.+)$/, '正在为 @$1 干活'],
    [/^Waiting on @(.+)$/, '在等 @$1'],
    [/^Waiting on @$/, '等待中 @'],
    [/^Coordination with @(.+)$/, '与 @$1 协同'],
    [/^Showing the last good view\.json; the current file is over 64 KB\.$/,
      '显示的是上一次可用的 view.json，当前文件超过 64 KB。'],
    [/^Showing the last good view\.json; the current file is not valid JSON\.$/,
      '显示的是上一次可用的 view.json，当前文件不是合法 JSON。'],
    [/^((?:\d+[smh]\s?)+)ago$/, '$1前'],
    // 成员卡片的 title 是一整串："name · role · Active · 3 posts\nClick to hide…"。
    [/ · (Active|Waiting|Killed) · /g, (m, state) => ` · ${{ Active: '进行中', Waiting: '等待中', Killed: '已结束' }[state]} · `],
    [/(\w+) \(you\)/g, '$1（你）'],
    [/Click to hide from the board/g, '点击从看板隐藏'],
    [/^From (.+)$/, '来自 $1'],
    [/^To (.+)$/, '发给 $1'],
    [/^(.+?) to (.+), (\d{1,2}:\d{2})$/, '$1 → $2，$3'],
    [/^read #(\d+) · updated (.+)$/, (m, seq, when) => `读到 #${seq} · ${zh(when)}更新`],
    [/^Narrator read up to #(\d+) of (\d+)$/, '讲解员读到 #$1（共 #$2）'],
    [/^(.+): last step failed \((quota|error)\)$/, (m, who, why) => `${who}：最后一步失败（${why === 'quota' ? '额度用尽' : '出错'}）`],
    [/^(.+): no progress, and not waiting on the board$/, '$1：没有进展，也没有在板上等'],
    [/^#(\d+) from @([^\s:]+)(.*)$/, (m, seq, who, rest) => `#${seq} 来自 @${who}${rest}`],
    [/^(\d+) @all$/, '$1 条 @all'],
    [/^@all (\d+)$/, '@all $1 条'],
    [/^paused: (quota|error)$/, (m, why) => (why === 'quota' ? '已暂停：额度用尽' : '已暂停：出错')],
    [/^Runs on (.+)$/, (m, who) => `运行在 ${zh(who)}`],
    [/^Everyone in #(.+)$/, '#$1 里的所有人'],
    [/^#(.+) is archived: this addresses nobody$/, '#$1 已归档：这条不会叫到任何人'],
    [/^Go to #(\d+) \((.+)\)$/, '跳到 #$1（$2）'],
    [/^Go to #(\d+)$/, '跳到 #$1'],
    [/^Go to #(\d+) on the Board$/, '在看板跳到 #$1'],
    [/^Post #(\d+) was not found$/, '找不到 #$1 这条消息'],
    [/^Exported (.+) \((.+)\)$/, '已导出 $1（$2）'],
    [/^Download (.+)$/, '下载 $1'],
    [/^Exporting (.+)…$/, '正在导出 $1…'],
    [/^Rendering (.+)…$/, '正在渲染 $1…'],
    [/^(.+) runs on (.+); open it there\.$/, (m, who, where) => `${who} 运行在 ${zh(where)}，请到那边打开。`],
    [/^Copied “(.+)”\. Paste it to the coordinator and say what you want changed\.$/,
      '已复制“$1”。粘给协调者，并说明要改什么。'],
    [/^Tell it “(.+) …” to the coordinator on (.+)\.$/, (m, text, where) => `去跟 ${zh(where)} 上的协调者说：“${text} …”。`],
    [/^Last change: “(.+)”$/, '最近一次改动：“$1”'],
    [/^(.+)'s page · AI-generated$/, '$1 的页面 · AI 生成'],
    [/^(.+)'s page$/, '$1 的页面'],
    [/^(.+)'s conversation needs the app\.$/, '$1 的会话需要在应用里打开。'],
    [/^(.+)s conversation needs the app\.$/, '$1 的会话需要在应用里打开。'],
    [/^(Coordinator|Narrator|Monitor) · /, (m, who) => `${{ Coordinator: '协调者', Narrator: '讲解员', Monitor: '监工' }[who]} · `],
    [/^(\d[\d.]*[KMG]B)$/, '$1'],
  ];

  // 只翻译外壳：这些容器里的内容属于用户 / agent / 原始文件。
  const SKIP = 'pre, code, textarea, script, style, .raw, .msg-body, [contenteditable="true"], [data-zh-skip]';
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

  const norm = (s) => String(s).replace(/\u2019/g, "'").replace(/\u00a0/g, ' ');

  // 规则里要把捕获到的片段再翻一次（"Runs on another machine"），所以留个钩子。
  let translateText = null;
  const zh = (text) => (translateText ? translateText(String(text)) : String(text));

  translateText = function translate(raw) {
    if (!raw) return raw;
    const lead = raw.match(/^\s*/)[0];
    const tail = raw.match(/\s*$/)[0];
    const core = raw.slice(lead.length, raw.length - tail.length);
    if (!core) return raw;
    const key = norm(core);
    if (Object.prototype.hasOwnProperty.call(TEXT, key)) return lead + TEXT[key] + tail;
    let out = key;
    for (let i = 0; i < RULES.length; i += 1) {
      const [re, rep] = RULES[i];
      const next = out.replace(re, rep);
      if (next !== out) out = next;
    }
    return out === core ? raw : lead + out + tail;
  };

  const skipped = (el) => {
    try { return Boolean(el && el.closest && el.closest(SKIP)); } catch (e) { return false; }
  };

  function translateNode(node) {
    if (node.nodeType === 3) {
      if (skipped(node.parentElement)) return;
      const next = translateText(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== 1) return;
    if (skipped(node)) return;
    for (let i = 0; i < ATTRS.length; i += 1) {
      const name = ATTRS[i];
      if (!node.hasAttribute || !node.hasAttribute(name)) continue;
      const value = node.getAttribute(name);
      const next = translateText(value);
      if (next !== value) node.setAttribute(name, next);
    }
  }

  function walk(root) {
    if (!root) return;
    translateNode(root);
    if (!root.querySelectorAll) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      translateNode(node);
      node = walker.nextNode();
    }
  }

  // 关系图的标题、图例和回放摘要有一部分是 canvas 里 fillText 画的字，
  // DOM 遍历碰不到，所以在 draw 入口再翻一次。
  function patchCanvas() {
    const proto = typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype;
    if (!proto || proto.__swarmZhPatched) return;
    proto.__swarmZhPatched = true;
    ['fillText', 'strokeText'].forEach((name) => {
      const original = proto[name];
      if (typeof original !== 'function') return;
      proto[name] = function patched(text) {
        const args = Array.prototype.slice.call(arguments, 1);
        return original.apply(this, [translateText(String(text))].concat(args));
      };
    });
  }

  function install() {
    if (typeof document === 'undefined' || !document.body) return;
    patchCanvas();
    document.documentElement.setAttribute('lang', 'zh-CN');
    if (document.title) document.title = translateText(document.title);
    walk(document.body);

    // app.js 每个轮询周期都会重画 innerHTML，跟着新节点翻译即可。
    let queued = false;
    let applying = false;
    const flush = () => {
      queued = false;
      if (applying) return;
      applying = true;
      try { walk(document.body); } finally { applying = false; }
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
      else setTimeout(flush, 16);
    };
    const observer = new MutationObserver((records) => {
      if (applying) return;
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (record.type === 'characterData') continue; // 由 walk 统一处理整棵树
        if (record.addedNodes && record.addedNodes.length) { schedule(); return; }
      }
      if (records.some((r) => r.type === 'attributes')) schedule();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS,
    });
  }

  window.__swarmZh = { TEXT, RULES, translateText, install };
})();
