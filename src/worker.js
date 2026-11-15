// 米游社扫码签到助手 —— Cloudflare Worker
// 设计：Cookie 只存在于访客浏览器 localStorage，服务端不落库（无 DB、无 KV）
import qrcode from "qrcode-generator";
import md5 from "js-md5";

const SALT = "t0qEgfub6cvueAPgR5m9aQWWVciEer7v";
const APP_VERSION = "2.117.0";
const UA =
  "Mozilla/5.0 (Linux; Android 12; Unspecified Device) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Version/4.0 Chrome/103.0.5060.129 Mobile Safari/537.36 miHoYoBBS/" + APP_VERSION;
const PASS = "https://passport-api.miyoushe.com/account/ma-cn-passport/web";
const BINDING = "https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie";

const GAMES = {
  hk4e_cn: { name: "原神", act: "e202311201442471", host: "https://api-takumi.mihoyo.com", prefix: "/event/luna", sg: "hk4e" },
  hkrpg_cn: { name: "崩坏：星穹铁道", act: "e202304121516551", host: "https://api-takumi.mihoyo.com", prefix: "/event/luna", sg: "hkrpg" },
  nap_cn: { name: "绝区零", act: "e202406242138391", host: "https://act-nap-api.mihoyo.com", prefix: "/event/luna/zzz", sg: "zzz" },
  bh3_cn: { name: "崩坏3", act: "e202306201626331", host: "https://api-takumi.mihoyo.com", prefix: "/event/luna", sg: "bh3" },
  bh2_cn: { name: "崩坏2", act: "e202203291431091", host: "https://api-takumi.mihoyo.com", prefix: "/event/luna", sg: "bh2" },
  nxx_cn: { name: "未定事件簿", act: "e202202251749321", host: "https://api-takumi.mihoyo.com", prefix: "/event/luna", sg: "nxx" },
};

function ds2(query = "", body = "") {
  const t = String(Math.floor(Date.now() / 1000));
  const r = String(100001 + Math.floor(Math.random() * 99999));
  const c = md5(`salt=${SALT}&t=${t}&r=${r}&b=${body}&q=${query}`);
  return `${t},${r},${c}`;
}

async function call(url, { method = "GET", body = "", query = "", cookie = "", device = "", sg = "", extra = {} } = {}) {
  const headers = {
    Cookie: cookie,
    DS: ds2(query, body),
    "x-rpc-app_version": APP_VERSION,
    "x-rpc-client_type": "5",
    "x-rpc-channel": "miyousheluodi",
    "x-rpc-device_id": device || "8" + Math.random().toString(16).slice(2, 17),
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    Origin: "https://webstatic.mihoyo.com",
    Referer: "https://webstatic.mihoyo.com/",
    ...extra,
  };
  if (sg) headers["x-rpc-signgame"] = sg;
  const init = { method, headers };
  if (body) init.body = body;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { retcode: -1, message: text.slice(0, 200) }; }
    return { json, res };
  } catch (e) {
    return { json: { retcode: -9999, message: "网络错误 " + e.message }, res: null };
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });

const mask = (s) => (s && s.length > 1 ? s[0] + "***" : s || "");
const maskUid = (u) => (u && u.length > 7 ? u.slice(0, 3) + "****" + u.slice(-2) : u || "");

async function handleQr(req) {
  const dev = "8" + Math.random().toString(16).slice(2, 18);
  const { json: d } = await call(PASS + "/createQRLogin", {
    method: "POST",
    body: "{}",
    device: dev,
    extra: {
      "x-rpc-app_id": "bll8iq97cem8",
      "x-rpc-client_type": "4",
      "content-type": "application/json",
      Origin: "https://user.mihoyo.com",
      Referer: "https://user.mihoyo.com/",
    },
  });
  if (!d || d.retcode !== 0) return json({ ok: false, msg: d?.message || "生成失败" });
  const url = d.data.url;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return json({ ok: true, ticket: d.data.ticket, device: dev, url, png: qr.createDataURL(8, 4) });
}

async function handlePoll(url) {
  const ticket = url.searchParams.get("ticket");
  const device = url.searchParams.get("device") || "";
  if (!ticket) return json({ ok: false, msg: "missing ticket" });
  const { json: d, res } = await call(PASS + "/queryQRLoginStatus", {
    method: "POST",
    body: JSON.stringify({ ticket }),
    device,
    extra: {
      "x-rpc-app_id": "bll8iq97cem8",
      "x-rpc-client_type": "4",
      "content-type": "application/json",
      Origin: "https://user.mihoyo.com",
      Referer: "https://user.mihoyo.com/",
    },
  });
  if (!d) return json({ ok: false, msg: "查询失败" });
  if (d.retcode === -3501) return json({ ok: false, status: "Expired", msg: "二维码已过期" });
  if (d.retcode === -3505) return json({ ok: false, status: "Cancelled", msg: "已取消" });
  const status = d.data?.status;
  if (status !== "Confirmed") return json({ ok: true, status });
  const jar = {};
  const raw = res?.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const first = c.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) jar[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join(";");
  const aid = String(d.data?.user_info?.aid || jar.ltuid_v2 || "");
  if (!cookie.includes("ltoken_v2")) return json({ ok: false, status, msg: "没有拿到登录凭证，请重试" });
  return json({ ok: true, status, cookie, aid, aidMasked: maskUid(aid) });
}

