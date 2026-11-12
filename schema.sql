-- =====================================================================
-- schema.sql — منصة المواقع (Supabase / PostgreSQL)  |  النسخة 1.0
-- شغّله مرة وحدة في Supabase > SQL Editor. كل الأسعار الأساسية بالدينار (JOD).
-- الإنشاء الآمن للطلب يتم عبر الدالة create_order() فقط (من الباك إند بمفتاح service_role).
-- =====================================================================

-- ---------- مرجعيات عامة ----------
create table currencies(code text primary key, symbol text not null, rate numeric not null default 1 check(rate>0),
  manual boolean not null default false, updated_at timestamptz not null default now());
create table payment_methods(id text primary key, name text not null, instructions text not null default '', active boolean not null default true, sort int not null default 0, cfg jsonb not null default '{}');
create table countries(id text primary key, name text not null, flag text, currency text references currencies(code), active boolean not null default true, sort int not null default 0);
create table couriers(id uuid primary key default gen_random_uuid(), type text not null check(type in('driver','company')), name text not null, phone text,
  vehicle text, cost_jod numeric not null default 0, countries text[] not null default '{}', areas text[] not null default '{}', tracking_url text, notes text, active boolean not null default true);
create table courier_secrets(courier_id uuid primary key references couriers(id) on delete cascade, api_key text);   -- للخادم فقط
create table governorates(id uuid primary key default gen_random_uuid(), country_id text not null references countries(id) on delete cascade, name text not null,
  fee_jod numeric not null default 0 check(fee_jod>=0), eta text, default_courier uuid references couriers(id) on delete set null, sort int not null default 0);
create table country_payment_methods(country_id text references countries(id) on delete cascade, method_id text references payment_methods(id) on delete cascade, primary key(country_id,method_id));
create table order_statuses(id uuid primary key default gen_random_uuid(), name text not null, color text not null default '#64748b',
  kind text not null default 'normal' check(kind in('normal','done','cancel')), sort int not null default 0);   -- cancel: يرجّع المخزون ويُستثنى من المبيعات

-- ---------- المواقع ----------
-- config = كل إعدادات التصميم والنصوص والأقسام (انظر ملف النموذج): ألوان، خطوط، sections، t.ar/t.en، features، faq، pages، stock، ann، seo، pixel، ga
create table sites(id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, domain text unique, whatsapp text,
  config jsonb not null default '{}', active boolean not null default true, created_at timestamptz not null default now());
create table site_countries(site_id uuid references sites(id) on delete cascade, country_id text references countries(id) on delete cascade, primary key(site_id,country_id));
create table site_currencies(site_id uuid references sites(id) on delete cascade, currency text references currencies(code) on delete cascade, primary key(site_id,currency));
create table design_versions(id uuid primary key default gen_random_uuid(), site_id uuid not null references sites(id) on delete cascade, snapshot jsonb not null, created_by uuid, created_at timestamptz not null default now());

-- ---------- الكتالوج الرئيسي ----------
-- options: [{"name":"الحجم","values":[{"label":"30مل","add":0},{"label":"50مل","add":5}]}]
-- images: روابط Supabase Storage (غير محدودة) | videos: [{"url":"..."}] | story: [{"h","t","img"}] | faq: [{"q","a"}] | landing: إعدادات صفحة الهبوط
create table products(id uuid primary key default gen_random_uuid(), slug text unique, name text not null, name_en text, category text, description text, description_en text,
  ingredients text, usage text, price_jod numeric not null check(price_jod>=0), old_price_jod numeric, stock int not null default 0 check(stock>=0), min_stock int not null default 5, stock_updated_at timestamptz, emoji text, bg text,
  best boolean not null default false, badge text, offer_end date, options jsonb not null default '[]', images jsonb not null default '[]', videos jsonb not null default '[]',
  tiers jsonb not null default '[]', upsell jsonb not null default '{}', guarantee text, seo_title text, seo_desc text,
  benefits jsonb not null default '[]', story jsonb not null default '[]', faq jsonb not null default '[]', landing jsonb not null default '{}',
  active boolean not null default true, created_at timestamptz not null default now());
create table site_products(site_id uuid references sites(id) on delete cascade, product_id uuid references products(id) on delete cascade,
  active boolean not null default true, price_override numeric check(price_override>=0), sort int not null default 0, primary key(site_id,product_id));

-- ---------- كوبونات / تقييمات / مشتركون ----------
create table coupons(id uuid primary key default gen_random_uuid(), code text unique not null, type text not null check(type in('pct','fix')), value numeric not null check(value>0),
  expires_on date, max_uses int not null default 0, used_count int not null default 0, ref_phone text, active boolean not null default true);
