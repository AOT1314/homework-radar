// 公网部署时的运行时配置：留空表示走 Supabase 云端。
// 本地的局域网服务会拦截这个路径、动态注入内网同步地址，所以这里的值只影响公网静态站。
window.__RADAR_SYNC_BASE__ = '';
window.__RADAR_SYNC_SPACE__ = '';