async function stats(body) {
  const cookie = body.cookie || "";
  const device = body.device || "";
  if (!cookie) return json({ ok: false, msg: "未登录" });
  const out = [];
  for (const [biz, g] of Object.entries(GAMES)) {
    const q = `game_biz=${biz}&lang=zh-cn`;
    const { json: br } = await call(`${BINDING}?${q}`, { cookie, device, query: q });
    const roles = br?.data?.list || [];
    if (!roles.length) continue;
    const qa = `act_id=${g.act}&lang=zh-cn`;
    const { json: hr } = await call(`${g.host}${g.prefix}/home?${qa}`, { cookie, device, query: qa, sg: g.sg });
    const awards = hr?.data?.awards || [];
    const list = [];
    for (const r of roles) {
      const qi = `act_id=${g.act}&region=${r.region}&uid=${r.game_uid}&lang=zh-cn`;
      const { json: ir } = await call(`${g.host}${g.prefix}/info?${qi}`, { cookie, device, query: qi, sg: g.sg });
      const day = Number(ir?.data?.total_sign_day || 0);
      const a = awards[day - 1];
      list.push({
        uid: String(r.game_uid),
        uidMasked: maskUid(String(r.game_uid)),
        region: r.region,
        nick: mask(r.nickname),
        level: r.level,
        day,
        isSign: !!ir?.data?.is_sign,
        award: a ? `${a.name}×${a.cnt}` : "",
      });
    }
    out.push({ biz, name: g.name, roles: list });
  }
  return json({ ok: true, games: out });
}

