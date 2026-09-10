-- ============================================================
-- INDIAN CANTEEN INGREDIENTS MASTER
--
-- Seeds every canteen with the standard Indian-kitchen ingredient
-- list so recipes can be entered immediately (the live DB had 550
-- menu items but almost no ingredients, which left the automatic
-- stock-deduction and anti-theft variance systems with nothing to
-- work on).
--
-- current_stock starts at 0 — real stock comes from the opening
-- stock audit. cost_per_unit is an approximate market rate to give
-- shortage-value estimates meaning until purchases refine it.
--
-- Idempotent: skips any (canteen, name) that already exists.
-- ============================================================

INSERT INTO public.ingredients (canteen_id, name, category, unit, current_stock, minimum_stock, cost_per_unit)
SELECT c.id, x.name, x.category, x.unit, 0, x.min_stock, x.cost
FROM public.canteens c
CROSS JOIN (VALUES
  -- ---- Grains & Flours ----
  ('Wheat Flour (Atta)',      'Grains & Flours', 'kg',    25, 45),
  ('Maida',                   'Grains & Flours', 'kg',    10, 42),
  ('Besan',                   'Grains & Flours', 'kg',    5,  90),
  ('Rice (Basmati)',          'Grains & Flours', 'kg',    10, 120),
  ('Rice (Regular)',          'Grains & Flours', 'kg',    25, 55),
  ('Idli Rice',               'Grains & Flours', 'kg',    5,  60),
  ('Poha',                    'Grains & Flours', 'kg',    5,  60),
  ('Suji (Rava)',             'Grains & Flours', 'kg',    5,  50),
  ('Sabudana',                'Grains & Flours', 'kg',    2,  90),
  ('Murmura',                 'Grains & Flours', 'kg',    2,  80),
  ('Dalia',                   'Grains & Flours', 'kg',    2,  55),
  ('Rice Flour',              'Grains & Flours', 'kg',    2,  55),
  ('Cornflour',               'Grains & Flours', 'kg',    1,  80),
  ('Ragi Flour',              'Grains & Flours', 'kg',    2,  70),
  ('Bajra Flour',             'Grains & Flours', 'kg',    2,  55),
  ('Vermicelli (Seviyan)',    'Grains & Flours', 'kg',    2,  80),

  -- ---- Pulses & Dals ----
  ('Toor Dal',                'Pulses',          'kg',    10, 140),
  ('Moong Dal (Yellow)',      'Pulses',          'kg',    5,  120),
  ('Moong (Whole Green)',     'Pulses',          'kg',    3,  110),
  ('Chana Dal',               'Pulses',          'kg',    5,  95),
  ('Urad Dal',                'Pulses',          'kg',    5,  130),
  ('Urad (Whole Black)',      'Pulses',          'kg',    3,  125),
  ('Masoor Dal',              'Pulses',          'kg',    3,  100),
  ('Rajma',                   'Pulses',          'kg',    3,  140),
  ('Kabuli Chana (Chole)',    'Pulses',          'kg',    5,  130),
  ('Kala Chana',              'Pulses',          'kg',    3,  95),

  -- ---- Oils & Fats ----
  ('Sunflower Oil',           'Oils & Fats',     'litre', 15, 130),
  ('Mustard Oil',             'Oils & Fats',     'litre', 5,  160),
  ('Groundnut Oil',           'Oils & Fats',     'litre', 5,  180),
  ('Ghee',                    'Oils & Fats',     'kg',    5,  600),
  ('Butter',                  'Oils & Fats',     'kg',    2,  550),

  -- ---- Spices & Condiments ----
  ('Salt',                    'Spices',          'kg',    10, 22),
  ('Sugar',                   'Spices',          'kg',    15, 45),
  ('Jaggery (Gud)',           'Spices',          'kg',    3,  60),
  ('Turmeric Powder',         'Spices',          'kg',    2,  220),
  ('Red Chilli Powder',       'Spices',          'kg',    2,  350),
  ('Coriander Powder',        'Spices',          'kg',    2,  220),
  ('Cumin Seeds (Jeera)',     'Spices',          'kg',    2,  400),
  ('Mustard Seeds (Rai)',     'Spices',          'kg',    1,  120),
  ('Garam Masala',            'Spices',          'kg',    1,  500),
  ('Chaat Masala',            'Spices',          'kg',    1,  400),
  ('Sambar Powder',           'Spices',          'kg',    1,  450),
  ('Pav Bhaji Masala',        'Spices',          'kg',    1,  450),
  ('Chole Masala',            'Spices',          'kg',    1,  450),
  ('Kitchen King Masala',     'Spices',          'kg',    1,  500),
  ('Black Pepper',            'Spices',          'kg',    0.5, 800),
  ('Green Cardamom',          'Spices',          'kg',    0.2, 3000),
  ('Cloves',                  'Spices',          'kg',    0.2, 1000),
  ('Cinnamon',                'Spices',          'kg',    0.3, 500),
  ('Bay Leaf (Tej Patta)',    'Spices',          'kg',    0.2, 300),
  ('Hing (Asafoetida)',       'Spices',          'kg',    0.1, 2000),
  ('Fenugreek Seeds (Methi)', 'Spices',          'kg',    0.5, 120),
  ('Ajwain',                  'Spices',          'kg',    0.5, 300),
  ('Fennel Seeds (Saunf)',    'Spices',          'kg',    0.5, 300),
  ('Dry Red Chilli',          'Spices',          'kg',    1,  350),
  ('Amchur Powder',           'Spices',          'kg',    0.5, 350),
  ('Kasuri Methi',            'Spices',          'kg',    0.3, 600),
  ('Tamarind (Imli)',         'Spices',          'kg',    1,  160),
  ('Vinegar',                 'Spices',          'litre', 1,  60),
  ('Tomato Ketchup',          'Spices',          'kg',    3,  120),
  ('Pickle (Achar)',          'Spices',          'kg',    2,  180),
  ('Papad',                   'Spices',          'kg',    2,  300),
  ('Baking Soda',             'Spices',          'kg',    0.5, 60),
  ('Baking Powder',           'Spices',          'kg',    0.5, 150),
  ('Custard Powder',          'Spices',          'kg',    0.5, 250),
  ('Food Colour',             'Spices',          'kg',    0.1, 400),

  -- ---- Vegetables ----
  ('Onion',                   'Vegetables',      'kg',    20, 35),
  ('Tomato',                  'Vegetables',      'kg',    15, 40),
  ('Potato',                  'Vegetables',      'kg',    25, 30),
  ('Ginger',                  'Vegetables',      'kg',    2,  120),
  ('Garlic',                  'Vegetables',      'kg',    2,  180),
  ('Green Chilli',            'Vegetables',      'kg',    2,  80),
  ('Coriander Leaves',        'Vegetables',      'kg',    2,  80),
  ('Mint Leaves (Pudina)',    'Vegetables',      'kg',    1,  80),
  ('Curry Leaves',            'Vegetables',      'kg',    0.5, 100),
  ('Cauliflower',             'Vegetables',      'kg',    5,  50),
  ('Cabbage',                 'Vegetables',      'kg',    5,  35),
  ('Carrot',                  'Vegetables',      'kg',    5,  50),
  ('French Beans',            'Vegetables',      'kg',    3,  70),
  ('Green Peas',              'Vegetables',      'kg',    3,  90),
  ('Capsicum',                'Vegetables',      'kg',    3,  70),
  ('Brinjal (Baingan)',       'Vegetables',      'kg',    3,  45),
  ('Bhindi (Okra)',           'Vegetables',      'kg',    3,  60),
  ('Lauki (Bottle Gourd)',    'Vegetables',      'kg',    3,  35),
  ('Palak (Spinach)',         'Vegetables',      'kg',    3,  45),
  ('Methi Leaves',            'Vegetables',      'kg',    2,  60),
  ('Cucumber',                'Vegetables',      'kg',    3,  40),
  ('Lemon',                   'Vegetables',      'kg',    2,  80),
  ('Beetroot',                'Vegetables',      'kg',    2,  50),
  ('Radish (Mooli)',          'Vegetables',      'kg',    2,  35),
  ('Pumpkin (Kaddu)',         'Vegetables',      'kg',    3,  30),
  ('Drumstick',               'Vegetables',      'kg',    1,  90),
  ('Spring Onion',            'Vegetables',      'kg',    1,  60),
  ('Mushroom',                'Vegetables',      'kg',    1,  200),

  -- ---- Dairy & Eggs ----
  ('Milk',                    'Dairy',           'litre', 20, 58),
  ('Curd (Dahi)',             'Dairy',           'kg',    5,  70),
  ('Paneer',                  'Dairy',           'kg',    5,  350),
  ('Cheese',                  'Dairy',           'kg',    1,  450),
  ('Fresh Cream',             'Dairy',           'litre', 2,  220),
  ('Khoya (Mawa)',            'Dairy',           'kg',    1,  350),
  ('Eggs',                    'Dairy',           'pcs',   60, 7),

  -- ---- Dry Fruits & Nuts ----
  ('Peanuts',                 'Dry Fruits',      'kg',    3,  130),
  ('Cashew (Kaju)',           'Dry Fruits',      'kg',    1,  800),
  ('Almonds (Badam)',         'Dry Fruits',      'kg',    1,  750),
  ('Raisins (Kishmish)',      'Dry Fruits',      'kg',    1,  350),
  ('Dry Coconut (Copra)',     'Dry Fruits',      'kg',    1,  250),
  ('Fresh Coconut',           'Dry Fruits',      'pcs',   10, 40),

  -- ---- Beverages & Packaged ----
  ('Tea Leaves',              'Beverages',       'kg',    3,  350),
  ('Coffee Powder',           'Beverages',       'kg',    1,  600),
  ('Bread',                   'Bakery',          'pcs',   10, 45),
  ('Pav',                     'Bakery',          'pcs',   50, 4),
  ('Noodles',                 'Packaged',        'kg',    3,  120),
  ('Pasta',                   'Packaged',        'kg',    2,  140),
  ('Soya Chunks',             'Packaged',        'kg',    2,  150),
  ('Honey',                   'Packaged',        'kg',    0.5, 350)
) AS x(name, category, unit, min_stock, cost)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ingredients i
  WHERE i.canteen_id = c.id AND lower(i.name) = lower(x.name)
);
