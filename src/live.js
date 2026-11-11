// ربط واجهة اللوحة/المتجر (public/app.html) بقاعدة البيانات
// الحالة تُبنى بنفس شكل النموذج (S) حتى تعمل كل الواجهة كما هي، والحفظ يتم بفروقات (diff) لكل جدول.
import crypto from 'node:crypto';
import fs from 'node:fs';

const env = process.env;
const ms = t => (t ? new Date(t).getTime() : 0);
const num = v => (v === null || v === undefined || v === '' ? 0 : +v);
const nul = v => (v === '' || v === undefined ? null : v);
const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const optsToProto = o => (o || []).map(g => ({ name: g.name, vals: (g.values || []).map(v => v.label + (num(v.add) ? '=' + num(v.add) : '')).join('، ') }));
const optsToDb = o => (o || []).filter(g => (g.name || '').trim() && (g.vals || '').trim()).map(g => ({
  name: g.name.trim(), values: String(g.vals).split(/[،,]/).map(t => t.trim()).filter(Boolean).map(t => { const [l, a] = t.split('='); return { label: l.trim(), add: +a || 0 }; }) }));
const SITE_COLS = ['id', 'name', 'slug', 'domain', 'wa', 'countries', 'currencies'];

// ---------- قراءة ----------
export async function loadState(c, { mode, siteId, staff }) {
  const q = async (s, p) => (await c.query(s, p)).rows;
  const scope = mode === 'store' ? [siteId] : (staff && staff.role !== 'admin' && staff.site_ids ? staff.site_ids : null);
  const S = { ev: [], ui: {} };
  const sites = await q(`select s.*, coalesce((select array_agg(country_id) from site_countries where site_id=s.id),'{}') countries,
     coalesce((select array_agg(currency) from site_currencies where site_id=s.id),'{}') currencies from sites s ${mode === 'store' ? 'where s.id=$1' : 'order by s.created_at'}`, mode === 'store' ? [siteId] : []);
  S.sites = sites.map(s => ({ ...(s.config || {}), id: s.id, name: s.name, slug: s.slug, domain: s.domain || '', wa: s.whatsapp || '', countries: s.countries, currencies: s.currencies }));
  if (mode === 'store') S.sites.forEach(x => { delete x.capi; delete x.capiToken; });
  const prods = await q(`select p.*, coalesce((select jsonb_object_agg(site_id, jsonb_build_object('on',active,'price',coalesce(price_override,0))) from site_products where product_id=p.id),'{}') vis,
     (select min(sort) from site_products where product_id=p.id) srt from products p ${mode === 'store' ? 'where p.active and exists(select 1 from site_products sp where sp.product_id=p.id and sp.site_id=$1 and sp.active)' : ''} order by srt nulls last, p.created_at desc`, mode === 'store' ? [siteId] : []);
  let today = {};
  if (mode === 'store') {
    (await q(`select i.product_id pid, count(distinct o.id)::int n from orders o join order_items i on i.order_id=o.id join order_statuses s on s.id=o.status_id
      where o.site_id=$1 and s.kind<>'cancel' and o.created_at>=date_trunc('day',now()) group by 1`, [siteId])).forEach(r => today[r.pid] = r.n);
    const d = (await q(`select count(*)::int n from orders o join order_statuses s on s.id=o.status_id where o.site_id=$1 and s.kind='done'`, [siteId]))[0];
    S.sites[0]._done = d.n;
  }
  S.products = prods.map(p => ({ id: p.id, name: p.name, name_en: p.name_en || '', slug: p.slug || '', cat: p.category || '', desc: p.description || '', desc_en: p.description_en || '',
    ingredients: p.ingredients || '', usage: p.usage || '', price: num(p.price_jod), old: num(p.old_price_jod), stock: p.stock, min: p.min_stock, stockAt: ms(p.stock_updated_at),
    emoji: p.emoji || '🛍️', bg: p.bg || '#e5e7eb', best: p.best, badge: p.badge || '', offerEnd: p.offer_end ? new Date(p.offer_end).toISOString().slice(0, 10) : '',
    options: optsToProto(p.options), imgs: p.images || [], videos: p.videos || [], benefits: p.benefits || [], story: p.story || [], faq: p.faq || [],
    lp: Object.keys(p.landing || {}).length ? p.landing : null, vis: p.vis || {}, tiers: p.tiers || [], upsell: Object.keys(p.upsell || {}).length ? p.upsell : { pid: '', pct: 10 },
    guarantee: p.guarantee || '', seoT: p.seo_title || '', seoD: p.seo_desc || '', active: p.active, ...(mode === 'store' ? { _today: today[p.id] || 0 } : {}) }));
  S.statuses = (await q(`select * from order_statuses order by sort,name`)).map(s => ({ id: s.id, name: s.name, color: s.color, kind: s.kind }));
  S.currencies = (await q(`select * from currencies order by code='JOD' desc, code`)).map(c => ({ code: c.code, symbol: c.symbol, rate: num(c.rate), manual: c.manual }));
  S.payMethods = (await q(`select * from payment_methods ${mode === 'store' ? 'where active' : ''} order by sort,id`)).map(m => ({ id: m.id, name: m.name, instr: m.instructions || '' }));
  const cpm = await q(`select * from country_payment_methods`);
  const govs = await q(`select * from governorates order by sort,name`);
  S.countries = (await q(`select * from countries ${mode === 'store' ? 'where active' : ''} order by sort,name`)).map(c => ({ id: c.id, name: c.name, flag: c.flag || '', cur: c.currency || 'JOD', on: c.active,
    pay: Object.fromEntries(cpm.filter(x => x.country_id === c.id).map(x => [x.method_id, true])),
    govs: govs.filter(g => g.country_id === c.id).map(g => ({ id: g.id, name: g.name, fee: num(g.fee_jod), eta: g.eta || '', courier: g.default_courier || '' })) }));
  const inScope = (col) => scope ? `${col} = any($1::uuid[])` : 'true';
  const sp = scope ? [scope] : [];
  S.reviews = (await q(`select * from reviews where ${inScope('site_id')} ${mode === 'store' ? 'and approved' : ''} order by created_at`, sp)).map(r => ({ id: r.id, site: r.site_id, pid: r.product_id || '', name: r.name,
    stars: r.stars, text: r.body, imgs: r.images || [], video: r.video || '', ok: r.approved, verified: r.verified }));
  S.coupons = []; S.orders = []; S.couriers = []; S.subs = []; S.staff = []; S.log = []; S.notifs = []; S.stockLog = []; S.settlements = [];
  S.leads = []; S.blacklist = []; S.tasks = []; S.waTpl = {}; S.spend = {}; S.restock = [];
  S.winback = { code: '', text: 'رجعنا لك 🎁 استخدمي كود {code} واحصلي على خصم على طلبك القادم!' };
  if (mode === 'store') return S;

  const csites = await q(`select * from coupon_sites`);
  S.coupons = (await q(`select * from coupons order by code`)).map(c => ({ id: c.id, code: c.code, type: c.type, val: num(c.value), exp: c.expires_on ? new Date(c.expires_on).toISOString().slice(0, 10) : '',
    max: c.max_uses, used: c.used_count, sites: csites.filter(x => x.coupon_id === c.id).map(x => x.site_id), on: c.active, ref: c.ref_phone || undefined }));
  const sec = await q(`select * from courier_secrets`);
  S.couriers = (await q(`select * from couriers order by name`)).map(c => ({ id: c.id, type: c.type, name: c.name, phone: c.phone || '', vehicle: c.vehicle || '', cost: num(c.cost_jod),
    countries: c.countries || [], areas: (c.areas || []).join('، '), track: c.tracking_url || '', apiKey: (sec.find(s => s.courier_id === c.id) || {}).api_key || '', on: c.active, note: c.notes || '' }));
  S.orders = (await q(`select o.*,
     coalesce((select jsonb_agg(jsonb_build_object('pid',i.product_id,'name',i.name,'opts',coalesce(i.options_text,''),'qty',i.qty,'unit',i.unit_price_jod) order by i.id) from order_items i where i.order_id=o.id),'[]') items,
     coalesce((select jsonb_agg(jsonb_build_object('at',h.created_at,'st',h.status_id,'who',coalesce(h.by_name,'')) order by h.created_at) from order_status_history h where h.order_id=o.id),'[]') hist,
     (select to_jsonb(d) from order_deliveries d where d.order_id=o.id) dl
     from orders o where ${inScope('o.site_id')} order by o.created_at desc limit 3000`, sp)).map(o => ({
    id: o.id, no: +o.order_no, site: o.site_id, name: o.customer_name, phone: o.phone, country: o.country_id, govId: o.governorate_id || '', gov: o.governorate_name || '', area: o.area || '', address: o.address || '',
    pay: o.payment_method, cur: o.currency, items: o.items.map(i => ({ ...i, unit: num(i.unit) })), sub: num(o.subtotal_jod), ship: num(o.shipping_jod), disc: num(o.discount_jod), tdisc: num(o.tier_discount_jod),
    total: num(o.total_jod), coupon: o.coupon_code || '', status: o.status_id, at: ms(o.created_at), note: o.note || '', cnote: o.customer_note || '', utm: o.utm || null, flags: o.flags || [],
    assignee: o.assignee || '', refCode: o.ref_code || '', history: o.hist.map(h => ({ at: ms(h.at), st: h.st, who: h.who })),
    dl: o.dl ? { cid: o.dl.courier_id, no: o.dl.tracking_no || '', cost: num(o.dl.cost_jod), st: o.dl.status, at: ms(o.dl.assigned_at), settled: o.dl.settled, reason: o.dl.failed_reason || '' } : null }));
  S.subs = (await q(`select * from subscribers where ${inScope('site_id')} order by created_at desc`, sp)).map(s => ({ id: s.id, site: s.site_id, name: s.name || '', email: s.email || '', phone: s.phone, at: ms(s.created_at) }));
  S.staff = (await q(`select s.*, u.email from staff s left join auth.users u on u.id=s.user_id order by s.role, s.name`)).map(s => ({ id: s.user_id, name: s.name, email: s.email || '', role: s.role,
    sites: s.site_ids ? s.site_ids : 'all', perms: s.perms || {} }));
  S.log = (await q(`select * from activity_log order by id desc limit 200`)).map(l => ({ at: ms(l.created_at), who: l.user_name || '', text: l.action }));
  S.notifs = (await q(`select * from notifications order by id desc limit 100`)).map(n => ({ id: String(n.id), at: ms(n.created_at), text: n.body, read: n.read }));
  S.stockLog = (await q(`select * from stock_log order by id desc limit 300`)).map(l => ({ id: String(l.id), at: ms(l.created_at), who: l.by_name, pid: l.product_id, pname: l.product_name, before: l.before_qty, after: l.after_qty, why: l.reason }));
  S.settlements = (await q(`select * from settlements order by created_at desc limit 200`)).map(s => ({ id: s.id, at: ms(s.created_at), by: s.by_name || '', cid: s.courier_id, cname: s.courier_name || '', n: (s.order_nos || []).length,
    nos: (s.order_nos || []).map(Number), cash: num(s.cash_jod), fee: num(s.fee_jod), net: num(s.net_jod), daySales: num(s.day_sales_jod), dayOrders: s.day_orders }));
  S.leads = (await q(`select l.*, p.name pname from leads l left join products p on p.id=l.product_id where ${inScope('l.site_id')} order by l.updated_at desc limit 500`, sp)).map(l => ({ id: l.id, site: l.site_id, pid: l.product_id || '',
    pname: l.pname || '', name: l.name || '', phone: l.phone, at: ms(l.created_at), upd: ms(l.updated_at), utm: l.utm || null, conv: l.converted, done: l.followed_up }));
  S.blacklist = (await q(`select * from blacklist order by created_at`)).map(b => ({ id: b.id, phone: b.phone, note: b.note || '', at: ms(b.created_at) }));
  S.tasks = (await q(`select t.*, o.order_no from tasks t left join orders o on o.id=t.order_id order by t.created_at desc`)).map(t => ({ id: t.id, oid: t.order_id, no: t.order_no ? +t.order_no : '', text: t.body,
    due: t.due_on ? new Date(t.due_on).toISOString().slice(0, 10) : '', assignee: t.assignee || '', by: t.by_name || '', done: t.done, at: ms(t.created_at) }));
  (await q(`select * from wa_templates`)).forEach(w => S.waTpl[w.status_id] = w.body);
  (await q(`select * from ad_spend`)).forEach(a => S.spend[a.key] = num(a.spend_jod));
  S.restock = (await q(`select * from restock_requests where ${inScope('site_id')} order by created_at desc`, sp)).map(r => ({ id: r.id, site: r.site_id, pid: r.product_id, phone: r.phone, at: ms(r.created_at), done: r.done }));
  const wb = (await q(`select value from integrations where key='winback'`))[0]; if (wb) S.winback = wb.value;
  return S;
}