async function sign(body) {
  const { cookie, device, biz, uid, region } = body;
  const g = GAMES[biz];
  if (!g || !cookie || !uid || !region) return json({ ok: false, msg: "参数不合法" });
  const payload = JSON.stringify({ act_id: g.act, region, uid, lang: "zh-cn" });
  const { json: d } = await call(`${g.host}${g.prefix}/sign`, {
    method: "POST", body: payload, cookie, device, sg: g.sg,
    extra: { "content-type": "application/json" },
  });
  const rc = d?.retcode;
  const ok = rc === 0 || rc === -5003;
  return json({ ok, retcode: rc, msg: d?.message || "", already: rc === -5003 });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }
    try {
      if (path === "/api/qr" && (request.method === "POST" || request.method === "GET")) return await handleQr(request);
      if (path === "/api/poll") return await handlePoll(url);
      if (path === "/api/stats" && request.method === "POST") return await stats(await request.json());
      if (path === "/api/sign" && request.method === "POST") return await sign(await request.json());
      if (path === "/" || path === "/index.html") {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return json({ ok: false, msg: "服务器错误: " + e.message }, 500);
    }
  },
};

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>米游社签到助手</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:16px;font:15px/1.6 -apple-system,"PingFang SC",sans-serif;background:#0f1216;color:#e8eaed}
h1{font-size:19px;margin:0 0 4px}.sub{color:#8b939d;font-size:12px;margin-bottom:14px}
.card{background:#171b21;border:1px solid #232a33;border-radius:14px;padding:14px;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:15px;font-weight:600}
button:disabled{background:#2a3444;color:#7c8797}
button.ghost{background:#232a33;color:#cfd4da;font-weight:400;font-size:13px;padding:9px}
img.qr{display:block;width:100%;max-width:260px;margin:12px auto;border-radius:10px;background:#fff;padding:8px}
.game{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}
.name{font-weight:600}.nick{color:#8b939d;font-size:12px}
.big{font-size:24px;font-weight:700;color:#7dd3a0}.big span{font-size:12px;color:#8b939d;font-weight:400;margin-left:4px}
.award{color:#e8c46a;font-size:13px;margin:4px 0 10px}
.tip{color:#8b939d;font-size:12px;line-height:1.5}
.err{color:#f87171;font-size:13px}
</style></head><body>
<h1>米游社签到助手</h1>
<div class="sub">扫码登录 · 查看签到天数与奖励 · 一键签到</div>
<div id="app"></div>
<div class="tip" style="margin-top:14px">登录凭证只保存在你的浏览器里，关闭页面或点“清除登录”即删除；服务端不保存任何账号信息。</div>
<script>
const app = document.getElementById('app');
let st = { cookie: '', device: '', aid: '', ticket: '', timer: null, games: [], busy: false };
st.cookie = localStorage.getItem('mys_cookie') || '';
st.device = localStorage.getItem('mys_device') || '';
st.aid = localStorage.getItem('mys_aid') || '';

function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function render(){ st.cookie ? renderUser() : renderLogin(); }

function renderLogin(msg){
  app.innerHTML = \`<div class="card">
    <div class="tip">用米游社 App 扫码登录，登录后可以查看本月签到天数、今天的奖励，也可以直接签到。</div>
    <div id="qrbox"></div>
    <button id="btnqr" style="margin-top:12px">生成二维码</button>
    <div class="err" id="msg">\${esc(msg||'')}</div>
  </div>\`;
  document.getElementById('btnqr').onclick = makeQR;
  if(st.ticket) showQR();
}

async function makeQR(){
  const btn = document.getElementById('btnqr'); if(btn){btn.disabled=true;btn.textContent='生成中…'}
  const r = await fetch('/api/qr',{method:'POST'}).then(x=>x.json()).catch(()=>({ok:false,msg:'网络错误'}));
  if(!r.ok){ if(btn){btn.disabled=false;btn.textContent='重新生成'} document.getElementById('msg').textContent = r.msg||'生成失败'; return; }
  st.ticket = r.ticket; st.device = r.device;
  st.qrPng = r.png; showQR(); poll();
}

function showQR(){
  document.getElementById('qrbox').innerHTML =
    \`<img class="qr" src="\${st.qrPng}" alt="二维码">
      <div class="tip">长按图片可保存到相册；米游社 App → 扫一扫 → 相册 选择这张图。</div>\`;
  const btn = document.getElementById('btnqr');
  if(btn){btn.disabled=true;btn.textContent='等待确认…'}
}

async function poll(){
  clearTimeout(st.timer);
  const r = await fetch('/api/poll?ticket='+encodeURIComponent(st.ticket)+'&device='+encodeURIComponent(st.device))
    .then(x=>x.json()).catch(()=>({ok:false}));
  if(r.ok && r.status !== 'Confirmed'){
    st.timer = setTimeout(poll, 2500); return;
  }
  if(r.ok && r.status === 'Confirmed'){
    st.cookie = r.cookie; st.aid = r.aidMasked || r.aid || '';
    localStorage.setItem('mys_cookie', st.cookie);
    localStorage.setItem('mys_device', st.device);
    localStorage.setItem('mys_aid', st.aid);
    loadStats(); return;
  }
  const m = document.getElementById('msg'); if(m) m.textContent = r.msg || '二维码已失效，请重新生成';
  const btn = document.getElementById('btnqr'); if(btn){btn.disabled=false;btn.textContent='重新生成'}
}

async function loadStats(){
  app.innerHTML = '<div class="card">加载中…</div>';
  const r = await fetch('/api/stats',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({cookie:st.cookie,device:st.device})}).then(x=>x.json()).catch(()=>({ok:false,msg:'网络错误'}));
  if(!r.ok){ renderLogin(r.msg||'登录已失效，请重新扫码'); return; }
  st.games = r.games;
  renderUser();
}

function renderUser(){
  let html = \`<div class="card"><div class="game"><div class="name">已登录</div><div class="nick">\${esc(st.aid)}</div></div>
    <button class="ghost" id="btnclear">清除登录</button></div>\`;
  if(!st.games.length) html += '<div class="card">没有找到已绑定的游戏角色。</div>';
  for(const g of st.games){
    for(const x of g.roles){
      const signed = x.isSign;
      html += \`<div class="card">
        <div class="game"><div class="name">\${esc(g.name)}</div><div class="nick">\${esc(x.nick)}</div></div>
        <div class="big">\${x.day}<span>本月已签（天）</span></div>
        <div class="award">\${signed?'今天已签到':'今天还没签到'} · 今日奖励 \${esc(x.award||'—')}</div>
        <button class="sign" data-biz="\${g.biz}" data-uid="\${x.uid}" data-region="\${x.region}" \${signed?'disabled':''}>
          \${signed?'已签到':'帮我签到'}</button>
      </div>\`;
    }
  }
  app.innerHTML = html;
  document.getElementById('btnclear').onclick = ()=>{
    localStorage.clear(); st={cookie:'',device:'',aid:'',games:[]}; render();
  };
  document.querySelectorAll('button.sign').forEach(b=>{
    b.onclick = async ()=>{
      b.disabled=true; b.textContent='签到中…';
      const r = await fetch('/api/sign',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({cookie:st.cookie,device:st.device,biz:b.dataset.biz,uid:b.dataset.uid,region:b.dataset.region})})
        .then(x=>x.json()).catch(()=>({ok:false,msg:'网络错误'}));
      if(r.ok){ loadStats(); } else { b.disabled=false; b.textContent='签到失败：'+(r.msg||''); }
    };
  });
}

render();
if(st.cookie) loadStats();
</script></body></html>`;
