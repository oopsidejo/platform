import {PGlite} from '@electric-sql/pglite';
import fs from 'fs';
const db=new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth; create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
`);
try{ await db.exec(fs.readFileSync('/home/claude/handoff/schema.sql','utf8')); console.log('SCHEMA OK'); }catch(e){ console.log('SCHEMA ERR',e.message); process.exit(1); }
const q=async(s,p)=> (await db.query(s,p)).rows;
const site=(await q(`insert into sites(slug,name) values('mk','MK') returning id`))[0].id;
await db.exec(`insert into site_countries select '${site}',id from countries`);
const prod=(await q(`insert into products(name,price_jod,stock,options) values('عطر',10,5,'[{"name":"الحجم","values":[{"label":"30","add":0},{"label":"50","add":5}]}]') returning id`))[0].id;
await db.exec(`insert into site_products(site_id,product_id) values('${site}','${prod}')`);
await db.exec(`insert into coupons(code,type,value) values('SAVE10','pct',10)`);
const gov=(await q(`select id from governorates where name='عمّان'`))[0].id;
const mk=(o)=>JSON.stringify({site_id:site,name:'سارة',phone:'0791234567',country_id:'jo',governorate_id:gov,payment_method:'cod',currency:'JOD',items:[{product_id:prod,qty:2,options:[{name:'الحجم',label:'50'}]}],...o});
const call=async(p)=>{try{return (await q(`select create_order($1::jsonb) r`,[p]))[0].r}catch(e){return 'ERR: '+e.message}};
console.log('1 ok', JSON.stringify(await call(mk({coupon:'SAVE10'}))));   // (10+5)*2=30, ship 2, disc 3 => 29
console.log('stock left', (await q(`select stock from products`))[0].stock);  // 3
console.log('2 too many', await call(mk({items:[{product_id:prod,qty:9}]})));
console.log('3 bad coupon', await call(mk({coupon:'NOPE'})));
console.log('4 bad option', await call(mk({items:[{product_id:prod,qty:1,options:[{name:'الحجم',label:'999'}]}]})));
console.log('5 bad payment', await call(mk({payment_method:'cliq',country_id:'ps'})));
console.log('6 bad phone', await call(mk({phone:'12'})));
const o=(await q(`select * from orders`))[0]; console.log('order', o.order_no, o.subtotal_jod, o.shipping_jod, o.discount_jod, o.total_jod);
const canc=(await q(`select id from order_statuses where kind='cancel'`))[0].id;
await db.query(`select set_order_status($1,$2,'test')`,[o.id,canc]); console.log('stock after cancel', (await q(`select stock from products`))[0].stock); // 5
console.log('coupon used', (await q(`select used_count from coupons`))[0].used_count);

console.log('--- v1.1 ---');
console.log('note ok', JSON.stringify(await call(mk({note:'اتصل قبل التوصيل',items:[{product_id:prod,qty:1}]}))));
console.log('note saved', (await q(`select customer_note from orders where customer_note is not null`))[0].customer_note);
console.log('notif', (await q(`select body from notifications order by id desc limit 1`))[0].body.replace(/\n/g,' | '));
console.log('stock_log', JSON.stringify((await q(`select by_name,before_qty,after_qty,reason from stock_log order by id`))));
await db.exec(`insert into staff(user_id,name,role) values('00000000-0000-0000-0000-000000000001','t','admin')`);
await db.exec(`create or replace function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$`);
await db.query(`select adjust_stock($1,2,'وليد')`,[prod]); console.log('adjust', (await q(`select stock from products`))[0].stock, (await q(`select count(*) c from stock_log`))[0].c);
const cr=(await q(`insert into couriers(type,name,cost_jod) values('driver','أبو أحمد',1) returning id`))[0].id;
const oid=(await q(`select id from orders limit 1`))[0].id;
await db.exec(`insert into order_deliveries(order_id,courier_id,cost_jod,status) values('${oid}','${cr}',1,'delivered') on conflict(order_id) do update set courier_id='${cr}',status='delivered',cost_jod=1`);
console.log('settle', JSON.stringify((await q(`select settle_courier($1,'وليد') r`,[cr]))[0].r));
try{await db.query(`select settle_courier($1,'x')`,[cr])}catch(e){console.log('2nd settle:',e.message)}

console.log('--- v1.2 ---');
const p2=(await q(`insert into products(name,price_jod,stock) values('كريم',10,10) returning id`))[0].id;
await db.exec(`insert into site_products(site_id,product_id) values('${site}','${p2}')`);
await db.exec(`update products set stock=20, tiers='[{"qty":2,"type":"pct","val":10},{"qty":3,"type":"half"}]', upsell='{"pid":"${p2}","pct":20}' where id='${prod}'`);
await db.exec(`update sites set config='{"freeShip":{"on":true,"min":30},"referral":{"on":true,"pct":10}}' where id='${site}'`);
await db.query(`select save_lead($1,$2,'منى','0781112223')`,[site,prod]);
await db.query(`select save_lead($1,$2,'منى ع','0781112223')`,[site,prod]);
console.log('leads', JSON.stringify(await q(`select name,converted from leads`)));
const r1=await call(mk({phone:'0781112223',items:[{product_id:prod,qty:2},{product_id:p2,qty:1,upsell:true}]}));
console.log('tier+upsell+freeship', JSON.stringify(r1));  // 20-2=18 +8 =26 <30 -> ship 2 -> 28
const r2=await call(mk({phone:'0781112223',items:[{product_id:prod,qty:3}]}));
console.log('half tier + dup flag + ship free', JSON.stringify(r2)); // 30 - 5 = 25 -> ship 2
const r3=await call(mk({phone:'0781112224',items:[{product_id:prod,qty:4}]}));
console.log('free ship', JSON.stringify(r3)); // 40-10(half floor(4/2)*.5*10=10)=30 -> free
console.log('lead converted', JSON.stringify(await q(`select converted from leads`)));
console.log('bad upsell', await call(mk({items:[{product_id:p2,qty:1,upsell:true}]})));
await db.exec(`insert into blacklist(phone) values('0799999999')`);
console.log('blacklist', await call(mk({phone:'0799999999'})));
console.log('track', JSON.stringify((await q(`select track_order($1,10003,'0781112223') r`,[site]))[0].r).slice(0,120));
console.log('ref coupons', JSON.stringify(await q(`select code,ref_phone from coupons where ref_phone is not null`)));
process.exit(0);
