-- v1.6: الدفع كليك (بيانات الحساب، خصم/توصيل مجاني عند الدفع كليك، إيصالات الدفع). آمن للتشغيل أكثر من مرة.
alter table payment_methods add column if not exists cfg jsonb not null default '{}';
alter table orders add column if not exists receipts jsonb not null default '[]';
alter table orders add column if not exists pay_discount_jod numeric not null default 0;
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
revoke all on function public.create_order(jsonb) from public,anon,authenticated;
grant execute on function public.create_order(jsonb) to service_role;
