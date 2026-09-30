/**
 * 游戏历史记录管理模块
 * 使用 localStorage 存储每局游戏的得分、时间、结果
 */
var HistoryManager = (function() {
  var STORAGE_KEY = 'game_history';
  var MAX_RECORDS_PER_GAME = 50; // 每个游戏最多保留50条记录

  var GAME_NAMES = {
    '2048': '2048',
    'tetris': '俄罗斯方块',
    'snake': '贪吃蛇',
    'snake-ai1': '人机贪吃蛇',
    'snake-ai2': '人机贪吃蛇2',
    'snake-ai3': '人机贪吃蛇3',
    'snake-ai35': '人机贪吃蛇3.5',
    'snake-ai4': '人机贪吃蛇4',
    'snake-ai5': '人机贪吃蛇5',
    'snake-adventure': '贪吃蛇大冒险'
  };

  var GAME_ICONS = {
    '2048': '🔢',
    'tetris': '🧱',
    'snake': '🐍',
    'snake-ai1': '⚔️',
    'snake-ai2': '🧠',
    'snake-ai3': '🏆',
    'snake-ai35': '🌟',
    'snake-ai4': '🔥',
    'snake-ai5': '💎',
    'snake-adventure': '🗺️'
  };

  function _loadAll() {
    try {
      var data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : {};
    } catch(e) {
      return {};
    }
  }

  function _saveAll(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch(e) {
      console.warn('Failed to save history:', e);
    }
  }

  /**
   * 记录一局游戏
   * @param {string} gameId - 游戏ID
   * @param {object} record - { score, result, duration, bestScore, extra }
   *   result: 'win' | 'lose' | 'quit'
   *   duration: 游戏时长(秒)
   *   bestScore: 历史最高分(可选)
   *   extra: 额外信息(可选，如关卡、模式等)
   */
  function record(gameId, record) {
    var data = _loadAll();
    if (!data[gameId]) data[gameId] = [];

    var entry = {
      score: record.score || 0,
      result: record.result || 'quit',
      duration: record.duration || 0,
      bestScore: record.bestScore || record.score || 0,
      extra: record.extra || null,
      time: Date.now()
    };

    data[gameId].push(entry);

    // 限制记录数量
    if (data[gameId].length > MAX_RECORDS_PER_GAME) {
      data[gameId] = data[gameId].slice(-MAX_RECORDS_PER_GAME);
    }

    _saveAll(data);
    return entry;
  }

  /**
   * 获取某个游戏的历史记录
   */
  function getRecords(gameId) {
    var data = _loadAll();
    return data[gameId] || [];
  }

  /**
   * 获取所有游戏的历史记录
   */
  function getAllGames() {
    return _loadAll();
  }

  /**
   * 获取某个游戏的统计信息
   */
  function getStats(gameId) {
    var records = getRecords(gameId);
    if (records.length === 0) return null;

    var scores = records.map(function(r) { return r.score || 0; });
    var wins = records.filter(function(r) { return r.result === 'win'; }).length;
    var totalDuration = records.reduce(function(sum, r) { return sum + (r.duration || 0); }, 0);

    return {
      totalGames: records.length,
      bestScore: Math.max.apply(null, scores),
      avgScore: Math.round(scores.reduce(function(a,b) { return a+b; }, 0) / scores.length),
      wins: wins,
      winRate: Math.round(wins / records.length * 100),
      totalDuration: totalDuration,
      lastPlay: records[records.length - 1].time
    };
  }

  /**
   * 清空某个游戏的历史
   */
  function clearGame(gameId) {
    var data = _loadAll();
    delete data[gameId];
    _saveAll(data);
  }

  /**
   * 清空所有历史
   */
  function clearAll() {
    _saveAll({});
  }

  /**
   * 格式化时长
   */
  function formatDuration(seconds) {
    if (!seconds || seconds < 0) return '0秒';
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    if (m > 0) return m + '分' + s + '秒';
    return s + '秒';
  }

  /**
   * 格式化时间戳
   */
  function formatTime(ts) {
    var d = new Date(ts);
    var month = (d.getMonth() + 1).toString().padStart(2, '0');
    var day = d.getDate().toString().padStart(2, '0');
    var hour = d.getHours().toString().padStart(2, '0');
    var min = d.getMinutes().toString().padStart(2, '0');
    return month + '-' + day + ' ' + hour + ':' + min;
  }

  /**
   * 获取游戏名称
   */
  function getGameName(gameId) {
    return GAME_NAMES[gameId] || gameId;
  }

  /**
   * 获取游戏图标
   */
  function getGameIcon(gameId) {
    return GAME_ICONS[gameId] || '🎮';
  }

  /**
   * 注入返回按钮和历史记录挂钩到游戏页面
   * 在游戏HTML的 <body> 后调用
   */
  function injectBackButton() {
    var btn = document.createElement('div');
    btn.innerHTML = '← 返回';
    btn.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999;' +
      'background:rgba(0,0,0,0.6);color:#fff;padding:8px 16px;border-radius:20px;' +
      'font-size:14px;cursor:pointer;font-family:sans-serif;backdrop-filter:blur(4px);' +
      'border:1px solid rgba(255,255,255,0.2);transition:all 0.2s;';
    btn.ontouchstart = btn.onmousedown = function() {
      btn.style.transform = 'scale(0.9)';
      btn.style.opacity = '0.7';
    };
    btn.ontouchend = btn.onmouseup = function() {
      btn.style.transform = '';
      btn.style.opacity = '';
    };
    btn.onclick = function() {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        // 兜底：从任意子目录回到根首页
        var root = location.pathname.replace(/[^/]*\.html?$/, '').replace(/[^/]+\/$/, '');
        location.href = root + 'index.html';
      }
    };
    document.body.appendChild(btn);
  }

  return {
    record: record,
    getRecords: getRecords,
    getAllGames: getAllGames,
    getStats: getStats,
    clearGame: clearGame,
    clearAll: clearAll,
    formatDuration: formatDuration,
    formatTime: formatTime,
    getGameName: getGameName,
    getGameIcon: getGameIcon,
    injectBackButton: injectBackButton
  };
})();
