// ==========================
//  Cloudflare Worker 后端
//  接收 Bug 报告，提供可视化面板，支持删除（密码验证）
//  依赖 D1 数据库绑定 (binding = "DB")
//  环境变量：PWD（删除密码）
// ==========================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 处理预检请求
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---------- 1. 提交 Bug ----------
    if (path === '/submit' && method === 'POST') {
      try {
        const bugData = await request.json();
        const { source, time, type, content, traceback } = bugData;

        if (!type || !content) {
          return Response.json(
            { success: false, error: '缺少必要字段: type 和 content' },
            { status: 400, headers: CORS_HEADERS }
          );
        }

        const result = await env.DB.prepare(
          `INSERT INTO bugs (source, time, type, content, traceback)
           VALUES (?, ?, ?, ?, ?) RETURNING id`
        ).bind(
          source || '未知线程',
          time || new Date().toLocaleString(),
          type,
          content,
          traceback || ''
        ).run();

        return Response.json(
          {
            success: true,
            id: result.meta?.last_row_id || result.results?.[0]?.id,
            message: '🐞 Bug 报告已接收！',
          },
          { headers: CORS_HEADERS }
        );
      } catch (e) {
        return Response.json(
          { success: false, error: e.message },
          { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    // ---------- 2. 查看面板（分页 + 筛选） ----------
    if (path === '/' && method === 'GET') {
      const params = new URLSearchParams(url.search);
      const page = parseInt(params.get('page')) || 1;
      const limit = Math.min(parseInt(params.get('limit')) || 20, 100);
      const typeFilter = params.get('type') || '';
      const offset = (page - 1) * limit;

      let whereClause = '';
      let bindParams = [];
      if (typeFilter) {
        whereClause = 'WHERE type = ?';
        bindParams.push(typeFilter);
      }

      // 总条数
      const countResult = await env.DB.prepare(
        `SELECT COUNT(*) as total FROM bugs ${whereClause}`
      ).bind(...bindParams).first();
      const totalItems = countResult?.total || 0;
      const totalPages = Math.ceil(totalItems / limit);

      // 分页数据
      const dataSql = `
        SELECT id, source, time, type, content, created_at
        FROM bugs ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `;
      const { results } = await env.DB.prepare(dataSql)
        .bind(...bindParams, limit, offset)
        .all();

      // 所有类型（用于筛选下拉）
      const typeList = await env.DB.prepare(
        'SELECT DISTINCT type FROM bugs ORDER BY type'
      ).all();
      const typeOptions = typeList.results || [];

      const html = renderDashboard(results, {
        page,
        limit,
        totalPages,
        totalItems,
        type: typeFilter,
        typeOptions,
      });

      return new Response(html, {
        headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' },
      });
    }

    // ---------- 3. JSON API（获取列表） ----------
    if (path === '/api/bugs' && method === 'GET') {
      const params = new URLSearchParams(url.search);
      const page = parseInt(params.get('page')) || 1;
      const limit = Math.min(parseInt(params.get('limit')) || 20, 100);
      const typeFilter = params.get('type') || '';
      const offset = (page - 1) * limit;

      let whereClause = '';
      let bindParams = [];
      if (typeFilter) {
        whereClause = 'WHERE type = ?';
        bindParams.push(typeFilter);
      }
      const sql = `SELECT * FROM bugs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      const { results } = await env.DB.prepare(sql)
        .bind(...bindParams, limit, offset)
        .all();
      return Response.json(
        { success: true, data: results, page, limit },
        { headers: CORS_HEADERS }
      );
    }

    // ---------- 4. 删除 Bug（新增） ----------
    if (path === '/delete' && method === 'POST') {
      try {
        const body = await request.json();
        const { password, ids, id } = body;

        // 验证密码
        const correctPassword = env.PWD;
        if (!correctPassword) {
          return Response.json(
            { success: false, error: '服务器未配置删除密码（PWD 环境变量）' },
            { status: 500, headers: CORS_HEADERS }
          );
        }
        if (password !== correctPassword) {
          return Response.json(
            { success: false, error: '密码错误' },
            { status: 401, headers: CORS_HEADERS }
          );
        }

        // 统一成数组
        let deleteIds = [];
        if (ids && Array.isArray(ids)) {
          deleteIds = ids;
        } else if (id !== undefined) {
          deleteIds = [id];
        } else {
          return Response.json(
            { success: false, error: '请提供 id 或 ids 数组' },
            { status: 400, headers: CORS_HEADERS }
          );
        }

        if (deleteIds.length === 0) {
          return Response.json(
            { success: false, error: '删除 ID 列表不能为空' },
            { status: 400, headers: CORS_HEADERS }
          );
        }

        // 构建 IN 语句的安全占位符
        const placeholders = deleteIds.map(() => '?').join(',');
        const sql = `DELETE FROM bugs WHERE id IN (${placeholders})`;

        const result = await env.DB.prepare(sql)
          .bind(...deleteIds)
          .run();

        const deletedCount = result.meta?.rows_written || result.results?.length || 0;

        return Response.json(
          {
            success: true,
            deletedCount,
            message: `成功删除 ${deletedCount} 条记录`,
          },
          { headers: CORS_HEADERS }
        );
      } catch (e) {
        return Response.json(
          { success: false, error: e.message },
          { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    return new Response('❌ 404 - 接口不存在。请访问 / 查看面板，或 POST 到 /submit', {
      status: 404,
      headers: CORS_HEADERS,
    });
  },
};

// ========== HTML 渲染函数（不变） ==========
function renderDashboard(bugs, pagination) {
  const { page, totalPages, totalItems, type, typeOptions } = pagination;

  const rows = bugs
    .map(
      (b) => `
    <tr>
      <td><strong>#${b.id}</strong></td>
      <td style="font-size:13px; max-width:150px; word-break:break-all;">${b.source}</td>
      <td style="font-size:13px;">${b.time}</td>
      <td><span class="badge">${b.type}</span></td>
      <td style="max-width:250px; word-break:break-all;">${b.content}</td>
      <td style="font-size:12px; color:#666;">${new Date(b.created_at).toLocaleString('zh-CN')}</td>
    </tr>
  `
    )
    .join('');

  const optionsHtml = typeOptions
    .map(
      (t) =>
        `<option value="${t.type}" ${t.type === type ? 'selected' : ''}>${t.type}</option>`
    )
    .join('');

  const paginationHtml = `
    <div class="pagination">
      <span>共 ${totalItems} 条记录，第 ${page}/${totalPages} 页</span>
      <div>
        <a href="?page=${page - 1}&type=${type}" class="${page <= 1 ? 'disabled' : ''}">⬅ 上一页</a>
        <a href="?page=${page + 1}&type=${type}" class="${page >= totalPages ? 'disabled' : ''}">下一页 ➡</a>
      </div>
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🐞 游戏 Bug 实时监控面板</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', -apple-system, sans-serif; background: #f4f6f9; padding: 30px; color: #1e293b; }
    .container { max-width: 1400px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; flex-wrap: wrap; gap: 15px; }
    h1 { font-size: 28px; font-weight: 700; background: linear-gradient(135deg, #e11d48, #f43f5e); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .stats { background: white; padding: 15px 25px; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
    .stats span { font-weight: 700; color: #0f172a; }
    .filters { background: white; padding: 15px 25px; border-radius: 16px; margin-bottom: 25px; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; border: 1px solid #e2e8f0; }
    .filters select, .filters input { padding: 8px 14px; border-radius: 8px; border: 1px solid #cbd5e1; background: white; font-size: 14px; }
    .filters button { background: #0f172a; color: white; border: none; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-weight: 500; }
    .filters button:hover { background: #1e293b; }
    .table-wrap { background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.04); border: 1px solid #e2e8f0; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { background: #f8fafc; text-align: left; padding: 14px 16px; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
    td { padding: 14px 16px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:hover td { background: #f8fafc; }
    .badge { background: #fee2e2; color: #b91c1c; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-block; }
    .empty { text-align: center; padding: 60px 20px; color: #94a3b8; }
    .empty .emoji { font-size: 48px; display: block; margin-bottom: 10px; }
    .pagination { display: flex; justify-content: space-between; align-items: center; padding: 18px 24px; background: white; border-top: 1px solid #e2e8f0; flex-wrap: wrap; gap: 10px; }
    .pagination a { padding: 6px 16px; background: #f1f5f9; border-radius: 6px; text-decoration: none; color: #0f172a; margin: 0 4px; font-size: 14px; }
    .pagination a.disabled { opacity: 0.4; pointer-events: none; }
    .pagination a:hover:not(.disabled) { background: #e2e8f0; }
    .footer-tip { margin-top: 15px; font-size: 13px; color: #94a3b8; text-align: center; }
    code { background: #e2e8f0; padding: 2px 8px; border-radius: 4px; font-size: 13px; }
  </style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🐞 Bug 追踪仪表盘</h1>
    <div class="stats">📊 当前显示 <span>${bugs.length}</span> 条 · 数据库总计 <span>${totalItems}</span> 条</div>
  </div>

  <div class="filters">
    <form method="GET" style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
      <label>筛选错误类型：</label>
      <select name="type">
        <option value="">全部类型</option>
        ${optionsHtml}
      </select>
      <button type="submit">应用筛选</button>
      <a href="/" style="color:#e11d48; text-decoration:none; font-size:14px;">🔄 重置</a>
    </form>
  </div>

  <div class="table-wrap">
    ${bugs.length === 0 ? `
      <div class="empty">
        <span class="emoji">🎉</span>
        <p>暂无 Bug 记录，你的游戏运行得很稳定！</p>
      </div>
    ` : `
      <table>
        <thead><tr><th>ID</th><th>来源线程</th><th>游戏时间</th><th>类型</th><th>内容</th><th>接收时间</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `}
    ${bugs.length > 0 ? paginationHtml : ''}
  </div>

  <div class="footer-tip">
    💡 游戏客户端请 POST JSON 至 <code>/submit</code>  | 原始数据 API: <code>/api/bugs</code>  | 删除接口: <code>POST /delete</code>（需密码）
  </div>
</div>
</body>
</html>`;
}
