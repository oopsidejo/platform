// API منصة المواقع — Fastify + PostgreSQL (Supabase)
// كل الأسعار والمخزون والكوبونات تُحسب داخل قاعدة البيانات (create_order). لا نثق بأي رقم من المتصفح.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadState, applySync, can, page } from './live.js';

const env = process.env;
const DIAL = { jo: '962', ps: '970', sy: '963', lb: '961', sa: '966', iq: '964', eg: '20', ae: '971', kw: '965', qa: '974', il: '972' };
const PHRX = { jo: /^0?7[789]\d{7}$/, ps: /^0?5[69]\d{7}$/ };
const ph9 = p => String(p || '').replace(/\D/g, '').slice(-9);
const toE164 = (p, cid) => { let d = String(p || '').replace(/\D/g, ''); const dc = DIAL[cid] || '962'; if (d.startsWith('00')) d = d.slice(2); if (d.startsWith(dc)) return '+' + d; return '+' + dc + d.replace(/^0+/, ''); };
const phoneOk = (p, cid) => { let d = String(p || '').replace(/\D/g, ''); const dc = DIAL[cid]; if (dc && d.startsWith(dc)) d = '0' + d.slice(dc.length); else if (dc && d.startsWith('00' + dc)) d = '0' + d.slice(dc.length + 2); return PHRX[cid] ? PHRX[cid].test(d) : d.length >= 8 && d.length <= 13; };
const OTP_SECRET = () => env.OTP_SECRET || env.SUPABASE_SERVICE_KEY || 'otp';
const hashCode = (c, p) => crypto.createHash('sha256').update(OTP_SECRET() + ':' + p + ':' + c).digest('hex');
async function sendSms(to, text) {
  if (!env.SMSGATE_USER || !env.SMSGATE_PASS) throw new Error('nogw');
  const r = await fetch((env.SMSGATE_URL || 'https://api.sms-gate.app/3rdparty/v1') + '/messages', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(env.SMSGATE_USER + ':' + env.SMSGATE_PASS).toString('base64'), 'content-type': 'application/json' },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to], ttl: 600 }) });
  if (!r.ok) throw new Error('gw ' + r.status);
}
const RCPT = /^receipts\/[0-9]{4}-[0-9]{2}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;
// عمود date يرجع كنص YYYY-MM-DD (بدون تحويل لمنطقة زمنية → لا ينزاح التاريخ يوماً)
pg.types.setTypeParser(1082, v => v);
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: +(env.DB_POOL || 5),
});
pool.on('error', e => console.error('pg pool', e.message));
const q = async (sql, params) => (await pool.query(sql, params)).rows;