// ---------- كتابة (فروقات) ----------
const PERM = { sites: 'design', products: 'products', orders: 'orders', couriers: 'delivery', coupons: 'coupons', reviews: 'reviews', subs: 'reviews', statuses: 'settings', countries: 'settings',
  payMethods: 'settings', currencies: 'settings', staff: 'settings', leads: 'orders', blacklist: 'orders', tasks: 'orders', restock: 'products', waTpl: 'settings', spend: 'reports', winback: 'orders', log: null };
export const can = (st, k) => !k || st.role === 'admin' || !!(st.perms || {})[k];

export async function applySync(c, st, body, ctx) {
  const q = (s, p) => c.query(s, p);
  const ups = body.upserts || {}, dels = body.deletes || {}, out = { reload: false };
  for (const k of new Set([...Object.keys(ups), ...Object.keys(dels)])) if (!can(st, PERM[k] === undefined ? 'settings' : PERM[k])) throw new Error('غير مصرّح: ' + k);
  const U = k => ups[k] || [], D = k => (dels[k] || []);

  // العملات أولاً (الدول تعتمد عليها)
  for (const x of U('currencies')) await q(`insert into currencies(code,symbol,rate,manual) values($1,$2,$3,$4) on conflict(code) do update set symbol=$2,rate=$3,manual=$4,updated_at=now()`, [x.code, x.symbol, num(x.rate) || 1, !!x.manual]);
  for (const x of U('payMethods')) await q(`insert into payment_methods(id,name,instructions,sort) values($1,$2,$3,$4) on conflict(id) do update set name=$2,instructions=$3,sort=$4`, [x.id, x.name, x.instr || '', x._i || 0]);
  for (const x of U('couriers')) {
    await q(`insert into couriers(id,type,name,phone,vehicle,cost_jod,countries,areas,tracking_url,notes,active) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict(id) do update set type=$2,name=$3,phone=$4,vehicle=$5,cost_jod=$6,countries=$7,areas=$8,tracking_url=$9,notes=$10,active=$11`,
      [x.id, x.type, x.name, x.phone, x.vehicle, num(x.cost), x.countries || [], String(x.areas || '').split(/[،,]/).map(s => s.trim()).filter(Boolean), nul(x.track), x.note || '', x.on !== false]);
    await q(`insert into courier_secrets(courier_id,api_key) values($1,$2) on conflict(courier_id) do update set api_key=$2`, [x.id, nul(x.apiKey)]);
  }
  for (const x of U('countries')) {
    await q(`insert into countries(id,name,flag,currency,active,sort) values($1,$2,$3,$4,$5,$6) on conflict(id) do update set name=$2,flag=$3,currency=$4,active=$5,sort=$6`, [x.id, x.name, x.flag, x.cur, x.on !== false, x._i || 0]);
    await q(`delete from country_payment_methods where country_id=$1`, [x.id]);
    for (const [m, on] of Object.entries(x.pay || {})) if (on) await q(`insert into country_payment_methods values($1,$2) on conflict do nothing`, [x.id, m]);
    const ids = (x.govs || []).map(g => g.id).filter(isUuid);
    await q(`delete from governorates where country_id=$1 and not (id = any($2::uuid[]))`, [x.id, ids]);
    for (const [i, g] of (x.govs || []).entries()) await q(`insert into governorates(id,country_id,name,fee_jod,eta,default_courier,sort) values($1,$2,$3,$4,$5,$6,$7)
      on conflict(id) do update set name=$3,fee_jod=$4,eta=$5,default_courier=$6,sort=$7`, [isUuid(g.id) ? g.id : crypto.randomUUID(), x.id, g.name, num(g.fee), g.eta || '', isUuid(g.courier) ? g.courier : null, i]);
  }
  for (const x of U('statuses')) await q(`insert into order_statuses(id,name,color,kind,sort) values($1,$2,$3,$4,$5) on conflict(id) do update set name=$2,color=$3,kind=$4,sort=$5`, [x.id, x.name, x.color, x.kind, x._i || 0]);
  for (const x of U('sites')) {
    const cfg = { ...x }; SITE_COLS.forEach(k => delete cfg[k]); delete cfg._i; delete cfg._done;
    if (cfg.versions && cfg.versions.length > 10) cfg.versions = cfg.versions.slice(-10);
    await q(`insert into sites(id,slug,name,domain,whatsapp,config) values($1,$2,$3,$4,$5,$6) on conflict(id) do update set slug=$2,name=$3,domain=$4,whatsapp=$5,config=$6`,
      [x.id, String(x.slug || x.id).toLowerCase(), x.name, nul(String(x.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')), nul(x.wa), cfg]);
    await q(`delete from site_countries where site_id=$1`, [x.id]); for (const k of x.countries || []) await q(`insert into site_countries values($1,$2) on conflict do nothing`, [x.id, k]);
    await q(`delete from site_currencies where site_id=$1`, [x.id]); for (const k of x.currencies || []) await q(`insert into site_currencies values($1,$2) on conflict do nothing`, [x.id, k]);
  }
  for (const x of U('products')) {
    const lp = x.lp || {};
    await q(`insert into products(id,slug,name,name_en,category,description,description_en,ingredients,usage,price_jod,old_price_jod,stock,min_stock,emoji,bg,best,badge,offer_end,options,images,videos,benefits,story,faq,landing,tiers,upsell,guarantee,seo_title,seo_desc,stock_updated_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,now())
      on conflict(id) do update set slug=$2,name=$3,name_en=$4,category=$5,description=$6,description_en=$7,ingredients=$8,usage=$9,price_jod=$10,old_price_jod=$11,min_stock=$13,emoji=$14,bg=$15,best=$16,badge=$17,offer_end=$18,
      options=$19,images=$20,videos=$21,benefits=$22,story=$23,faq=$24,landing=$25,tiers=$26,upsell=$27,guarantee=$28,seo_title=$29,seo_desc=$30`,
      [x.id, nul(String(x.slug || '').trim()), x.name, x.name_en || null, x.cat || null, x.desc || '', x.desc_en || '', x.ingredients || '', x.usage || '', num(x.price), num(x.old) || null, Math.max(0, Math.floor(num(x.stock))), Math.floor(num(x.min)),
       x.emoji || null, x.bg || null, !!x.best, x.badge || null, nul(x.offerEnd), JSON.stringify(optsToDb(x.options)), JSON.stringify(x.imgs || []), JSON.stringify((x.videos || []).filter(v => v.url)),
       JSON.stringify(x.benefits || []), JSON.stringify(x.story || []), JSON.stringify(x.faq || []), JSON.stringify(lp), JSON.stringify(x.tiers || []), JSON.stringify(x.upsell || {}), x.guarantee || '', x.seoT || '', x.seoD || '']);
    const vis = x.vis || {};
    await q(`delete from site_products where product_id=$1 and not (site_id = any($2::uuid[]))`, [x.id, Object.keys(vis).filter(isUuid)]);
    for (const [sid, v] of Object.entries(vis)) if (isUuid(sid)) await q(`insert into site_products(site_id,product_id,active,price_override,sort) values($1,$2,$3,$4,$5)
      on conflict(site_id,product_id) do update set active=$3,price_override=$4,sort=$5`, [sid, x.id, !!v.on, num(v.price) || null, x._i || 0]);
  }
  for (const x of U('coupons')) {
    await q(`insert into coupons(id,code,type,value,expires_on,max_uses,active,ref_phone) values($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict(id) do update set code=$2,type=$3,value=$4,expires_on=$5,max_uses=$6,active=$7`, [x.id, String(x.code).toUpperCase(), x.type, num(x.val) || 1, nul(x.exp), Math.floor(num(x.max)), x.on !== false, x.ref || null]);
    await q(`delete from coupon_sites where coupon_id=$1`, [x.id]); for (const s of x.sites || []) await q(`insert into coupon_sites values($1,$2) on conflict do nothing`, [x.id, s]);
  }
  for (const x of U('reviews')) await q(`insert into reviews(id,site_id,product_id,name,stars,body,images,video,verified,approved) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict(id) do update set site_id=$2,product_id=$3,name=$4,stars=$5,body=$6,images=$7,video=$8,verified=$9,approved=$10`,
    [x.id, x.site, isUuid(x.pid) ? x.pid : null, x.name, Math.min(5, Math.max(1, +x.stars || 5)), x.text || '', JSON.stringify((x.imgs || []).filter(Boolean)), nul(x.video), !!x.verified, !!x.ok]);
  for (const x of U('orders')) {
    await q(`update orders set note=$2, assignee=$3 where id=$1`, [x.id, x.note || '', isUuid(x.assignee) ? x.assignee : null]);
    if (x.dl && isUuid(x.dl.cid)) await q(`insert into order_deliveries(order_id,courier_id,tracking_no,cost_jod,status,failed_reason,settled) values($1,$2,$3,$4,$5,$6,$7)
      on conflict(order_id) do update set courier_id=$2,tracking_no=$3,cost_jod=$4,status=$5,failed_reason=$6`, [x.id, x.dl.cid, nul(x.dl.no), num(x.dl.cost), x.dl.st || 'assigned', nul(x.dl.reason), !!x.dl.settled]);
    else if (!x.dl) await q(`delete from order_deliveries where order_id=$1 and not settled`, [x.id]);
  }
  for (const x of U('leads')) await q(`update leads set followed_up=$2 where id=$1`, [x.id, !!x.done]);
  for (const x of U('blacklist')) await q(`insert into blacklist(id,phone,note) values($1,$2,$3) on conflict(id) do update set phone=$2,note=$3`, [x.id, x.phone, x.note || '']);
  for (const x of U('tasks')) await q(`insert into tasks(id,order_id,body,due_on,assignee,by_name,done) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set body=$3,due_on=$4,assignee=$5,done=$7`,
    [x.id, isUuid(x.oid) ? x.oid : null, x.text, nul(x.due), isUuid(x.assignee) ? x.assignee : null, x.by || st.name, !!x.done]);
  for (const x of U('restock')) await q(`update restock_requests set done=$2 where id=$1`, [x.id, !!x.done]);
  for (const x of U('subs')) await q(`update subscribers set name=$2,email=$3,phone=$4 where id=$1`, [x.id, nul(x.name), nul(x.email), x.phone]);
  if (ups.waTpl) for (const [sid, body] of Object.entries(ups.waTpl)) if (isUuid(sid)) await q(`insert into wa_templates values($1,$2) on conflict(status_id) do update set body=$2`, [sid, body || '']);
  if (ups.spend) for (const [k, v] of Object.entries(ups.spend)) await q(`insert into ad_spend(key,spend_jod) values($1,$2) on conflict(key) do update set spend_jod=$2,updated_at=now()`, [k, num(v)]);
  if (ups.winback) await q(`insert into integrations(key,value) values('winback',$1) on conflict(key) do update set value=$1`, [ups.winback]);
  for (const x of U('log')) await q(`insert into activity_log(user_id,user_name,action) values($1,$2,$3)`, [st.user_id, st.name, String(x.text || '').slice(0, 500)]);
  for (const x of U('staff')) {
    let id = x.id;
    const ex = (await q(`select user_id from staff where user_id=$1`, [isUuid(id) ? id : null])).rows[0];
    if (!ex) {
      if (!x.email) throw new Error('إيميل الموظف مطلوب');
      const u = (await q(`select id from auth.users where lower(email)=lower($1)`, [x.email])).rows[0];
      id = u ? u.id : await ctx.invite(x.email);
      out.reload = true;
    }
    await q(`insert into staff(user_id,name,role,site_ids,perms) values($1,$2,$3,$4,$5) on conflict(user_id) do update set name=$2,role=$3,site_ids=$4,perms=$5`,
      [id, x.name, x.role === 'admin' ? 'admin' : 'staff', x.sites === 'all' ? null : (x.sites || []).filter(isUuid), x.perms || {}]);
  }

  // الحذف (بترتيب يحترم العلاقات)
  const del = async (k, sql) => { for (const id of D(k)) await q(sql, [id]); };
  await del('tasks', `delete from tasks where id=$1`); await del('leads', `delete from leads where id=$1`); await del('blacklist', `delete from blacklist where id=$1`);
  await del('restock', `delete from restock_requests where id=$1`); await del('subs', `delete from subscribers where id=$1`); await del('reviews', `delete from reviews where id=$1`);
  await del('coupons', `delete from coupons where id=$1`);
  for (const id of D('products')) { const used = (await q(`select 1 from order_items where product_id=$1 limit 1`, [id])).rows.length;
    if (used) await q(`update products set active=false where id=$1`, [id]); else await q(`delete from products where id=$1`, [id]); }
  await del('couriers', `delete from couriers where id=$1`);
  for (const id of D('statuses')) { if ((await q(`select 1 from orders where status_id=$1 limit 1`, [id])).rows.length) throw new Error('فيه طلبات بهذه الحالة'); await q(`delete from order_statuses where id=$1`, [id]); }
  await del('countries', `delete from countries where id=$1`); await del('payMethods', `delete from payment_methods where id=$1`); await del('currencies', `delete from currencies where code=$1`);
  for (const id of D('sites')) { if ((await q(`select 1 from orders where site_id=$1 limit 1`, [id])).rows.length) await q(`update sites set active=false where id=$1`, [id]); else await q(`delete from sites where id=$1`, [id]); }
  for (const id of D('staff')) { if (id === st.user_id) throw new Error('ما بتقدر تحذف حسابك'); await q(`delete from staff where user_id=$1`, [id]); }
  return out;
}

// ---------- الصفحة ----------
let HTML = null;
export function page(appCfg, seo) {
  if (!HTML || env.NODE_ENV !== 'production') HTML = fs.readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let h = HTML.replace('<script>', `<script>window.APP=${JSON.stringify(appCfg).replace(/</g, '\\u003c')};</script><script>`);
  if (seo) {
    h = h.replace(/<title>[^<]*<\/title>/, `<title>${esc(seo.title)}</title><meta name="description" content="${esc(seo.desc)}"><meta property="og:title" content="${esc(seo.title)}"><meta property="og:description" content="${esc(seo.desc)}">${seo.img ? `<meta property="og:image" content="${esc(seo.img)}">` : ''}${seo.ld ? `<script type="application/ld+json">${JSON.stringify(seo.ld).replace(/</g, '\\u003c')}</script>` : ''}`);
  }
  return h;
}