create table coupon_sites(coupon_id uuid references coupons(id) on delete cascade, site_id uuid references sites(id) on delete cascade, primary key(coupon_id,site_id));  -- فاضي = كل المواقع
create table reviews(id uuid primary key default gen_random_uuid(), site_id uuid not null references sites(id) on delete cascade, product_id uuid references products(id) on delete cascade,
  name text not null, stars int not null check(stars between 1 and 5), body text not null, images jsonb not null default '[]', video text, verified boolean not null default false,
  approved boolean not null default false, created_at timestamptz not null default now());
create table subscribers(id uuid primary key default gen_random_uuid(), site_id uuid not null references sites(id) on delete cascade, name text, email text, phone text not null, created_at timestamptz not null default now(), unique(site_id,phone));

-- ---------- الطلبات والتوصيل ----------
create table orders(id uuid primary key default gen_random_uuid(), order_no bigint generated always as identity (start with 10001), site_id uuid not null references sites(id),
  customer_name text not null, phone text not null, country_id text not null references countries(id), governorate_id uuid references governorates(id), governorate_name text,
  area text, address text, payment_method text not null references payment_methods(id), currency text not null, fx_rate numeric not null default 1, receipts jsonb not null default '[]', pay_discount_jod numeric not null default 0,
  subtotal_jod numeric not null, shipping_jod numeric not null, discount_jod numeric not null default 0, total_jod numeric not null, coupon_code text, customer_note text, tier_discount_jod numeric not null default 0, flags text[] not null default '{}', assignee uuid, ref_code text,
  status_id uuid references order_statuses(id), note text, utm jsonb, created_at timestamptz not null default now());
create index on orders(site_id,created_at desc); create index on orders(status_id); create index if not exists orders_phone9_idx on orders(right(phone,9));
create table order_items(id uuid primary key default gen_random_uuid(), order_id uuid not null references orders(id) on delete cascade, product_id uuid references products(id) on delete set null,
  name text not null, options_text text, qty int not null check(qty>0), unit_price_jod numeric not null);
create table order_status_history(id uuid primary key default gen_random_uuid(), order_id uuid not null references orders(id) on delete cascade, status_id uuid references order_statuses(id), by_name text, created_at timestamptz not null default now());
create index if not exists order_items_order_idx on order_items(order_id); create index if not exists order_status_history_order_idx on order_status_history(order_id);
create table order_deliveries(order_id uuid primary key references orders(id) on delete cascade, courier_id uuid references couriers(id), tracking_no text, cost_jod numeric not null default 0,
  status text not null default 'assigned' check(status in('assigned','picked','delivered','failed')), failed_reason text, settled boolean not null default false, settled_at timestamptz, assigned_at timestamptz not null default now());

-- ---------- رفع المبيعات والمتابعة (v1.2) ----------
-- tiers: [{"qty":2,"type":"pct","val":10},{"qty":2,"type":"half"}] | upsell: {"pid":"<uuid>","pct":15}
-- إعدادات الموقع داخل sites.config: freeShip{on,min}, proof{on,min}, referral{on,pct}, welcomeCp, returnPolicy, leads, thanks{...}, tiktok
create table leads(id uuid primary key default gen_random_uuid(), site_id uuid not null references sites(id) on delete cascade, product_id uuid references products(id) on delete set null,
  name text, phone text not null, utm jsonb, converted boolean not null default false, followed_up boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index leads_open_phone on leads(site_id, right(regexp_replace(phone,'\D','','g'),9)) where not converted;
create table blacklist(id uuid primary key default gen_random_uuid(), phone text not null, note text, created_at timestamptz not null default now());
create table tasks(id uuid primary key default gen_random_uuid(), order_id uuid references orders(id) on delete cascade, body text not null, due_on date, assignee uuid, by_name text, done boolean not null default false, created_at timestamptz not null default now());
create table wa_templates(status_id uuid primary key references order_statuses(id) on delete cascade, body text not null);
create table ad_spend(key text primary key, site_id uuid references sites(id) on delete cascade, spend_jod numeric not null default 0, updated_at timestamptz not null default now());
create table restock_requests(id uuid primary key default gen_random_uuid(), site_id uuid not null references sites(id) on delete cascade, product_id uuid not null references products(id) on delete cascade, phone text not null, done boolean not null default false, created_at timestamptz not null default now());

-- ---------- تحليل الزيارات (v1.8) ----------
create table site_events(id bigint generated always as identity primary key, site_id uuid not null references sites(id) on delete cascade,
  at timestamptz not null default now(), sid text not null, t text not null, path text, pid uuid, src text, camp text, dev text);
create index site_events_site_at on site_events(site_id, at desc);

-- ---------- OTP (v1.7) ----------
create table otp_codes(id bigint generated always as identity primary key, site_id uuid not null references sites(id) on delete cascade, phone9 text not null,
  code_hash text not null, expires_at timestamptz not null, attempts int not null default 0, token text, verified_at timestamptz, failed boolean not null default false, created_at timestamptz not null default now());
create index otp_codes_phone_idx on otp_codes(site_id, phone9, created_at desc);

-- ---------- المخزون والإشعارات والتسويات ----------
create table stock_log(id bigint generated always as identity primary key, product_id uuid references products(id) on delete set null, product_name text, by_name text not null,
  before_qty int not null, after_qty int not null, reason text not null default 'تعديل يدوي', created_at timestamptz not null default now());
create table notifications(id bigint generated always as identity primary key, body text not null, read boolean not null default false, created_at timestamptz not null default now());
create table settlements(id uuid primary key default gen_random_uuid(), courier_id uuid references couriers(id) on delete set null, courier_name text, order_nos bigint[] not null default '{}',
  cash_jod numeric not null, fee_jod numeric not null, net_jod numeric not null, day_sales_jod numeric not null default 0, day_orders int not null default 0, by_name text, created_at timestamptz not null default now());

-- ---------- الموظفون والسجل والتكاملات ----------
create table staff(user_id uuid primary key, name text not null, role text not null default 'staff' check(role in('admin','staff')),
  site_ids uuid[], perms jsonb not null default '{}');   -- site_ids = null → كل المواقع | perms مثل {"orders":true,"products":true}
create table activity_log(id bigint generated always as identity primary key, user_id uuid, user_name text, action text not null, entity text, entity_id text, details jsonb, created_at timestamptz not null default now());
create table integrations(key text primary key, value jsonb not null default '{}');   -- مفاتيح API (Meta CAPI، شركات التوصيل...) للخادم فقط

-- ---------- دوال الصلاحيات ----------
create or replace function public.staff_can(perm text, sid uuid default null) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from staff s where s.user_id=auth.uid() and (s.role='admin' or (coalesce((s.perms->>perm)::boolean,false) and (sid is null or s.site_ids is null or sid=any(s.site_ids)))))$$;