export function build() {
  const app = Fastify({ logger: env.NODE_ENV !== 'test' || !!env.DEBUG_ERR, trustProxy: true, bodyLimit: 200_000 });
  const origins = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  app.register(cors, { origin: origins.length ? origins : true });
  app.register(rateLimit, { global: true, max: +(env.RL_GLOBAL || 300), timeWindow: '1 minute' });
  // مهم: تعريف المسارات بعد اكتمال تحميل rate-limit (وإلا لا يُطبَّق أي حد على أي مسار)
  app.after(() => {

  const strict = { config: { rateLimit: { max: +(env.RL_WRITE || 10), timeWindow: '1 minute' } } };
  const fail = (reply, msg, code = 400) => { reply.code(code); return { ok: false, error: msg }; };
  // أخطاء قاعدة البيانات اللي رسالتها عربية مقصودة للزبون؛ غيرها نخفيه
  const dbErr = (reply, e) => {
    const m = String(e.message || '');
    if (/[؀-ۿ]/.test(m)) return fail(reply, m);
    if (e.code === '23505') return fail(reply, 'قيمة مكررة: ' + (/slug/.test(m) ? 'الرابط المختصر مستخدم لمنتج أو موقع آخر' : /code/.test(m) ? 'كود الكوبون مستخدم' : /domain/.test(m) ? 'الدومين مستخدم لموقع آخر' : /subscribers/.test(m) ? 'رقم المشترك موجود مسبقاً' : 'موجودة مسبقاً'));
    if (e.code === '23503') return fail(reply, 'لا يمكن الحذف: العنصر مرتبط ببيانات أخرى (طلبات أو دول). حدّث الصفحة للتراجع');
    if (e.code === '22P02' || e.code === '23502' || e.code === '23514') { app.log.warn({ e: m }, 'bad data'); return fail(reply, 'قيمة غير صحيحة بأحد الحقول (تأكد من الأرقام والحقول المطلوبة)'); }
    app.log.error(e); return fail(reply, 'حدث خطأ، حاول مرة ثانية', 500);
  };
  // أي خطأ غير متوقع: لا نكشف تفاصيل قاعدة البيانات للزائر
  app.setErrorHandler((e, req, reply) => {
    if (e.statusCode && e.statusCode < 500) { reply.code(e.statusCode); return reply.send({ ok: false, error: e.statusCode === 429 ? 'محاولات كثيرة، انتظر دقيقة وحاول مرة ثانية' : e.statusCode === 413 ? 'الملف أو البيانات أكبر من المسموح' : 'طلب غير صالح' }); }
    if (e.code === '22P02' || e.code === '23503' || e.code === '23502') { reply.code(400); return reply.send({ ok: false, error: 'بيانات غير صحيحة' }); }
    app.log.error(e); reply.code(500); return reply.send({ ok: false, error: 'حدث خطأ، حاول مرة ثانية' });
  });
  const str = (v, n) => String(v ?? '').trim().slice(0, n);
  const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  // UTM من الرابط: مفاتيح معروفة فقط ونصوص قصيرة (تُعرض بلوحة الإدارة)
  const cleanUtm = u => { if (!u || typeof u !== 'object') return null; const o = {};
    for (const k of ['source', 'medium', 'campaign', 'content', 'term', 'fbclid', 'ttclid']) if (u[k] !== undefined && u[k] !== null && String(u[k]).trim()) o[k] = String(u[k]).trim().slice(0, k.endsWith('clid') ? 300 : 120);
    return Object.keys(o).length ? o : null; };
  const siteBy = async (key) => (await q(
    `select * from sites where active and (id::text=$1 or slug=$1 or domain=$1) limit 1`, [String(key || '').toLowerCase()]))[0];

  app.get('/health', async () => { await q('select 1'); return { ok: true }; });

  // بيانات الموقع كاملة للواجهة: الإعدادات + المنتجات + الدول والمحافظات والدفع والعملات + التقييمات المنشورة
  app.get('/api/site', async (req, reply) => {
    const host = String(req.query.site || req.headers['x-site'] || req.hostname || '').replace(/^www\./, '');
    const s = await siteBy(host); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const [products, countries, governorates, payments, currencies, reviews, statuses] = await Promise.all([
      q(`select p.id,p.slug,p.name,p.name_en,p.category,p.description,p.description_en,p.ingredients,p.usage,coalesce(sp.price_override,p.price_jod) price_jod,p.old_price_jod,
          p.stock,p.min_stock,p.emoji,p.bg,p.best,p.badge,p.offer_end,p.options,p.images,p.videos,p.benefits,p.story,p.faq,p.landing,p.tiers,p.upsell,p.guarantee,p.seo_title,p.seo_desc
         from site_products sp join products p on p.id=sp.product_id where sp.site_id=$1 and sp.active and p.active order by sp.sort,p.created_at desc`, [s.id]),
      q(`select c.* from countries c join site_countries sc on sc.country_id=c.id where sc.site_id=$1 and c.active order by c.sort`, [s.id]),
      q(`select g.id,g.country_id,g.name,g.fee_jod,g.eta from governorates g join site_countries sc on sc.country_id=g.country_id where sc.site_id=$1 order by g.sort`, [s.id]),
      q(`select cpm.country_id,p.id,p.name,p.instructions from country_payment_methods cpm join payment_methods p on p.id=cpm.method_id where p.active order by p.sort`),
      q(`select c.code,c.symbol,c.rate from currencies c join site_currencies sc on sc.currency=c.code where sc.site_id=$1`, [s.id]),
      q(`select id,product_id,name,stars,body,images,verified,created_at from reviews where site_id=$1 and approved order by created_at desc limit 500`, [s.id]),
      q(`select id,name,color from order_statuses order by sort`),
    ]);
    const { config, ...site } = s;
    // لا نرسل أي أسرار من config (مثل توكن CAPI) للمتصفح
    const pub = { ...(config || {}) }; delete pub.capiToken; delete pub.capi;
    reply.header('cache-control', 'public, max-age=30');
    return { ok: true, site: { ...site, config: pub }, products, countries, governorates, payments, currencies, reviews, statuses };
  });

  // إنشاء الطلب (آمن) + إرسال Purchase لميتا من الخادم
  app.post('/api/orders', strict, async (req, reply) => {
    const b = req.body || {};
    if (!String(b.phone || '').trim()) return fail(reply, 'رقم الهاتف مطلوب', 400);
    const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    // الحقول الإجبارية حسب إعداد «نموذج الطلب» للموقع (الافتراضي: الاسم والمنطقة والعنوان)
    const ff = ((s.config || {}).form || {}).fields, keyOf = { name: 'name', area: 'area', address: 'address', note: 'note' };
    const reqd = Array.isArray(ff) ? ff.filter(f => f && f.on && f.req && keyOf[f.k]).map(f => keyOf[f.k]) : ['name', 'area', 'address'];
    if (reqd.some(k => !String(b[k] || '').trim())) return fail(reply, 'هذا الحقل مطلوب', 400);
    if (!String(b.name || '').trim()) b.name = 'زبون';
    const vf = (s.config || {}).verify || {}, p9 = ph9(b.phone); let extraFlags = [];
    if (vf.phoneCheck !== false && !phoneOk(b.phone, String(b.country_id || 'jo'))) return fail(reply, 'رقم الهاتف غير صحيح', 400);
    const maxDay = +vf.maxPerDay || 0;
    if (maxDay > 0) { const n = (await q(`select count(*)::int n from orders where site_id=$1 and right(regexp_replace(phone,'\\D','','g'),9)=$2 and created_at>now()-interval '24 hours'`, [s.id, p9]))[0].n;
      if (n >= maxDay) return fail(reply, 'وصلت للحد الأقصى من الطلبات اليوم، تواصل معنا على واتساب', 429); }
    if (vf.otp === 'sms') {
      const ok = b.otp_token && (await q(`delete from otp_codes where site_id=$1 and phone9=$2 and token=$3 and verified_at>now()-interval '30 minutes' returning id`, [s.id, p9, String(b.otp_token)])).length;
      if (!ok) { const failed = (await q(`select 1 from otp_codes where site_id=$1 and phone9=$2 and failed and expires_at>now() limit 1`, [s.id, p9])).length;
        if (!failed) return fail(reply, 'أكّد رقمك بالكود أولاً', 400); extraFlags.push('nootp'); }
    }
    const payload = {
      site_id: s.id, name: str(b.name, 80), phone: str(b.phone, 25), country_id: str(b.country_id, 60), governorate_id: str(b.governorate_id, 40),
      area: str(b.area, 120), address: str(b.address, 300), payment_method: str(b.payment_method, 60), currency: str(b.currency, 8) || 'JOD',
      coupon: str(b.coupon, 40), note: str(b.note, 1000), utm: cleanUtm(b.utm),
      receipts: Array.isArray(b.receipts) ? b.receipts.filter(x => RCPT.test(String(x))).slice(0, 3) : [],
      items: Array.isArray(b.items) ? b.items.slice(0, 20).map(i => ({ product_id: (i || {}).product_id, qty: Math.max(1, Math.min(999, Math.floor(+(i || {}).qty || 1))), options: Array.isArray((i || {}).options) ? i.options.slice(0, 10).map(o => ({ name: str((o || {}).name, 80), label: str((o || {}).label, 80) })) : [], upsell: !!(i || {}).upsell })) : [],
    };
    if (!isUuid(payload.governorate_id) || payload.items.some(i => !isUuid(i.product_id))) return fail(reply, 'بيانات الطلب غير صحيحة');
    try {
      const r = (await q('select create_order($1::jsonb) r', [payload]))[0].r;
      if (extraFlags.length) await q(`update orders set flags=flags||$2::text[] where id=$1`, [r.order_id, extraFlags]);
      // تفاصيل محسوبة بالخادم لصفحة الشكر (الخصم والمجموع والمنتجات كما حُفظت فعلاً)
      try { const d = (await q(`select o.subtotal_jod, o.discount_jod, (select jsonb_agg(jsonb_build_object('pid',i.product_id,'name',i.name,'opts',coalesce(i.options_text,''),'qty',i.qty,'unit',i.unit_price_jod) order by i.id) from order_items i where i.order_id=o.id) items from orders o where o.id=$1`, [r.order_id]))[0];
        if (d) { r.subtotal_jod = +d.subtotal_jod; r.discount_jod = +d.discount_jod; r.items = (d.items || []).map(i => ({ ...i, unit: +i.unit })); } } catch (e) { app.log.warn({ e: e.message }, 'order details'); }
      sendCapi(s, r, b, req).catch(e => app.log.warn({ e: e.message }, 'capi failed'));
      return { ok: true, ...r };
    } catch (e) { return dbErr(reply, e); }
  });

  // طلب غير مكتمل (عند كتابة الاسم والرقم)
  app.post('/api/leads', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    if (s.config && s.config.leads === false) return { ok: true };
    try { await q('select save_lead($1,$2,$3,$4,$5)', [s.id, isUuid(b.product_id) ? b.product_id : null, str(b.name, 80), str(b.phone, 25), cleanUtm(b.utm)]); return { ok: true }; }
    catch (e) { return dbErr(reply, e); }
  });

  app.post('/api/track', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const no = parseInt(String(b.order_no || '').replace(/\D/g, '').slice(0, 15), 10); if (!no) return fail(reply, 'رقم الطلب غير صحيح');
    const r = (await q('select track_order($1,$2,$3) r', [s.id, no, String(b.phone || '')]))[0].r;
    return r ? { ok: true, order: r } : fail(reply, 'ما لقينا طلب بهذه البيانات', 404);
  });

  app.post('/api/reviews', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const stars = Math.min(5, Math.max(1, +b.stars || 5)), name = String(b.name || '').trim().slice(0, 60), body = String(b.body || '').trim().slice(0, 2000);
    if (!name || !body) return fail(reply, 'اكتب الاسم والتقييم');
    // الصور: روابط https نظيفة فقط (بدون رموز تكسر الـ HTML/CSS) — تُعرض بلوحة الإدارة وبالموقع
    const imgs = (Array.isArray(b.images) ? b.images : []).filter(u => typeof u === 'string' && u.length < 500 && /^https:\/\/[\w.-]+\/[\w\-./%~]+$/.test(u)).slice(0, 3);
    try {
      const pid = isUuid(b.product_id) ? (await q(`select 1 from site_products where site_id=$1 and product_id=$2`, [s.id, b.product_id]))[0] ? b.product_id : null : null;
      await q(`insert into reviews(site_id,product_id,name,stars,body,images,approved,verified) values($1,$2,$3,$4,$5,$6,false,false)`,
        [s.id, pid, name, stars, body, JSON.stringify(imgs)]);
      return { ok: true, message: 'شكراً! سيظهر تقييمك بعد مراجعته' };
    } catch (e) { return dbErr(reply, e); }
  });

  app.post('/api/subscribe', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const phone = String(b.phone || '').trim(); if (phone.replace(/\D/g, '').length < 9) return fail(reply, 'أدخل رقماً صحيحاً');
    if (phone.length > 25) return fail(reply, 'أدخل رقماً صحيحاً');
    const email = String(b.email || '').trim().slice(0, 120); if (email && !/^\S+@\S+\.\S+$/.test(email)) return fail(reply, 'الإيميل غير صحيح');
    await q(`insert into subscribers(site_id,name,email,phone) values($1,$2,$3,$4) on conflict(site_id,phone) do update set name=coalesce(excluded.name,subscribers.name), email=coalesce(excluded.email,subscribers.email)`,
      [s.id, str(b.name, 80) || null, email || null, phone]);
    let coupon = null; const wc = s.config && s.config.welcomeCp;
    if (wc) coupon = (await q(`select code from coupons where code=$1 and active`, [wc]))[0]?.code || null;
    return { ok: true, coupon };
  });

  app.post('/api/restock', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const phone = String(b.phone || '').trim(); if (phone.replace(/\D/g, '').length < 9) return fail(reply, 'أدخل رقماً صحيحاً');
    if (phone.length > 25 || !isUuid(b.product_id)) return fail(reply, 'أدخل رقماً صحيحاً');
    try { if (!(await q(`select 1 from restock_requests where site_id=$1 and product_id=$2 and phone=$3 and not done`, [s.id, b.product_id, phone]))[0])
        await q(`insert into restock_requests(site_id,product_id,phone) values($1,$2,$3)`, [s.id, b.product_id, phone]); return { ok: true }; }
    catch (e) { return dbErr(reply, e); }
  });

  // فحص الكوبون للعرض فقط (الحساب النهائي داخل create_order)
  app.post('/api/coupon', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const c = (await q(`select c.* from coupons c where upper(code)=upper($1) and active and (expires_on is null or expires_on>=current_date) and (max_uses=0 or used_count<max_uses)
      and (not exists(select 1 from coupon_sites x where x.coupon_id=c.id) or exists(select 1 from coupon_sites x where x.coupon_id=c.id and x.site_id=$2))`, [str(b.code, 40), s.id]))[0];
    return c ? { ok: true, type: c.type, value: +c.value } : fail(reply, 'الكوبون غير صالح');
  });

  // ================= اللوحة والمتجر الحقيقيين =================
  const SB = (env.SUPABASE_URL || '').replace(/\/$/, ''), ANON = env.SUPABASE_ANON_KEY || '', SVC = env.SUPABASE_SERVICE_KEY || '';
  if (env.NODE_ENV !== 'test' && (!/^https:\/\//.test(SB) || !ANON)) app.log.error('SUPABASE_URL / SUPABASE_ANON_KEY ناقصة أو غير صحيحة — تسجيل الدخول للوحة لن يعمل');
  const tokCache = new Map();
  async function authUser(req) {
    const t = String(req.headers.authorization || '').replace(/^Bearer\s*/i, '');
    if (env.NODE_ENV === 'test' && env.AUTH_TEST_UID) { if (t === 'test') return env.AUTH_TEST_UID; if (/^test:/.test(t) && isUuid(t.slice(5))) return t.slice(5); } // للاختبارات فقط
    if (!t || !SB || !ANON) return null;
    const c = tokCache.get(t); if (c && c.exp > Date.now()) return c.id;
    let r; try { r = await fetch(SB + '/auth/v1/user', { headers: { apikey: ANON, authorization: 'Bearer ' + t } }); } catch (e) { app.log.error({ e: e.message }, 'supabase auth unreachable'); return null; }
    if (!r.ok) return null; const u = await r.json().catch(() => null); if (!u || !isUuid(u.id)) return null;
    if (tokCache.size > 500) tokCache.clear();
    tokCache.set(t, { id: u.id, exp: Date.now() + 60_000 }); return u.id;
  }
  async function staffOf(req, reply) {
    const id = await authUser(req); if (!id) { reply.code(401); return null; }
    const st = (await q(`select * from staff where user_id=$1`, [id]))[0]; if (!st) { reply.code(403); return null; }
    return st;
  }
  async function tx(uid, fn) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)`, [uid, JSON.stringify({ sub: uid, role: 'authenticated' })]).catch(() => {});
      const r = await fn(c); await c.query('commit'); return r;
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }
  const invite = async (email) => {
    if (!SVC) throw new Error('أضف SUPABASE_SERVICE_KEY لإضافة موظفين');
    const r = await fetch(SB + '/auth/v1/invite', { method: 'POST', headers: { apikey: SVC, authorization: 'Bearer ' + SVC, 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    const j = await r.json(); if (!r.ok) throw new Error('تعذّر دعوة الموظف: ' + (j.msg || j.message || r.status)); return j.id;
  };

  const authAdmin = async (path, method, body) => {
    if (!SVC) throw new Error('أضف SUPABASE_SERVICE_KEY (service_role) بإعدادات Render');
    const r = await fetch(SB + '/auth/v1/admin/' + path, { method, headers: { apikey: SVC, authorization: 'Bearer ' + SVC, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const m = j.msg || j.message || j.error_description || ''; throw new Error(/already/i.test(m) ? 'هذا الإيميل مسجّل مسبقاً' : /password/i.test(m) ? 'كلمة السر ضعيفة' : 'تعذّر إنشاء حساب الموظف: ' + (m || r.status)); }
    return j;
  };
  const createUser = async (email, password) => (await authAdmin('users', 'POST', { email, password, email_confirm: true })).id;
  const setPassword = async (id, password) => { await authAdmin('users/' + id, 'PUT', { password }); };
  // ===== تطبيق ويب (PWA) للوحة =====
  const PUB = new URL('../public/', import.meta.url);
  app.get('/admin/manifest.webmanifest', async (req, reply) => reply.type('application/manifest+json').header('cache-control', 'public, max-age=3600').send(JSON.stringify({
    name: 'لوحة التحكم — منصة المواقع', short_name: 'لوحة التحكم', start_url: '/admin', scope: '/admin', display: 'standalone', dir: 'rtl', lang: 'ar',
    background_color: '#f3f4f8', theme_color: '#4f46e5',
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] })));
  app.get('/admin-sw.js', async (req, reply) => reply.type('application/javascript').header('cache-control', 'no-cache').send(fs.readFileSync(new URL('sw.js', PUB))));
  app.get('/icons/:f', async (req, reply) => { const f = String(req.params.f); if (!/^[a-z0-9-]+\.png$/.test(f)) return reply.code(404).send(); try { return reply.type('image/png').header('cache-control', 'public, max-age=604800').send(fs.readFileSync(new URL('icons/' + f, PUB))) } catch { return reply.code(404).send() } });
  app.get('/admin', async (req, reply) => reply.type('text/html').header('cache-control', 'no-store').send(page({ mode: 'admin', sb: SB, anon: ANON })));
  app.get('/admin/me', async (req, reply) => { const st = await staffOf(req, reply); return st ? { ok: true, id: st.user_id, name: st.name, role: st.role } : { ok: false }; });
  app.get('/admin/state', async (req, reply) => {
    const st = await staffOf(req, reply); if (!st) return { ok: false, error: 'غير مصرّح' };
    const c = await pool.connect(); try { const S = await loadState(c, { mode: 'admin', staff: st }); S.me = st.user_id; return { ok: true, S }; } finally { c.release(); }
  });
  app.post('/admin/sync', { bodyLimit: 5_000_000, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
    const st = await staffOf(req, reply); if (!st) return { ok: false, error: 'غير مصرّح' };
    try { const r = await tx(st.user_id, c => applySync(c, st, req.body || {}, { invite, createUser, setPassword })); return { ok: true, ...r }; } catch (e) { return dbErr(reply, e); }
  });
  app.post('/admin/action', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req, reply) => {
    const st = await staffOf(req, reply); if (!st) return { ok: false, error: 'غير مصرّح' };
    const b = req.body || {};
    try {
      if (b.type === 'status') { if (!can(st, 'orders') && !can(st, 'delivery')) throw new Error('غير مصرّح');
        if (!isUuid(b.order) || !isUuid(b.status)) throw new Error('بيانات غير صحيحة');
        const o = (await q(`select site_id from orders where id=$1`, [b.order]))[0]; if (!o) throw new Error('الطلب غير موجود');
        if (st.role !== 'admin' && st.site_ids && !st.site_ids.includes(o.site_id)) throw new Error('غير مصرّح');
        if (!(await q(`select 1 from order_statuses where id=$1`, [b.status]))[0]) throw new Error('الحالة غير موجودة، حدّث الصفحة');
        await tx(st.user_id, c => c.query(`select set_order_status($1,$2,$3)`, [b.order, b.status, str(b.who, 80) || st.name])); return { ok: true }; }
      if (b.type === 'stock') { if (!can(st, 'products')) throw new Error('غير مصرّح'); if (!isUuid(b.pid)) throw new Error('بيانات غير صحيحة');
        await tx(st.user_id, c => c.query(`select adjust_stock($1,$2,$3,$4)`, [b.pid, Math.max(0, Math.floor(+b.qty || 0)), st.name, b.reason || 'تعديل يدوي'])); return { ok: true }; }
      if (b.type === 'settle') { if (!can(st, 'delivery')) throw new Error('غير مصرّح'); if (!isUuid(b.cid)) throw new Error('بيانات غير صحيحة');
        const r = await tx(st.user_id, async c => (await c.query(`select settle_courier($1,$2) r`, [b.cid, st.name])).rows[0].r); return { ok: true, r }; }
      if (b.type === 'read') { if (!can(st, 'orders') && !can(st, 'products')) return { ok: true }; await q(`update notifications set read=true where not read`); return { ok: true }; }
      throw new Error('إجراء غير معروف');
    } catch (e) { return dbErr(reply, e); }
  });
  app.post('/admin/upload', { bodyLimit: 30_000_000, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const st = await staffOf(req, reply); if (!st) return { ok: false, error: 'غير مصرّح' };
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String((req.body || {}).data || '')); if (!m) return fail(reply, 'ملف غير صالح');
    if (!/^(image\/(png|jpe?g|webp|gif)|video\/(mp4|webm|quicktime))$/.test(m[1])) return fail(reply, 'نوع الملف غير مدعوم (صور أو فيديو mp4 فقط)');
    if (!SVC || !SB) return fail(reply, 'أضف SUPABASE_URL و SUPABASE_SERVICE_KEY بإعدادات الخادم لرفع الصور');
    const ext = (m[1].split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, ''), path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
    let r; try { r = await fetch(`${SB}/storage/v1/object/media/${path}`, { method: 'POST', headers: { apikey: SVC, authorization: 'Bearer ' + SVC, 'content-type': m[1], 'cache-control': '31536000' }, body: Buffer.from(m[2], 'base64') }); }
    catch (e) { return fail(reply, 'تعذّر الاتصال بمخزن الصور (تأكد من SUPABASE_URL)', 502); }
    if (!r.ok) { const t = (await r.text()).slice(0, 150); return fail(reply, /bucket/i.test(t) ? 'مخزن الصور غير جاهز: أنشئ Bucket عام باسم media في Supabase Storage' : 'فشل رفع الملف: ' + t, 500); }
    return { ok: true, url: `${SB}/storage/v1/object/public/media/${path}` };
  });

  // ===== تحليل الزيارات =====
  app.post('/api/ev', { bodyLimit: 4000, config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req, reply) => {
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b) } catch { b = {} } }
    const t = ['view', 'form', 'order'].includes(b.t) ? b.t : null, sid = String(b.sid || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
    if (!t || sid.length < 8 || !isUuid(b.site)) return { ok: true };
    const s = (await q(`select id from sites where id=$1 and active`, [b.site]))[0]; if (!s) return { ok: true };
    if (/bot|crawl|spider|facebookexternalhit|preview/i.test(String(req.headers['user-agent'] || ''))) return { ok: true };
    await q(`insert into site_events(site_id,sid,t,path,pid,src,camp,dev) values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.id, sid, t, String(b.path || '').slice(0, 120), isUuid(b.pid) ? b.pid : null, String(b.src || '').slice(0, 40) || null, String(b.camp || '').slice(0, 80) || null, b.dev === 'm' ? 'm' : 'd']);
    return { ok: true };
  });
  app.get('/admin/analytics', async (req, reply) => {
    const st = await staffOf(req, reply); if (!st) return { ok: false, error: 'غير مصرّح' };
    if (!can(st, 'reports') && !can(st, 'orders')) return fail(reply, 'غير مصرّح', 403);
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7)), sid = isUuid(req.query.site) ? req.query.site : null;
    let sites = sid ? [sid] : (await q(`select id from sites`)).map(r => r.id);
    if (st.role !== 'admin' && st.site_ids) sites = sites.filter(x => st.site_ids.includes(x));
    const P = [sites, days], E = `site_id = any($1::uuid[]) and at > now() - make_interval(days => $2::int)`, O = `o.site_id = any($1::uuid[]) and o.created_at > now() - make_interval(days => $2::int) and s.kind<>'cancel'`;
    const one = async (sql) => (await q(sql, P))[0];
    const kpi = await one(`select count(distinct sid)::int visitors, count(*) filter (where t='view')::int views, count(distinct sid) filter (where t='form')::int forms,
      count(distinct sid) filter (where dev='m')::int mob, count(distinct sid) filter (where t='order')::int ordsess from site_events where ${E}`);
    const ok = await one(`select count(*)::int orders, coalesce(sum(o.total_jod),0)::float sales from orders o join order_statuses s on s.id=o.status_id where ${O}`);
    const prev = await one(`select count(distinct sid)::int visitors from site_events where site_id = any($1::uuid[]) and at between now() - make_interval(days => $2::int * 2) and now() - make_interval(days => $2::int)`);
    const daily = await q(`with d as (select (current_date - g)::date as dd from generate_series(0, $2::int - 1) as g)
      select to_char(d.dd,'MM-DD') as "day", (select count(distinct sid) from site_events e where e.site_id = any($1::uuid[]) and e.at::date=d.dd)::int as v,
      (select count(*) from orders o join order_statuses s on s.id=o.status_id where o.site_id = any($1::uuid[]) and o.created_at::date=d.dd and s.kind<>'cancel')::int as o from d order by d.dd`, P);
    const prods = await q(`select p.id, p.name, coalesce(e.v,0)::int v, coalesce(e.f,0)::int f, coalesce(x.o,0)::int o, coalesce(x.s,0)::float s from products p
      left join (select pid, count(distinct sid) filter (where t='view') v, count(distinct sid) filter (where t='form') f from site_events where ${E} and pid is not null group by pid) e on e.pid=p.id
      left join (select i.product_id, count(distinct o.id) o, sum(i.qty*i.unit_price_jod) s from orders o join order_statuses s on s.id=o.status_id join order_items i on i.order_id=o.id where ${O} group by i.product_id) x on x.product_id=p.id
      where p.active and (coalesce(e.v,0)+coalesce(x.o,0))>0 order by v desc, o desc limit 20`, P);
    const srcs = await q(`with ev as (select coalesce(nullif(camp,''),nullif(src,''),'(مباشر)') k, count(distinct sid) v from site_events where ${E} group by 1),
      od as (select coalesce(nullif(o.utm->>'campaign',''),nullif(o.utm->>'source',''),'(مباشر)') k, count(*) o, sum(o.total_jod) s from orders o join order_statuses s on s.id=o.status_id where ${O} group by 1)
      select coalesce(ev.k,od.k) k, coalesce(ev.v,0)::int v, coalesce(od.o,0)::int o, coalesce(od.s,0)::float s from ev full join od on od.k=ev.k order by v desc nulls last limit 15`, P);
    const dev = await q(`select dev, count(distinct sid)::int v, count(distinct sid) filter (where t='form')::int f, count(distinct sid) filter (where t='order')::int o from site_events where ${E} group by dev`, P);
    const pages = await q(`select path, count(*)::int n from site_events where ${E} and t='view' group by path order by n desc limit 10`, P);
    const leads = await one(`select count(*)::int n from leads where site_id = any($1::uuid[]) and created_at > now() - make_interval(days => $2::int) and not converted`);
    return { ok: true, days, kpi: { ...kpi, ...ok, prevVisitors: prev.visitors, leads: leads.n }, daily, prods, srcs, dev, pages };
  });

  // ===== التحقق من الرقم OTP (رسائل من موبايل أندرويد عبر SMS Gateway) =====
  app.post('/api/otp/send', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const cid = String(b.country_id || 'jo'), p9 = ph9(b.phone);
    if (!phoneOk(b.phone, cid)) return fail(reply, 'رقم الهاتف غير صحيح');
    const n = (await q(`select count(*)::int n from otp_codes where site_id=$1 and phone9=$2 and created_at>now()-interval '1 hour'`, [s.id, p9]))[0].n;
    if (n >= 4) return fail(reply, 'طلبت كود كثير، حاول بعد شوي');
    const code = String(crypto.randomInt(1000, 10000));
    try {
      await sendSms(toE164(b.phone, cid), `كود تأكيد طلبك من ${s.name}: ${code}`);
      await q(`insert into otp_codes(site_id,phone9,code_hash,expires_at) values($1,$2,$3,now()+interval '10 minutes')`, [s.id, p9, hashCode(code, p9)]);
      return { ok: true };
    } catch (e) {
      app.log.warn({ e: e.message }, 'sms failed');
      await q(`insert into otp_codes(site_id,phone9,code_hash,expires_at,failed) values($1,$2,'-',now()+interval '20 minutes',true)`, [s.id, p9]);
      return { ok: true, skipped: true }; // البوابة معطّلة: نكمل الطلب بدون كود ونعلّمه
    }
  });
  app.post('/api/otp/verify', { config: { rateLimit: { max: 15, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const p9 = ph9(b.phone), r = (await q(`select * from otp_codes where site_id=$1 and phone9=$2 and not failed and expires_at>now() order by id desc limit 1`, [s.id, p9]))[0];
    if (!r) return fail(reply, 'انتهت صلاحية الكود، اطلب كود جديد');
    if (r.attempts >= 5) return fail(reply, 'محاولات كثيرة، اطلب كود جديد');
    if (r.code_hash !== hashCode(String(b.code || '').replace(/\D/g, ''), p9)) { await q(`update otp_codes set attempts=attempts+1 where id=$1`, [r.id]); return fail(reply, 'الكود غير صحيح'); }
    const token = crypto.randomBytes(16).toString('hex'); await q(`update otp_codes set token=$2, verified_at=now() where id=$1`, [r.id, token]);
    return { ok: true, token };
  });

  // ===== إيصالات الدفع (Bucket خاص اسمه receipts) =====
  async function putReceipt(dataUrl) {
    const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/s.exec(String(dataUrl || '')); if (!m) throw new Error('ارفع صورة فقط (JPG أو PNG)');
    const buf = Buffer.from(m[3], 'base64'); if (buf.length > 4_000_000) throw new Error('حجم الصورة كبير');
    if (!SVC || !SB) throw new Error('رفع الإيصالات غير مفعّل حالياً');
    const ext = m[2].replace('jpeg', 'jpg'), key = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
    const r = await fetch(`${SB}/storage/v1/object/receipts/${key}`, { method: 'POST', headers: { apikey: SVC, authorization: 'Bearer ' + SVC, 'content-type': m[1] }, body: buf });
    if (!r.ok) { const t = (await r.text()).slice(0, 150); throw new Error(/bucket/i.test(t) ? 'مخزن الإيصالات غير جاهز (أنشئ Bucket خاص باسم receipts)' : 'تعذّر رفع الصورة'); }
    return 'receipts/' + key;
  }
  app.post('/api/receipt-upload', { bodyLimit: 6_000_000, config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    try { return { ok: true, path: await putReceipt(b.data) }; } catch (e) { return fail(reply, e.message); }
  });
  // رفع إيصال بعد الطلب (من صفحة الشكر) — يتحقق من رقم الطلب والهاتف
  app.post('/api/receipt', { bodyLimit: 6_000_000, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const no = parseInt(String(b.order_no || '').replace(/\D/g, ''), 10), ph = String(b.phone || '').replace(/\D/g, '').slice(-9);
    const o = (await q(`select id, receipts from orders where site_id=$1 and order_no=$2 and right(regexp_replace(phone,'\\D','','g'),9)=$3`, [s.id, no || 0, ph]))[0];
    if (!o) return fail(reply, 'ما لقينا الطلب', 404); if ((o.receipts || []).length >= 3) return fail(reply, 'الحد الأقصى 3 صور');
    try { const p = await putReceipt(b.data); await q(`update orders set receipts=receipts||to_jsonb($2::text) where id=$1`, [o.id, p]);
      await q(`insert into notifications(body) values($1)`, [`📎 إيصال دفع جديد للطلب #${no}`]); return { ok: true }; } catch (e) { return fail(reply, e.message); }
  });
  app.get('/admin/receipt', async (req, reply) => {
    const st = await staffOf(req, reply); if (!st) return { ok: false, error: 'غير مصرّح' };
    const p = String(req.query.p || ''); if (!RCPT.test(p)) return fail(reply, 'مسار غير صالح');
    const r = await fetch(`${SB}/storage/v1/object/sign/${p}`, { method: 'POST', headers: { apikey: SVC, authorization: 'Bearer ' + SVC, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 900 }) });
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.signedURL) return fail(reply, 'تعذّر فتح الإيصال', 500);
    return { ok: true, url: SB + '/storage/v1' + j.signedURL };
  });

  // المتجر العام: الدومين يحدد الموقع (وإذا ما تطابق → أول موقع، مفيد لرابط onrender)
  async function storeSite(req) {
    const host = String(req.query.site || req.hostname || '').replace(/^www\./, '').replace(/:\d+$/, '').toLowerCase();
    return (await siteBy(host)) || (await q(`select * from sites where active order by created_at limit 1`))[0];
  }
  app.get('/store/state', async (req, reply) => {
    const s = await storeSite(req); if (!s) return fail(reply, 'لا يوجد موقع', 404);
    const c = await pool.connect(); try { reply.header('cache-control', 'public, max-age=20'); return { ok: true, S: await loadState(c, { mode: 'store', siteId: s.id }) }; } finally { c.release(); }
  });
  const storePage = async (req, reply) => {
    const s = await storeSite(req); if (!s) return reply.code(404).type('text/html').send('<h1 style="font-family:sans-serif;text-align:center;margin-top:20vh">لا يوجد موقع بعد — أنشئه من /admin</h1>');
    const cfg = s.config || {}; let seo = { title: cfg.seoT || s.name, desc: cfg.seoD || ((cfg.t || {}).ar || {}).heroSub || '' };
    if (req.params.page) { const pg = (cfg.cpages || []).find(p => p.slug === req.params.page); if (pg) seo = { title: `${pg.title} | ${s.name}`, desc: seo.desc }; }
    if (req.url.startsWith('/collections/all')) seo = { title: `${(cfg.coll || {}).title || 'كل المنتجات'} | ${s.name}`, desc: seo.desc };
    if (req.params.slug) {
      const p = (await q(`select p.* , coalesce(sp.price_override,p.price_jod) pr from products p join site_products sp on sp.product_id=p.id and sp.site_id=$1 and sp.active where p.active and (p.slug=$2 or p.id::text=$2) limit 1`, [s.id, req.params.slug]))[0];
      if (p) { const rv = (await q(`select count(*)::int n, avg(stars)::numeric(3,1) a from reviews where product_id=$1 and approved`, [p.id]))[0];
        seo = { title: p.seo_title || `${p.name} | ${s.name}`, desc: p.seo_desc || p.description || '', img: (p.images || [])[0],
          ld: { '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: p.seo_desc || p.description || '', image: p.images || [],
            offers: { '@type': 'Offer', priceCurrency: 'JOD', price: +p.pr, availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
            ...(rv.n ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: +rv.a, reviewCount: rv.n } } : {}) } }; }
    }
    return reply.type('text/html').header('cache-control', 'public, max-age=60').send(page({ mode: 'store', site: s.slug }, seo));
  };
  app.get('/', storePage); app.get('/p/:slug', storePage); app.get('/lp/:slug', storePage); app.get('/track', storePage); app.get('/thanks', storePage); app.get('/pages/:page', storePage); app.get('/collections/all', storePage);
  });
  return app;
}

