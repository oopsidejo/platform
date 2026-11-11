// API منصة المواقع — Fastify + PostgreSQL (Supabase)
// كل الأسعار والمخزون والكوبونات تُحسب داخل قاعدة البيانات (create_order). لا نثق بأي رقم من المتصفح.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import crypto from 'node:crypto';

const env = process.env;
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
  app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });

  const strict = { config: { rateLimit: { max: +(env.RL_WRITE || 10), timeWindow: '1 minute' } } };
  const fail = (reply, msg, code = 400) => { reply.code(code); return { ok: false, error: msg }; };
  // أخطاء قاعدة البيانات اللي رسالتها عربية مقصودة للزبون؛ غيرها نخفيه
  const dbErr = (reply, e) => {
    const m = String(e.message || '');
    if (/[؀-ۿ]/.test(m)) return fail(reply, m);
    app.log.error(e); return fail(reply, 'حدث خطأ، حاول مرة ثانية', 500);
  };
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
    const miss = ['name', 'phone', 'area', 'address'].find(k => !String(b[k] || '').trim());
    if (miss) return fail(reply, 'هذا الحقل مطلوب', 400);
    const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const payload = {
      site_id: s.id, name: b.name, phone: b.phone, country_id: b.country_id, governorate_id: b.governorate_id,
      area: b.area, address: b.address, payment_method: b.payment_method, currency: b.currency || 'JOD',
      coupon: b.coupon || '', note: b.note || '', utm: b.utm || null,
      items: Array.isArray(b.items) ? b.items.slice(0, 20).map(i => ({ product_id: i.product_id, qty: +i.qty || 1, options: i.options || [], upsell: !!i.upsell })) : [],
    };
    try {
      const r = (await q('select create_order($1::jsonb) r', [payload]))[0].r;
      sendCapi(s, r, b, req).catch(e => app.log.warn({ e: e.message }, 'capi failed'));
      return { ok: true, ...r };
    } catch (e) { return dbErr(reply, e); }
  });

  // طلب غير مكتمل (عند كتابة الاسم والرقم)
  app.post('/api/leads', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    if (s.config && s.config.leads === false) return { ok: true };
    try { await q('select save_lead($1,$2,$3,$4,$5)', [s.id, b.product_id || null, b.name, b.phone, b.utm || null]); return { ok: true }; }
    catch (e) { return dbErr(reply, e); }
  });

  app.post('/api/track', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const no = parseInt(String(b.order_no || '').replace(/\D/g, ''), 10); if (!no) return fail(reply, 'رقم الطلب غير صحيح');
    const r = (await q('select track_order($1,$2,$3) r', [s.id, no, String(b.phone || '')]))[0].r;
    return r ? { ok: true, order: r } : fail(reply, 'ما لقينا طلب بهذه البيانات', 404);
  });

  app.post('/api/reviews', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const stars = Math.min(5, Math.max(1, +b.stars || 5)), name = String(b.name || '').trim().slice(0, 60), body = String(b.body || '').trim().slice(0, 2000);
    if (!name || !body) return fail(reply, 'اكتب الاسم والتقييم');
    const imgs = (Array.isArray(b.images) ? b.images : []).filter(u => /^https:\/\//.test(u)).slice(0, 3); // الصور ترفع أولاً على Storage
    await q(`insert into reviews(site_id,product_id,name,stars,body,images,approved,verified) values($1,$2,$3,$4,$5,$6,false,false)`,
      [s.id, b.product_id || null, name, stars, body, JSON.stringify(imgs)]);
    return { ok: true, message: 'شكراً! سيظهر تقييمك بعد مراجعته' };
  });

  app.post('/api/subscribe', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const phone = String(b.phone || '').trim(); if (phone.replace(/\D/g, '').length < 9) return fail(reply, 'أدخل رقماً صحيحاً');
    const email = String(b.email || '').trim(); if (email && !/^\S+@\S+\.\S+$/.test(email)) return fail(reply, 'الإيميل غير صحيح');
    await q(`insert into subscribers(site_id,name,email,phone) values($1,$2,$3,$4) on conflict(site_id,phone) do update set name=coalesce(excluded.name,subscribers.name), email=coalesce(excluded.email,subscribers.email)`,
      [s.id, String(b.name || '').trim() || null, email || null, phone]);
    let coupon = null; const wc = s.config && s.config.welcomeCp;
    if (wc) coupon = (await q(`select code from coupons where code=$1 and active`, [wc]))[0]?.code || null;
    return { ok: true, coupon };
  });

  app.post('/api/restock', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const phone = String(b.phone || '').trim(); if (phone.replace(/\D/g, '').length < 9) return fail(reply, 'أدخل رقماً صحيحاً');
    try { await q(`insert into restock_requests(site_id,product_id,phone) values($1,$2,$3)`, [s.id, b.product_id, phone]); return { ok: true }; }
    catch (e) { return dbErr(reply, e); }
  });

  // فحص الكوبون للعرض فقط (الحساب النهائي داخل create_order)
  app.post('/api/coupon', strict, async (req, reply) => {
    const b = req.body || {}; const s = await siteBy(b.site); if (!s) return fail(reply, 'الموقع غير موجود', 404);
    const c = (await q(`select c.* from coupons c where upper(code)=upper($1) and active and (expires_on is null or expires_on>=current_date) and (max_uses=0 or used_count<max_uses)
      and (not exists(select 1 from coupon_sites x where x.coupon_id=c.id) or exists(select 1 from coupon_sites x where x.coupon_id=c.id and x.site_id=$2))`, [String(b.code || ''), s.id]))[0];
    return c ? { ok: true, type: c.type, value: +c.value } : fail(reply, 'الكوبون غير صالح');
  });
  return app;
}

// Meta Conversions API — event_id = رقم الطلب لمنع التكرار مع البكسل بالمتصفح
const sha = v => v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined;
async function sendCapi(site, r, b, req) {
  const cfg = site.config || {}, pixel = cfg.pixel, token = cfg.capiToken || env['CAPI_TOKEN_' + site.slug.toUpperCase().replace(/-/g, '_')];
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