-- ---------- RLS ----------
do $$ declare t text; begin
 for t in select unnest(array['currencies','payment_methods','countries','couriers','courier_secrets','governorates','country_payment_methods','order_statuses','sites','site_countries','site_currencies','design_versions',
  'products','site_products','coupons','coupon_sites','reviews','subscribers','orders','order_items','order_status_history','order_deliveries','stock_log','notifications','settlements','otp_codes','site_events','leads','blacklist','tasks','wa_templates','ad_spend','restock_requests','staff','activity_log','integrations']) loop
  execute format('alter table %I enable row level security',t); end loop; end $$;
-- قراءة عامة (الزوار)
create policy pub_cur on currencies for select to anon,authenticated using(true);
create policy pub_pay on payment_methods for select to anon,authenticated using(active);
create policy pub_cty on countries for select to anon,authenticated using(active);
create policy pub_gov on governorates for select to anon,authenticated using(true);
create policy pub_cpm on country_payment_methods for select to anon,authenticated using(true);
create policy pub_site on sites for select to anon,authenticated using(active);
create policy pub_sc on site_countries for select to anon,authenticated using(true);
create policy pub_scu on site_currencies for select to anon,authenticated using(true);
create policy pub_prod on products for select to anon,authenticated using(active);
create policy pub_sp on site_products for select to anon,authenticated using(active);
create policy pub_rev on reviews for select to anon,authenticated using(approved);
-- الزوار يضيفون تقييم (بانتظار الموافقة) ويشتركون فقط
create policy anon_rev on reviews for insert to anon,authenticated with check(approved=false and verified=false);
create policy anon_sub on subscribers for insert to anon,authenticated with check(true);
-- الإدارة (حسب الصلاحية)
create policy adm_products on products for all to authenticated using(staff_can('products')) with check(staff_can('products'));
create policy adm_sp on site_products for all to authenticated using(staff_can('products',site_id)) with check(staff_can('products',site_id));
create policy adm_orders on orders for all to authenticated using(staff_can('orders',site_id)) with check(staff_can('orders',site_id));
create policy adm_items on order_items for all to authenticated using(exists(select 1 from orders o where o.id=order_id and staff_can('orders',o.site_id)));
create policy adm_hist on order_status_history for all to authenticated using(exists(select 1 from orders o where o.id=order_id and staff_can('orders',o.site_id)));
create policy adm_deliv on order_deliveries for all to authenticated using(staff_can('delivery')) with check(staff_can('delivery'));
create policy adm_couriers on couriers for all to authenticated using(staff_can('delivery')) with check(staff_can('delivery'));
create policy adm_coupons on coupons for all to authenticated using(staff_can('coupons')) with check(staff_can('coupons'));
create policy adm_csites on coupon_sites for all to authenticated using(staff_can('coupons')) with check(staff_can('coupons'));
create policy adm_reviews on reviews for all to authenticated using(staff_can('reviews',site_id)) with check(staff_can('reviews',site_id));
create policy adm_subs on subscribers for select to authenticated using(staff_can('reviews',site_id));
create policy adm_sites on sites for all to authenticated using(staff_can('design',id)) with check(staff_can('design',id));
create policy adm_scn on site_countries for all to authenticated using(staff_can('design',site_id)) with check(staff_can('design',site_id));
create policy adm_scu on site_currencies for all to authenticated using(staff_can('design',site_id)) with check(staff_can('design',site_id));
create policy adm_dv on design_versions for all to authenticated using(staff_can('design',site_id)) with check(staff_can('design',site_id));
create policy adm_settings on order_statuses for all to authenticated using(staff_can('settings')) with check(staff_can('settings'));
create policy adm_gov on governorates for all to authenticated using(staff_can('settings')) with check(staff_can('settings'));
create policy adm_cur on currencies for all to authenticated using(staff_can('settings')) with check(staff_can('settings'));
create policy adm_cty on countries for all to authenticated using(staff_can('settings')) with check(staff_can('settings'));
create policy adm_pm on payment_methods for all to authenticated using(staff_can('settings')) with check(staff_can('settings'));
create policy adm_cpm on country_payment_methods for all to authenticated using(staff_can('settings')) with check(staff_can('settings'));
create policy adm_staff on staff for all to authenticated using(staff_can('settings')) with check(staff_can('settings'));
create policy adm_log on activity_log for select to authenticated using(staff_can('settings'));
create policy adm_stocklog on stock_log for select to authenticated using(staff_can('products'));
create policy adm_notif on notifications for all to authenticated using(staff_can('orders') or staff_can('products')) with check(staff_can('orders') or staff_can('products'));
create policy adm_settle on settlements for select to authenticated using(staff_can('delivery'));
create policy anon_restock on restock_requests for insert to anon,authenticated with check(done=false);
create policy adm_leads on leads for all to authenticated using(staff_can('orders',site_id)) with check(staff_can('orders',site_id));
create policy adm_bl on blacklist for all to authenticated using(staff_can('orders')) with check(staff_can('orders'));
create policy adm_tasks on tasks for all to authenticated using(staff_can('orders')) with check(staff_can('orders'));
create policy adm_wa on wa_templates for all to authenticated using(staff_can('settings')) with check(staff_can('settings'));
create policy adm_wa_read on wa_templates for select to authenticated using(staff_can('orders'));
create policy adm_spend on ad_spend for all to authenticated using(staff_can('reports')) with check(staff_can('reports'));
create policy adm_restock on restock_requests for all to authenticated using(staff_can('products',site_id)) with check(staff_can('products',site_id));
-- الطلبات غير المكتملة تُحفظ من الباك إند فقط (service_role) عبر save_lead()
-- courier_secrets و integrations: بدون سياسات → service_role فقط