// Meta Conversions API — event_id = رقم الطلب لمنع التكرار مع البكسل بالمتصفح
const sha = v => v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined;
async function sendCapi(site, r, b, req) {
  const cfg = site.config || {}, pixel = cfg.pixel, token = cfg.capiToken || cfg.capi || env['CAPI_TOKEN_' + site.slug.toUpperCase().replace(/-/g, '_')];
  if (!pixel || !token) return;
  const phone = String(b.phone || '').replace(/\D/g, '').replace(/^0/, '962');
  const body = { data: [{
    event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000), event_id: String(r.order_no), action_source: 'website',
    event_source_url: b.page_url || `https://${site.domain || ''}`,
    user_data: { ph: [sha(phone)], fn: [sha(String(b.name || '').split(' ')[0])], client_ip_address: req.ip, client_user_agent: req.headers['user-agent'], fbp: b.fbp, fbc: b.fbc },
    custom_data: { currency: 'JOD', value: +r.total_jod, order_id: String(r.order_no) },
  }], ...(cfg.capiTest ? { test_event_code: cfg.capiTest } : {}) };
  const res = await fetch(`https://graph.facebook.com/v21.0/${pixel}/events?access_token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('CAPI ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

if (process.env.NODE_ENV !== 'test') {
  build().listen({ port: +(env.PORT || 3000), host: '0.0.0.0' });
}
export { pool };
