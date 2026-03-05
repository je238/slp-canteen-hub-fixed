
-- Add anon access policies for all tables so the app works without auth
CREATE POLICY "Allow anon full access to canteens" ON public.canteens FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to ingredients" ON public.ingredients FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to menu_items" ON public.menu_items FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to orders" ON public.orders FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to order_items" ON public.order_items FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to purchases" ON public.purchases FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to purchase_items" ON public.purchase_items FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to suppliers" ON public.suppliers FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to recipes" ON public.recipes FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to recipe_ingredients" ON public.recipe_ingredients FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to expenses" ON public.expenses FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to staff" ON public.staff FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to stock_ledger" ON public.stock_ledger FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to attendance" ON public.attendance FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon full access to action_logs" ON public.action_logs FOR ALL TO anon USING (true) WITH CHECK (true);