-- ---------- إنشاء الطلب الآمن (الباك إند فقط) ----------
-- payload: {site_id,name,phone,note,country_id,governorate_id,area,address,payment_method,currency,coupon,utm,items:[{product_id,qty,options:[{name,label}]}]}
-- كل الأسعار والمخزون والكوبون والتوصيل تُحسب هنا من قاعدة البيانات، ولا يُوثق بأي رقم من المتصفح.
create or replace function public.create_order(payload jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_site sites; v_gov governorates; v_cur currencies; v_cp coupons; v_st order_statuses; v_ord orders;
 it jsonb; op jsonb; v_prod products; v_sp site_products; v_unit numeric; v_opts text; v_val jsonb; v_grp jsonb; v_tier jsonb;
 v_sub numeric:=0; v_ship numeric; v_disc numeric:=0; v_tdisc numeric:=0; v_qty int; v_items jsonb:='[]'; v_name text; v_phone text; v_ph9 text; v_before int;
 v_main products; v_after numeric; v_net numeric; v_freeprod boolean:=false; v_pm payment_methods; v_pdisc numeric:=0; v_rc jsonb; v_r jsonb; v_flags text[]:='{}'; v_fs jsonb; v_ref text; v_up boolean;
begin
 v_name:=btrim(coalesce(payload->>'name','')); v_phone:=regexp_replace(coalesce(payload->>'phone',''),'\D','','g'); v_ph9:=right(v_phone,9);
 if v_name='' or length(v_phone)<9 then raise exception 'بيانات العميل غير صحيحة'; end if;
 if exists(select 1 from blacklist where right(regexp_replace(phone,'\D','','g'),9)=v_ph9) then raise exception 'تعذّر إتمام الطلب'; end if;
 select * into v_site from sites where id=(payload->>'site_id')::uuid and active; if not found then raise exception 'الموقع غير موجود'; end if;
 if not exists(select 1 from site_countries where site_id=v_site.id and country_id=payload->>'country_id') then raise exception 'الدولة غير متاحة بهذا الموقع'; end if;
 select * into v_gov from governorates where id=(payload->>'governorate_id')::uuid and country_id=payload->>'country_id'; if not found then raise exception 'المحافظة غير صحيحة'; end if;
 if not exists(select 1 from country_payment_methods c join payment_methods p on p.id=c.method_id where c.country_id=payload->>'country_id' and c.method_id=payload->>'payment_method' and p.active) then raise exception 'طريقة الدفع غير متاحة'; end if;
 select * into v_pm from payment_methods where id=payload->>'payment_method';
 v_rc:=case when jsonb_typeof(payload->'receipts')='array' then payload->'receipts' else '[]'::jsonb end;
 if jsonb_array_length(v_rc)>3 then raise exception 'الحد الأقصى 3 صور للإيصال'; end if;
 for v_r in select * from jsonb_array_elements(v_rc) loop
  if jsonb_typeof(v_r)<>'string' or (v_r#>>'{}') !~ '^receipts/[0-9]{4}-[0-9]{2}/[0-9a-f-]{36}\.(jpg|png|webp)$' then raise exception 'صورة الإيصال غير صالحة'; end if;
 end loop;
 if coalesce(v_pm.cfg->>'proof','off')='required' and jsonb_array_length(v_rc)=0 then raise exception 'ارفع صورة إيصال الدفع لإتمام الطلب'; end if;
 select * into v_cur from currencies where code=coalesce(payload->>'currency','JOD'); if not found then raise exception 'عملة غير صحيحة'; end if;
 if jsonb_array_length(coalesce(payload->'items','[]'))=0 then raise exception 'لا توجد منتجات'; end if;
 for it in select * from jsonb_array_elements(payload->'items') loop
  v_up:=coalesce((it->>'upsell')::boolean,false); v_qty:=case when v_up then 1 else greatest(coalesce((it->>'qty')::int,1),1) end;
  select * into v_prod from products where id=(it->>'product_id')::uuid and active for update; if not found then raise exception 'منتج غير موجود'; end if;
  select * into v_sp from site_products where site_id=v_site.id and product_id=v_prod.id and active; if not found then raise exception 'المنتج غير متاح بهذا الموقع'; end if;
  if v_prod.stock<v_qty then raise exception 'الكمية المتوفرة من «%» هي % فقط',v_prod.name,v_prod.stock; end if;
  v_unit:=coalesce(v_sp.price_override,v_prod.price_jod); v_opts:='';
  if v_up then
   if v_main.id is null or coalesce(v_main.upsell->>'pid','')<>v_prod.id::text then raise exception 'إضافة غير صالحة'; end if;
   v_unit:=v_unit*(1-coalesce((v_main.upsell->>'pct')::numeric,0)/100); v_opts:='إضافة بسعر خاص';
  else
   for op in select * from jsonb_array_elements(coalesce(it->'options','[]')) loop
    v_val:=null;
    for v_grp in select * from jsonb_array_elements(v_prod.options) loop
     if v_grp->>'name'=op->>'name' then select x into v_val from jsonb_array_elements(v_grp->'values') x where x->>'label'=op->>'label' limit 1; end if;
    end loop;
    if v_val is null then raise exception 'خيار غير صحيح'; end if;
    v_unit:=v_unit+coalesce((v_val->>'add')::numeric,0); v_opts:=v_opts||case when v_opts='' then '' else '، ' end||(op->>'label');
   end loop;
   -- عرض الكمية (أفضل عرض ينطبق)
   select t into v_tier from jsonb_array_elements(v_prod.tiers) t where (t->>'qty')::int<=v_qty and (t->>'type'<>'half' or v_qty>=2) order by (t->>'qty')::int desc limit 1;
   if v_tier is not null then v_tdisc:=v_tdisc+case when v_tier->>'type'='half' then v_unit*floor(v_qty/2)*0.5 else v_unit*v_qty*coalesce((v_tier->>'val')::numeric,0)/100 end; end if;
   if v_main.id is null then v_main:=v_prod; end if;
  end if;
  if not v_up and coalesce((v_prod.landing->>'_fs')::boolean,false) then v_freeprod:=true; end if;
  v_before:=v_prod.stock; update products set stock=stock-v_qty, stock_updated_at=now() where id=v_prod.id;
  insert into stock_log(product_id,product_name,by_name,before_qty,after_qty,reason) values(v_prod.id,v_prod.name,'النظام',v_before,v_before-v_qty,'بيع — طلب جديد');
  v_sub:=v_sub+v_unit*v_qty;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('product_id',v_prod.id,'name',v_prod.name,'opts',v_opts,'qty',v_qty,'unit',v_unit));
 end loop;
 v_after:=greatest(v_sub-v_tdisc,0); v_ship:=v_gov.fee_jod;
 if coalesce(payload->>'coupon','')<>'' then
  select * into v_cp from coupons where upper(code)=upper(payload->>'coupon') and active for update;
  if not found or (v_cp.expires_on is not null and v_cp.expires_on<current_date) or (v_cp.max_uses>0 and v_cp.used_count>=v_cp.max_uses)
     or (exists(select 1 from coupon_sites where coupon_id=v_cp.id) and not exists(select 1 from coupon_sites where coupon_id=v_cp.id and site_id=v_site.id)) then raise exception 'الكوبون غير صالح'; end if;
  v_disc:=case when v_cp.type='pct' then v_after*v_cp.value/100 else least(v_cp.value,v_after) end;
  update coupons set used_count=used_count+1 where id=v_cp.id;
 end if;
 v_net:=greatest(v_after-v_disc,0); v_fs:=v_site.config->'freeShip';
 if coalesce((v_fs->>'on')::boolean,false) and coalesce((v_fs->>'min')::numeric,0)>0 and v_net>=(v_fs->>'min')::numeric then v_ship:=0; end if;
 if coalesce((v_fs->>'all')::boolean,false) or v_freeprod or coalesce((v_pm.cfg->>'freeShip')::boolean,false) then v_ship:=0; end if;
 if coalesce(v_pm.cfg->>'dtype','none')='pct' then v_pdisc:=v_net*least(greatest(coalesce((v_pm.cfg->>'dval')::numeric,0),0),100)/100;
 elsif v_pm.cfg->>'dtype'='fix' then v_pdisc:=least(greatest(coalesce((v_pm.cfg->>'dval')::numeric,0),0),v_net); end if;
 if exists(select 1 from orders o join order_statuses s on s.id=o.status_id where right(o.phone,9)=v_ph9 and o.created_at>now()-interval '7 days' and s.kind<>'cancel') then v_flags:=array_append(v_flags,'dup'); end if;
 if exists(select 1 from orders o join order_statuses s on s.id=o.status_id left join order_deliveries d on d.order_id=o.id where right(o.phone,9)=v_ph9 and (s.kind='cancel' or d.status='failed')) then v_flags:=array_append(v_flags,'bad'); end if;
 select * into v_st from order_statuses order by sort,name limit 1;
 insert into orders(site_id,customer_name,phone,country_id,governorate_id,governorate_name,area,address,payment_method,currency,fx_rate,subtotal_jod,shipping_jod,discount_jod,tier_discount_jod,total_jod,coupon_code,customer_note,flags,status_id,utm,receipts,pay_discount_jod)
 values(v_site.id,v_name,v_phone,payload->>'country_id',v_gov.id,v_gov.name,payload->>'area',payload->>'address',payload->>'payment_method',v_cur.code,v_cur.rate,v_sub,v_ship,v_disc,v_tdisc,greatest(v_net-v_pdisc,0)+v_ship,v_cp.code,nullif(btrim(coalesce(payload->>'note','')),''),v_flags,v_st.id,payload->'utm',v_rc,v_pdisc) returning * into v_ord;
 insert into order_items(order_id,product_id,name,options_text,qty,unit_price_jod) select v_ord.id,(x->>'product_id')::uuid,x->>'name',x->>'opts',(x->>'qty')::int,(x->>'unit')::numeric from jsonb_array_elements(v_items) x;
 insert into order_status_history(order_id,status_id,by_name) values(v_ord.id,v_st.id,'الزبون');
 update leads set converted=true, updated_at=now() where site_id=v_site.id and right(regexp_replace(phone,'\D','','g'),9)=v_ph9 and not converted;
 if coalesce((v_site.config->'referral'->>'on')::boolean,false) then
  select code into v_ref from coupons c where c.ref_phone=v_ph9 and exists(select 1 from coupon_sites s where s.coupon_id=c.id and s.site_id=v_site.id) limit 1;
  if v_ref is null then
   v_ref:='FR'||upper(substr(md5(random()::text),1,4));
   with c as (insert into coupons(code,type,value,max_uses,ref_phone) values(v_ref,'pct',coalesce((v_site.config->'referral'->>'pct')::numeric,10),20,v_ph9) returning id)
   insert into coupon_sites select id,v_site.id from c;
  end if;
  update orders set ref_code=v_ref where id=v_ord.id;
 end if;
 if v_gov.default_courier is not null and exists(select 1 from couriers where id=v_gov.default_courier and active) then
  insert into order_deliveries(order_id,courier_id,cost_jod) select v_ord.id,id,cost_jod from couriers where id=v_gov.default_courier; end if;
 insert into notifications(body) values('🧾 طلب جديد #'||v_ord.order_no||' — '||v_site.name||E'\n'||v_name||' '||v_phone||' — '||v_ord.total_jod||' د.أ'||case when v_ord.customer_note is not null then E'\n📝 '||v_ord.customer_note else '' end||case when cardinality(v_flags)>0 then E'\n⚠️ '||array_to_string(v_flags,', ') else '' end);
 return jsonb_build_object('order_id',v_ord.id,'order_no',v_ord.order_no,'total_jod',v_ord.total_jod,'tier_discount_jod',v_tdisc,'pay_discount_jod',v_pdisc,'shipping_jod',v_ship,'currency',v_cur.code,'fx_rate',v_cur.rate,'flags',to_jsonb(v_flags),'ref_code',v_ref);
end $$;
-- حفظ/تحديث طلب غير مكتمل (من الباك إند عند كتابة الاسم والرقم)
create or replace function public.save_lead(p_site uuid, p_product uuid, p_name text, p_phone text, p_utm jsonb default null) returns void language plpgsql security definer set search_path=public as $$
begin
 if length(regexp_replace(coalesce(p_phone,''),'\D','','g'))<9 or btrim(coalesce(p_name,''))='' then return; end if;
 insert into leads(site_id,product_id,name,phone,utm) values(p_site,p_product,btrim(p_name),p_phone,p_utm)
 on conflict (site_id, right(regexp_replace(phone,'\D','','g'),9)) where not converted do update set name=excluded.name, product_id=excluded.product_id, utm=coalesce(excluded.utm,leads.utm), updated_at=now();
end $$;
revoke all on function public.save_lead(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_lead(uuid,uuid,text,text,jsonb) to service_role;
revoke all on function public.create_order(jsonb) from public,anon,authenticated;
grant execute on function public.create_order(jsonb) to service_role;

-- إلغاء الطلب يرجّع المخزون (يُستدعى من الباك إند/اللوحة عند تغيير الحالة)
create or replace function public.set_order_status(p_order uuid, p_status uuid, p_by text) returns void language plpgsql security definer set search_path=public as $$
declare v_old order_statuses; v_new order_statuses; o orders;
begin
 select * into o from orders where id=p_order for update; select * into v_old from order_statuses where id=o.status_id; select * into v_new from order_statuses where id=p_status;
 if v_old.kind<>'cancel' and v_new.kind='cancel' then insert into stock_log(product_id,product_name,by_name,before_qty,after_qty,reason) select p.id,p.name,p_by,p.stock,p.stock+i.qty,'إلغاء طلب #'||o.order_no from order_items i join products p on p.id=i.product_id where i.order_id=o.id;
  update products p set stock=p.stock+i.qty, stock_updated_at=now() from order_items i where i.order_id=o.id and i.product_id=p.id; end if;
 if v_old.kind='cancel' and v_new.kind<>'cancel' then insert into stock_log(product_id,product_name,by_name,before_qty,after_qty,reason) select p.id,p.name,p_by,p.stock,greatest(p.stock-i.qty,0),'إعادة تفعيل طلب #'||o.order_no from order_items i join products p on p.id=i.product_id where i.order_id=o.id;
  update products p set stock=greatest(p.stock-i.qty,0), stock_updated_at=now() from order_items i where i.order_id=o.id and i.product_id=p.id; end if;
 update orders set status_id=p_status where id=o.id; insert into order_status_history(order_id,status_id,by_name) values(o.id,p_status,p_by);
end $$;
revoke all on function public.set_order_status(uuid,uuid,text) from public,anon;
grant execute on function public.set_order_status(uuid,uuid,text) to authenticated,service_role;

-- تعديل المخزون من صفحة «المخزون» (سجل + إشعار)
create or replace function public.adjust_stock(p_product uuid, p_qty int, p_by text, p_reason text default 'تعديل يدوي') returns void language plpgsql security definer set search_path=public as $$
declare p products;
begin
 if not staff_can('products') then raise exception 'غير مصرّح'; end if;
 select * into p from products where id=p_product for update; if not found then raise exception 'منتج غير موجود'; end if;
 p_qty:=greatest(p_qty,0); if p_qty=p.stock then return; end if;
 update products set stock=p_qty, stock_updated_at=now() where id=p.id;
 insert into stock_log(product_id,product_name,by_name,before_qty,after_qty,reason) values(p.id,p.name,p_by,p.stock,p_qty,p_reason);
 insert into notifications(body) values('📦 '||p.name||': '||p.stock||' ← '||p_qty||' ('||p_reason||' — '||p_by||')'||case when p_qty<=0 then E'\n⛔ نفد المخزون!' when p_qty<=p.min_stock then E'\n⚠️ وصل للحد الأدنى' else '' end);
end $$;
revoke all on function public.adjust_stock(uuid,int,text,text) from public,anon; grant execute on function public.adjust_stock(uuid,int,text,text) to authenticated,service_role;

-- «تسوية وإغلاق» لموصّل: يقفل طلباته المُسلَّمة ويسجّل التسوية ومبيعات اليوم
create or replace function public.settle_courier(p_courier uuid, p_by text) returns jsonb language plpgsql security definer set search_path=public as $$
declare c couriers; v_n int; v_cash numeric; v_fee numeric; v_nos bigint[]; v_ds numeric; v_do int; rid uuid;
begin
 if not staff_can('delivery') then raise exception 'غير مصرّح'; end if;
 select * into c from couriers where id=p_courier; if not found then raise exception 'موصّل غير موجود'; end if;
 select count(*),coalesce(sum(case when o.payment_method='cod' then o.total_jod else 0 end),0),coalesce(sum(d.cost_jod),0),coalesce(array_agg(o.order_no),'{}')
  into v_n,v_cash,v_fee,v_nos from order_deliveries d join orders o on o.id=d.order_id where d.courier_id=p_courier and d.status='delivered' and not d.settled;
 if v_n=0 then raise exception 'لا طلبات بانتظار التسوية'; end if;
 select coalesce(sum(o.total_jod),0),count(*) into v_ds,v_do from orders o join order_statuses s on s.id=o.status_id where s.kind<>'cancel' and o.created_at>=date_trunc('day',now());
 update order_deliveries set settled=true, settled_at=now() where courier_id=p_courier and status='delivered' and not settled;
 insert into settlements(courier_id,courier_name,order_nos,cash_jod,fee_jod,net_jod,day_sales_jod,day_orders,by_name) values(c.id,c.name,v_nos,v_cash,v_fee,v_cash-v_fee,v_ds,v_do,p_by) returning id into rid;
 insert into notifications(body) values('✅ تمت تسوية «'||c.name||'» — صافي '||(v_cash-v_fee)||' د.أ ('||v_n||' طلب) بواسطة '||p_by);
 return jsonb_build_object('settlement_id',rid,'orders',v_n,'cash',v_cash,'fee',v_fee,'net',v_cash-v_fee,'day_sales',v_ds,'day_orders',v_do);
end $$;
revoke all on function public.settle_courier(uuid,text) from public,anon; grant execute on function public.settle_courier(uuid,text) to authenticated,service_role;

-- كشف التسوية اليومية للسائقين والشركات (الكاش المحصّل − أجرة التوصيل)
create or replace view public.v_courier_settlement with (security_invoker=true) as
 select c.id courier_id,c.name,count(*) delivered,sum(case when o.payment_method='cod' then o.total_jod else 0 end) cod_cash,sum(d.cost_jod) fees,
  sum(case when o.payment_method='cod' then o.total_jod else 0 end)-sum(d.cost_jod) net
 from order_deliveries d join couriers c on c.id=d.courier_id join orders o on o.id=d.order_id where d.status='delivered' and not d.settled group by c.id,c.name;

-- تتبّع الطلب للزبون (برقم الطلب + الهاتف) — يُستدعى من الباك إند مع rate limit
create or replace function public.track_order(p_site uuid, p_no bigint, p_phone text) returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('order_no',o.order_no,'status',s.name,'color',s.color,'history',(select jsonb_agg(jsonb_build_object('status',hs.name,'at',h.created_at) order by h.created_at) from order_status_history h join order_statuses hs on hs.id=h.status_id where h.order_id=o.id),
  'courier',c.name,'delivery_status',d.status,'tracking_url',case when c.tracking_url is not null and d.tracking_no is not null then replace(c.tracking_url,'{no}',d.tracking_no) end)
 from orders o join order_statuses s on s.id=o.status_id left join order_deliveries d on d.order_id=o.id left join couriers c on c.id=d.courier_id
 where o.site_id=p_site and o.order_no=p_no and right(o.phone,9)=right(regexp_replace(p_phone,'\D','','g'),9) $$;
revoke all on function public.track_order(uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.track_order(uuid,bigint,text) to service_role;

-- ---------- بيانات أولية ----------
insert into currencies(code,symbol,rate,manual) values('JOD','د.أ',1,true),('USD','$',1.41,false),('ILS','₪',5.1,false),('SAR','ر.س',5.3,false);
insert into payment_methods(id,name,instructions,sort) values('cod','الدفع عند الاستلام','ادفعي للمندوب عند استلام الطلب.',1),('cliq','CliQ','حوّلي المبلغ على الاسم المستعار ثم أرسلي صورة الحوالة على واتساب.',2);
insert into countries(id,name,flag,currency,sort) values('jo','الأردن','🇯🇴','JOD',1),('ps','فلسطين','🇵🇸','ILS',2),('sy','سوريا','🇸🇾','USD',3),('lb','لبنان','🇱🇧','USD',4);
insert into country_payment_methods values('jo','cod'),('jo','cliq'),('ps','cod'),('sy','cod'),('lb','cod');
insert into governorates(country_id,name,fee_jod,eta,sort) values('jo','عمّان',2,'يوم',1),('jo','إربد',3,'1-2 يوم',2),('jo','الزرقاء',3,'1-2 يوم',3),('jo','العقبة',5,'2-3 أيام',4),('jo','محافظة أخرى',4,'2-3 أيام',5),
 ('ps','رام الله',5,'3-4 أيام',1),('ps','نابلس',5,'3-4 أيام',2),('ps','الخليل',6,'3-5 أيام',3),('sy','دمشق',8,'5-7 أيام',1),('sy','حلب',9,'6-8 أيام',2),('lb','بيروت',9,'4-6 أيام',1),('lb','طرابلس',10,'5-7 أيام',2);
insert into order_statuses(name,color,kind,sort) values('طلب جديد','#f59e0b','normal',1),('تم التأكيد','#3b82f6','normal',2),('قيد التجهيز','#8b5cf6','normal',3),('تم الشحن','#06b6d4','normal',4),('تم التسليم','#16a34a','done',5),('ملغي','#dc2626','cancel',6);
