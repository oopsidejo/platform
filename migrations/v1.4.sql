-- v1.4 — فهارس للأداء فقط (آمن تشغيله أكثر من مرة). شغّله مرة في Supabase > SQL Editor.
-- بدونها: تحميل اللوحة يمسح جدول بنود الطلبات وسجل الحالات كاملاً لكل طلب (يبطأ مع مئات/آلاف الطلبات).
create index if not exists order_items_order_idx on order_items(order_id);
create index if not exists order_status_history_order_idx on order_status_history(order_id);
create index if not exists orders_phone9_idx on orders(right(phone,9));
